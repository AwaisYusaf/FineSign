# FineSign

**Open-source, self-hostable e-signature & agreement management — a DocuSign /
Adobe Sign alternative you run yourself.** Sign **PDF and Word** documents, route
them to multiple signers, capture legally-meaningful consent + identity, and keep
every byte on your own infrastructure with no per-signature fees.

Built on **`finesign-core`**, a standalone PDF signing engine, plus a pure
agreement domain, a hardened Fastify API, and a React web UI.

## Highlights

- **Full envelope lifecycle** — draft → add documents (PDF or DOCX) → place fields
  → route to sequential/parallel signers → sign → **completed**, with a
  **hash-chained, tamper-evident audit trail** and a rendered **certificate of
  completion**.
- **Cryptographic signatures (PAdES)** — seal completed PDFs at **B-B / B-T / B-LT
  / B-LTA** (RFC 3161 timestamps, DSS with CRL/OCSP, archive timestamps) so they
  verify offline for decades. Independently validated with OpenSSL.
- **Legally-credible signing** — ESIGN/UETA electronic-signature **consent**
  capture, **signer identity** (IP + user-agent + timestamps), and optional
  per-recipient **access-code** authentication with brute-force lockout.
- **Fields** — signature, initials, auto-dated, **text, and checkbox**, stamped
  into the final PDF (rotation-correct).
- **Workflow** — envelope **expiration**, manual **resend**, **reminders**.
- **Webhooks** — DocuSign-Connect-style **HMAC-signed event callbacks** with a
  durable outbox, retry/backoff, and an SSRF-guarded deliverer.
- **Encryption at rest** — transparent **AES-256-GCM** for every stored blob, with
  key rotation (KMS-ready key provider).
- **Self-hostable** — SQLite + local filesystem out of the box (Postgres adapter
  included); one-command Docker Compose.

Each security-sensitive subsystem was hardened with a multi-agent adversarial
review — see `docs/review/`.

## Monorepo layout

| Package | What it is |
| --- | --- |
| [`finesign-core`](packages/core) | The pure PDF signing engine (stamp signatures/dates/text, rotation-correct). Standalone. |
| [`@finesign/shared`](packages/shared) | Typed errors, `Clock`, id/token generation, logger. |
| [`@finesign/domain`](packages/domain) | Pure agreement model: envelopes, recipients, fields, state machine, hash-chained audit, ports. |
| [`@finesign/convert`](packages/convert) | Document normalization: PDF passthrough + DOCX→PDF (LibreOffice). |
| [`@finesign/storage`](packages/storage) | `EnvelopeRepository` + `BlobStore` + webhook store adapters (in-memory, SQLite, Postgres, local FS) + encryption-at-rest decorator. |
| [`@finesign/pades`](packages/pades) | PAdES B-B→B-LTA signing + verification (CMS/PKI, RFC 3161, DSS). |
| [`@finesign/server`](packages/server) | Fastify REST API + composition root: sealing, webhooks, encryption wiring. |
| [`@finesign/web`](packages/web) | React (JS) web UI — sender console + signer page + webhooks admin. |

Architecture and rules: [FACTORY.md](FACTORY.md) ·
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[DocuSign-parity ledger](docs/DOCUSIGN-PARITY.md) · [CHANGELOG.md](CHANGELOG.md).

## Quick start (dev)

```bash
npm install --legacy-peer-deps
npm run gate                              # boundaries + build + typecheck + lint + tests + web
cp .env.example .env                      # set FINESIGN_SENDER_API_KEY at minimum
npm start --workspace @finesign/server    # API on :4000 (SQLite + local blobs)
npm run dev  --workspace @finesign/web    # web UI on :5173
```

> `--legacy-peer-deps` is required (a transitive `unpdf`/`@napi-rs/canvas` peer
> conflict otherwise breaks install).

## Self-host with Docker

```bash
cp .env.example .env        # set FINESIGN_SENDER_API_KEY (and, recommended, FINESIGN_ENCRYPTION_KEY)
docker compose up --build   # API on :4000, web on :8080
```

Data (SQLite + encrypted blobs) persists in the `finesign-data` volume. DOCX
support and email need LibreOffice (bundled in the image) and SMTP (set `SMTP_*`).

## The lifecycle in one glance

```
POST /api/envelopes                              → create a draft
POST /api/envelopes/:id/documents                → upload a PDF or DOCX (normalized to PDF)
POST /api/envelopes/:id/recipients               → add signers (sequential or parallel; optional access code)
POST /api/envelopes/:id/fields                   → place signature/date/text/checkbox fields
POST /api/envelopes/:id/send                     → validate, issue tokens, email signers (optional expiresInDays)
POST /api/envelopes/:id/recipients/:rid/remind   → nudge / resend a fresh link
GET  /sign/:token                                → signer opens their session (their docs only)
POST /sign/:token/authenticate                   → access-code challenge (if required)
POST /sign/:token/apply                          → consent + signature + field values → stamped
GET  /api/envelopes/:id/documents/:doc/download  → the signed (and sealed) PDF
GET  /api/envelopes/:id/documents/:doc/verify    → PAdES verification result
GET  /api/envelopes/:id/certificate              → certificate of completion (audit + hashes)
POST /api/webhooks                               → register an event callback endpoint
```

Interactive API docs: `GET /docs` (OpenAPI at `/openapi.json`). All `/api/*`
routes require the sender API key (`Authorization: Bearer <FINESIGN_SENDER_API_KEY>`).

## Signing PDF vs Word

`finesign-core` signs PDFs. Word (`.docx`) is **normalized to PDF** on upload via
a `DocumentConverter` (the LibreOffice reference adapter). If LibreOffice is absent
the server fails loudly rather than silently dropping the file.

## Security

FineSign is a signing product; security posture, the threat model, and how to
report a vulnerability live in [SECURITY.md](SECURITY.md). In short: the
management API is API-key-gated, signer links are unguessable expiring
single-recipient tokens, signatures are cryptographic PAdES + a tamper-evident
audit trail, blobs are encrypted at rest, and webhook delivery is SSRF-guarded.

## Configuration

Every environment variable is documented in [.env.example](.env.example). Only
`FINESIGN_SENDER_API_KEY` is required to boot.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The one rule that keeps the codebase
honest: **`npm run gate` must be green** (it enforces the architecture boundaries,
build, type-aware lint, and the full test suite).

## License

[Apache-2.0](LICENSE). Bundled signature fonts are under the SIL Open Font License.
See [NOTICE](NOTICE).
