# FS-021 — Data retention, erasure and export

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P2 | L | M11 Hardening & operations | Decision D9; FS-007 (delete ports), FS-019 | SECURITY.md residuals | Approved |

## Problem
Nothing is ever deleted. Completed envelopes keep documents and recipient
personal data (names, emails, IP addresses, user agents) forever; there is no
retention policy, no way to honour an erasure request, no legal hold, and no way
to export an envelope with its evidence. Operators subject to GDPR or similar
rules cannot comply.

## Goal
Operators can set a retention period, place envelopes on legal hold, erase an
envelope on request, and export a complete evidence package.

**Out of scope:** per-tenant policies; automatic erasure of audit evidence while
on hold (holds always win).

## Design (assuming D9 recommended default)
- **Export:** `GET /api/envelopes/:id/export` → a zip with the signed PDFs, the
  standalone certificate, the audit trail as JSON (with its verification result)
  and a manifest of SHA-256 hashes.
- **Legal hold:** `PUT/DELETE /api/envelopes/:id/hold` (admin) — a held envelope
  cannot be erased or purged; audited (`envelope_hold_set` / `_released`).
- **Erasure:** `DELETE /api/envelopes/:id/erase` (admin, terminal envelopes
  only, not on hold) deletes blobs and replaces recipient PII in the envelope with
  tombstones (`[erased]`), keeping the audit chain's structure and the envelope
  id so the activity log can refer to it; recorded in the activity log. (The
  audit hashes become unverifiable for erased fields — documented trade-off;
  export first if evidence must be kept.)
- **Retention:** `FINESIGN_RETENTION_DAYS` (off by default): a sweep erases
  terminal envelopes older than N days that are not on hold, in batches, using a
  repository query like `listExpirable`.

## API and data changes
Routes above; `Envelope.legalHold`; new env var; FS-018 migration for an index on
terminal-state age.

## Acceptance criteria
1. Export contains every signed PDF, the certificate, the audit JSON and a
   manifest whose hashes match the files.
2. Erasure removes all blobs and every recipient name, email, IP and user agent
   from the stored envelope; the envelope id and event types remain.
3. Held envelopes cannot be erased or purged (409) until the hold is released.
4. With retention set, the sweep erases only terminal, unheld envelopes older
   than the period, and each erasure is in the activity log.
5. All routes are admin-only (senders 403/404).

## Test plan
- `server`: criteria 1–5 with `FixedClock`; zip contents checked in the test.
- `storage`: retention query contract.

## Security and risks
Irreversible deletion (admin-only, terminal-only, holds, activity log); the
export zip contains PII (served with no-store caching).

## Docs to update
SECURITY.md (residuals, data handling), README (retention and erasure),
`.env.example`, CHANGELOG, ADR (erasure vs audit integrity).
