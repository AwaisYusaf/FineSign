# FS-003 — Personal API tokens; retire the shared key

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P0 | M | M7 Accounts & access | FS-001a, FS-002 | X.8; PRD §2 (developers) | Approved · adversarial review required |

## Problem
Integrations call the API with the shared admin key, so every integration has
admin rights over every envelope, and rotating the key breaks all of them at
once. After FS-001a/FS-002 it is also the one credential that bypasses
ownership.

## Goal
Each user can create named API tokens that act as that user for envelope work,
see when each was last used, and revoke them; admins can see and revoke anyone's
tokens. The shared key is deprecated, then removed (D12).

**Out of scope:** fine-grained scopes (read-only tokens) — follow-up if asked;
OAuth clients.

## Design
- Format `fs_` + 32 random bytes (base64url); shown **once**; stored as SHA-256
  (looked up by hash — the hash is the index, so no timing concern) with `id`,
  `userId`, `name`, `createdAt`, `expiresAt?`, `lastUsedAt` (written at most once
  a minute), `revokedAt`.
- `Authorization: Bearer fs_…` → the owner's principal (`via: "token"`), role and
  `disabledAt` read from the user row per request.
- **Tokens cannot manage credentials or users.** `/api/tokens*`, `/api/users*`,
  `/api/auth/password` and the activity log are **session-only**: a token gets
  403 there. A leaked token therefore cannot mint successors that outlive its
  revocation, invite admins, or change the password.
- Admins: `GET /api/admin/tokens` (all users' token metadata) and revoke any.
- **CLI for headless setups:** `npm run admin -- create-token --email … --name …`
  prints a token once (for CI and the Docker smoke test, which can't use a
  browser session).
- **Legacy key (D12 default):** still accepted with a boot warning until the
  first tagged release after M7, then removed; the CHANGELOG states the exact
  release. The e2e harness, Docker CI and examples move to bootstrap admin +
  CLI token in this ticket.
- Web: Account → "API tokens" (list, create with one-time reveal + copy, revoke);
  Admin → tokens of all users.
- Store: `ApiTokenRepository` (in-memory + SQLite, + Postgres per D7).

## API and data changes
`GET/POST /api/tokens`, `DELETE /api/tokens/:id`, `GET /api/admin/tokens`,
`DELETE /api/admin/tokens/:id`; table `api_tokens`; OpenAPI bearer scheme.

## Acceptance criteria
1. A sender's token sees only that sender's envelopes; an admin's sees all.
2. The plaintext token appears in exactly one response; only its hash is stored;
   it never appears in logs.
3. Revoked, expired, or disabled-owner tokens get 401.
4. A token (even an admin's) gets 403 on token, user, password and activity
   routes.
5. An admin can list and revoke another user's token; a sender cannot.
6. The CLI prints a working token for an existing user.
7. With the legacy key set, the server boots with a deprecation warning and the
   key works; the e2e and Docker CI jobs no longer use it.
8. In the browser: create, copy, list (no secret shown), revoke, and a request
   with the revoked token fails.

## Test plan
- `storage`: token contract.
- `server`: criteria 1–7 (FixedClock for expiry and the lastUsed throttle).
- `e2e`: criterion 8; harness migration.

## Security and risks
Bearer secrets: one-time reveal, hash-only storage, never logged, cannot
self-replicate (criterion 4).

## Docs to update
README (API usage), SECURITY.md, `.env.example`, docker docs, e2e README,
CHANGELOG (removal release).
