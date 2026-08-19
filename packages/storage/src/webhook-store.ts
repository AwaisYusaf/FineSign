/**
 * Webhook persistence — subscriptions + a durable delivery outbox. The *what*
 * (event fan-out to subscribers) is a server concern, but the *storage* lives
 * here alongside the other adapters. Two impls (in-memory for tests, SQLite for
 * self-hosting) satisfy the same `WebhookStore` contract in `./webhook-contract`.
 *
 * Delivery model (see the deliverer in @finesign/server):
 *  - Each audit event on an envelope fans out to every ACTIVE subscription whose
 *    type filter matches, as one `WebhookDelivery` row (the transactional outbox).
 *  - Fan-out is forward-only + idempotent: a `UNIQUE(subscription, envelope,
 *    eventId)` guard plus a per-(subscription,envelope) high-water-mark derived
 *    from `MAX(eventSeq)` means re-running fan-out never double-enqueues.
 *  - A background drainer claims due rows (`pending` + `nextAttemptAt <= now`),
 *    POSTs them, and reschedules with backoff or marks them `dead`.
 */
import Database from "better-sqlite3";

export interface WebhookSubscription {
  id: string;
  /** Absolute https URL (http only allowed for private hosts in dev). */
  url: string;
  /** Raw HMAC-SHA256 secret used to sign deliveries. Redacted from API reads. */
  secret: string;
  /** Audit event types to deliver, or `null` for ALL types. */
  eventTypes: string[] | null;
  active: boolean;
  createdAt: string;
}

export type WebhookDeliveryStatus = "pending" | "delivered" | "dead";

export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  envelopeId: string;
  /** The audit event id this delivery carries (idempotency key component). */
  eventId: string;
  /** The audit event's per-envelope sequence (drives the high-water-mark). */
  eventSeq: number;
  eventType: string;
  /** Canonical JSON body — exactly the bytes signed + POSTed. */
  payload: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  /** ISO time this row becomes eligible for (re)delivery. */
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
}

export interface WebhookStore {
  // ── subscriptions ──
  createSubscription(sub: WebhookSubscription): Promise<void>;
  listSubscriptions(): Promise<WebhookSubscription[]>;
  getSubscription(id: string): Promise<WebhookSubscription | null>;
  /** Returns true if a row was removed. */
  deleteSubscription(id: string): Promise<boolean>;

  // ── delivery outbox ──
  /** Highest audit `eventSeq` already enqueued for this (subscription, envelope),
   *  or -1 if none. The fan-out high-water-mark. */
  maxEnqueuedSeq(subscriptionId: string, envelopeId: string): Promise<number>;
  /** Insert a delivery; a duplicate (subscription, envelope, eventId) is ignored. */
  enqueueDelivery(delivery: WebhookDelivery): Promise<void>;
  /**
   * Atomically claim up to `limit` `pending` deliveries whose `nextAttemptAt <=
   * now`. When `leaseMs > 0`, each claimed row's `nextAttemptAt` is bumped forward
   * by `leaseMs` in the SAME atomic step, so a concurrent drain cannot re-claim it
   * (a crashed drain's rows re-appear once the lease lapses — at-least-once). The
   * returned rows carry their PRE-lease state.
   */
  claimDue(now: string, limit: number, leaseMs?: number): Promise<WebhookDelivery[]>;
  updateDelivery(delivery: WebhookDelivery): Promise<void>;
  /** Inspection (tests/debugging), newest first. */
  listDeliveries(params?: { subscriptionId?: string; limit?: number }): Promise<WebhookDelivery[]>;
}

// ── In-memory ─────────────────────────────────────────────────────────────────

export class InMemoryWebhookStore implements WebhookStore {
  private readonly subs = new Map<string, WebhookSubscription>();
  private readonly deliveries: WebhookDelivery[] = [];
  private readonly seen = new Set<string>(); // `${sub}|${env}|${eventId}` dedup

