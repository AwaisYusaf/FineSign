# FS-017 — Bug: a void never reaches webhooks or recipients

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P0 (bug) | S | M6.9 Fix first | — | PRD FR-E5, FR-R1; DG4 webhooks | Done |

## Problem
`EnvelopeApp.voidEnvelope` (`server/src/app.ts`) saves the voided envelope
directly instead of going through `persistThenDeliver`, and the domain's
`voidEnvelope` returns an envelope with no effects. So:
- webhook subscribers never receive `envelope_voided` — and because the envelope
  is terminal, no later save ever catches the outbox up (found by the plan
  review with a probe: deliveries exist up to `recipient_notified`, none for the
  void);
- recipients who were already sent a link are never told the request was
  withdrawn; their link just starts failing.

## Goal
Voiding an envelope fans out to webhooks like every other transition, and
recipients who were notified are told it was withdrawn.

**Out of scope:** a void reason shown on the signer's dead-link page (it already
says "withdrawn").

## Design
- Domain: `voidEnvelope` returns a `DomainResult` with `notify` effects for every
  recipient who has been notified (status `notified` or `viewed`, plus signers
  who signed, so they know the agreement won't complete) with reason `voided`.
  Telling the owner when *someone else* voids their envelope only becomes
  possible with admin voids, so it moved to FS-002.
- Server: `voidEnvelope` uses `persistThenDeliver`, so the webhook outbox is
  filled from the audit trail and mail goes out after the save. Add a `voided`
  case to the email text (and to FS-010's templates).
- Audit: no new event; `envelope_voided` already exists.

## API and data changes
Notification reason `voided`; no route changes.

## Acceptance criteria
1. After send → void, a matching webhook subscription receives an
   `envelope_voided` delivery.
2. Every recipient who had been notified gets one "withdrawn" email; recipients
   never notified (later routing steps, CCs) get none.
3. Voiding a draft sends no email and still fans out to webhooks.
4. Void still runs under `retryOnConflict` and a lost race sends nothing twice.

## Test plan
- `domain`: effects of `voidEnvelope` for sequential, parallel and draft cases.
- `server`: criteria 1–4 — this is the regression test (fails today: no
  delivery for `envelope_voided`).

## Security and risks
The "withdrawn" email must not include a link or the void reason's raw HTML
(plain text today; FS-010 escapes).

## Docs to update
CHANGELOG (Fixed).

## Outcome
Done. Regression tests: `webhooks.test.ts` "a void reaches subscribers",
`concurrency.test.ts` "a void tells each notified recipient once, even when its
save loses a race" and "voiding a draft sends no email", and the domain test
"void moves draft/sent to voided and tells only recipients already in the flow".
The two server regression tests failed before the fix. The sender's void reason
is deliberately left out of recipient emails (it may be internal), matching how
decline reasons are handled.
