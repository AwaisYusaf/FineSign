# FS-002 — Envelope ownership and per-user visibility

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P0 | M | M7 Accounts & access | FS-001a, FS-018 | X.8; decisions D5, D6, D14 | Approved · adversarial review required (IDOR) |

## Problem
Every authenticated caller can read, send, void and download every envelope. The
sender's name and email are free text typed into each draft, so the audit trail
records what someone typed, not who acted.

## Goal
Each envelope belongs to the user who created it. Senders see and act on only
their own; admins see all. The sender identity on an envelope comes from the
account, and audit events name the acting user.

**Out of scope:** sharing an envelope with another sender, teams/folders (D5
default: senders see only their own); reassigning ownership (FS-004a).

## Design
- `Envelope.ownerId: string | null` (null = created before accounts; visible to
  admins only). `createEnvelope` takes the owner and copies the account's name
  and email into `senderName`/`senderEmail` (a snapshot: a later rename does not
  rewrite history).
- One authorization helper in `app.ts`, `loadOwned(principal, id)`: admins pass;
  senders get **404** (not 403) for an envelope they don't own, so ids can't be
  probed. Every `/api/envelopes/:id…` route, the downloads, verify, certificate
  and dev-links go through it. `list` filters by `ownerId` for senders.
- Audit actor for sender actions becomes `user:<id>` with the email in the event
  data (today: `"sender"`). Signer and system actors are unchanged. Webhook
  payloads carry no `actor` field (`webhooks.ts`), so what changes for
  integrators is the event `data` (now including the acting user's email) — and
  this is the first breaking payload change, so payloads gain
  `"schemaVersion": 1` here (D14 default) and the CHANGELOG lists the change.
- Webhooks (subscriptions see every envelope's events) and the expiry sweep
  become **admin-only** routes (D6 default; per-user webhooks are a follow-up).
- All envelope routes run under the same owner check, including draft
  operations wrapped in `retryOnConflict` (FS-006/FS-007).
- Storage: `owner_id` column + index in SQLite/Postgres (migration adds it as
  NULL); `list({ ownerId })`; contract tests.
- Web: the wizard's "Your name / Your email" inputs go; the details step shows
  "Sending as Jane Q. Public <jane@example.com>". Webhooks nav item shows for
  admins only.

## API and data changes
- `POST /api/envelopes` ignores `senderName`/`senderEmail` from a session
  principal (still accepted from the legacy API key, until FS-003 retires it).
- `Envelope.ownerId` in responses. Audit `actor` format change; webhook payload
  `schemaVersion` + `data` change (documented for consumers).
- FS-018 migration adds `owner_id` (+ index).

## Acceptance criteria
1. User A cannot list, read, modify, send, void, remind, download, verify or get
   dev links for user B's envelope — each returns 404 — while an admin can.
2. A sender's dashboard lists only their envelopes; an admin's lists all.
3. An envelope created by a signed-in user carries their id, name and email,
   whatever the request body says.
4. Audit events for sender actions record `user:<id>`.
5. Webhook routes return 403 for a sender.
6. Existing envelopes (no owner) still load for admins after the migration.

## Test plan
- `domain`: createEnvelope snapshots identity; actor format.
- `storage`: contract — owner filter, migration of a pre-existing database.
- `server`: a table-driven test over every envelope route × {owner, other
  sender, admin} asserting 200/404 — new routes must be added to the table.
- `e2e`: two senders in two browser contexts; neither sees the other's draft.

## Security and risks
IDOR is the main risk: the route table test fails if a route skips
`loadOwned`. Adversarial review required.

## Docs to update
SECURITY.md (management API row), CHANGELOG (actor format, webhook admin-only),
API notes in README, BACKLOG.
