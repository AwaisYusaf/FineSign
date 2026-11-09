# FS-012 — Approve without adopting a signature

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P2 | S | M10 Signing completeness | Decision D3; before FS-013 and FS-016 (all edit `certificate.ts`) | U.19; PRD §3 (roles) | Approved |

## Problem
An approver with no fields still has to adopt a signature: `POST
/sign/:token/apply` requires one (`parseSignature` in `http.ts`), and the signer
page asks for it. The signature goes nowhere — it is never stamped — so the
approver is asked to "sign" nothing, and the audit records a meaningless image or
typed name. The audit event is `recipient_signed`, the same as a signer's.

## Goal
An approver approves with explicit consent alone (adopting a signature only if
they have signature/initials fields), and the record says "approved".

**Out of scope:** approval comments, "request changes" (a correction workflow,
parity 13).

## Design
- **Domain:** `applySignature` accepts `signature: null` when the recipient is an
  approver with no signature/initials fields (a `ValidationError` otherwise). It
  still requires consent, field values for any text/checkbox fields, and the
  access code. It records a new audit event `recipient_approved` (instead of
  `recipient_signed`) for approvers, signature or not; recipient status stays
  `signed` (the state machine is unchanged; "Approved" is presentation).
- **API:** `signature` becomes optional in the apply body for that case;
  OpenAPI updated.
- **Certificate:** lists approvers as "Approved <timestamp>".
- **Webhooks:** `recipient_approved` added to the event list — a breaking change
  for consumers filtering on `recipient_signed` for approvers, announced in the
  CHANGELOG under the payload `schemaVersion` introduced by FS-002 (D14).
- **Web:** for such an approver the signer page shows no signature card; the
  primary button "Approve" needs consent only.

## API and data changes
Optional `signature`; new event type `recipient_approved`.

## Acceptance criteria
1. An approver with no signature fields approves with consent and no signature;
   the envelope advances or completes as before.
2. An approver who has a signature field must still provide a signature (400
   without one); a signer without a signature still gets 400.
3. The audit trail and certificate show "approved" for approvers.
4. In the browser, a fieldless approver sees no signature step and approves with
   consent alone.

## Test plan
- `domain`: criteria 1–3 at the service level, audit chain valid.
- `server`: apply without signature (approver ok / signer 400); certificate text.
- `e2e`: update the approver test from the review fixes (no signature adoption).

## Security and risks
Consent and access-code requirements are unchanged, so assurance doesn't drop.
Event-type change documented for webhook consumers.

## Docs to update
CHANGELOG (event type), README webhook events, BACKLOG (U.19).
