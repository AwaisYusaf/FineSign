# FineSign — Backlog

The living task list that drives the autonomous build loop (FACTORY §4). Ordered
by priority within each milestone. `[ ]` todo · `[~]` in progress · `[x]` done ·
`[>]` deferred (with reason).

## M0 — Harness + core
- [x] M0.1 Monorepo skeleton, workspaces, root tsconfig, gate script
- [x] M0.2 FACTORY.md, PRD, ARCHITECTURE, BACKLOG, ADR-0001
- [x] M0.3 Rename library → `finesign-core`, build+test green in monorepo
- [x] M0.4 `@finesign/shared`: Result, typed errors base, id/token gen, Clock
- [x] M0.5 Gate hardening: ESLint (type-aware) + boundary/purity guard as gate steps

## M1 — Domain model (pure)
- [x] M1.1 Entities: Envelope, Document, Recipient, Field, AuditEvent (+ types)
- [x] M1.2 Status state machine (envelope + recipient), table-driven, tested
- [x] M1.3 Routing engine: sequential/parallel next-recipient resolution
- [x] M1.4 Audit log with sha256 hash-chain + verification, tested
- [x] M1.5 Envelope service: create/addDoc/addRecipient/addField/send/sign/void/decline
- [x] M1.6 Send-time validation (every signer has a field; every field assigned)

## M2 — Document normalization
- [x] M2.1 `DocumentConverter` port + `PdfPassthroughConverter`
- [x] M2.2 `DocxToPdfConverter` (LibreOffice reference adapter) + capability probe
- [x] M2.3 Page-count / dimensions probe via core; field auto-detect integration

## M3 — Storage adapters
- [x] M3.1 `EnvelopeRepository` + `BlobStore` port shapes finalized in domain
- [x] M3.2 In-memory repository + blob store
- [x] M3.3 SQLite repository + local-FS blob store
- [x] M3.4 Shared contract test run against both repositories

## M4 — API server (vertical slice)
- [x] M4.1 Fastify app, error handler, DI composition root, health
- [x] M4.2 Envelope CRUD routes (create draft, add doc/recipient/field, get)
- [x] M4.3 Send route (validate → snapshot → issue tokens → notify)
- [x] M4.4 Signer session routes: GET /sign/:token, POST /sign/:token/apply
- [x] M4.5 Completion: stamp docs via core, certificate, download routes
- [x] M4.6 Full lifecycle integration test (PDF + DOCX, 2 sequential signers)
- [x] M4.7 Rate limiting + upload validation on public routes
- [x] M4.8 Self-critique fixes: sender API-key auth (S1), no-token-in-logs (S2),
      filename sanitization (S3), DOCX runner hardening (S4), global rate limit
      (S5), generic 4xx errors (L6), persist-before-deliver (K4), date-full (K1),
      decline/sender notify (K2), audit-id in chain (K3), off-page field reject
      (K5), typed-width scale (K6), routing robustness (K7), ENOENT-only blob (A4)

## M5 — Web UI (scaffold this session, finish later)
- [x] M5.1 Vite + React app shell, API client
- [x] M5.2 Sender: create envelope, upload, place fields, add recipients, send
- [x] M5.3 Signer: open by token, draw/type signature, sign-all, confirm
- [>] M5.4 Real-time status (defer: needs websocket layer — post-M5)

