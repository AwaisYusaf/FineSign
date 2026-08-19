# Changelog

All notable changes to FineSign. Milestones map to FACTORY §7.

## [Unreleased]

### M0 — Harness + core
- Software factory harness (`FACTORY.md`), PRD, ARCHITECTURE, BACKLOG, ADR-0001.
- npm-workspaces monorepo with TypeScript project references + `scripts/gate.sh`
  (build + typecheck + test as the single quality gate).
- Extracted the signing engine into `finesign-core` (renamed from the initial
  spike); added `getPdfInfo` (page count + geometry probe).
- `@finesign/shared`: typed error hierarchy, `Clock`, id/token generation
  (crypto + seeded), logger.

### M1 — Domain model (pure)
- Entities: Envelope, Document, Recipient, Field, AuditEvent.
- Table-driven envelope + recipient state machines.
- Sequential/parallel routing engine.
- Append-only, SHA-256 hash-chained audit log with tamper verification.
- `EnvelopeService`: pure operations returning `(nextState, effects)` for
  create/addDoc/addRecipient/addField/send/sign/decline/void.
- Send-time validation.

### M2 — Document normalization
- `DocumentConverter` port; `PdfPassthroughConverter`; `LibreOfficeDocxConverter`
  (injectable runner); `CompositeConverter`; `normalizeDocument`.

### M3 — Storage
- `EnvelopeRepository` + `BlobStore` ports.
- In-memory + SQLite repositories; in-memory + local-FS blob stores.
- One shared contract test both repositories pass.

### M4 — API server (vertical slice)
- Fastify REST API: envelope authoring, send, tokenized signer sessions,
  image + typed signing (via finesign-core), downloads, certificate of completion.
- Single error handler (code → HTTP status); rate limiting on public routes;
  magic-byte upload validation.
- Full lifecycle integration test: PDF + DOCX, two sequential signers,
  draft → completed, audit chain verified.

### M4.8 — Self-critique pass (adversarial review + fixes)
- Ran three adversarial reviews (correctness, security, architecture). Fixed all
  19 findings, each locked with a regression test:
  - **Security**: sender API-key auth on management routes (closes IDOR/
    enumeration), no tokens in logs, filename sanitization, DOCX-converter
    hardening (throwaway profile + timeout), global rate limit, generic 4xx errors.
  - **Correctness**: independent full dates (no MM/DD/YYYY fragmenting),
    decline notifies the sender with a truthful "Declined" message, audit `id`
    bound into the hash chain, persist-before-deliver ordering, off-page field
    rejection, width-aware typed scaling, robust routing.
  - **Architecture**: ADR-0002 for the core font-asset exception + doc
    correction; **gate hardened** with ESLint (type-aware) and a machine-enforced
    purity/boundary guard; domain hashing routed through `@finesign/shared`;
    unused `Mailer` port removed from the domain.

_61 tests green across 6 packages; gate now runs boundaries + build + lint + tests._

### Backend hardening
- **M6.1**: the certificate of completion is now appended into each signed PDF
  (the sealed file carries its own audit certificate), alongside the standalone
  certificate endpoint.
- **SMTP mailer** (`SmtpMailer`, nodemailer v9) behind an injected transport —
  real delivery, unit-tested without a live server.
- **OpenAPI**: `/openapi.json` + Swagger UI at `/docs`, generated from routes.
- **Postgres repository** over an injected query seam, verified against the same
  shared contract as in-memory + SQLite (via pg-mem).
- S3 blob store deferred (BlobStore port keeps it a drop-in; local-FS covers
  self-host) — see backlog X.2.

_65 tests green across 6 packages._

### Hardening self-critique (second review pass)
- Reviewed the new code adversarially; fixed all findings:
  - **Postgres atomicity (High)**: writes now run in a single-connection
    transaction (`BEGIN/COMMIT`), and `seq` is a DB-assigned `bigserial` with
    PK-based conflict detection — no torn token index, no racy `MAX(seq)+1`.
  - Removed a dead `SmtpConfig.from` field; auth hook now keys off the matched
    route pattern (not the raw URL); documented `finalize`'s exactly-once guard.

### M5 — Web UI (React, JavaScript)
- `@finesign/web`: a Vite + React app with a **sender console** (create envelope,
  upload PDF/DOCX, add recipients, click-to-place fields on pdf.js-rendered pages,
  send) and a **signer page** (`/s/:token`: review documents, draw/type a
  signature, sign-all or decline).
