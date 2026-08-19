/**
 * PostgreSQL `EnvelopeRepository` (X.1). Depends only on a small query seam
 * (`PgQueryable`) — a `pg.Pool` satisfies it directly, and tests drive it with an
 * in-memory Postgres (pg-mem). The aggregate is stored whole (as text, portable
 * across drivers), with a companion `recipient_tokens` index for token lookups.
 *
 * ATOMICITY (parity with the SQLite adapter): every write runs inside a single
 * transaction on ONE checked-out connection, so the envelope row and its token
 * index never diverge — a crash or concurrent read can never see a half-updated
 * token index (which would 404 a valid signing link). Insertion order for
 * `list()` comes from a `bigserial` column assigned by the database, not a
 * read-modify-write `MAX(seq)+1`, so concurrent creates can't collide on `seq`.
 */
import type { Envelope, EnvelopeRepository } from "@finesign/domain";
import { ConflictError } from "@finesign/shared";

/** A checked-out connection (subset of `pg.PoolClient`). */
export interface PgClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

/** The subset of a `pg.Pool` this adapter needs. */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<PgClient>;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e.code === "23505" || /duplicate key|unique constraint/i.test(e.message ?? "");
}

export class PostgresEnvelopeRepository implements EnvelopeRepository {
  private readonly ready: Promise<void>;

  constructor(private readonly client: PgQueryable) {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS envelopes (
        id         text PRIMARY KEY,
        data       text NOT NULL,
        status     text NOT NULL,
        created_at text NOT NULL,
        seq        bigserial,
        version    integer NOT NULL DEFAULT 0
      );
    `);
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS recipient_tokens (
        token_hash   text PRIMARY KEY,
        envelope_id  text NOT NULL,
        recipient_id text NOT NULL
      );
    `);
    // `expires_at` powers the expiry sweep. Added separately (not in the CREATE
    // above) so a database created before it existed picks it up too — the
    // CREATE is a no-op there. Backfilled from the stored aggregate.
    await this.client.query("ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS expires_at text");
    await this.client.query(
      "UPDATE envelopes SET expires_at = data::json->>'expiresAt' WHERE expires_at IS NULL"
    );
    // Composite (status, expires_at) rather than a partial index: it is the
    // textbook shape for `WHERE status = ? AND expires_at < ?`, and it does not
    // depend on partial-index support, which not every Postgres-compatible
    // engine implements faithfully.
    await this.client.query("CREATE INDEX IF NOT EXISTS idx_env_expiry ON envelopes(status, expires_at)");
  }

  /** Run `fn` inside a single-connection BEGIN/COMMIT (ROLLBACK on error). */
  private async withTransaction<T>(fn: (c: PgClient) => Promise<T>): Promise<T> {
    await this.ready;
    const c = await this.client.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await c.query("ROLLBACK");
      } catch {
        // ignore rollback failure; surface the original error
      }
      throw err;
    } finally {
      c.release();
    }
  }

  /** Refresh the token index for one envelope (within the caller's transaction). */
  private async refreshTokens(c: PgClient, envelope: Envelope): Promise<void> {
    await c.query("DELETE FROM recipient_tokens WHERE envelope_id = $1", [envelope.id]);
    for (const r of envelope.recipients) {
      if (r.tokenHash) {
        await c.query(
          "INSERT INTO recipient_tokens (token_hash, envelope_id, recipient_id) VALUES ($1, $2, $3)",
          [r.tokenHash, envelope.id, r.id]
        );
      }
    }
  }

  async create(envelope: Envelope): Promise<void> {
    await this.withTransaction(async (c) => {
      try {
        // Plain INSERT — the primary key gives atomic, race-free conflict
        // detection (no SELECT-then-write TOCTOU). `seq` is DB-assigned.
        await c.query(
          "INSERT INTO envelopes (id, data, status, created_at, version, expires_at) VALUES ($1, $2, $3, $4, $5, $6)",
          [envelope.id, JSON.stringify(envelope), envelope.status, envelope.createdAt, envelope.version, envelope.expiresAt]
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw new Error(`envelope ${envelope.id} already exists`);
        throw err;
      }
      await this.refreshTokens(c, envelope);
    });
  }

  async save(envelope: Envelope): Promise<void> {
    await this.withTransaction(async (c) => {
      const newVersion = envelope.version + 1;
      const data = JSON.stringify({ ...envelope, version: newVersion });
      // Atomic compare-and-swap via `WHERE version = expected` (no lock needed):
      // the UPDATE affects a row only if the stored version still matches.
      const upd = await c.query(
        "UPDATE envelopes SET data = $2, status = $3, version = $4, expires_at = $6 WHERE id = $1 AND version = $5 RETURNING id",
        [envelope.id, data, envelope.status, newVersion, envelope.version, envelope.expiresAt]
      );
      if (upd.rows.length === 0) {
        const exists = await c.query("SELECT 1 FROM envelopes WHERE id = $1", [envelope.id]);
        if (exists.rows.length > 0) {
          throw new ConflictError("VERSION_CONFLICT", `envelope ${envelope.id} was modified concurrently`);
        }
        await c.query(
          "INSERT INTO envelopes (id, data, status, created_at, version, expires_at) VALUES ($1, $2, $3, $4, $5, $6)",
          [envelope.id, data, envelope.status, envelope.createdAt, newVersion, envelope.expiresAt]
        );
      }
      await this.refreshTokens(c, envelope);
    });
  }

  async findById(id: string): Promise<Envelope | null> {
    await this.ready;
    const { rows } = await this.client.query("SELECT data FROM envelopes WHERE id = $1", [id]);
    return rows.length > 0 ? (JSON.parse(rows[0].data as string) as Envelope) : null;
  }

  async findByRecipientTokenHash(
    tokenHash: string
  ): Promise<{ envelope: Envelope; recipientId: string } | null> {
    await this.ready;
    const { rows } = await this.client.query(
      "SELECT envelope_id, recipient_id FROM recipient_tokens WHERE token_hash = $1",
      [tokenHash]
    );
    if (rows.length === 0) return null;
    const env = await this.findById(rows[0].envelope_id as string);
    if (!env) return null;
    return { envelope: env, recipientId: rows[0].recipient_id as string };
  }

  async list(params?: { limit?: number; offset?: number }): Promise<Envelope[]> {
    await this.ready;
    const offset = params?.offset ?? 0;
    const text =
      params?.limit != null
        ? "SELECT data FROM envelopes ORDER BY seq ASC LIMIT $1 OFFSET $2"
        : "SELECT data FROM envelopes ORDER BY seq ASC OFFSET $1";
    const args = params?.limit != null ? [params.limit, offset] : [offset];
    const { rows } = await this.client.query(text, args);
    return rows.map((r) => JSON.parse(r.data as string) as Envelope);
  }

  async listExpirable(nowIso: string, limit: number): Promise<Envelope[]> {
    await this.ready;
    const { rows } = await this.client.query(
      "SELECT data FROM envelopes WHERE status = 'sent' AND expires_at IS NOT NULL AND expires_at < $1 ORDER BY expires_at ASC LIMIT $2",
      [nowIso, limit]
    );
    return rows.map((r) => JSON.parse(r.data as string) as Envelope);
  }
}
