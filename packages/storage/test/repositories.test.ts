import { test } from "node:test";
import assert from "node:assert/strict";
import { newDb } from "pg-mem";
import {
  InMemoryEnvelopeRepository,
  SqliteEnvelopeRepository,
  PostgresEnvelopeRepository,
  runEnvelopeRepositoryContract,
  InMemoryWebhookStore,
  SqliteWebhookStore,
  runWebhookStoreContract,
  type PgQueryable,
} from "../src/index";

test("InMemoryEnvelopeRepository satisfies the repository contract", async () => {
  await runEnvelopeRepositoryContract(() => new InMemoryEnvelopeRepository());
});

test("SqliteEnvelopeRepository satisfies the repository contract", async () => {
  await runEnvelopeRepositoryContract(() => new SqliteEnvelopeRepository(":memory:"));
});

test("InMemoryWebhookStore satisfies the webhook-store contract", async () => {
  await runWebhookStoreContract(() => new InMemoryWebhookStore());
});

test("SqliteWebhookStore satisfies the webhook-store contract", async () => {
  await runWebhookStoreContract(() => new SqliteWebhookStore(":memory:"));
});

test("PostgresEnvelopeRepository satisfies the repository contract (pg-mem)", async () => {
  await runEnvelopeRepositoryContract(() => {
    // Each factory call gets an independent in-memory Postgres.
    const db = newDb();
    const pg = db.adapters.createPg();
    const pool = new pg.Pool() as unknown as PgQueryable;
    return new PostgresEnvelopeRepository(pool);
  });
});

test("SqliteEnvelopeRepository persists across reopen of the same file", async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "finesign-sqlite-"));
  const file = path.join(dir, "db.sqlite");
  try {
    const a = new SqliteEnvelopeRepository(file);
    await a.create({
      id: "persist", title: "T", status: "draft", routingType: "sequential",
      senderName: "S", senderEmail: "s@x.test", createdAt: "2026-07-10T00:00:00.000Z",
      sentAt: null, completedAt: null, voidedReason: null, expiresAt: null,
      documents: [], recipients: [], fields: [], audit: [], version: 0,
    });
    a.close();
    const b = new SqliteEnvelopeRepository(file);
    const loaded = await b.findById("persist");
    assert.equal(loaded!.title, "T");
    b.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
