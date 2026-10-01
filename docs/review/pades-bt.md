# PAdES-B-T (RFC 3161) — adversarial review + fixes

An adversarial review of the PAdES-B-T implementation
(`@finesign/pades` + server wiring), with each finding independently verified by a
separate skeptic agent before it counted. Lenses: crypto-correctness, forgery /
clock-move security, standards conformance, robustness / DoS, integration / config.

**9 findings confirmed; all fixed, each with a regression test.** Gate green
(103 tests across 8 packages); OpenSSL independently verifies both the document
seal (`cms -verify`) and the token (`ts -verify -data <signature>`).

## Fixed

### CRITICAL — forged "trusted" seal via SubjectKeyIdentifier signer-id
`findSignerCert` only handled an `IssuerAndSerialNumber` `SignerInfo.sid` and fell
back to `certificates[0]` for any other `sid`. But PKIjs's `SignedData.verify`
resolves a `SubjectKeyIdentifier` `sid` by `SHA-1(subjectPublicKey)` and verifies
the signature against **that** cert. So an attacker could:

1. take the public platform seal cert from any sealed PDF;
2. build a CMS with `certificates = [genuinePlatformCert, attackerCert]`;
3. set `sid = SubjectKeyIdentifier(SHA-1(attackerCert SPKI))` and sign the signed
   attributes with the **attacker's** key, forging `signing-certificate-v2` to hash
   the genuine cert.

PKIjs verified the attacker's signature (integrity ✔), while `findSignerCert`
returned `certificates[0]` (the genuine cert), so common-name, the ESS check, and
**direct trust** all passed → `valid = true`. Document forgery.

**Fix** (`verify.ts findSignerCert`): resolve a `SubjectKeyIdentifier` `sid` exactly
as PKIjs does — `SHA-1(subjectPublicKey)` — and **never** fall back to
`certificates[0]`; return `null` on no exact match. Every downstream check (trust,
EKU, ESS, validity) now binds to the certificate that actually produced the
signature. Applies to both the document-signature and the TSA-token paths.
Regression: `pades-security.test.ts` (attacker signature verifies, but signer
resolves to the attacker cert → not trusted → invalid).

### HIGH — fail-open clock-move on an un-anchored timestamp
The RFC 3161 token is an **unsigned** CMS attribute, so anyone can strip the real
one and insert a self-signed TSA's token over the (public) signature bytes. The
verifier accepted such a token on crypto merits alone and let its `genTime` become
the effective signing time, **reviving an expired/revoked signer cert**.

**Fix** (`verify.ts verifyTimestampToken`): a timestamp only moves the effective
signing time when it is **anchored** — i.e. a `tsaTrustStore` is configured and the
TSA chains/pins to it (validated as-of `genTime`). Un-anchored timestamps are still
reported `present`/`valid` on crypto merits but never extend validity (fail-closed,
mirroring the document trust store). The same SKI fix above closes the TSA-pinning
bypass. Regression: `pades-bt.test.ts` (un-anchored timestamp does not resurrect an
expired cert).

### HIGH — empty `SignerInfos` threw out of the verifier
A structurally-valid `SignedData` with an empty `SignerInfos` SET made
`sd.signerInfos[0]` undefined, and the later `.digestAlgorithm` access threw out of
`verifyPdf`. **Fix**: guard immediately after parse → degrade to an invalid verdict
with a `problems[]` note. Regression in `pades-security.test.ts`.

### HIGH — production external-TSA left trust pinning optional
`FINESIGN_TSA_URL` without `FINESIGN_TSA_CERT` produced no trust anchor. Combined
with the fail-open above, a forged timestamp could revive an expired seal. **Fix**:
the verifier no longer moves the clock without an anchor, and `container.ts` now
warns prominently when an external TSA is configured without a pinned cert
(timestamps are recorded but do not extend validity).

### LOW — hardening
- **DER-minimal serials**: the in-process TSA emitted `00 01` (non-minimal, OpenSSL
  rejects); certificate serials used `"00" + random` (non-minimal ~50 % of the time
  — a latent OpenSSL/Adobe flake). Both now emit minimal positive DER integers.
- **In-process TSA serial** now encodes the full counter (no wrap/reuse after 65 536
  tokens).
- **HTTP TSA client**: case-insensitive `content-type` match (RFC 7231), a 64 KB
  response cap (no OOM from a hostile/MITM'd endpoint), and a malformed-DER guard.
- **Config clarity**: warn when `FINESIGN_TSA_*` is set but sealing is off, or when
  `FINESIGN_TSA_CERT` is set but ignored.

## Verified-safe (claims that did NOT survive verification)

The review also probed — and the code was confirmed correct on — the imprint being
over the signature value (not the ByteRange / OCTET STRING TLV), the DER SET-OF
ordering and `[0]→SET` re-tag, the token `SignedData` version (3), the
attached-vs-detached handling (the `id-data` retype dodges a PKIjs constructed-OCTET
-STRING bug without weakening the signature check), and `certReq:true` so the TSA
cert is embedded.