  async createSubscription(sub: WebhookSubscription): Promise<void> {
    this.subs.set(sub.id, { ...sub, eventTypes: sub.eventTypes ? [...sub.eventTypes] : null });
  }
  async listSubscriptions(): Promise<WebhookSubscription[]> {
    return [...this.subs.values()].map((s) => ({ ...s, eventTypes: s.eventTypes ? [...s.eventTypes] : null }));
  }
  async getSubscription(id: string): Promise<WebhookSubscription | null> {
    const s = this.subs.get(id);
    return s ? { ...s, eventTypes: s.eventTypes ? [...s.eventTypes] : null } : null;
  }
  async deleteSubscription(id: string): Promise<boolean> {
    return this.subs.delete(id);
  }

  async maxEnqueuedSeq(subscriptionId: string, envelopeId: string): Promise<number> {
    let max = -1;
    for (const d of this.deliveries) {
      if (d.subscriptionId === subscriptionId && d.envelopeId === envelopeId && d.eventSeq > max) {
        max = d.eventSeq;
      }
    }
    return max;
  }
  async enqueueDelivery(delivery: WebhookDelivery): Promise<void> {
    const key = `${delivery.subscriptionId}|${delivery.envelopeId}|${delivery.eventId}`;
    if (this.seen.has(key)) return; // idempotent
    this.seen.add(key);
    this.deliveries.push({ ...delivery });
  }
  async claimDue(now: string, limit: number, leaseMs = 0): Promise<WebhookDelivery[]> {
    const nowMs = new Date(now).getTime();
    const dueRows = this.deliveries
      .filter((d) => d.status === "pending" && new Date(d.nextAttemptAt).getTime() <= nowMs)
      .slice(0, limit);
    const claimed = dueRows.map((d) => ({ ...d })); // snapshot BEFORE leasing
    if (leaseMs > 0) {
      const leaseAt = new Date(nowMs + leaseMs).toISOString();
      for (const d of dueRows) d.nextAttemptAt = leaseAt; // hide from concurrent claims
    }
    return claimed;
  }
  async updateDelivery(delivery: WebhookDelivery): Promise<void> {
    const i = this.deliveries.findIndex((d) => d.id === delivery.id);
    if (i >= 0) this.deliveries[i] = { ...delivery };
  }
  async listDeliveries(params?: { subscriptionId?: string; limit?: number }): Promise<WebhookDelivery[]> {
    let rows = [...this.deliveries].reverse();
    if (params?.subscriptionId) rows = rows.filter((d) => d.subscriptionId === params.subscriptionId);
    if (params?.limit !== undefined) rows = rows.slice(0, params.limit);
    return rows.map((d) => ({ ...d }));
  }
}

// ── SQLite ──────────────────────────────────────────────────────────────────

export class SqliteWebhookStore implements WebhookStore {
  private readonly db: Database.Database;

