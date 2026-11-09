# FS-022 — Correct a pending recipient's name or email after sending

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | M | M8 Authoring & dashboard | — | parity 13 (scoped) | Approved |

## Problem
A typo in a recipient's email is noticed only after sending, when the email
bounces or the person says they never got it. Today the only fix is to void the
envelope and rebuild it from scratch, losing any signatures already collected.
It is the most common real-world support case for e-signature tools.

## Goal
While an envelope is out, the sender can correct the name or email of a
recipient who has not acted yet; the old link stops working and the corrected
address gets a fresh one.

**Out of scope:** changing role, routing order or fields after send; delegation
by the recipient; correcting someone who already signed.

## Design
- Domain: `correctRecipient(env, recipientId, { name?, email? })` — only for
  `sent` envelopes and recipients who have not signed or declined. Re-mints the
  token if it is the recipient's turn (old link dies immediately) and returns a
  `notify` effect to the new address; if not yet their turn, just updates the
  record. Audited `recipient_corrected` with old and new values (the old email is
  evidence of what happened).
- Server: `PATCH /api/envelopes/:id/recipients/:rid/correct` under
  `retryOnConflict` and the owner check (FS-002).
- Web: on the envelope page, a pending recipient's row menu gets "Correct
  details" (dialog with name and email).

## API and data changes
New route; audit event `recipient_corrected` (webhook event list).

## Acceptance criteria
1. Correcting the email of the current signer sends a new link to the new
   address; the old link returns the "replaced by a newer email" state.
2. Correcting a later recipient (not their turn) sends nothing until their turn,
   then sends to the corrected address.
3. Correcting someone who signed or declined, or on a non-`sent` envelope,
   returns 409.
4. The audit trail records old and new values; the certificate shows the final
   address.
5. In the browser: correct a typo on the envelope page and see the new address
   and a fresh dev link.

## Test plan
- `domain`: criteria 1–4 at the service level.
- `server`: route, concurrency (correct racing a sign), owner check.
- `e2e`: criterion 5.

## Security and risks
Account takeover of a signing slot by whoever controls the sender account — same
trust as creating the envelope; audited with old/new values.

## Docs to update
CHANGELOG, README, BACKLOG (parity 13 partially).