- Backend support: a public `GET /sign/:token/documents/:documentId` so the signer
  can render their document; a configurable `signPath` so signing links point at
  the SPA's `/s/:token` route (distinct from the API's `/sign/*`); and a dev-only
  `GET /api/envelopes/:id/dev-links` (off by default) so local demos can surface
  signer links without email.
- Fixed a boot bug found while running it: the server now creates its data
  directory before SQLite opens (fresh installs failed to start).
- Verified end-to-end against the running stack: create → upload → place fields →
  send → signer view → sign → completed → download a certified 2-page PDF.

_66 backend tests green across 6 packages; web app lints + builds in the gate._

### M6.2 — PAdES / PKI cryptographic signatures (`@finesign/pades`)
The legal-grade signing module (ADR-0003), built in phases with the gate green
at each step:
- **PAdES-B-B signing**: a detached CMS signature (`SubFilter ETSI.CAdES.detached`)
  embedded in the PDF via incremental update, with the mandatory signed
  attributes — content-type, message-digest, signing-time, and
  **signing-certificate-v2** (ESS/RFC 5035). Built with PKIjs (CMS) + @signpdf
  (ByteRange mechanics); the key operation is behind an HSM-ready `sign(tbs)`.
- **Credentials**: `LocalSigningCredential` loads a PKCS#12/PFX (leaf matched by
  public-key SPKI) or generates a self-signed dev cert.
- **Verification**: integrity, **whole-document coverage**, message-digest +
  signing-certificate-v2 checks, trust (direct-pin or chain), certificate
  validity-at-time, and weak-algorithm rejection (SHA-1/MD5, RSA<2048).
- **Lifecycle**: the platform seals completed documents (`PadesDocumentSealer`);
  `GET /api/envelopes/:id/documents/:documentId/verify` returns the verdict.
  Fail-closed via `FINESIGN_SEAL_REQUIRED`.
- **Independently validated with OpenSSL** (`openssl cms -verify` succeeds).
- **Adversarial crypto review** fixed a critical authenticity flaw (`valid` now
  requires a trusted whole-document signature — defeats self-signed forgery and
  the append-a-signed-revision attack) plus 9 further findings, each with a
  regression test. See docs/review/pades-crypto.md.

_Levels B-T / B-LT / B-LTA, per-signer certs, and Adobe/EU-DSS conformance are
staged follow-ons (backlog M6.2)._

### Critical review (multi-agent, Fable 5) + hardening
Ran a 60-agent adversarial review across every critical module + a DocuSign
parity analysis (`docs/review/critical-review.md`, `docs/DOCUSIGN-PARITY.md`);
38 findings confirmed by independent verification. Fixed the confirmed
correctness/security issues, each with a regression test:
- **Crypto**: chain-trust now binds to the actual signer certificate (a forged,
  self-signed doc with an appended chained cert can no longer be reported
  authentic); the verifier no longer strips trailing `0x00` (was an intermittent
  ~1/256 false-negative) and no longer treats a stray `/ByteRange` literal as a
  signature; non-RSA/EC keys are rejected instead of mislabelled.
- **Engine**: decompression-bomb guard now runs before image embed; non-zero
  MediaBox origins are honoured (stamps no longer land off-page); date cells use
  UTC and index within the auto subset.
- **Integrity**: **optimistic-concurrency version CAS** across in-memory / SQLite /
  Postgres kills the lost-update & double-sign races; every completed document is
  now sealed (no unsealed no-field docs); text/checkbox fields are rejected at
  send rather than silently dropped; the sender is notified on completion; decline
  notifications no longer leak the envelope or the reason to uninvolved recipients.
- **Hardening**: trustProxy + real-IP rate-limit keying, body-limit aligned to the
  upload cap, list pagination validated, atomic blob writes + ENOENT-only `exists`,
  DOCX converter error/timeout/size hardening (process-group SIGKILL), unique
  sqlite `seq`.

_86 tests green across 8 packages; OpenSSL still independently verifies the seals._

### M6.2 — PAdES-B-T (RFC 3161 trusted timestamps)
The signature-timestamp layer (pades **P4**) — proves *when* a signature existed,
independent of the signer's clock, and lets a seal survive its certificate's later
expiry. Designed from a code-level blueprint verified against the installed PKIjs
(`docs/design/pades-bt-blueprint.md`), then implemented behind the gate:
- **Timestamp**: an `id-aa-signatureTimeStampToken` UNSIGNED CMS attribute carrying
  an RFC 3161 `TimeStampToken`, computed over the **SignerInfo signature value**
  (not the document, not the OCTET STRING TLV). Wired through a post-signature hook
  in `buildCmsSignedData` so the B-B signature is untouched.
