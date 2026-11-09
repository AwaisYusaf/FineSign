# FS-015 — Keyed audit chain

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P2 | M | M11 Hardening & operations | FS-018 | R.1; PRD FR-A2 | Approved · adversarial review required (crypto) |

## Problem
The audit trail is an unkeyed SHA-256 chain (`domain/src/audit.ts`). Anyone who
can write to the database can rewrite events and recompute every hash, and
`verifyAuditChain` still passes. A naive fix — a MAC per event — still fails
three ways: an attacker strips the MACs and the events read as "legacy";
deleting trailing events (say `envelope_voided`) leaves a valid prefix; and
because `hashEvent` doesn't cover the envelope id, a valid chain can be
transplanted onto another envelope.

## Goal
Without the server's key, nobody can alter, remove, reorder, truncate or
transplant an envelope's audit events undetected, and operators can verify any
envelope's trail on demand.

**Out of scope:** external anchoring of chain heads (later option); per-tenant
keys; KMS-held keys (port allows it later).

## Design
- **MAC binds the envelope:** `mac = HMAC-SHA256(key, envelopeId ‖ eventHash)`
  with a `macKeyId` per event.
- **MAC'd head:** the aggregate carries `auditHead = { lastSeq, lastHash, status,
  mac }` over `envelopeId ‖ lastSeq ‖ lastHash ‖ status`. Truncation or a status
  rewrite no longer matches the head.
- **Single choke point:** a repository decorator (`AuditSealingRepository`) adds
  MACs to new events and recomputes the head on every `create`/`save`, so none of
  the eight direct `repo.save` paths in `app.ts` can be missed; the domain stays
  pure and unchanged.
- **Legacy attestation:** a one-time migration (FS-018 step, run when a key is
  first configured) attests existing events under the key, recorded with an
  `attestedAt` marker. From then on any event without a MAC is **invalid**, not
  "legacy" (no MAC-stripping downgrade).
- **Keys:** `FINESIGN_AUDIT_KEY` (hex, ≥ 32 bytes) + `FINESIGN_AUDIT_KEY_ID`, and
  `FINESIGN_AUDIT_VERIFY_KEYS` for rotation (same pattern as encryption keys). An
  unknown key id reports "unverifiable", distinct from "tampered".
- **Verify:** `GET /api/envelopes/:id/audit/verify` → `{ status: valid |
  tampered | unverifiable | unkeyed, firstBadSeq?, attestedAt? }`; shown on the
  envelope page next to the seal verdict.
- ADR-0005 records the design and its limit: whoever holds the key can forge.

## API and data changes
Events gain `mac`, `macKeyId`; aggregate gains `auditHead`; verify route; env
vars; FS-018 migration; ADR-0005.

## Acceptance criteria
1. With a key, every new event and the head verify.
2. Editing an event, deleting one, reordering, truncating the tail, or rewriting
   the status in the store — each — makes verification report `tampered` with
   the first bad position.
3. Stripping MACs and recomputing the plain hash chain is reported `tampered`.
4. Copying a valid chain onto another envelope is reported `tampered`.
5. After attestation, pre-existing events verify; rotation keeps old MACs
   verifiable; an unknown key id reports `unverifiable`.
6. No key configured: boot warning, status `unkeyed`, behaviour otherwise
   unchanged.

## Test plan
- `server`/`storage`: criteria 1–6 by tampering through the SQLite store
  directly, then calling the verify route; decorator contract over all adapters.

## Security and risks
Crypto design: adversarial review required. Key loss makes trails unverifiable
(not invalid) — documented with backup guidance (FS-018).

## Docs to update
ADR-0005, SECURITY.md, `.env.example`, CHANGELOG, BACKLOG (R.1).
