# ADR-0003: PAdES / PKI cryptographic signatures

- **Status:** accepted
- **Date:** 2026-07-11
- **Scope:** the `@finesign/pades` module and its integration into the envelope
  lifecycle. This is the legal-grade core: cryptographic, tamper-evident,
  independently verifiable signatures embedded in the PDF itself.

## Context

Until now FineSign signatures are **visual overlays** (a drawn/typed mark) plus a
**hash-chained audit trail** and a certificate page. That is strong evidence, but
it is not a *cryptographic* signature: a third party (a court, Adobe Reader, a
counterparty) cannot mathematically verify that the completed PDF hasn't been
altered since signing, nor that a specific key attested to it.

PAdES (PDF Advanced Electronic Signatures, **ETSI EN 319 142**) is the PDF profile
of CAdES (**ETSI EN 319 122** / CMS, **RFC 5652**). It embeds a detached CMS
SignedData object inside the PDF via the standard signature dictionary
(`/Type /Sig`, `/ByteRange`, `/Contents`), so any conformant validator (Adobe
Acrobat, the EU DSS validator, etc.) can verify integrity, the signing
certificate, and the signing time.

### PAdES baseline levels (ETSI EN 319 142-1)

| Level | Adds | Guarantee |
|---|---|---|
| **B-B** (Basic) | CMS SignedData + signed attrs (content-type, message-digest, **signing-certificate-v2**, signing-time); `SubFilter ETSI.CAdES.detached` | integrity + signer certificate binding |
| **B-T** (Timestamp) | RFC 3161 signature timestamp (unsigned attr) | proves the signature existed at time T (independent of the signer's clock) |
| **B-LT** (Long-Term) | validation material (cert chain + CRL/OCSP) in the PDF **DSS** | verifiable after certs expire / CA revocation info is gone |
| **B-LTA** (Long-Term Archive) | a document timestamp over the DSS | integrity of the validation material over decades |

## Decisions

### 1. The signing model: **platform seal**, extensible to per-signer certs

After all human signers complete (visual marks stamped + certificate appended),
the **platform applies one PAdES signature over the final PDF** using the
platform's organizational signing certificate. This is exactly how DocuSign /
Adobe Sign seal a completed envelope: the humans' identities are captured by the
audit trail + certificate page; the cryptographic seal provides integrity and the
platform's non-repudiable attestation of the completed state.

Per-signer PAdES signatures (each signer's own X.509 cert, multiple signature
fields, sequential incremental updates) are a **later extension** — the module's
ports and incremental-update signing are designed so this drops in without
rework, but it requires per-user PKI enrollment we don't have yet.

### 2. Libraries — vetted crypto, never hand-rolled ASN.1

- **CMS / PAdES construction & verification:** **PKIjs** (`pkijs` + `asn1js` +
  `pvutils`). PKIjs is the most standards-complete JS PKI library — it models CMS
  SignedData, ESS `signing-certificate-v2`, and RFC 3161 timestamps directly, so
  we produce *correct* PAdES-B-B/B-T, not an approximation.
- **PDF signature mechanics** (placeholder, `/ByteRange` computation, splicing the
  CMS into `/Contents` via incremental update): **`@signpdf`** (`@signpdf/signpdf`,
  `@signpdf/placeholder-pdf-lib`, `@signpdf/utils`). Byte-exact `/ByteRange`
  handling is error-prone; using the maintained, purpose-built library here is the
  robust choice, not a shortcut. We inject a **custom `Signer`** that builds the
  PKIjs CMS — so `@signpdf` owns the PDF bytes and we own the cryptography.
- **Test-fixture cert/P12 generation only:** `node-forge` (self-signed CA + leaf +
  PKCS#12) — dev/test scaffolding, never on the production signing path.

FACTORY §1.3 note: `@finesign/pades` is an **adapter-tier** package (it does
crypto + touches keys), not a pure package. `finesign-core` and `@finesign/domain`
stay pure and gain no crypto dependency.

### 3. HSM/KMS-ready credential port

The private-key operation is behind a port:

```
interface SigningCredential {
  certificate(): Uint8Array;          // signer cert, DER
  chain(): Uint8Array[];              // issuer chain, DER (leaf-first, excl. leaf)
  digestAlgorithm(): "SHA-256" | "SHA-384" | "SHA-512";
  signatureScheme(): "RSASSA-PKCS1-v1_5" | "RSASSA-PSS" | "ECDSA";
  sign(tbs: Uint8Array): Promise<Uint8Array>;  // sign the DER-encoded signedAttrs
}
```

`sign(tbs)` receives the **DER-encoded SET OF signed attributes** (the exact bytes
CMS signs) and returns the raw signature. A software `Pkcs12Credential` implements
it locally; an HSM/KMS credential implements the same `sign` remotely — so the CMS
assembly never sees the raw key material. This is the correct, future-proof seam.

### 4. Verification is a first-class, standalone capability

"Legal" is meaningless without **independent verification**. `@finesign/pades`
ships a verifier that, given a signed PDF:
- parses every signature dictionary and recomputes each `/ByteRange` digest;
- **checks coverage** — flags any signature that does not cover the whole document
  (the classic "signature valid but only over part of the file" attack);
- verifies the CMS signature against the signing certificate;
- checks the `message-digest` and `signing-certificate-v2` signed attributes;
- validates the certificate chain to a configured **trust store**;
- verifies the RFC 3161 timestamp (B-T) if present;
- returns a structured verdict (valid/invalid, per-signature reasons, signer
  identity, coverage, signing time, timestamp).

## Phases (sub-tasks — each ends with a green gate)

- **P0** — this ADR + `@finesign/pades` skeleton + dependency vetting spike.
- **P1** — `SigningCredential` port + `Pkcs12Credential` + test-fixture PKI
  (self-signed CA→leaf, P12). Tested: load, expose cert/chain, sign, verify.
- **P2** — PAdES-**B-B** signer: ETSI.CAdES.detached placeholder → ByteRange →
  PKIjs CMS (content-type, message-digest, signing-time, signing-certificate-v2)
  → splice. Tested by producing a signed PDF.
- **P3** — PAdES **verifier**: ByteRange + coverage + CMS + attrs + chain-to-trust
  + tamper detection. Tested valid / tampered / partial-coverage.
- **P4** — PAdES-**B-T** (DONE): RFC 3161 `TimestampAuthority` port + in-process TSA
  + HTTP client. The timestamp imprint is over the **SignerInfo signature value**;
  the token embeds as the `id-aa-signatureTimeStampToken` unsigned attr. The verifier
  checks the token signature, `messageImprint == hash(signature)`, the critical
  `id-kp-timeStamping` EKU, and (when pinned) the TSA chain as-of `genTime`; only a
  trusted, **anchored** timestamp's `genTime` extends the signer-cert validity window.
  Designed from `docs/design/pades-bt-blueprint.md`; hardened by an adversarial review
  (`docs/review/pades-bt.md`, incl. a CRITICAL SubjectKeyIdentifier signer-resolution
  forgery). Independently validated with OpenSSL `ts -verify`.
- **P5** — lifecycle integration: platform-seal the completed PDF (B-B, or B-T if a
  TSA is configured); store the sealed copy; `GET …/verify` endpoint. Integration
  tested end-to-end incl. tamper.
- **P6** — PAdES-**B-LT/LTA** (DONE): DSS (chain + CRL) via a hand-rolled,
  byte-preserving incremental-update writer, plus a `/DocTimeStamp` archive
  timestamp. A `ValidationDataProvider` port supplies the material (in-process test
  CA now; HTTP CDP/AIA later). The verifier classifies signatures vs document
  timestamps, RELAXES coverage for legitimate DSS/DocTimeStamp appends while
  rejecting content tampering + render-reachable overlay injection, and validates
  chain+revocation offline as-of the trusted time. Designed from
  `docs/design/pades-ltlta-blueprint.md`; hardened by an adversarial review
  (`docs/review/pades-ltlta.md`, incl. a CRITICAL timestamp-authenticity bypass).
  OpenSSL `crl -verify` + `ts -verify` independently validate.
- **P7** — adversarial crypto self-critique (coverage attacks, ASN.1 parsing
  safety, algorithm downgrade, key handling, cert-time checks) + fixes.

## Security & correctness invariants (non-negotiable)

- **Whole-document coverage**: the platform seal must cover the entire final file;
  the verifier must reject/flag any signature that doesn't.
- **No weak algorithms**: SHA-256 minimum; reject MD5/SHA-1 digests on verify.
- **signing-certificate-v2** (ESS, SHA-256 cert hash) is mandatory in B-B — binds
  the signature to a specific certificate (defeats cert-substitution).
- **Deterministic tests**: injected clock; test PKI generated per-run (no committed
  private keys); timestamps from an in-process TSA — the whole path is reproducible
  and offline.
- **Keys never logged**; passphrases never logged; the CMS assembly never holds the
  raw key (only the `sign(tbs)` result).
- **Fail closed**: if sealing is enabled but the credential can't load, the server
  refuses rather than silently delivering an unsealed "completed" document.

## Consequences

- New adapter package `@finesign/pades` with the crypto deps above; the gate gains
  its build/lint/tests. Pure packages remain crypto-free (boundary guard unchanged).
- Completed documents become Adobe-verifiable and tamper-evident — the feature that
  unlocks legally-binding agreements.
- B-LT/LTA and per-signer certs are explicitly staged as follow-ons; the design
  does not preclude them.
