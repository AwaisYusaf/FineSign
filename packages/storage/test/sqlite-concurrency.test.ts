/**
 * SQLite optimistic concurrency across connections.
 *
 * Regression: `save` read the version, then wrote, as two separate statements.
 * In one process better-sqlite3 is synchronous, so that looked atomic — but two
 * processes (or worker threads) on the same database file could interleave
 * between the read and the write, and one update was silently overwritten with
 * no VERSION_CONFLICT (718 of 999 saves lost in a two-thread run). The check and
 * the write now share one immediate transaction.
 *
 * The workers load the BUILT adapter (dist/), like every cross-package import in
 * these tests, so run `npx tsc -b` first (the gate does).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { Envelope } from "@finesign/domain";
import { SqliteEnvelopeRepository } from "../src/index";

/** Runs in each worker: load → modify → save, `cycles` times, on its own connection. */
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { SqliteEnvelopeRepository } = require(workerData.adapter);
(async () => {
  const repo = new SqliteEnvelopeRepository(workerData.file);
  let saved = 0, conflicts = 0;
  for (let i = 0; i < workerData.cycles; i++) {
    const env = await repo.findById("env-1");
    try {
      await repo.save({ ...env, title: "worker " + workerData.id + " / " + i });
      saved++;
    } catch (e) {
      if (e.code !== "VERSION_CONFLICT") throw e;
      conflicts++;
    }
  }
  repo.close();
  parentPort.postMessage({ saved, conflicts });
})();
`;

function runWorker(data: Record<string, unknown>): Promise<{ saved: number; conflicts: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { eval: true, workerData: data });
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

test("two connections racing on one SQLite file never silently lose an update", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finesign-cas-"));
  const file = path.join(dir, "cas.sqlite");
  const repo = new SqliteEnvelopeRepository(file);
  const envelope: Envelope = {
    id: "env-1",
    title: "t",
    status: "draft",
    routingType: "parallel",
    senderName: "Jane Q. Public",
    senderEmail: "jane@example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    sentAt: null,
    completedAt: null,
    expiresAt: null,
    voidedReason: null,
    documents: [],
    recipients: [],
    fields: [],
    audit: [],
    version: 0,
  } as unknown as Envelope;
  await repo.create(envelope);

  const adapter = path.resolve(__dirname, "../dist/index.js");
  const cycles = 500;
  try {
    const results = await Promise.all([1, 2].map((id) => runWorker({ adapter, file, id, cycles })));
    const saved = results.reduce((n, r) => n + r.saved, 0);
    const conflicts = results.reduce((n, r) => n + r.conflicts, 0);
    const final = await repo.findById("env-1");

    assert.equal(saved + conflicts, 2 * cycles, "every attempt either saved or reported a conflict");
    assert.equal(final!.version, saved, "each successful save advanced the version exactly once: none were lost");
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
