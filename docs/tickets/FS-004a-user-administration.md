# FS-004a — User administration: invitations, roles, disable, reassign

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P0 | L | M7 Accounts & access | FS-001a, FS-002, FS-003, FS-010 (email templates), FS-019 | X.8; PRD §2 (administrators) | Approved · adversarial review required |

## Problem
After FS-001a/b the only ways to add a user are the bootstrap env, the claim
form and a CLI on the server. An admin cannot add a colleague from the console,
change their role, take access away, or deal with the envelopes of someone who
left.

## Goal
Admins invite users, change roles, disable and re-enable them, and reassign a
departed user's envelopes — from the console, with every action in the activity
log.

**Out of scope:** password change/reset (FS-004b), SSO, self-service sign-up
(deliberately absent on a self-hosted instance), team visibility (D5).

## Design
- **Invitations:** email + role → one-time token (32 bytes, hash stored, 72 h),
  `<base>/invite/<token>`. The admin is shown the link **once** in a copy dialog
  (like a webhook secret) — so invitations work on installs without SMTP — and it
  is also emailed. Accepting sets name + password and signs in. Re-inviting
  rotates the token. An existing email is refused. Under
  `FINESIGN_DEV_EXPOSE_TOKENS` the link is also available to the e2e suite.
- **Roles and disable:** `PATCH /api/users/:id` `{ role?, disabled? }`.
  Disabling deletes sessions and makes tokens fail (per-request check). The
  **last active admin** cannot be disabled or demoted — enforced inside a single
  store transaction (count active admins and update together), so two admins
  demoting each other at once can't leave zero.
- **Reassign ownership:** `POST /api/admin/envelopes/reassign` `{ fromUserId,
  toUserId, envelopeIds? }` moves ownership (all or selected), audited on each
  envelope (`envelope_owner_reassigned`) and in the activity log. In-flight
  envelopes keep their recipients; future sender notifications go to the new
  owner.
- Web: Admin → "Users" (name, email, role, status, last sign-in; invite dialog;
  row menu: change role, disable/enable, re-invite, reassign envelopes);
  `/invite/:token` public page.
- All actions append to the activity log (FS-019).

## API and data changes
`GET /api/users`, `POST /api/users/invite`, `PATCH /api/users/:id`,
`POST /api/users/:id/reinvite`, `POST /api/admin/envelopes/reassign`,
`POST /api/auth/accept-invite` (public, allowlisted); one-time-token table
(`purpose: invite | reset`, shared with FS-004b).

## Acceptance criteria
1. An admin invites a user and sees the link once; the invitee accepts (link from
   the dialog or the email), is signed in with the invited role; the link works
   once and expires after 72 hours.
2. A disabled user is signed out everywhere, cannot sign in, and their tokens
   fail; re-enabling restores sign-in but not old sessions.
3. Two concurrent requests demoting the last two admins leave at least one admin
   (one of them gets 409).
4. Reassigning moves the selected envelopes to the new owner, who can now act on
   them; the previous owner (if still active) can no longer see them; each move is
   audited.
5. Senders and tokens get 403 on every route here.
6. In the browser: invite → accept in a second context → active; disable → the
   invitee is bounced to sign-in; reassign → envelopes appear for the new owner.

## Test plan
- `storage`: one-time-token contract; transactional last-admin guard.
- `server`: criteria 1–5 (CapturingMailer, FixedClock, a concurrency test for 3).
- `e2e`: criterion 6; axe check on the Users page.

## Security and risks
Privilege escalation (admin-only, session-only, last-admin guard), token leakage
(hash-only, one-time, short-lived, shown once). Adversarial review required.

## Docs to update
SECURITY.md, README (managing users), CHANGELOG.
