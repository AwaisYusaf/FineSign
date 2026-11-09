# FS-019 — Instance activity log

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | M | M7 Accounts & access | FS-001a, FS-018 | PRD FR-A1 (spirit) | Approved |

## Problem
Envelope state changes are audited in each envelope's hash chain, but nothing
records actions that are not envelope transitions: sign-ins and failed sign-ins,
invitations, role changes, disables, API token creation and revocation, webhook
creation and deletion, draft deletion, ownership reassignment. For an
e-signature product an admin must be able to answer "who did that, and when?".

## Goal
Security-relevant instance actions are written to an append-only activity log
that admins can browse and filter.

**Out of scope:** shipping logs to a SIEM (operators can tail the server log;
FS-020), hash-chaining the activity log (FS-015 covers envelope trails).

## Design
- `ActivityLog` port: `append({ at, actor, action, target?, ip?, userAgent?,
  data })` and `list({ before?, action?, actor?, limit })`. Actions are a closed
  union (`auth.signed_in`, `auth.sign_in_failed`, `user.invited`, `user.role_changed`,
  `user.disabled`, `token.created`, `token.revoked`, `webhook.created`,
  `webhook.deleted`, `envelope.deleted`, `envelope.owner_reassigned`, …).
- Written by the server after the action commits (best-effort, logged on
  failure — an activity-log outage must not block sign-in). Never contains
  passwords, tokens or token hashes; failed sign-ins record the normalized email
  only.
- SQLite adapter (+ Postgres per D7) via a FS-018 migration; in-memory for tests.
- Web: Admin → "Activity" page with filters and cursor paging.

## API and data changes
`GET /api/activity` (admin-only); new table.

## Acceptance criteria
1. Each listed action appends exactly one entry with actor, time, IP and target.
2. No entry contains a password, token, token hash or session id.
3. Senders get 403 on `/api/activity`.
4. Entries page newest first with a stable cursor and filter by action and actor.
5. In the browser, an admin sees their own sign-in and a token creation.

## Test plan
- `storage`: activity-log contract.
- `server`: one assertion per action as it is implemented (FS-001a, FS-003,
  FS-004a, FS-007 add their rows); a secrets-free check over all entries.
- `e2e`: criterion 5.

## Security and risks
Log injection (structured fields, escaped in the UI); PII retention (covered by
FS-021).

## Docs to update
SECURITY.md (threat model), README (admin), CHANGELOG.
