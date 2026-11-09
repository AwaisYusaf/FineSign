# FS-001b — Console sign-in and the upgrade path

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P0 | M | M7 Accounts & access | FS-001a | X.8 | Approved |

## Problem
The console asks for the shared API key and keeps it in `localStorage`, readable
by any script on the origin. Once accounts exist (FS-001a), the console must sign
people in with their own credentials — and an existing install that upgrades
with no users and no bootstrap env must not end up with a console nobody can
enter.

## Goal
The console signs people in with email and password, never stores a credential
in the browser, and guides an upgrading operator to create the first admin.

**Out of scope:** invitations and reset pages (FS-004a/b).

## Design
- **Sign-in page:** email + password, generic error, "throttled — try again in
  N s" message on 429. On success, go to the intended page; the `next` parameter
  only accepts same-origin relative paths (no `//host`, no scheme).
- **Session-aware app:** `AuthProvider` loads `/api/auth/me`; all requests send
  the cookie (`credentials: "same-origin"`, the default behind the proxy); a 401
  from any call returns to sign-in keeping the current path. The account menu
  shows name + email and "Sign out" (calls logout).
- **No credential in the browser:** the API-key gate and `finesign_api_key`
  localStorage entry are removed; on first load after upgrade the stale entry is
  deleted.
- **First run / upgrade:** if `/api/auth/setup-status` says `hasUsers: false`,
  the sign-in page shows "Create the first admin" — a form for email, name,
  password **plus the instance's legacy API key** as proof of ownership
  (`POST /api/auth/claim`, accepted only while no user exists, only with a
  correct key, rate-limited). With no legacy key configured either, the page
  shows the bootstrap-env and CLI instructions instead.
- **e2e fixtures:** sign in through the API (cookie in the browser context)
  instead of seeding `localStorage`; the suite's server gets bootstrap env.

## API and data changes
`POST /api/auth/claim` `{ apiKey, email, name, password }` (public, only while
no users exist).

## Acceptance criteria
1. Sign in, reload (still signed in), sign out (back to sign-in, cookie gone and
   the session rejected server-side).
2. A wrong password shows an error; throttling shows the wait time.
3. After sign-in, no credential is stored in `localStorage` or
   `sessionStorage`; a stale API key entry from before the upgrade is removed.
4. A 401 mid-session returns to sign-in and, after signing in, back to the page.
5. `next=//evil.example` and `next=https://evil.example` are ignored.
6. Upgrading a pre-M7 SQLite database (no users) with only the legacy key set:
   the sign-in page offers "Create the first admin", the claim with the right key
   creates an admin and reaches the dashboard showing the existing envelopes;
   a wrong key is refused; a second claim after a user exists is refused.

## Test plan
- `server`: claim route (criterion 6's API half).
- `e2e`: criteria 1–6 (criterion 6 boots the suite's server on a fixture
  database).
- axe accessibility check on the sign-in and claim pages.

## Security and risks
The claim route is a one-shot privilege grant: only while no users exist, only
with the existing admin secret, rate-limited, recorded in the activity log once
FS-019 lands. Adversarial review together with FS-001a.

## Docs to update
README quick start and upgrade notes, web AGENTS.md (auth), e2e README,
CHANGELOG.