  constructor(filename = ":memory:") {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        id          TEXT PRIMARY KEY,
        url         TEXT NOT NULL,
        secret      TEXT NOT NULL,
        event_types TEXT,               -- JSON array, or NULL = all
        active      INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id              TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        envelope_id     TEXT NOT NULL,
        event_id        TEXT NOT NULL,
        event_seq       INTEGER NOT NULL,
        event_type      TEXT NOT NULL,
        payload         TEXT NOT NULL,
        status          TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error      TEXT,
        created_at      TEXT NOT NULL,
        UNIQUE (subscription_id, envelope_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_wh_due ON webhook_deliveries(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_wh_hwm ON webhook_deliveries(subscription_id, envelope_id, event_seq);
    `);
  }

  private rowToSub(r: {
    id: string; url: string; secret: string; event_types: string | null; active: number; created_at: string;
  }): WebhookSubscription {
    return {
      id: r.id,
      url: r.url,
      secret: r.secret,
      eventTypes: r.event_types ? (JSON.parse(r.event_types) as string[]) : null,
      active: r.active === 1,
      createdAt: r.created_at,
    };
  }

  async createSubscription(sub: WebhookSubscription): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO webhook_subscriptions (id, url, secret, event_types, active, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(sub.id, sub.url, sub.secret, sub.eventTypes ? JSON.stringify(sub.eventTypes) : null, sub.active ? 1 : 0, sub.createdAt);
  }
  async listSubscriptions(): Promise<WebhookSubscription[]> {
    const rows = this.db.prepare("SELECT * FROM webhook_subscriptions ORDER BY created_at ASC").all() as Parameters<typeof this.rowToSub>[0][];
    return rows.map((r) => this.rowToSub(r));
  }
  async getSubscription(id: string): Promise<WebhookSubscription | null> {
    const r = this.db.prepare("SELECT * FROM webhook_subscriptions WHERE id = ?").get(id) as Parameters<typeof this.rowToSub>[0] | undefined;
    return r ? this.rowToSub(r) : null;
  }
  async deleteSubscription(id: string): Promise<boolean> {
    const info = this.db.prepare("DELETE FROM webhook_subscriptions WHERE id = ?").run(id);
    return info.changes > 0;
  }

  async maxEnqueuedSeq(subscriptionId: string, envelopeId: string): Promise<number> {
    const r = this.db
      .prepare("SELECT COALESCE(MAX(event_seq), -1) AS m FROM webhook_deliveries WHERE subscription_id = ? AND envelope_id = ?")
      .get(subscriptionId, envelopeId) as { m: number };
    return r.m;
  }
  async enqueueDelivery(d: WebhookDelivery): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO webhook_deliveries
         (id, subscription_id, envelope_id, event_id, event_seq, event_type, payload, status, attempts, next_attempt_at, last_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(d.id, d.subscriptionId, d.envelopeId, d.eventId, d.eventSeq, d.eventType, d.payload, d.status, d.attempts, d.nextAttemptAt, d.lastError, d.createdAt);
  }
  async claimDue(now: string, limit: number, leaseMs = 0): Promise<WebhookDelivery[]> {
    // SELECT + lease-bump in ONE synchronous transaction so a concurrent drain
    // (another process on the same WAL file) cannot claim the same rows.
    const claim = this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT ?")
        .all(now, limit) as WebhookDeliveryRow[];
      if (leaseMs > 0 && rows.length > 0) {
        const leaseAt = new Date(new Date(now).getTime() + leaseMs).toISOString();
        const upd = this.db.prepare("UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ?");
        for (const r of rows) upd.run(leaseAt, r.id);
      }
      return rows;
    });
    return claim().map(rowToDelivery);
  }
  async updateDelivery(d: WebhookDelivery): Promise<void> {
    this.db
      .prepare("UPDATE webhook_deliveries SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?")
      .run(d.status, d.attempts, d.nextAttemptAt, d.lastError, d.id);
  }
  async listDeliveries(params?: { subscriptionId?: string; limit?: number }): Promise<WebhookDelivery[]> {
    const limit = params?.limit ?? 100;
    const rows = params?.subscriptionId
      ? (this.db.prepare("SELECT * FROM webhook_deliveries WHERE subscription_id = ? ORDER BY created_at DESC LIMIT ?").all(params.subscriptionId, limit) as WebhookDeliveryRow[])
      : (this.db.prepare("SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?").all(limit) as WebhookDeliveryRow[]);
    return rows.map(rowToDelivery);
  }

  close(): void {
    this.db.close();
  }
}

interface WebhookDeliveryRow {
  id: string; subscription_id: string; envelope_id: string; event_id: string; event_seq: number;
  event_type: string; payload: string; status: string; attempts: number; next_attempt_at: string;
  last_error: string | null; created_at: string;
}

function rowToDelivery(r: WebhookDeliveryRow): WebhookDelivery {
  return {
    id: r.id,
    subscriptionId: r.subscription_id,
    envelopeId: r.envelope_id,
    eventId: r.event_id,
    eventSeq: r.event_seq,
    eventType: r.event_type,
    payload: r.payload,
    status: r.status as WebhookDeliveryStatus,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    createdAt: r.created_at,
  };
}
