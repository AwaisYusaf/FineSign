# FS-004b — Change and reset passwords

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | M | M7 Accounts & access | FS-004a (one-time tokens), FS-010 | X.8 | Approved · adversarial review required |

## Problem
Users cannot change their password, and someone who forgets it has no way back
in except an admin running the CLI on the server.

## Goal
Users change their own password; anyone can reset a forgotten password by email
without revealing which accounts exist; admins can issue a reset link for
installs without email.

**Out of scope:** 2FA (D11), password expiry rules (NIST advises against).

## Design
- **Change:** `POST /api/auth/password` `{ current, next }` (session-only), then
  all of the user's other sessions are revoked.
- **Forgot:** `POST /api/auth/forgot` `{ email }` always returns 202 with the same
  body. The lookup, token creation and email happen **off the request path**
  (queued in-process), so response timing doesn't reveal whether the account
  exists. Rate-limited per IP and per normalized email.
- **Reset:** one-time token (purpose `reset`, 1 hour) → `/reset/:token` → new
  password → all sessions revoked, login throttle cleared (FS-001a).
- **Admin-issued reset:** `POST /api/users/:id/reset-link` (admin, session-only)
  shows a copy-once link — for installs without SMTP. Under
  `FINESIGN_DEV_EXPOSE_TOKENS`, emailed links are also visible to the e2e suite.
- Activity log entries for changes, reset requests (email only) and completions.

## API and data changes
`POST /api/auth/password`, `POST /api/auth/forgot`, `POST /api/auth/reset`
(public, allowlisted), `POST /api/users/:id/reset-link`.

## Acceptance criteria
1. Changing the password requires the current one and signs out the user's other
   sessions, not the current one.
2. Forgot-password returns the same status, body and (within noise) timing for
   known and unknown emails; only known emails produce a link.
3. A reset link works once, expires after an hour, revokes all sessions and
   clears the login throttle.
4. An admin-issued link works the same way and is shown only once.
5. In the browser: forgot → follow the link → set a new password → sign in.

## Test plan
- `server`: criteria 1–4 (CapturingMailer, FixedClock; timing check asserts the
  request does not await the mail path).
- `e2e`: criterion 5 via the dev-exposed link.

## Security and risks
Enumeration (constant response, off-path work), token theft (hash-only,
one-time, 1 h), session persistence after reset (revoked).

## Docs to update
SECURITY.md, README, CHANGELOG.
