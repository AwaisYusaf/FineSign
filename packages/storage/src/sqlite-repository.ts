/**
 * SQLite `EnvelopeRepository`. The aggregate is stored as a JSON document keyed
 * by id (envelopes are loaded/saved whole — see ARCHITECTURE), with a companion
 * `recipient_tokens` index so a signing token hash resolves to its envelope +
 * recipient in one indexed lookup. Writes are wrapped in a transaction so the
 * aggregate row and its token index never diverge.
 */
import Database from "better-sqlite3";
import type { Envelope, EnvelopeRepository } from "@finesign/domain";
import { ConflictError } from "@finesign/shared";

export class SqliteEnvelopeRepository implements EnvelopeRepository {
  private readonly db: Database.Database;

  /** @param filename SQLite file path, or ":memory:" for an ephemeral db. */
  constructor(filename = ":memory:") {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS envelopes (
        id         TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        status     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        seq        INTEGER,
        version    INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS recipient_tokens (
        token_hash   TEXT PRIMARY KEY,
        envelope_id  TEXT NOT NULL,
        recipient_id TEXT NOT NULL
      );
      -- UNIQUE so any seq collision surfaces as a loud constraint error rather
      -- than silently destabilising list() order (E6). better-sqlite3 is
      -- synchronous and each create runs without interleaving, so single-process
      -- deployments never collide; this guards the multi-process case.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_env_seq ON envelopes(seq);
    `);
  }

  /** Row insertion order for stable `list()` — monotonically increasing. */
  private nextSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), -1) AS m FROM envelopes").get() as { m: number };
    return row.m + 1;
  }

  /** Write the aggregate (row + token index) at a given seq + version, storing
   *  `version` in BOTH the column and the JSON so reads return it. */
  private persist(envelope: Envelope, seq: number, version: number): void {
    const data = JSON.stringify({ ...envelope, version });
    const tx = this.db.transaction(() => {
      this.db
        .prepare("INSERT OR REPLACE INTO envelopes (id, data, status, created_at, seq, version) VALUES (?, ?, ?, ?, ?, ?)")
        .run(envelope.id, data, envelope.status, envelope.createdAt, seq, version);
      this.db.prepare("DELETE FROM recipient_tokens WHERE envelope_id = ?").run(envelope.id);
      const ins = this.db.prepare(
        "INSERT OR REPLACE INTO recipient_tokens (token_hash, envelope_id, recipient_id) VALUES (?, ?, ?)"
      );
      for (const r of envelope.recipients) {
        if (r.tokenHash) ins.run(r.tokenHash, envelope.id, r.id);
      }
    });
    tx();
  }

  async create(envelope: Envelope): Promise<void> {
    const exists = this.db.prepare("SELECT 1 FROM envelopes WHERE id = ?").get(envelope.id);
    if (exists) throw new Error(`envelope ${envelope.id} already exists`);
    this.persist(envelope, this.nextSeq(), envelope.version);
  }

  async save(envelope: Envelope): Promise<void> {
    // Optimistic-concurrency compare-and-swap. better-sqlite3 is synchronous, so
    // the read + conditional write is effectively atomic within this process.
    const row = this.db.prepare("SELECT seq, version FROM envelopes WHERE id = ?").get(envelope.id) as
      | { seq: number; version: number }
      | undefined;
    if (row && row.version !== envelope.version) {
      throw new ConflictError(
        "VERSION_CONFLICT",
        `envelope ${envelope.id} was modified concurrently (expected version ${envelope.version}, found ${row.version})`
      );
    }
    this.persist(envelope, row ? row.seq : this.nextSeq(), envelope.version + 1);
  }

  async findById(id: string): Promise<Envelope | null> {
    const row = this.db.prepare("SELECT data FROM envelopes WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Envelope) : null;
  }

  async findByRecipientTokenHash(
    tokenHash: string
  ): Promise<{ envelope: Envelope; recipientId: string } | null> {
    const idx = this.db
      .prepare("SELECT envelope_id, recipient_id FROM recipient_tokens WHERE token_hash = ?")
      .get(tokenHash) as { envelope_id: string; recipient_id: string } | undefined;
    if (!idx) return null;
    const env = await this.findById(idx.envelope_id);
    if (!env) return null;
    return { envelope: env, recipientId: idx.recipient_id };
  }

  async list(params?: { limit?: number; offset?: number }): Promise<Envelope[]> {
    const limit = params?.limit ?? -1; // -1 → no limit in SQLite
    const offset = params?.offset ?? 0;
    const rows = this.db
      .prepare("SELECT data FROM envelopes ORDER BY seq ASC LIMIT ? OFFSET ?")
      .all(limit, offset) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Envelope);
  }

  /** Release the underlying file handle. */
  close(): void {
    this.db.close();
  }
}