## M6 — Trust layer
- [x] M6.1 Certificate-of-completion generator + appended into each signed PDF
- [x] M6.2 PAdES/PKI cryptographic signatures (`@finesign/pades`) — ADR-0003
  - [x] P0 skeleton + dependency vetting (pkijs + @signpdf + node-forge)
  - [x] P1 `SigningCredential` port + `LocalSigningCredential` (PKCS#12 + self-signed)
  - [x] P2 PAdES-B-B signer (ETSI.CAdES.detached, signing-certificate-v2)
  - [x] P3 verifier (integrity + whole-doc coverage + attrs + trust + weak-algo reject)
  - [x] P5 lifecycle integration: platform seal on completion + verify endpoint
  - [x] P7 adversarial crypto self-critique + fixes (C1 auth/trust, H1 validity,
        H2 weak-algo, M1 byte-range, M2/M3/L1–L4); OpenSSL independently verifies
  - [x] P4 PAdES-B-T (RFC 3161 timestamp) — `TimestampAuthority` port + in-process
        TSA + HTTP RFC 3161 client; imprint over the signature value; verifier
        (token sig + imprint + critical id-kp-timeStamping EKU + optional TSA
        chain-to-anchor as-of genTime); trusted-anchored genTime drives cert
        validity. Server: `FINESIGN_TSA_URL`/`FINESIGN_TSA_CERT`/`FINESIGN_DEV_TSA`.
        OpenSSL `ts -verify` independently validates the token. Adversarial review
        (`docs/review/pades-bt.md`) fixed 9 findings incl. a CRITICAL SKI
        signer-resolution forgery and the fail-open clock-move.
  - [x] P6 PAdES-B-LT/LTA — DSS (chain + CRL) via a hand-rolled byte-preserving
        incremental-update writer + a `/DocTimeStamp` archive timestamp; test CA
        (CA→leaf + CRL issuance); append-aware coverage (rejects content tampering
        + render-reachable overlay injection); offline chain+revocation at trusted
        time; `sealPdf(level:"B-LT"|"B-LTA")` + server dev wiring. OpenSSL `crl -verify`
        + `ts -verify` independently validate. Adversarial review
        (`docs/review/pades-ltlta.md`) fixed 9 findings incl. a CRITICAL
        timestamp-authenticity bypass + a HIGH overlay injection.
    - [x] P6f OCSP-based B-LT — `BasicOCSPResponse` in the DSS `/OCSPs`; verifier
          combines CRL + OCSP (revoked wins); `source: crl|ocsp|both`.
    - [x] P6 HTTP validation-data provider — `createHttpValidationDataProvider`
          (CDP/AIA fetch + injectable fetch), completing the port (in-process + HTTP).
    - [ ] P6g link the DocTimeStamp into /AcroForm (survive normalizers / Adobe) —
          needs a scoped relaxation of the coverage catalog check; deferred.
    - [ ] P6 bind B-LTA revocation material to the DocTimeStamp-protected DSS bytes.
  - [ ] P7b external-validator conformance beyond OpenSSL (Adobe Acrobat + EU DSS)
  - [ ] per-signer certificates (each signer's own X.509, multiple sig fields)

## Cross-cutting / later
- [x] X.1 Postgres repository adapter (over an injected query seam; pg-mem contract test)
- [>] X.2 S3 blob store adapter (defer: a tested adapter needs the heavy AWS SDK or a
      mock S3 server; the `BlobStore` port + LocalFsBlobStore already cover self-hosting)
- [x] X.3 SMTP mailer adapter (nodemailer v9, injected transport)
- [x] X.4 OpenAPI spec + Swagger UI (`/openapi.json`, `/docs`)
- [ ] X.5 Docker compose for one-command self-host
- [ ] X.6 Port core's AI signer-field detector as optional `@finesign/detect-ai`
- [ ] X.7 Sandbox DOCX conversion (seccomp/container, no-network, macros off) — S4 follow-up
- [ ] X.8 Full sender identity/auth (accounts, orgs, per-sender scoping) — supersedes the M4 API-key guard

## Critical-review remediation (multi-agent review — docs/review/critical-review.md)
### Fixed this pass (gate green)
- [x] R.A PAdES crypto: chain-trust bound to signer (HIGH), stop stripping trailing
      0x00 (MEDIUM), stray-`/ByteRange`-literal filter (MEDIUM), reject non-RSA/EC
      keys + honest EC-P12 message (HIGH/MEDIUM)
- [x] R.B finesign-core: PNG bomb guard before embed (HIGH), MediaBox non-zero
      origin offset (HIGH), split-date auto-subset index + UTC date (MEDIUM)
- [x] R.C domain/server: **optimistic concurrency (version CAS)** across all 3 repos
      (HIGH lost-update/double-sign), seal ALL documents at completion (HIGH),
      reject text/checkbox at send to stop silent data loss (MEDIUM), notify sender
      on completion (MEDIUM), decline-notification privacy (MEDIUM)
- [x] R.D/E server+storage+convert: trustProxy + rate-limit key, bodyLimit↔upload
      alignment, list limit/offset validation, blob `exists()` ENOENT-only + atomic
      `put()`, DOCX ENOENT-vs-conversion-failure, output size cap, process-group
      SIGKILL on timeout, sqlite `seq` unique index
### Deferred (filed, not done)
- [ ] R.1 Keyed/anchored audit chain (HMAC or external anchoring) — a DB-write
      attacker can currently recompute the unkeyed SHA-256 chain (mitigated pre-
      completion: the completed cert is PAdES-sealed). MEDIUM.
- [ ] R.2 Notification outbox / retry — a mail failure after persist leaves a
      recipient un-notified with no resend (pairs with parity "reminders/resend").
- [ ] R.3 Crafted-PDF parse timeout/resource cap (worker or `getPdfInfo` bound)
      beyond the 10 MB size cap.
- [ ] R.4 Full EC-PKCS#12 loading (PKI.js/OpenSSL) — forge P12 parse is RSA-only.
- [ ] R.5 Certificate document-hash over the delivered sealed artifact (currently
      over the pre-seal intermediate) so it is self-verifiable.

## DocuSign parity roadmap → docs/DOCUSIGN-PARITY.md
Tier-1 (legal credibility): ~~PAdES-B-T timestamps (P4)~~ ✅ DONE, signer IP/UA + ESIGN/UETA
e-consent capture, recipient auth step-up, encryption at rest, CA cert + KMS,
B-LT/LTA. Tier-2 (experience): text/checkbox capture, field editor, anchor
auto-placement. Tier-3 (workflow): templates, reminders/resend/expiration,
webhooks, branding. See the doc for the full matrix + sequencing.

---

### Deferred-item reasons
- **M5.4** websockets add infra surface not needed for the core flow; poll first.
- **M6.3** RFC-3161 needs an external TSA endpoint to test against; spike only.
- **X.2** an honestly-tested S3 adapter needs the heavy AWS SDK or a mock S3 server;
  the `BlobStore` port makes it a drop-in later, and LocalFsBlobStore covers self-host now.
