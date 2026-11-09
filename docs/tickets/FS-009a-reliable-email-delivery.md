# FS-009a — Reliable email delivery (retry, visible status)

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | M | M9 Delivery (recommended early — see board) | FS-018 | R.2; PRD FR-R1 | Approved · adversarial review required (tokens) |

## Problem
Emails are sent best-effort after the save (`notifyBestEffort` in `app.ts`). If
the SMTP server is down, a signer is never told it's their turn and nobody finds
out — the envelope just stalls. There is no record that a send failed.

## Goal
A notification that fails is retried with backoff until it is delivered or
declared failed, the sender can see which, and no signing link is ever stored.

**Out of scope:** automatic reminders (FS-009b), bounce handling from a provider.

## Design
- **Pending notifications live on the aggregate**, so they are saved in the same
  write as the transition that caused them (no crash window, no new store):
  `Envelope.pendingNotifications: { id, target: recipientId | "sender", reason,
  attempts, nextAttemptAt, lastError? }[]`, plus a denormalized
  `next_notify_at` column (min over entries, like `expires_at`) and a
  `listNotifyDue(now, limit)` repository query (FS-018 migration).
- **Token-bearing vs tokenless.** Raw tokens are never stored. The first attempt
  happens inline after the save with the freshly minted token (as today).
  Retrying a token-bearing reason (`your_turn`, `reminder`, `resent`,
  `completed_copy`) re-mints through a new domain op, `renotify(env, entryId)`,
  which covers every reason — including `completed_copy` on a completed envelope
  and for `cc` recipients (today's `renotify` refuses both) — and drops the entry
  if it no longer applies (the recipient already signed, the envelope was
  voided). Tokenless reasons (`declined`, `voided`, `expired`, sender notices)
  are resent as they are.
- **Status writes never break the main operation.** Marking an entry delivered or
  failed is its own load → update → save loop with its own conflict retries,
  run after the main operation returned; a conflict there never re-runs
  `applySignature`. If the status write fails entirely, the entry stays pending
  and the ticker retries (at-least-once delivery; a duplicate email is possible,
  a lost one is not).
- **Ticker:** `FINESIGN_MAIL_RETRY_POLL_MS` (default 60 s) drains due entries
  under `retryOnConflict`; backoff 1 min → 5 → 30 → 2 h → 12 h, then failed: the
  entry is removed and `recipient_notification_failed` is audited.
- **Visible state:** recipients expose `lastNotification { reason, status:
  sent | retrying | failed, at }`; the envelope page shows "Email not delivered —
  retrying" or "failed" next to the existing Resend button.
- `FINESIGN_DEV_EXPOSE_TOKENS` dev links keep working for re-minted links.

## API and data changes
Envelope `pendingNotifications`, recipient `lastNotification`; audit event
`recipient_notification_failed`; env var; FS-018 migration (`next_notify_at`).

## Acceptance criteria
1. With the mailer failing, sending succeeds and the recipient shows "retrying";
   when the mailer recovers, the next drain delivers a link that works and the
   earlier, undelivered link does not.
2. A failed `completed_copy` to a CC and a failed `declined` notice are both
   retried and delivered (the CC with a fresh working link).
3. Retries follow the backoff and end as "failed" with one audit event.
4. No stored row or log line contains a raw token.
5. A conflict while recording delivery status never turns a successful signature
   into an error response.
6. Two server processes draining at once deliver each entry once (lease via the
   version check), and a crash after the save but before the inline attempt still
   delivers on the next drain.

## Test plan
- `domain`: `renotify` for every reason; entry bookkeeping.
- `storage`: `listNotifyDue` contract + migration.
- `server`: criteria 1–6 with a failing `CapturingMailer`, `FixedClock`, a
  simulated conflict on the status save, and a "crash" (skip the inline attempt).

## Security and risks
No secrets at rest (design), duplicate sends bounded (at-least-once), mail
volume bounded by backoff and FS-024 quotas.

## Docs to update
`.env.example`, CHANGELOG, BACKLOG (R.2), SECURITY.md, AGENTS.md (effects).
