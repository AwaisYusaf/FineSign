# FineSign — Project State & AI Session Handoff

> **Purpose of this file.** It captures everything an AI agent (or human) needs to
> continue building FineSign in a fresh session/repo without re-deriving context.
> Read this first, then trust the code + the `docs/` referenced below. When facts
> here disagree with the code, **the code wins** — update this file.
>
> _Last updated: 2026-07-12. Status: DocuSign-parity gaps DG1–DG5 + open-source
> readiness complete; **170 tests green across 8 packages**; `npm run gate` green._

---

## 1. What FineSign is

**Open-source, self-hostable e-signature & agreement-management platform — a
DocuSign / Adobe Sign alternative you run yourself.** Sign PDF and Word documents,
route to multiple signers, capture legally-meaningful consent + identity, seal with
real cryptographic (PAdES/PKI) signatures, and keep every byte on your own infra
with no per-signature fees. Apache-2.0 licensed.

It is a **TypeScript npm-workspaces monorepo** (strict TS, no `any`) with a pure
domain core, a Fastify REST API, and a React (JS) web UI. Built on **`finesign-core`**,
a standalone PDF signing engine.

> **Historical note:** FineSign began life inside another repo (a VA-claims backend)
> as a git-ignored `/finesign/` folder so it never affected the parent app. Once
> copied out into its own repo, that constraint no longer applies — it is now a
> standalone project. (The `.gitignore` here is FineSign's own.)

---

## 2. Current status at a glance

| Area | Status |
| --- | --- |
| Envelope lifecycle (draft→send→sign→complete, sequential/parallel routing) | ✅ done |
| Hash-chained tamper-evident audit + certificate of completion | ✅ done |
| PDF + DOCX (DOCX→PDF via LibreOffice) | ✅ done |
| PAdES cryptographic seals: **B-B / B-T / B-LT / B-LTA** (RFC 3161, DSS, CRL+OCSP) | ✅ done, OpenSSL-validated |
| Storage: in-memory · SQLite · Postgres repos; in-memory · local-FS blobs | ✅ done |
| REST API (Fastify) + OpenAPI at `/docs`, API-key auth on `/api/*` | ✅ done |
| React web UI: sender console, signer page, webhooks admin | ✅ done |
| **DG1** — signer identity + ESIGN/UETA consent + access-code auth | ✅ done, reviewed |
| **DG2** — text + checkbox fields (captured + stamped) | ✅ done |
| **DG3** — envelope expiration + manual resend + reminders | ✅ done |
| **DG4** — webhooks / event callbacks (Connect-style) | ✅ done, reviewed |
| **DG5** — encryption at rest (AES-256-GCM blob store) | ✅ done, reviewed |
| Open-source readiness (license, docs, docker-compose, scans) | ✅ done |

**The gate is the source of truth for "is it OK":** `npm run gate` runs
architecture-boundary checks + build + type-aware lint + the full test suite + the
web app's lint/build. It must be green.

---

## 3. How to run it

```bash
npm install --legacy-peer-deps     # the flag is REQUIRED (see gotchas)
npm run gate                       # boundaries + build + typecheck + lint + tests + web
cp .env.example .env               # set FINESIGN_SENDER_API_KEY at minimum
npm start --workspace @finesign/server   # API on :4000 (SQLite + local blobs)
npm run dev  --workspace @finesign/web   # web UI on :5173 (Vite)
```

**Self-host (one command):** `docker compose up --build` → web on `:8080`
(reverse-proxies the API; single origin, no CORS), server not exposed directly,
data in the `finesign-data` volume. Requires `.env` with `FINESIGN_SENDER_API_KEY`.

Node 20+ (dev box is on 22). DOCX needs LibreOffice on the host (bundled in the
Docker image). Built server entrypoint: `node packages/server/dist/index.js`.

---

## 4. Monorepo map + dependency direction

```
packages/
  core/      finesign-core — pure PDF signing engine (stamp sig/date/text, rotation-correct). Standalone.
  shared/    @finesign/shared — typed errors, Clock, IdGenerator, token hashing, Logger.
  domain/    @finesign/domain — PURE agreement model: entities, state machine, routing, hash-chained audit, ports. (nextState, effects[]) pattern.
  convert/   @finesign/convert — document normalization (PDF passthrough + DOCX→PDF via LibreOffice).
  storage/   @finesign/storage — EnvelopeRepository (in-mem/SQLite/Postgres) + BlobStore (in-mem/local-FS) + WebhookStore + EncryptedBlobStore.
  pades/     @finesign/pades — PAdES B-B→B-LTA signing + verification (CMS/PKI, RFC 3161, DSS, CRL/OCSP).
  server/    @finesign/server — Fastify REST API + composition root (container.ts wires everything). This is where I/O lives.
  web/       @finesign/web — React (JavaScript, not TS) + Vite + pdf.js. Sender console + signer page + webhooks admin.
```

**Architecture boundaries (machine-enforced by `scripts/check-boundaries.sh`):**
- `core` and `domain` are **PURE**: no I/O (`fs`/`http`/`net`/`child_process`/`dns`),
  no `process.env`, no importing "rightward" (`@finesign/storage|convert|server`).
- `domain` may import only `@finesign/shared` (+ unscoped `finesign-core`).
- `core` imports no internal package.
- Everything else (server/storage/convert/pades) may do I/O freely.

**Layering:** `routes` (thin HTTP, in `server/src/http.ts`) → `EnvelopeApp`
(application service, `server/src/app.ts`) → pure `EnvelopeService` (domain) →
adapters (storage/convert/pades). The domain returns **`{ nextState, effects[] }`**;
the server executes the effects (email, stamp PDF, finalize, **enqueue webhooks**).

---

## 5. Core domain model (packages/domain)

- **Aggregate root `Envelope`** owns documents, recipients, fields, and an
  append-only **hash-chained audit log** (`hash = sha256(prevHash || canonicalJson(event))`;
  `verifyAuditChain` proves it wasn't tampered with). Types in `domain/src/types.ts`.
- **State machines are table-driven in one place** (`domain/src/state-machine.ts`):
  `EnvelopeStatus = draft|sent|completed|voided|declined|expired`;
  `RecipientStatus = pending|notified|viewed|signed|declined`. Illegal transitions throw.
- **Routing** (`domain/src/routing.ts`): sequential (lowest unfinished `routingOrder`
  group is active) or parallel. `recipientMayAct`, `activeRecipients`, etc.
- **`EnvelopeService`** (`domain/src/envelope-service.ts`) is pure: `createEnvelope`,
  `addDocument/Recipient/Field`, `send`, `applySignature`, `decline`, `void`,
  `authenticate`, `markViewed`, and the DG3 methods `expireIfDue`/`resend`/`remind`.
  It takes an injected `Clock` + `IdGenerator` (deterministic tests via `FixedClock`
  + `SeededIdGenerator`).
- **Effects** (`domain/src/effects.ts`): `NotifyEffect` (reasons: `your_turn |
  completed_copy | declined | reminder | resent | expired`), `StampEffect`,
  `FinalizeEffect`. Optimistic concurrency via a `version` CAS in the repo.

---

## 6. Subsystem detail (what's built, where, and why)

### PAdES cryptographic signatures (packages/pades)
Full ladder, each level OpenSSL-validated, built from a blueprint
(`docs/design/pades-ltlta-blueprint.md`) and adversarially reviewed
(`docs/review/pades-ltlta.md`):
- **B-B** basic CMS; **B-T** RFC 3161 signature timestamp; **B-LT** DSS (Document
  Security Store: cert chain + CRLs/OCSP for offline validation); **B-LTA** archive
  `/DocTimeStamp`.
- Hand-rolled **byte-preserving incremental-update writer** (`incremental.ts`) —
  pdf-lib has no incremental mode, so DSS/DocTimeStamp are true append-only revisions.
- `sealPdf(pdf, credential, {level, timestampAuthority, validationDataProvider})`;
  `verifyPdf` classifies signatures vs document-timestamps, relaxes coverage for
  legit DSS/DocTimeStamp appends while rejecting content tampering, checks
  revocation offline as-of the trusted time, reports the strongest level.
- **Ports:** `SigningCredential` (HSM/KMS-ready; `Pkcs12Credential` today),
  `TimestampAuthority` (in-process + HTTP), `ValidationDataProvider` (CRL/OCSP,
  in-process + HTTP).
- **CRITICAL fix baked in:** a trusted *document timestamp* must NOT satisfy
  whole-document *authenticity* — only a trusted CAdES **signature** does
  (`valid = cmsSigs.some(s => s.trusted && s.coversWholeDocument)`).
- Libs: pkijs, asn1js, @signpdf, node-forge, pdf-lib, @napi-rs/canvas.
- Server wiring via `PadesDocumentSealer` (`server/src/sealer.ts`) + env
  (`FINESIGN_PADES_LEVEL`, `FINESIGN_SEAL_P12`, `FINESIGN_DEV_SEAL`, `FINESIGN_TSA_*`).
- **Deferred:** P6g (link DocTimeStamp into `/AcroForm` to survive normalizers),
  Adobe/EU-DSS conformance testing, per-signer certs.

### DG1 — Signer identity + ESIGN/UETA consent + access-code auth
`docs/review/dg1-identity-consent.md`. Recipient fields: `authMethod`,
`accessCodeHash`, `authenticatedAt`, `failedAuthAttempts`, `lockedUntil`,
`consentedAt`, `consentDisclosureVersion`, `signerIp`, `signerUserAgent`.
`applySignature` gates on auth + consent, captures IP/UA (length-capped) + consent
version. Per-recipient brute-force lockout (`AccessCodeAttemptError` persists the
counter on the throw path). `ESIGN_CONSENT` disclosure rendered on the certificate.
Credential hashes redacted from API responses (preSerialization hook).

### DG2 — Text & checkbox fields
`FieldInput {fieldId, value}`; `applySignature` captures/validates text (required
non-empty, 5000-char cap) + checkbox (required==="true"). Stamped into the final PDF
by `server/src/stamping.ts` (`stampTextAndCheckboxes`, font-safe, top-left-frac →
bottom-left-points). Signer UI renders inline inputs/checkboxes.

### DG3 — Expiration + resend + reminders
`send(env, issueToken, {expiresInDays})` stamps `expiresAt`. `expireIfDue(env, now)`
transitions a past-deadline `sent` → new terminal `expired` and notifies the sender.
Two triggers: **lazy** (in `EnvelopeApp.resolveToken`, so any token touch expires it)
+ **sweep** (`POST /api/envelopes/sweep-expired` + a background ticker). `resend`/
`remind` re-mint a fresh token (old link stops resolving; raw tokens are never
stored) and email the active signer, guarded to whose turn it is + not yet signed.
New audit events `recipient_resent`/`recipient_reminded`/`envelope_expired`. No
storage migration (the `status` column is plain text). Web: expiry field on send +
per-recipient Remind/Resend buttons.

### DG4 — Webhooks (Connect-style event callbacks) — `docs/review/dg4-webhooks.md`
- **Persistence in `@finesign/storage`** (`webhook-store.ts`): `WebhookStore` port +
  `InMemoryWebhookStore` + `SqliteWebhookStore` + `webhook-contract.ts` (shared
  contract test). Durable outbox: `UNIQUE(subscription, envelope, eventId)`;
  forward-only fan-out via `event.at >= sub.createdAt` + per-(sub,env) high-water-mark
  `maxEnqueuedSeq` (no cursor table). **`claimDue` atomically leases** claimed rows
  (bumps `nextAttemptAt` forward) so concurrent drains never double-process.
- **Delivery/SSRF/HMAC in the server** (`webhooks.ts`): `WebhookDeliverer`,
  `signWebhook` = `sha256=HMAC(secret, "<unixTs>.<body>")` (timestamp-bound, replay
  defense), `isPublicIp`/`parseIp` (IPv4+IPv6 denylist incl. 169.254.169.254 metadata,
  IPv4-mapped/compatible/NAT64/6to4), `redirect:"manual"`, DNS-lookup timeout,
  exponential backoff + dead-letter, in-process re-entrancy guard.
- **Fan-out is inline + best-effort** in `EnvelopeApp.persistThenDeliver`
  (`enqueueWebhooks`) — never throws into the signing flow.
- **Routes** (behind the API key): `POST/GET/DELETE /api/webhooks`,
  `GET /api/webhooks/:id/deliveries`, `POST /api/webhooks/deliver`. Secret returned
  ONCE on create, redacted from all other reads. Background drain via a ticker in
  `index.ts` (`FINESIGN_WEBHOOK_POLL_MS`).
- **Reviewed:** 6 confirmed findings fixed — the HIGH was non-atomic `claimDue` +
  overlapping drains → duplicate deliveries + attempts-race (fixed by the lease +
  guard); plus an `isPublicIp` fail-open on IPv4-compatible/6to4 and a per-POST
  signature-timestamp bug.

### DG5 — Encryption at rest — `docs/review/dg5-encryption.md`
- **`EncryptedBlobStore`** (`storage/src/encrypted-blob-store.ts`): transparent
  decorator over any `BlobStore`. AES-256-GCM, random 96-bit IV per blob,
  self-describing frame `magic|version|keyId|iv|tag|ciphertext` with the header
  **and the blob's storage key** as AAD (blocks version/key swaps AND ciphertext
  relocation). **Fail-closed by default** (`allowPlaintextRead:false`); legacy
  plaintext passthrough is an explicit env-gated migration mode.
- **KMS-ready `KeyProvider` port**; `LocalKeyProvider` keyring — active key seals
  new blobs, retired keys decrypt old ones; key ids derived from key material
  (SHA-256 prefix). Env: `FINESIGN_ENCRYPTION_KEY` (active) + `_DECRYPT_KEYS` (rotation).
- Wraps the blob store in both containers; documents/signed PDFs/certificates are all
  encrypted at rest, decrypted transparently on read.
- **Reviewed:** 8 confirmed findings fixed — headline was the plaintext-passthrough
  defeating tamper detection (flipped to fail-closed); AAD now binds the storage key;
  boot warns when encryption is off. Confidentiality vs a read-only attacker was never
  at risk.

---

## 7. Conventions & invariants (respect these)

- **The gate must stay green.** `npm run gate`. CI should run it.
- **Async-AI-free domain / effects pattern:** domain is pure and returns effects;
  the server (`app.ts`) executes them post-save in `persistThenDeliver`.
- **Errors** (`@finesign/shared/errors.ts`): `ValidationError` 400, `NotFoundError`
  404, `AuthorizationError` 403, `ConflictError(code,msg)` 409, etc. `assert.throws`
  in tests matches the **message**, not the `code` (they're separate fields).
- **Secrets are never stored raw except where required to sign** (webhook secret);
  tokens/access-codes are stored only as SHA-256 hashes; credential hashes are
  redacted from API responses; signer links are bearer credentials — never logged.
- **Storage adapters share a contract test** (`repositories.test.ts`,
  `webhook-contract.ts`) so in-mem/SQLite/Postgres behave identically. New
  entity fields must be added to the sample fixtures in the contract files.
- **Tests are deterministic:** `FixedClock` + `SeededIdGenerator`; inject
  `fetchImpl`/`resolveHost`/`docxRunner`/mailer rather than hitting the network.
- **Web is JavaScript (JSX), not TS.** ESLint-clean is part of the gate.

---

## 8. Environment variables

All documented in **`.env.example`** (copy to `.env`). Only
`FINESIGN_SENDER_API_KEY` (≥16 chars) is required to boot. Groups: server
(`PORT`, `FINESIGN_BASE_URL`, `FINESIGN_DATA_DIR`, `FINESIGN_TRUST_PROXY`),
email (`SMTP_*`, `FINESIGN_MAIL_FROM` — console mailer if unset), encryption
(`FINESIGN_ENCRYPTION_KEY`, `_DECRYPT_KEYS`, `_ALLOW_PLAINTEXT_READ`), PAdES sealing
(`FINESIGN_SEAL_P12`/`_PASSPHRASE`/`_REQUIRED`, `FINESIGN_PADES_LEVEL`, `FINESIGN_TSA_*`,
`FINESIGN_DEV_SEAL`/`_TSA`), webhooks (`FINESIGN_WEBHOOK_POLL_MS`/`_TIMEOUT_MS`/
`_MAX_ATTEMPTS`/`_ALLOW_PRIVATE`), expiry (`FINESIGN_EXPIRY_SWEEP_MS`), dev
(`FINESIGN_DEV_EXPOSE_TOKENS`, `FINESIGN_SIGN_PATH`), web (`VITE_API_BASE`).

**Never set the dev-only flags in production:** `FINESIGN_DEV_EXPOSE_TOKENS`,
`FINESIGN_WEBHOOK_ALLOW_PRIVATE`, `FINESIGN_ENCRYPTION_ALLOW_PLAINTEXT_READ`,
`FINESIGN_DEV_SEAL`, `FINESIGN_DEV_TSA`.

---

## 9. Open-source readiness (done)

`LICENSE` (Apache-2.0) + `NOTICE`; every package's `license` field is `Apache-2.0`.
`README.md`, `SECURITY.md` (threat model + private-disclosure + residuals),
`CONTRIBUTING.md`, `.env.example`, `.gitignore`, `.dockerignore`.
`Dockerfile` (server + LibreOffice), `Dockerfile.web` (nginx, `docker/nginx.conf`
reverse-proxies the API), `docker-compose.yml`.
`npm run licenses` → `scripts/license-report.mjs` → `docs/DEPENDENCY-LICENSES.md`
(333 deps, all permissive — no strong-copyleft-only). Secrets sweep: clean.

---

## 10. Gotchas / non-obvious things

1. **`npm install --legacy-peer-deps` is mandatory** — a transitive
   `unpdf`/`@napi-rs/canvas` peer conflict breaks install otherwise.
2. **No CORS in the server.** The Docker web image serves the SPA and reverse-proxies
   the API so the browser sees a single origin. If you split origins, add CORS.
3. **Encryption fail-closed default:** with a key set, a stored blob lacking the
   `FSENC` magic is REFUSED (not served). Migration from an existing plaintext store
   needs `FINESIGN_ENCRYPTION_ALLOW_PLAINTEXT_READ=true` temporarily.
4. **`assert.throws(fn, /re/)` matches the error *message*, not the `code`.**
5. **pkijs/node-forge quirks** (documented in `pades/`): CONSTRUCTED eContent OCTET
   STRING handling; node-forge mis-derives leaf AKI (test leaves omit it); minimal-DER
   serials to satisfy OpenSSL.
6. **Adding an entity field** ripples to the storage contract fixtures and any literal
   `Envelope`/`Recipient` in tests.
7. **Signer link vs API path:** the human signer page is the web route `/s/:token`;
   the API's signer JSON is `/sign/:token`. In Docker, `FINESIGN_SIGN_PATH=/s` and
   `FINESIGN_BASE_URL` = the public web origin so email links land on the SPA.

---

## 11. What's NOT done (backlog / deferred)

Tracked in `docs/BACKLOG.md` + `docs/DOCUSIGN-PARITY.md`. Notable:
- **PAdES P6g** — link `/DocTimeStamp` into `/AcroForm` (survive PDF normalizers);
  Adobe/EU-DSS conformance; per-signer certificates; real KMS/HSM key + validation providers.
- **Webhooks** — pinned-lookup DNS-rebinding close-out (documented residual);
  automated *time-scheduled* reminders (today reminders are sender-initiated).
- **Encryption** — envelope *metadata* (SQLite/Postgres rows) is not encrypted, only
  blobs; retention/deletion/legal-hold; a KMS key provider.
- **Fields** — radio/dropdown, format masks (SSN/email/regex); edit/move/resize placed
  fields; anchor/text-tag auto-placement.
- **Workflow** — templates + bulk send; correct-a-sent-envelope / delegate-reassign.
- **Other** — branding/white-label, rich HTML email, embedded signing SDK, i18n;
  reusable saved signature; mobile signing polish.

---

## 12. How work was done this session (repeatable pattern)

Each **security-sensitive** subsystem (PAdES, DG1, DG4, DG5) got a **multi-agent
adversarial review**: parallel review "lenses" (SSRF, HMAC/replay, outbox
correctness, key-management, AEAD-misuse, auth, …) each producing structured
findings → **independent per-finding verification** (CONFIRMED/REFUTED/UNCERTAIN) →
fix the confirmed ones with regression tests → re-run the gate. The review write-ups
live in `docs/review/`. This caught real bugs (the webhook concurrent-drain race, the
encryption tamper-detection bypass, the IPv6 SSRF fail-open) that unit tests missed.

If you have the orchestration tooling: keep using that pattern for anything touching
crypto, auth, or untrusted input. Otherwise, review such changes by hand against the
threat model in `SECURITY.md`.

---

## 13. Where to look next (in-repo docs)

- `README.md` — public overview + quickstart.
- `FACTORY.md` — the build discipline / architecture rules.
- `docs/ARCHITECTURE.md`, `docs/PRD.md` — design.
- `docs/DOCUSIGN-PARITY.md` — the capability-by-capability parity ledger (start here
  to pick the next feature).
- `docs/BACKLOG.md` — the backlog.
- `docs/review/*.md` — adversarial-review reports (what was found + fixed).
- `docs/design/pades-ltlta-blueprint.md` — the PAdES long-term design.
- `CHANGELOG.md` — chronological, detailed.
- `docs/DEPENDENCY-LICENSES.md` — generated dependency-license report.