- **`TimestampAuthority` port** with two adapters: an **in-process TSA**
  (deterministic, injected clock — for tests + single-org self-hosting) and an
  **HTTP RFC 3161 client** (the production path, injectable `fetch`). The TSA cert
  carries the mandatory single **critical `id-kp-timeStamping` EKU**.
- **Verification**: the token's own CMS signature, `messageImprint ==
  hash(signature)`, the TSA-cert EKU, and (optional) TSA chain-to-anchor as-of
  `genTime`; a **trusted, anchored** timestamp's `genTime` becomes the effective
  signing time for the signer-cert validity window + chain `checkDate`.
- **Server**: `FINESIGN_TSA_URL` (+ `FINESIGN_TSA_CERT` to pin) or `FINESIGN_DEV_TSA`
  enable B-T; the sealer emits B-T seals and the verify endpoint reports the
  timestamp verdict.
- **Independently validated with OpenSSL**: `openssl cms -verify` (document) and
  `openssl ts -verify -data <signature>` (token) both succeed; `openssl ts -reply`
  prints the correct `genTime` and a minimal DER serial.

### PAdES-B-T adversarial self-critique (multi-agent, Fable 5) + fixes
A 5-lens / 14-agent adversarial review (`docs/review/pades-bt.md`) with independent
per-finding verification surfaced 9 confirmed defects; all fixed, each with a
regression test:
- **Forged-seal (CRITICAL)**: `findSignerCert` fell back to `certificates[0]` for a
  SubjectKeyIdentifier `SignerInfo.sid`, so an attacker could sign with their own key
  under an SKI while placing a genuine trusted cert first and be reported trusted.
  Now resolves the SKI exactly as PKIjs does (`SHA-1(subjectPublicKey)`) and never
  guesses — binds every trust/EKU/attr check to the cert that actually signed.
- **Fail-open clock-move (HIGH)**: an un-anchored (no `tsaTrustStore`) timestamp no
  longer moves the effective signing time — because the token is an unsigned attr, a
  self-signed TSA could otherwise revive an expired/revoked seal. It is still
  reported `present`/`valid` on crypto merits, but only a **trusted, anchored**
  timestamp extends validity (fail-closed, like the document trust store).
- **Robustness (HIGH)**: an empty `SignerInfos` SET no longer throws out of the
  verifier; the HTTP TSA client caps response size, matches content-type
  case-insensitively, and guards malformed DER; the in-process TSA emits the full
  serial (no 65 536-token wrap); certificate serials are now minimal positive DER
  integers (fixes a latent ~50 % OpenSSL-reject flake); and mis-set TSA env is now
  warned, not silently ignored.

_103 tests green across 8 packages; OpenSSL independently verifies both the document
seal and the RFC 3161 token._

### M6.2 — PAdES-B-LT / B-LTA (long-term validation, pades P6)
Completes the PAdES level ladder — a signature that stays verifiable for decades,
offline, after the signing certs expire. Designed from a code-level blueprint
(`docs/design/pades-ltlta-blueprint.md`) and built in phases behind the gate:
- **B-LT (Long-Term)**: appends a **DSS** (Document Security Store) holding the
  certificate chain + CRLs so the signature validates OFFLINE. Built on a
  hand-rolled, byte-preserving **incremental-update writer** (`incremental.ts`) —
  pdf-lib has no incremental mode, so the DSS is a true append-only revision that
  leaves the signed bytes (and their ByteRange digest) untouched. Validation
  material comes from a `ValidationDataProvider` port; the in-process impl issues
  CRLs from a **test CA** (`generateTestCa`/`issueLeaf`, a real CA→leaf chain).
- **B-LTA (Long-Term-Archive)**: appends a **document timestamp**
  (`/Type /DocTimeStamp`, `/SubFilter /ETSI.RFC3161`) over the whole DSS-augmented
  file, protecting the validation material over time (reuses the `TimestampAuthority`).
- **Verifier**: classifies signatures vs document timestamps; **relaxes coverage**
  so legitimate DSS/DocTimeStamp appends don't break the underlying signature — while
  still rejecting content tampering (an append may only ADD DSS objects or re-emit
  the catalog adding only `/DSS`; a page/content change or a render-reachable
  injected object breaks coverage); validates the chain + revocation offline as-of
  the trusted time; and reports the strongest level (B-B < B-T < B-LT < B-LTA).
- **`sealPdf(level: "B-LT" | "B-LTA")`** orchestrates the full pipeline; the server
  sealer + a dev CA path wire it end-to-end.
- **Independently validated with OpenSSL**: `crl -verify` (DSS CRL) and
  `ts -verify -data <byterange>` (document timestamp) both succeed.

### PAdES-B-LT/LTA adversarial self-critique (multi-agent, Fable 5) + fixes
A 5-lens / 16-agent adversarial review (`docs/review/pades-ltlta.md`) with
independent per-finding verification confirmed 9 defects; 8 fixed with regression
tests, 1 deferred (documented):
- **Forged-seal (CRITICAL)**: a trusted *document timestamp* satisfied the
  whole-document *authenticity* clause, so a public-TSA timestamp over an attacker's
  self-signed PDF read as valid/B-LTA. The trust anchor is now required to be a
  trusted CAdES **signature** — a timestamp only raises the *level*.
- **Overlay injection (HIGH)**: an append that DEFINED an object satisfying a
  pre-planted dangling reference was accepted as benign. Coverage now rejects any
  newly-defined, render-reachable object (outside the `/DSS` subtree).
- **Revocation (MEDIUM×2)**: the CRL issuer is resolved only from TRUSTED anchors
  (not the attacker-suppliable DSS pool); a fail-closed `requireRevocation` option
  was added.
- Plus B-LTA gating on an anchored + whole-document + DSS-covering timestamp, CRL
  freshness (skip no-`nextUpdate`, prefer a `revoked` hit), and env-level validation.

### B-LT revocation sources: OCSP + an HTTP validation provider
Completed the `ValidationDataProvider` port and the verifier's revocation engine:
- **OCSP-based B-LT**: the provider issues a `BasicOCSPResponse` (in-process test
  CA) into the DSS `/OCSPs`; the verifier verifies the responder signature against
  the trusted issuer, matches the CertID, checks freshness, and reads the status
  (`good`/`revoked`). CRL + OCSP are combined (a `revoked` from either wins; OCSP
  preferred for `good`), selectable via `source: "crl" | "ocsp" | "both"`.
- **`createHttpValidationDataProvider`** — the production adapter (mirrors
  `createHttpTsa`): fetches the CRL from the leaf's CRL Distribution Point and an
  OCSP response from its AIA responder (or explicit URLs), with an injectable
  `fetchImpl` (unit-tested against canned CA material), response-size caps, and
  best-effort skip on malformed/oversized responses.

_120 tests green across 8 packages; OpenSSL independently verifies B-B/B-T/B-LT/B-LTA._

### DocuSign parity — DG1 + DG2 (legal credibility + field types)
Closing the DocuSign-parity gaps needed for a credible open-source v1:
- **DG1 — signer identity + ESIGN/UETA consent + access-code auth**: recipients can
  require an access code (per-recipient brute-force lockout, gated session, hashed
  secret); signing captures the trustProxy-aware client IP + user-agent + per-action
  timestamps and an explicit ESIGN/UETA electronic-signature consent event, all
  recorded in the hash-chained audit and rendered on the certificate of completion.
  Sender + signer UIs updated. Adversarial review (`docs/review/dg1-identity-consent.md`)
  fixed 6 findings incl. a UA-injection that could permanently brick completion and
  the access-code brute-force, plus redacting credential hashes from API responses.
- **DG2 — text & checkbox fields**: captured at signing and stamped into the
  completed PDF (font-safe, never throws), with required-field enforcement; values
  recorded on the envelope. Signer UI renders inline text inputs + checkboxes.

### DocuSign parity — DG3 (expiration + resend + reminders)
Closes the "an all-tokens-expired envelope is stuck in `sent`" gap and adds
sender-initiated nudges:
- **Envelope expiration**: `send` accepts `expiresInDays`, stamping `expiresAt`.
  A past-deadline `sent` envelope transitions to a new terminal **`expired`** state
  — **lazily** on the next token touch (`resolveToken` runs `expireIfDue`, so an
  abandoned envelope expires the moment anyone accesses it) and via an idempotent
  **`POST /api/envelopes/sweep-expired`** for a cron/worker. Expiry refuses further
  signing and emails the sender. New audit event `envelope_expired`.
- **Manual resend + reminders**: `POST /api/envelopes/:id/recipients/:rid/{resend,remind}`
  re-mint a fresh signing token (the previous link stops resolving, since raw tokens
  are never stored) and email the active signer; guarded to the recipient whose turn
  it is and not yet signed. New audit events `recipient_resent` / `recipient_reminded`;
  new notify reasons `resent` / `reminder` / `expired`.
- Pure-domain methods `expireIfDue` / `resend` / `remind` return `(nextState, effects)`;
  the `status` column is plain text so no storage migration is needed. Sender console
  gains an expiration input on send + per-recipient Remind / Resend actions.
  Follow-on: **automated** time-scheduled reminders (today they're sender-triggered).

### DocuSign parity — DG4 (webhooks / event callbacks, Connect-style)
The top integration gap. Operators register subscriptions `{url, secret, eventTypes}`
(behind the sender API key); each new audit event fans out to matching ACTIVE
subscriptions as durable outbox rows, drained by a retrying deliverer.
- **Persistence** (`@finesign/storage`): `WebhookStore` port + in-memory + SQLite
  impls (shared contract test). Outbox is idempotent (`UNIQUE(subscription,
  envelope, eventId)`) and forward-only (`event.at >= subscription.createdAt` +
  per-(sub,env) high-water-mark `maxEnqueuedSeq` — no cursor table).
- **Delivery** (`@finesign/server` `webhooks.ts`): POST signed with
  `X-FineSign-Signature: sha256=HMAC(secret, "<ts>.<body>")` (+ `-Timestamp`,
  `-Event`, `-Delivery` headers); exponential-backoff retry; dead-letter after
  `maxAttempts`. Fan-out is inline + best-effort in `persistThenDeliver` (never
  breaks signing). Drained via `POST /api/webhooks/deliver` + a background ticker.
- **SSRF-guarded**: the endpoint host is resolved and EVERY IP checked against a
  private/reserved denylist (IPv4 + IPv6, incl. 169.254.169.254 metadata, IPv4-
  mapped/compatible/NAT64/6to4); redirects are not followed; `allowPrivate` is a
  dev-only opt-in. **Secret hygiene**: returned once on creation, redacted from all
  other reads.
- **Adversarial review** (`docs/review/dg4-webhooks.md`, 5 lenses / 12 agents,
  6 confirmed findings) fixed a HIGH concurrent-drain double-delivery + attempts-
  race (now atomic lease + re-entrancy guard), an `isPublicIp` fail-open on
  IPv4-compatible/6to4 embeddings, and a per-POST signature-timestamp bug; plus a
  DNS-lookup timeout and backoff-overflow clamp. Sender-console Webhooks page added.
  Residual (documented): DNS-rebinding TOCTOU.

_159 tests green across 8 packages._

### DocuSign parity — DG5 (encryption at rest)
Documents, signed PDFs, and certificates are never written to disk/object-storage
in the clear.
- **`EncryptedBlobStore`** (`@finesign/storage`) — a transparent decorator over any
  `BlobStore` (in-memory / local-FS / future S3). AES-256-GCM, random 96-bit IV per
  blob, self-describing frame (`magic|version|keyId|iv|tag|ciphertext`) with the
  header **and the blob's storage key** as AAD (so version/key swaps and ciphertext
  relocation both fail authentication). Wraps the store in both containers.
- **KMS-ready `KeyProvider` port**; `LocalKeyProvider` keyring with per-blob key ids
  derived from key material (SHA-256 prefix) + **rotation** (`FINESIGN_ENCRYPTION_KEY`
  active + `FINESIGN_ENCRYPTION_DECRYPT_KEYS` retired). Fail-closed reads by default.
- **Adversarial review** (`docs/review/dg5-encryption.md`, 3 lenses / 12 agents,
  8 confirmed) flipped the legacy-plaintext passthrough to fail-closed (was a
  write-attacker tamper-detection bypass; migration is now an explicit env opt-in),
  bound the storage key into the AAD, and added a boot warning when encryption is
  off. Confidentiality vs a read-only attacker was never at risk.

_170 tests green across 8 packages._

### Open-source readiness
Everything needed to publish + self-host FineSign:
- **License**: Apache-2.0 (`LICENSE` + `NOTICE`; every package's `license` field set).
  Dependency-license sweep (`npm run licenses` → `docs/DEPENDENCY-LICENSES.md`):
  333 deps, all permissive (no strong-copyleft-only); secrets sweep clean.
- **Docs**: rewritten `README.md` (current feature set + quickstart), `SECURITY.md`
  (threat model + private-disclosure policy + documented residuals), `CONTRIBUTING.md`,
  and a fully-documented `.env.example`.
- **One-command self-host**: `docker compose up --build` — a multi-stage server image
  (LibreOffice bundled for DOCX) + an nginx web image that reverse-proxies the API
  (single origin, no CORS), with a persistent data volume. The server is not exposed
  directly (only via the proxy).
- **SMTP-from-env** wired into the boot path (real delivery when `SMTP_*` is set,
  console otherwise); boot-time warnings when encryption/SMTP are unconfigured.
- `.gitignore` / `.dockerignore` added.

### Next
- M5 — sender + signer web UI.
- M6 — certificate hardening + PAdES/PKI research spike.
