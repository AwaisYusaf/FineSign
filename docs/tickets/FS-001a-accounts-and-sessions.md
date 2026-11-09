# FS-001a — User accounts and sessions (server)

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P0 | L | M7 Accounts & access | FS-018 | X.8; PRD §2 | Approved · adversarial review required |

## Problem
The management API has exactly one credential, the shared
`FINESIGN_SENDER_API_KEY`: no users, no per-person revocation, no expiry, no
sign-out that revokes anything (the console's "Change API key" only forgets the
key client-side). Nothing downstream — ownership, attribution, per-user tokens —
can exist without users.

## Goal
The server has users with salted, slow password hashes and short-lived,
HTTP-only cookie sessions, with CSRF and login-abuse protection; the legacy key
keeps working for machines until FS-003 retires it.

**Out of scope:** the web sign-in and upgrade UX (FS-001b), ownership (FS-002),
tokens (FS-003), invitations/reset (FS-004a/b), SSO (D2), 2FA (D11).

## Design
- **User** (outside the envelope aggregate): `id`, `email` (unique, case-folded
  with NFKC + lower-case in JS), `name`, `role` (`admin` | `sender`),
  `passwordHash`, `createdAt`, `disabledAt`, `lastLoginAt`.
- **Passwords:** scrypt via `node:crypto`, N=2^15, r=8, p=1, 16-byte salt,
  **`maxmem` 64 MiB set explicitly** (Node's default throws for these
  parameters — verified), stored as `scrypt$N$r$p$salt$hash`, constant-time
  compare, parameters upgradeable on login. Policy per NIST 800-63B: 12–256
  characters. A **semaphore caps concurrent scrypt operations** (default 2) so a
  login flood can't starve libuv's thread pool (shared with file I/O).
- **Sessions:** 32 random bytes in cookie `fs_session` (`HttpOnly`,
  `SameSite=Lax`, `Path=/`, `Secure` derived from the scheme of
  `FINESIGN_BASE_URL`; on plain http the server boots with a loud warning instead
  of silently looping logins). Stored only as SHA-256 with `expiresAt` (absolute,
  default 7 days) and `idleExpiresAt` (default 12 hours; the slide is written at
  most once every 5 minutes). Fresh token at every login (no fixation). The
  user's role and `disabledAt` are **read from the user row on every request**,
  so demotion and disabling take effect immediately.
- **CSRF:** any cookie-authenticated request other than GET/HEAD must carry an
  `Origin` header (or, if absent, `Sec-Fetch-Site: same-origin`) matching
  `FINESIGN_PUBLIC_ORIGINS` (comma-separated; default: the origin of
  `FINESIGN_BASE_URL`; validated at boot). Missing or foreign → 403. A request
  with an `Authorization` header is authenticated by that header only and any
  cookie on it is ignored.
- **Login abuse (D10 default: throttle, not hard lock):** a sliding-window
  throttle keyed on the normalized email **whether or not the account exists**,
  plus one keyed on (IP, email), with progressive delay (1 s, 2 s, 4 s … capped at
  30 s) and a dedicated rate limit on the login route. Same 401 body and similar
  timing for unknown emails (a dummy scrypt verify). No state reveals which
  emails exist, and nobody can lock an admin out indefinitely. A successful
  password reset (FS-004b) or `npm run admin -- unlock --email` clears it.
- **Public route allowlist:** the auth guard currently covers everything under
  `/api/*`; `login`, `logout`, `me`, `setup-status` and FS-004's public routes are
  explicitly allowlisted, with a route-table test that fails if a new public route
  is added without being listed.
- **Bootstrap (no secrets in logs):** if no users exist and
  `FINESIGN_BOOTSTRAP_ADMIN_EMAIL` + `_PASSWORD` are set, that admin is created at
  boot (warning to remove the variables afterwards). CLI `npm run admin --
  create-user --admin --email …` prompts for the password. The boot-time API-key
  requirement (`index.ts`) moves after the store opens: the key is required only
  while no user exists and no bootstrap env is set.
- **Principal:** every handler receives `{ userId, role, via: "session" |
  "api-key" }`; the legacy key maps to a synthetic admin.
- **Stores:** `UserRepository`, `SessionRepository` — in-memory + SQLite (+
  Postgres per D7), shared contract tests, FS-018 migrations.
- ADR-0004 "Local accounts and cookie sessions".

## API and data changes
- `POST /api/auth/login` `{ email, password }` → 200 `{ user }` + cookie; 401
  generic; 429 when throttled (same for unknown emails).
- `POST /api/auth/logout` → 204; `GET /api/auth/me` → `{ user }` | 401;
  `GET /api/auth/setup-status` → `{ hasUsers, legacyKeyEnabled }` (no secrets).
- Env: `FINESIGN_BOOTSTRAP_ADMIN_EMAIL`, `FINESIGN_BOOTSTRAP_ADMIN_PASSWORD`,
  `FINESIGN_PUBLIC_ORIGINS`, `FINESIGN_SESSION_IDLE_HOURS`,
  `FINESIGN_SESSION_MAX_DAYS`, `FINESIGN_SCRYPT_CONCURRENCY`.
- Tables `users`, `sessions` (FS-018 migrations).

## Acceptance criteria
1. Bootstrap env on an empty store creates the admin once; reboots don't
   duplicate or overwrite it.
2. Correct credentials set a cookie with `HttpOnly`, `SameSite=Lax` and `Secure`
   (https base URL) and `/api/auth/me` returns the user.
3. Wrong password and unknown email return byte-identical 401 bodies; after
   repeated failures both are throttled identically (429), so throttling reveals
   nothing; the right password works again once the window passes.
4. A session stops working after logout, after the idle timeout, after the
   absolute timeout, and immediately after the user is disabled; a demoted
   admin loses admin routes on the next request.
5. Cookie-authenticated POST, PATCH and DELETE requests with a foreign `Origin`,
   or with no `Origin` and no `Sec-Fetch-Site: same-origin`, get 403; a request
   with a bearer header and a stray cookie is judged by the header only.
6. The route-table test lists every unauthenticated `/api` route; adding one
   without listing it fails the test.
7. Only hashes of sessions and passwords are stored; no password, session token
   or hash appears in any log line or response (suite-wide capturing-logger
   check).
8. The legacy API key still authorizes every `/api/*` route; the server boots
   without it when a user exists.
9. 20 concurrent logins never run more than the configured number of scrypt
   operations at once.

## Test plan
- `shared`: scrypt hash/verify with explicit `maxmem`, policy, upgrade detection.
- `storage`: user + session contracts (unique folded email, expiry, delete).
- `server`: one integration test per criterion (FixedClock for windows).

## Security and risks
Auth is the riskiest change in the plan: adversarial review against the diff
before Done. Plain-http deployments get a warning, not a silent downgrade.

## Docs to update
ADR-0004; SECURITY.md; `.env.example`; AGENTS.md (request path, principal);
CHANGELOG; BACKLOG (X.8).
