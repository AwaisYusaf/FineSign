/**
 * Append-only, hash-chained audit log (ARCHITECTURE: tamper-evidence). Each
 * event's `hash` folds in the previous event's hash, so altering any past event
 * invalidates every later hash. Pure — the hash uses Node's `crypto` only.
 */

import { sha256Hex } from "@finesign/shared";
import type { AuditEvent, AuditEventType } from "./types";

/**
 * Deterministic JSON: object keys sorted recursively, so the same logical
 * payload always hashes identically regardless of key insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** The full event identity that is bound into the chain — includes `id` so a
 *  tamper that rewrites event ids is detected (id was previously outside the
 *  chain). */
function hashEvent(
  prevHash: string,
  core: Pick<AuditEvent, "id" | "seq" | "type" | "at" | "actor" | "data">
): string {
  return sha256Hex(prevHash, canonicalJson(core));
}

/**
 * Append an event to an audit log, returning a NEW array (the input is not
 * mutated). Computes `seq`, `prevHash`, and `hash` from the existing tail.
 */
export function appendAuditEvent(
  log: readonly AuditEvent[],
  params: {
    id: string;
    type: AuditEventType;
    at: string;
    actor: string;
    data?: Record<string, unknown>;
  }
): AuditEvent[] {
  const prev = log[log.length - 1];
  const prevHash = prev ? prev.hash : "";
  const seq = prev ? prev.seq + 1 : 0;
  const core = {
    id: params.id,
    seq,
    type: params.type,
    at: params.at,
    actor: params.actor,
    data: params.data ?? {},
  };
  const event: AuditEvent = {
    ...core,
    prevHash,
    hash: hashEvent(prevHash, core),
  };
  return [...log, event];
}

/**
 * Verify a log's integrity: seq is 0..n-1 contiguous, each `prevHash` links to
 * the prior event, and each `hash` recomputes. Returns the first broken index,
 * or -1 if the whole chain is valid.
 */
export function verifyAuditChain(log: readonly AuditEvent[]): number {
  let prevHash = "";
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.seq !== i) return i;
    if (e.prevHash !== prevHash) return i;
    const expected = hashEvent(prevHash, {
      id: e.id,
      seq: e.seq,
      type: e.type,
      at: e.at,
      actor: e.actor,
      data: e.data,
    });
    if (e.hash !== expected) return i;
    prevHash = e.hash;
  }
  return -1;
}
