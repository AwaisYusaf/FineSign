# Gap analysis — what FineSign is missing, and why it matters (2026-11)

Step 1 of the plan → tickets → review → build loop, written before any of the
work it proposes. Sources: `docs/PRD.md`, `docs/DOCUSIGN-PARITY.md`,
`docs/BACKLOG.md`, `SECURITY.md`, and the code at `9df0831` — every gap was
checked against the code. Revised after an independent review (see
[Review outcome](#review-outcome)). Tickets: [`docs/tickets/`](../tickets/README.md).

## Where FineSign stands

The signing core is strong and well tested: draft → send → sign → complete with
sequential and parallel routing, three recipient roles, access codes, text and
checkbox fields, PAdES seals up to B-LTA with RFC 3161 timestamps, a hash-chained
audit trail with a certificate of completion, encryption at rest, webhooks,
expiry, remind/resend, and a rebuilt web UI with a browser test suite. The PRD's
success criteria (§7) are met.

What is missing is mostly what a **team** needs to run it day to day, what a
**sender** needs to fix mistakes, and what an **operator** needs to run it
safely over years. Nine problem areas, most important first.

## 0. A live bug: voids are invisible to integrations and recipients (P0)

`voidEnvelope` saves directly instead of going through `persistThenDeliver`, and
the domain returns no effects for it. Webhook subscribers never receive
`envelope_voided` (the envelope is terminal, so the outbox never catches up), and
notified recipients are never told the request was withdrawn. → **FS-017**.

## 1. One shared admin key is the only identity (P0)

**Today.** Every management call is authorized by one `FINESIGN_SENDER_API_KEY`.
The console stores it in `localStorage`; "Change API key" only forgets it
client-side — nothing is revoked. Whoever has it sees, sends, voids and downloads
every envelope and manages webhooks. Senders type their own name and email into
each draft, and nothing checks it.

**Why it matters.** No per-person access or revocation; no attribution ("sent
by" is free text, weak evidence for a signing platform); a non-expiring master
secret readable by any script on the console's origin; and ownership, per-user
API access, user management and send limits all need a user to hang off. With
many accounts, the server also becomes a potential mail relay (any account can
make it email arbitrary addresses) and crafted uploads stop being "trusted
input". Access codes are stored as unsalted SHA-256, recoverable offline.
→ **FS-001a, FS-001b, FS-002, FS-003, FS-004a, FS-004b, FS-019, FS-024, FS-025**.

## 2. Schema changes have no mechanism (P0, enabler)

The SQL stores patch old databases with ad hoc probes (`migrateExpiresAt`). The
plan adds about five tables and three columns. Without ordered, recorded
migrations, upgrades become guesswork. Separately, only SQLite is actually wired
into the server — the Postgres envelope repository exists but is never
constructed, and the webhook store has no Postgres adapter, though the README
offers Postgres. → **FS-018**, decision **D7**, **FS-023**.

## 3. The dashboard is wrong past 50 envelopes (P1)

The list API returns one page (50); the dashboard computes its status counts and
search over that page only. Past 50 envelopes the counts are wrong and older
envelopes can't be found. The list also returns whole aggregates (audit trails
included) for a table that shows a title and a status. → **FS-005**.

## 4. A sender cannot fix a draft — or a typo after sending (P1)

In a draft, a field can't be moved or resized, a recipient can't be edited or
removed, a document can't be removed, and the draft can't be deleted (only
voided, which leaves it on the dashboard). After sending, a typo in a recipient's
email forces a void and a rebuild. Form fields already in a PDF are never
detected, though `finesign-core` can (PRD FR-D4 unmet; BACKLOG M2.3 wrongly marks
it done). → **FS-006, FS-007, FS-022, FS-008**.

## 5. A failed email is silent and reminders are manual (P1)

Mail is sent best-effort after the save: if SMTP is down, a signer is never told
it's their turn and nobody finds out. Reminders need a click, and each one
re-mints the link, killing the one in the original email. Emails are one-line
plain text with a bare link, and replies go to the instance, not the sender.
→ **FS-009a, FS-009b, FS-010**.

## 6. Signing gaps against the PRD and for real users (P1–P2)

Signatures can be typed or drawn, not uploaded (PRD FR-S2). Approvers must adopt
a signature they never use. Text fields and the certificate use Helvetica
(Latin-1), so "Dvořák", "Łódź", Cyrillic and Greek are refused in text fields and
print as "?" on certificates. → **FS-011, FS-012, FS-013**.

## 7. Hardening that grows with more users (P2)

PDF parsing has a size cap but no time or memory bound, at upload and again at
completion (R.3); LibreOffice runs in the server's container and network (X.7);
the audit chain is unkeyed — a database writer can rewrite it (R.1); the
certificate's document hash can't be reproduced from the delivered file (R.5).
→ **FS-014a, FS-014b, FS-015, FS-016**.

## 8. Operations and data lifecycle (P2)

No request logs (`logger: false`), a `/health` that checks nothing, no view of
webhook dead letters or mail failures. Nothing is ever deleted: no retention
policy, no erasure on request, no legal hold, no evidence export — operators
under GDPR-like rules cannot comply. → **FS-020, FS-021**.

## Deliberately not in this plan

- **Templates and bulk send** — PRD §6 non-goal "for now"; build on accounts.
  Revisit after M7 (D4).
- **SSO / OIDC** and **2FA** — after local accounts exist (D2, D11).
- **Translations (i18n)** — FS-010 builds email templates on message keys so it
  can follow; the web UI is English-only for now.
- **Consent wording outside the US** — the ESIGN/UETA disclosure is US-specific
  (D16).
- **Real-time updates** (M5.4) — 5-second polling is adequate.
- **KMS/HSM, CA-issued seal certificates, SMS/ID verification** — need external
  providers to test against honestly; already on the parity roadmap.
- **S3 blob store** (X.2) — deferred with a written reason in the backlog.

## Decisions for the product owner

**Approved 2026-11-09: all sixteen recommended defaults.** The tickets are
written against them; revisiting one means updating the ticket(s) named.

| # | Decision | Approved default | Affects |
| --- | --- | --- | --- |
| D1 | Where tickets live | In the repo (`docs/tickets/`), reviewed with the code | process |
| D2 | Identity | Local email + password first; SSO/OIDC as a later ticket | FS-001a |
| D3 | Approvers | Approve with consent only (signature only if they have signature fields) | FS-012 |
| D4 | Templates | Out for now; plan them after M7 | — |
| D5 | Visibility | Senders see only their own envelopes; admins see all; admins can reassign | FS-002, FS-004a |
| D6 | Webhooks | Admin-only for now; per-user webhooks later | FS-002 |
| D7 | Postgres | SQLite is the supported store; Postgres marked experimental, new stores in-memory + SQLite only, README corrected (FS-023 stays P3) | FS-018, FS-023, every new store |
| D8 | Deleting drafts | Hard delete, drafts only, version-checked, recorded in the activity log | FS-007 |
| D9 | Retention and erasure | Export + erasure + legal hold; automatic retention off by default | FS-021 |
| D10 | Failed sign-ins | Progressive throttle, not a hard account lock | FS-001a |
| D11 | 2FA (TOTP) | Follow-up ticket after M7 | — |
| D12 | Legacy API key | Deprecated with a boot warning; removed in the first tagged release after M7 | FS-003 |
| D13 | Reminder links | Reminders keep the last 3 links valid; an explicit Resend revokes all earlier ones | FS-009b |
| D14 | Webhook compatibility | Add `schemaVersion: 1` with the first breaking change; announce breaks in the CHANGELOG (pre-1.0) | FS-002, FS-012 |
| D15 | Email replies | `Reply-To` is the sender's address | FS-010 |
| D16 | Consent wording | Keep the US ESIGN/UETA text; operator-configurable text as a later ticket | — |

## Review outcome

An independent reviewer checked the first draft against the code and found 30
issues; every one is resolved in the tickets or listed above:

- **Security flaws in the specs, fixed:** console mailer would have logged
  signing links (FS-010); CSRF rule let bodiless and Origin-less requests through
  (FS-001a); account lockout leaked which emails exist and let anyone lock out an
  admin (FS-001a → throttle); API tokens could mint successor tokens (FS-003 →
  credential routes are session-only).
- **Designs that would not have worked, reworked:** keyed audit chain allowed MAC
  stripping, truncation and transplanting (FS-015); mail retry couldn't re-mint
  completed-copy links and could turn a saved signature into a 409 (FS-009a);
  draft deletion raced with send (FS-007); PDF limits capped the wrong memory and
  missed later parse sites (FS-014a); scrypt parameters threw on Node's default
  memory limit (FS-001a, verified).
- **Missing work, added:** the void bug (FS-017), schema migrations (FS-018),
  activity log (FS-019), observability (FS-020), retention and erasure (FS-021),
  post-send email correction (FS-022), Postgres decision (FS-023), send quotas
  (FS-024), access-code hashing (FS-025), an upgrade path for existing installs
  (FS-001b).
- **Too large, split:** FS-001, FS-004, FS-009, FS-014.
- **Order changed:** the bug, migrations and reliable email come first; email
  templates move before the user-admin emails; certificate-touching tickets are
  sequenced; independent tickets marked as parallelizable.
