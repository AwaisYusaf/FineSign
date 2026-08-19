# Security Policy

FineSign is an e-signature product, so we take security seriously. This document
covers how to report a vulnerability, the threat model, and known residual risks.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.** Instead, use
GitHub's **private vulnerability reporting** ("Report a vulnerability" under the
repository's *Security* tab), or email the maintainers listed in the repository
metadata. We aim to acknowledge within 3 business days and to ship a fix or
mitigation before any public disclosure. We're happy to credit reporters.

## Supported versions

FineSign is pre-1.0; security fixes land on `main`. Pin a commit and watch the
repository for updates until tagged releases begin.

## Deployment hardening checklist

- **Set a strong `FINESIGN_SENDER_API_KEY`** (≥16 chars; the app refuses to boot
  without it). It gates the entire management API — treat it as an admin secret.
- **Enable encryption at rest** — set `FINESIGN_ENCRYPTION_KEY` (`openssl rand -hex
  32`). Without it, documents are stored in the clear (a boot warning is logged).
- **Terminate TLS** in front of FineSign and set `FINESIGN_TRUST_PROXY` to an
  explicit CIDR/hop count (not `true`) so the recorded signer IP can't be forged.
- **Never set the dev-only flags in production**: `FINESIGN_DEV_EXPOSE_TOKENS`,
  `FINESIGN_WEBHOOK_ALLOW_PRIVATE`, `FINESIGN_ENCRYPTION_ALLOW_PLAINTEXT_READ`,
  `FINESIGN_DEV_SEAL`, `FINESIGN_DEV_TSA`.
- **Firewall egress** if you accept operator-configured webhooks (defense in depth
  against SSRF/DNS-rebinding — see residuals below).
- For cryptographic seals that verify in Adobe/EU tooling, use a **CA-issued
  PKCS#12** seal cert (`FINESIGN_SEAL_P12`) and a pinned **RFC 3161 TSA**, and
  consider `FINESIGN_SEAL_REQUIRED=true` (fail-closed).

## Threat model (summary)

| Asset | Protection |
| --- | --- |
| Management API | Bearer API-key auth on every `/api/*` route; credential hashes redacted from responses. |
| Signer links | Unguessable, expiring, single-recipient tokens; only the SHA-256 hash is stored; a resend rotates the token. |
| Signer identity/consent | IP + user-agent + timestamps + ESIGN/UETA consent recorded in the hash-chained audit; optional access-code auth with per-recipient brute-force lockout. |
| Document integrity | PAdES (CMS/PKI) seals + whole-document coverage checks; a tamper-evident, hash-chained audit log (`verifyAuditChain`). |
| Documents at rest | AES-256-GCM per-blob (random IV, storage-key-bound AAD); fail-closed reads; key rotation. |
| Webhook delivery | HMAC-SHA256 signatures with timestamp binding (replay defense); SSRF guard (resolve + private-range denylist, no redirects); durable outbox with atomic lease + retry. |

Each security-sensitive subsystem was hardened via a multi-agent adversarial
review; the reports live in [`docs/review/`](docs/review/).

## Known residual risks (documented, accepted for the current release)

- **Webhook DNS rebinding (TOCTOU).** The SSRF guard resolves and validates every
  IP and refuses redirects, but a hostile authoritative DNS could rebind between
  our lookup and the socket connect. Mitigated by default-deny private ranges + a
  short timeout; fully closing it needs a pinned-lookup dispatcher. Firewall egress
  for high-assurance deployments.
- **Envelope metadata is not encrypted at rest.** DG5 encrypts document *blobs*;
  the SQLite/Postgres envelope rows (titles, recipient emails, audit) are not.
- **No built-in KMS/HSM.** The signing-credential and encryption-key ports are
  KMS-ready, but only local/env-backed providers ship today.

These are tracked in [docs/BACKLOG.md](docs/BACKLOG.md) /
[docs/DOCUSIGN-PARITY.md](docs/DOCUSIGN-PARITY.md).
