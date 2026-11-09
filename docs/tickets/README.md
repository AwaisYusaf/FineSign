# Tickets

Every feature starts here, not in code. The loop:

1. **Problem analysis** — what's missing and why it matters
   ([gap analysis 2026-11](../plan/gap-analysis-2026-11.md)).
2. **Ticket / spec** — one file per ticket from [`TEMPLATE.md`](TEMPLATE.md):
   problem, goal, design, API changes, numbered acceptance criteria, test plan,
   risks, docs.
3. **Review** — an independent reviewer critiques the plan against the code; the
   tickets are revised; the product owner settles the open decisions and approves
   (status `Approved`).
4. **Implement** — one ticket at a time; commits reference the ticket id
   (`feat(server): … (FS-006)`).

A ticket is **Done** when every acceptance criterion has a passing test,
`npm run gate` and `npm run e2e` are green, new pages pass an axe accessibility
check, the docs listed in the ticket are updated, and — where the ticket says
"adversarial review required" — a reviewer has tried to break the diff and every
confirmed finding is fixed with a regression test (FACTORY §5).

Status values: `Proposed` → `Approved` → `In progress` → `Done` (or `Dropped`,
with the reason in the ticket).

## Board

Approved by the product owner on 2026-11-09, with the recommended defaults for
decisions D1–D16. **AR** = adversarial review required before Done.

| ID | Ticket | Pri | Size | Milestone | Depends on | AR | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [FS-017](FS-017-voids-reach-webhooks-and-recipients.md) | Bug: a void never reaches webhooks or recipients | P0 | S | M6.9 Fix first | — | | Done |
| [FS-018](FS-018-schema-migrations.md) | Versioned schema migrations | P0 | M | M6.9 | D7 | | Approved |
| [FS-001a](FS-001a-accounts-and-sessions.md) | User accounts and sessions (server) | P0 | L | M7 Accounts & access | FS-018 | ✔ | Approved |
| [FS-001b](FS-001b-console-sign-in-and-upgrade.md) | Console sign-in and the upgrade path | P0 | M | M7 | FS-001a | ✔ | Approved |
| [FS-002](FS-002-envelope-ownership.md) | Envelope ownership and per-user visibility | P0 | M | M7 | FS-001a, FS-018; D5, D6, D14 | ✔ | Approved |
| [FS-003](FS-003-personal-api-tokens.md) | Personal API tokens; retire the shared key | P0 | M | M7 | FS-001a, FS-002; D12 | ✔ | Approved |
| [FS-019](FS-019-instance-activity-log.md) | Instance activity log | P1 | M | M7 | FS-001a, FS-018 | | Approved |
| [FS-004a](FS-004a-user-administration.md) | User administration: invitations, roles, disable, reassign | P0 | L | M7 | FS-001a, FS-002, FS-003, FS-010, FS-019 | ✔ | Approved |
| [FS-004b](FS-004b-password-change-and-reset.md) | Change and reset passwords | P1 | M | M7 | FS-004a, FS-010 | ✔ | Approved |
| [FS-024](FS-024-sender-send-quotas.md) | Send quotas for sender accounts | P1 | S | M7 | FS-002, FS-003 | | Approved |
| [FS-025](FS-025-slow-hash-access-codes.md) | Slow, salted hashes for access codes | P2 | S | M7 | FS-001a | | Approved |
| [FS-006](FS-006-move-resize-edit-fields.md) | Move, resize and edit placed fields | P1 | M | M8 Authoring & dashboard | — | | Approved |
| [FS-007](FS-007-edit-and-delete-drafts.md) | Edit and delete drafts | P1 | L | M8 | FS-018, FS-019; D8 | ✔ | Approved |
| [FS-022](FS-022-correct-recipient-email-after-send.md) | Correct a pending recipient's details after sending | P1 | M | M8 | — | | Approved |
| [FS-005](FS-005-server-side-search-and-counts.md) | Server-side search, status filters and counts | P1 | M | M8 | FS-002, FS-018 | | Approved |
| [FS-008](FS-008-suggested-fields-from-pdf-forms.md) | Suggest fields from a PDF's form fields | P1 | M | M8 | — | ✔ | Approved |
| [FS-009a](FS-009a-reliable-email-delivery.md) | Reliable email delivery (retry, visible status) | P1 | M | M9 Delivery | FS-018 | ✔ | Approved |
| [FS-010](FS-010-html-email-and-branding.md) | HTML email templates and instance branding | P2 | M | M9 (built before FS-004a) | FS-017 | ✔ | Approved |
| [FS-009b](FS-009b-automatic-reminders.md) | Automatic reminders | P1 | M | M9 | FS-009a; D13 | | Approved |
| [FS-011](FS-011-upload-signature-image.md) | Upload a signature image | P1 | S | M10 Signing completeness | — | ✔ | Approved |
| [FS-012](FS-012-approve-without-signature.md) | Approve without adopting a signature | P2 | S | M10 | D3 | | Approved |
| [FS-013](FS-013-unicode-text-fields-and-certificate.md) | Unicode text in fields and on the certificate | P2 | M | M10 | after FS-012 | | Approved |
| [FS-014a](FS-014a-bounded-pdf-processing.md) | Bound PDF processing | P2* | M | M11 Hardening & operations | — | ✔ | Approved |
| [FS-014b](FS-014b-docx-conversion-sandbox.md) | Sandboxed DOCX conversion | P2 | M | M11 | — | ✔ | Approved |
| [FS-015](FS-015-keyed-audit-chain.md) | Keyed audit chain | P2 | M | M11 | FS-018 | ✔ | Approved |
| [FS-016](FS-016-certificate-hash-of-delivered-file.md) | Certificate hashes that match the delivered files | P3 | S | M11 | after FS-013 | | Approved |
| [FS-020](FS-020-observability.md) | Observability: request logs, readiness, queue health | P2 | M | M11 | FS-009a | | Approved |
| [FS-021](FS-021-retention-erasure-export.md) | Data retention, erasure and export | P2 | L | M11 | FS-007, FS-019; D9 | ✔ | Approved |
| [FS-023](FS-023-postgres-end-to-end.md) | Postgres in production, end to end | P3 / P1 | M | M11 | FS-018; D7 | | Approved |

