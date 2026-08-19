# @finesign/pades

Cryptographic PDF signatures to **ETSI PAdES** standards — the module that makes
FineSign agreements legally defensible. Seal a PDF with a detached CMS signature
embedded in the document, and **independently verify** it (integrity, whole-
document coverage, signed attributes, trust).

Standards: ETSI EN 319 142 (PAdES) · ETSI EN 319 122 / RFC 5652 (CAdES/CMS) ·
RFC 5035 (ESS signing-certificate-v2). See
[ADR-0003](../../docs/adr/0003-pades-cryptographic-signatures.md).

## What it does

- **Seal** (`sealPdf`) — adds a `SubFilter: ETSI.CAdES.detached` signature via an
  incremental update: a signature dictionary with `/ByteRange` + `/Contents`
  holding a CMS SignedData over the whole file. Signed attributes: content-type,
  message-digest, signing-time, and **signing-certificate-v2** (binds the
  signature to a specific certificate). PAdES-**B-B** today.
- **Verify** (`verifyPdf`) — for every signature: recomputes the ByteRange
  digest, verifies the CMS signature, enforces **whole-document coverage** (no
  bytes outside the ByteRange — defeats the "valid over part of the file /
  appended change" attack), checks message-digest + signing-certificate-v2,
  validates trust (direct-pin or chain-to-CA), and rejects weak digests (SHA-1/MD5).
- **Credentials** (`SigningCredential`) — the private-key seam. `sign(tbs)` signs
  the DER-encoded signed attributes, so the raw key never reaches the CMS
  assembly; a software `LocalSigningCredential` (PKCS#12/PFX, or self-signed for
  dev) implements it, and an HSM/KMS credential would implement the same interface.

## Usage

```ts
import { generateSelfSignedCredential, sealPdf, verifyPdf, LocalSigningCredential } from "@finesign/pades";

// Production: load your organizational signing certificate.
const credential = LocalSigningCredential.fromPkcs12(fs.readFileSync("seal.p12"), passphrase);
// Dev/demo:
// const { credential } = generateSelfSignedCredential({ commonName: "Acme Inc." });

const sealed = await sealPdf(pdfBytes, credential, { reason: "Agreement completed" });

const result = await verifyPdf(sealed, { trustStore: [credential.certificate()] });
// result.valid, result.signatures[0].{ integrity, coversWholeDocument, digestMatches,
//   signingCertMatches, trusted, signerCommonName, signingTime }
```

In FineSign, the server seals a document at completion (`PadesDocumentSealer`) and
exposes `GET /api/envelopes/:id/documents/:documentId/verify`.

## Signing model

The **platform seal**: after all human signers complete, the platform applies one
PAdES signature over the final PDF with its organizational certificate — the
same model DocuSign/Adobe Sign use to make a completed envelope tamper-evident.
Signer identities are captured by the hash-chained audit trail + certificate page;
the seal provides cryptographic integrity and the platform's attestation.
Per-signer certificates are a designed-for extension (see roadmap).

## Configuration (server)

| Env | Effect |
|---|---|
| `FINESIGN_SEAL_P12` + `FINESIGN_SEAL_PASSPHRASE` | Seal with an org PKCS#12 cert. |
| `FINESIGN_DEV_SEAL=true` | Seal with a self-signed **dev** cert (not for production). |
| `FINESIGN_SEAL_REQUIRED=true` | Fail to boot if no credential is configured (fail-closed). |

## Level roadmap

- ✅ **B-B** (Basic) — implemented + tested (sign, verify, coverage, tamper, trust).
- ⏳ **B-T** (Timestamp) — RFC 3161 signature timestamp. Port + in-process TSA
  for deterministic tests (P4). Proves signing time independent of the signer's clock.
- ⏳ **B-LT** (Long-Term) — embed the certificate chain + CRL/OCSP revocation
  material in the PDF **DSS**, so the signature stays verifiable after certs
  expire. Needs live CA/OCSP infra to test end-to-end.
- ⏳ **B-LTA** (Long-Term Archive) — a document timestamp over the DSS for
  decade-scale integrity.
- ⏳ Per-signer certificates (each signer's own X.509, multiple signature fields).

## Verification against external validators

Internal tests prove sign↔verify consistency and attack detection. Before relying
on this legally, also validate output against **Adobe Acrobat** and the **EU DSS
demo validator** — those are the industry references. This is a manual step
tracked in the backlog (P7 follow-up).
