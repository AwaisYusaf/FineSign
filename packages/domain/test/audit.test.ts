import { test } from "node:test";
import assert from "node:assert/strict";
import { appendAuditEvent, verifyAuditChain } from "../src/audit";
import type { AuditEvent } from "../src/types";

function build(): AuditEvent[] {
  let log: AuditEvent[] = [];
  log = appendAuditEvent(log, { id: "e1", type: "envelope_created", at: "2026-01-01T00:00:00Z", actor: "sender" });
  log = appendAuditEvent(log, { id: "e2", type: "envelope_sent", at: "2026-01-01T00:01:00Z", actor: "sender", data: { n: 2 } });
  log = appendAuditEvent(log, { id: "e3", type: "recipient_signed", at: "2026-01-01T00:02:00Z", actor: "id-1" });
  return log;
}

test("append builds a contiguous, linked, verifiable chain", () => {
  const log = build();
  assert.equal(log.length, 3);
  assert.deepEqual(log.map((e) => e.seq), [0, 1, 2]);
  assert.equal(log[0].prevHash, "");
  assert.equal(log[1].prevHash, log[0].hash);
  assert.equal(log[2].prevHash, log[1].hash);
  assert.equal(verifyAuditChain(log), -1);
});

test("tampering with a past event breaks verification at that index", () => {
  const log = build();
  // Mutate event 1's data without recomputing hashes.
  const tampered = log.map((e, i) => (i === 1 ? { ...e, data: { n: 999 } } : e));
  assert.equal(verifyAuditChain(tampered), 1);
});

test("reordering events is detected", () => {
  const log = build();
  const swapped = [log[0], log[2], log[1]];
  assert.notEqual(verifyAuditChain(swapped), -1);
});

test("hash is independent of key order in data (canonical json)", () => {
  const a = appendAuditEvent([], { id: "x", type: "field_added", at: "t", actor: "s", data: { b: 1, a: 2 } });
  const b = appendAuditEvent([], { id: "x", type: "field_added", at: "t", actor: "s", data: { a: 2, b: 1 } });
  assert.equal(a[0].hash, b[0].hash);
});

test("tampering with an event id is detected (id is bound into the chain)", () => {
  const log = build();
  const tampered = log.map((e, i) => (i === 1 ? { ...e, id: "forged-id" } : e));
  assert.equal(verifyAuditChain(tampered), 1);
});
