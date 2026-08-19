# FineSign → DocuSign Parity Roadmap

Where FineSign stands against DocuSign / Adobe Sign, from the multi-agent critical
review (see `docs/review/critical-review.md`). Ordered by what unlocks a credible,
legally-defensible product. ✅ have · 🟡 partial · ⛔ missing.

## What FineSign already has
Envelopes (draft→send→sign→complete/void/decline), sequential + parallel routing,
signer/approver/cc roles, tokenized single-recipient signing links, drawn/typed
signatures + auto-date, PDF **and** DOCX, a hash-chained **audit trail** + a
**certificate of completion appended to the sealed PDF**, and — the differentiator
— **cryptographic PAdES-B-B signatures** (detached CMS, signing-certificate-v2,
independently verifiable, OpenSSL-validated) with whole-document coverage +
tamper/forgery/append defenses. SMTP + OpenAPI + a React sender/signer UI.

## The legally-load-bearing gaps (do these to be credible)

### Tier 1 — assurance & identity (what makes a signature hold up)
1. ✅ **Trusted timestamp — PAdES-B-T** (RFC 3161 TSA). Proves *when* a signature
   existed independent of the signer's clock, and lets verification survive
   seal-cert expiry. **Done** (pades **P4**): `TimestampAuthority` port + in-process
   TSA + HTTP RFC 3161 client; imprint over the signature value; verifier enforces
   the token signature, message-imprint, critical `id-kp-timeStamping` EKU, and
   (when pinned) TSA chain-to-anchor as-of `genTime`. OpenSSL `ts -verify`
   independently validates the token. Next: **B-LT/LTA** for decade-scale validity.
2. ✅ **Signer identity capture on the certificate**: IP address, user-agent, and
   per-action timestamps, plus the **ESIGN/UETA consent-to-sign-electronically**
   disclosure + an explicit consent event recorded in the hash-chained audit and
   rendered on the certificate of completion. **Done** (DG1). Follow-ons: a slow
   KDF for the access-code hash; geolocation.
3. 🟡 **Recipient authentication step-up**: **access code done** (DG1 — per-recipient
   brute-force lockout, gated session, hashed secret). SMS/email OTP + KBA/ID-document
   remain (need a delivery/verification provider).
4. 🟡 **Encryption at rest** done (DG5): an `EncryptedBlobStore` decorator AEAD-seals
   every blob (AES-256-GCM, random 96-bit IV, frame header as AAD) over any store, so
   documents/signed PDFs/certificates never touch disk in the clear. KMS-ready
   `KeyProvider` port; `LocalKeyProvider` keyring with per-blob key ids + rotation
   (`FINESIGN_ENCRYPTION_KEY` + `_DECRYPT_KEYS`). Follow-on: retention/deletion/
   legal-hold; a real KMS/HSM key provider.
5. 🟡 **CA-issued (not self-signed) seal cert + HSM/KMS-backed key**. The
   `SigningCredential.sign(tbs)` port is HSM-ready; wire a real KMS adapter.
6. ✅ **PAdES-B-LT / B-LTA** (DSS with chain + CRL; archive `/DocTimeStamp`) for
   decade-scale validity. **Done** (pades **P6**): a byte-preserving incremental
   writer appends the DSS + document timestamp; the verifier validates the chain +
   revocation offline as-of the trusted time and reports the level. OpenSSL
   `crl -verify` + `ts -verify` independently validate. Follow-ons: OCSP-based B-LT,
   an HTTP validation-data provider for production, and Adobe/EU-DSS conformance.

### Tier 2 — signing experience & field types
7. ✅ **Text & checkbox fields** captured at signing + stamped into the completed
   PDF, with **required-field enforcement** (DG2). Field values are recorded on the
   envelope. Follow-ons: radio/dropdown, format masks (SSN/email/regex), and
   font-safe rendering on rotated pages.
8. ⛔ **Edit/move/resize/delete placed fields** + drag-to-place polish + mobile signing.
9. ⛔ **Anchor / text-tag auto-placement** (place fields by keyword in the doc).
10. 🟡 **Adopt/reusable saved signature**, uploaded signature image.

### Tier 3 — workflow & integration (table stakes)
11. ⛔ **Templates** (reusable envelope definitions) + **bulk send**.
12. 🟡 **Manual resend + reminders + envelope expiration** done (DG3): `send` takes
    `expiresInDays`; a past-deadline envelope transitions `sent → expired` (lazily on
    the next token touch and via a `POST /api/envelopes/sweep-expired` sweep),
    refusing further signing and emailing the sender. Per-recipient `resend`/`remind`
    re-mint a fresh token (the old link stops resolving) and email the signer. Both
    are audited (`recipient_resent`/`recipient_reminded`/`envelope_expired`).
    Follow-on: **automated** time-based reminder scheduling (a cron/worker cadence);
    today reminders are sender-initiated and expiry needs the sweep or a touch.
13. ⛔ **Correct a sent envelope** / **delegate-reassign** a recipient.
14. ✅ **Webhooks / event callbacks** (Connect-style) done (DG4). Operators register
    subscriptions (URL + secret + event-type filter); each audit event fans out to
    matching subscriptions as durable outbox rows and is POSTed with an
    `X-FineSign-Signature: sha256=HMAC(secret,"<ts>.<body>")`, retried with backoff
    and dead-lettered. Idempotent + forward-only fan-out; SSRF-guarded delivery
    (resolve + private-range denylist, no redirects); secret shown once. Drained by
    `POST /api/webhooks/deliver` + a background ticker. Adversarially reviewed
    (`docs/review/dg4-webhooks.md`). Follow-on: pinned-lookup DNS-rebinding close-out.
15. ⛔ **Branding / white-label**, rich HTML email, embedded signing SDK, i18n.

## Sequencing recommendation
**Now:** P4 timestamps (1) → identity+consent capture (2) → text/checkbox capture (7).
These three make signatures legally credible and stop silent data loss.
**Next:** encryption at rest (4). *(Done: webhooks (14) via DG4; reminders/resend/
expiration (12) via DG3; access-code auth (3, partial) via DG1.)*
**Later:** templates/bulk (11), B-LT/LTA (6), KMS (5), field editor + auto-placement
(8–9), branding/embedded/i18n (15).

Full capability-by-capability status is in `docs/review/critical-review.md` §4.