\* FS-014a becomes an **M7 exit criterion** if accounts will be given to people
outside the operator's trust (any sender can then upload crafted PDFs).

Sizes: **S** ≈ under a day, **M** ≈ 1–3 days, **L** ≈ 3–5 days of focused work.
Totals: 29 tickets — 6 S, 19 M, 4 L.

## Recommended order

1. **Fix first:** FS-017 (a live bug) → FS-018 (every later schema change needs
   it) → FS-009a (silent email failures stall envelopes today; cheap with the
   aggregate design).
2. **M7:** FS-001a → FS-001b → FS-002 → FS-003 → FS-019 → FS-010 → FS-004a →
   FS-004b → FS-024 → FS-025. (FS-010 moves up so invitation and reset emails
   use the templates instead of being written twice.)
3. **M8:** FS-006 → FS-007 → FS-022 → FS-005 → FS-008.
4. **M9:** FS-009b.
5. **M10:** FS-012 → FS-013 (shared `certificate.ts`), FS-011 anytime.
6. **M11:** FS-014a, FS-014b, FS-015, FS-016 (after FS-013), FS-020, FS-021,
   FS-023 (per D7).

**Can run in parallel with M7** (they don't depend on accounts): FS-006, FS-008,
FS-011, FS-013. Not FS-006 and FS-007 together — both rework the draft
operations in `app.ts`.

## Open decisions

Sixteen product decisions (D1–D16) with recommended defaults are listed in the
[gap analysis](../plan/gap-analysis-2026-11.md#decisions-for-the-product-owner).
Tickets are written against the defaults; a different answer changes the ticket
named next to it.
