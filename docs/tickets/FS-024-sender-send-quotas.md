# FS-024 — Send quotas for sender accounts

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P1 (when accounts go beyond trusted staff) | S | M7 Accounts & access | FS-002, FS-003 | NFR-3 | Approved |

## Problem
With sender accounts (M7) any account — or a leaked API token — can make the
server send email to arbitrary addresses by creating and sending envelopes,
reminding and resending. With FS-010 those emails carry the operator's brand.
That turns a FineSign instance into a mail relay for spam or phishing, and gets
the operator's mail domain blocklisted.

## Goal
Each user has per-day limits on envelopes sent and notifications triggered,
configurable by the operator, with clear errors when reached.

**Out of scope:** per-recipient-domain rules, CAPTCHA.

## Design
- Counters per user per UTC day for `envelopes_sent` and `emails_triggered`
  (send, remind, resend, correct), stored with a FS-018 migration; checked before
  the operation (409 `QUOTA_EXCEEDED` with the reset time).
- Defaults generous for staff (e.g. 200 envelopes, 2000 emails per day) via
  `FINESIGN_QUOTA_ENVELOPES_PER_DAY`, `FINESIGN_QUOTA_EMAILS_PER_DAY`; admins
  exempt unless `FINESIGN_QUOTA_ADMINS=true`; 0 = unlimited.
- Hitting a quota is recorded in the activity log (FS-019).
- Web: a clear error toast with the reset time.

## API and data changes
New error code `QUOTA_EXCEEDED`; env vars; new counter table.

## Acceptance criteria
1. A sender at the daily envelope limit gets 409 on the next send, with the reset
   time; the next UTC day it works again.
2. Reminders, resends and corrections count against the email quota.
3. Admins are exempt by default.
4. Each refusal appears once in the activity log.

## Test plan
- `server`: criteria 1–4 with `FixedClock` crossing midnight UTC.

## Security and risks
Counter races (atomic increment in SQL); quotas must be checked inside the same
retried operation as the send.

## Docs to update
`.env.example`, SECURITY.md (hardening checklist), CHANGELOG.
