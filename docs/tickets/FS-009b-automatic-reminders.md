# FS-009b — Automatic reminders

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | M | M9 Delivery | FS-009a; Decision D13 | parity 12 follow-on | Approved |

## Problem
Reminders happen only when the sender clicks "Remind". Signers who forget are
never nudged unless the sender notices. And every reminder re-mints the
recipient's token, so the link in the original email stops working each time
(`renotify` in `envelope-service.ts`) — acceptable for a rare manual reminder,
confusing if reminders arrive every few days.

## Goal
An envelope can carry a reminder schedule the server follows on its own, and
reminders don't break links people already have (per D13).

**Out of scope:** per-recipient schedules, quiet hours.

## Design
- `send` accepts `reminders: { firstAfterDays, everyDays, maxCount }`
  (validated: 1–30 days, max 10), stored on the envelope.
- **Anchored to each recipient's turn:** the schedule starts when the recipient
  was first notified (sequential routing staggers it naturally).
- **Domain `remindIfDue(env, recipientId, now)`** re-evaluates everything inside
  the operation — still their turn, not acted, envelope `sent`, not expired, due
  time passed, under `maxCount` — and returns no change otherwise. The ticker
  calls it under `retryOnConflict`, so a retried attempt cannot send twice.
- **Links (D13 default: several active links):** a recipient may hold up to 3
  active token hashes; a reminder adds one (oldest dropped beyond 3), so recent
  emails all work. An explicit "Resend" still revokes every earlier link (its
  purpose is to cut off a forwarded link). Token-index adapters store multiple
  hashes per recipient (FS-018 migration). If D13 picks "single link", reminders
  keep today's re-mint behaviour instead.
- Ticker `FINESIGN_REMINDER_SWEEP_MS` (default 15 min) finds candidates via a
  denormalized `next_reminder_at` and `listReminderDue(now, limit)`.
- Web: review step "Remind automatically" (off by default: every N days, up to M
  times); envelope page shows the schedule and next reminder per pending
  recipient.

## API and data changes
`send` body `reminders`; recipient token hashes become a list (per D13);
system-actor `recipient_reminded`; env var; FS-018 migration.

## Acceptance criteria
1. With `{ firstAfterDays: 2, everyDays: 3, maxCount: 2 }`, a pending signer gets
   reminders at day 2 and day 5 after their turn starts, and none after.
2. In sequential routing, the second signer's schedule starts when the first
   signs, not at send.
3. Nobody is reminded after signing, declining, voiding, expiry or completion.
4. A conflict-retried sweep sends each reminder once; two processes sweeping
   at once send each reminder once.
5. (D13 = several links) The original link and every reminder link work; after
   an explicit Resend only the newest link works.
6. The envelope page shows the schedule and the next reminder time.

## Test plan
- `domain`: `remindIfDue` tables (turns, routing, limits, expiry, statuses).
- `storage`: multiple token hashes per recipient; `listReminderDue` + migration.
- `server`: criteria 1–5 with `FixedClock`; `e2e`: criterion 6.

## Security and risks
More live links per recipient (cap 3, each 256-bit, expiring); explicit resend
still revokes. Mail volume bounded by `maxCount` and FS-024.

## Docs to update
`.env.example`, CHANGELOG, BACKLOG (parity 12), SECURITY.md (signer links row).
