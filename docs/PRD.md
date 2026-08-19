# FineSign — Product Requirements

## 1. Vision

An open-source, self-hostable **e-signature and agreement-management platform** —
a DocuSign / Adobe Sign alternative you run on your own infrastructure. Built on
the **`finesign-core`** signing engine (also open source and independently
installable). Sign **PDF and Word** documents, route them to multiple signers,
track everything, and keep every byte on your own servers with no per-signature
fees.

## 2. Who it's for

- **Senders** — anyone who needs a document signed (ops, legal, HR, sales).
- **Signers** — recipients who receive a link and sign; no account required.
- **Administrators** — self-hosters who deploy, configure storage/email, and audit.
- **Developers** — integrate signing into their own product via `finesign-core`
  (the engine) or the FineSign REST API (the platform).

## 3. Core concepts (domain language)

- **Agreement / Envelope** — the unit of work: one or more documents sent to one
  or more recipients for signature. Has a lifecycle (draft → sent → completed).
- **Document** — a PDF or DOCX inside an envelope. DOCX is normalized to PDF for
  signing. Each document has a page count and detected/placed fields.
- **Recipient** — a person with a **role** (`signer`, `approver`, `cc`), a
  **routing order** (sequential or parallel), and a status. Signers have fields
  to complete; CC recipients just receive the finished copy.
- **Field** — a place on a document assigned to a recipient: `signature`,
  `initials`, `date_signed`, `text`, `checkbox`. Has a page + display-space box.
- **Signing session** — a tokenized, expiring, single-recipient link that lets a
  signer open their documents and complete their fields without an account.
- **Audit trail** — an append-only, tamper-evident event log for the envelope
  (created, sent, viewed, signed, completed, declined, voided…), renderable as a
  **certificate of completion** appended to the final PDF.

## 4. Functional requirements

### 4.1 Documents
- FR-D1: Upload PDF; validate by magic bytes; store original immutably.
- FR-D2: Upload DOCX; normalize to PDF via an injected `DocumentConverter`;
  keep both original and normalized copies.
- FR-D3: Report page count and dimensions per document.
- FR-D4: Auto-detect signature/date fields from AcroForm (`finesign-core`), and
  allow manual field placement (drag-box in display space).

### 4.2 Envelopes & routing
- FR-E1: Create a draft envelope; add documents, recipients, and fields.
- FR-E2: Assign every field to exactly one recipient.
- FR-E3: Support sequential routing (recipient N unlocked only after N-1
  completes) and parallel routing (all at once).
- FR-E4: Send: validate the envelope is complete (every signer has ≥1 field,
  every field has a recipient), snapshot it, and issue signing sessions.
- FR-E5: Void a sent envelope (terminal); decline by a recipient (terminal).

### 4.3 Signing
- FR-S1: Open a signing session by token → see only this recipient's documents +
  fields. Reject expired/invalid/wrong-status tokens.
- FR-S2: Provide a signature as drawn image, uploaded image, or typed name (via
  `finesign-core` fonts).
- FR-S3: "Sign all" — apply the captured signature to every assigned signature
  field and auto-date every date field.
- FR-S4: On the last signer's completion, mark the envelope completed and
  generate the final signed PDF(s) + certificate.
- FR-S5: Signing is idempotent and re-derives from the original document.

### 4.4 Delivery & retrieval
- FR-R1: Notify recipients by email when it's their turn (injected `Mailer`;
  console mailer for local dev).
- FR-R2: Download the signed document and the certificate of completion.
- FR-R3: Sender dashboard: list envelopes with status; drill into audit trail.

### 4.5 Audit & trust
- FR-A1: Every state change emits an audit event with actor, timestamp, IP,
  and user-agent where available.
- FR-A2: Audit log is append-only and hash-chained (each event references the
  prior event's hash) for tamper evidence.
- FR-A3: Certificate of completion enumerates signers, timestamps, and the
  document hash.

## 5. Non-functional requirements

- NFR-1: **Self-hostable with zero external SaaS.** Runs with SQLite + local
  blob storage out of the box; Postgres + S3 via adapters.
- NFR-2: **Pure core.** `@finesign/domain` has no I/O; `finesign-core` is pure
  except for lazily loading its own bundled font assets from the package dir
  (`engine/fonts.ts` — see ADR-0002). Machine-enforced by
  `scripts/check-boundaries.sh`.
- NFR-3: **Security:** tokens ≥128 bits entropy, expiring; uploads validated and
  capped; authz on every transition; no secrets in logs.
- NFR-4: **Deterministic tests:** injected clock + RNG.
- NFR-5: **TypeScript strict**, single language across the stack.
- NFR-6: **Portable:** no reliance on a specific cloud; adapters are swappable.

## 6. Explicit non-goals (for now)

- Hosted multi-tenant SaaS billing.
- Advanced form-builder / conditional logic.
- Bulk send / templates library (post-M4 backlog).
- Cryptographic PAdES/PKI signatures land in M6+; until then signatures are
  visual overlays plus a hash-chained audit trail (clearly labeled as such).

## 7. Success criteria (this build)

A self-hoster can, against a running FineSign server: create an envelope from a
PDF **and** a DOCX, add two sequential signers with fields, send it, sign as each
signer via tokenized links, and download a completed, audited PDF — all covered
by automated integration tests and reproducible from the README.
