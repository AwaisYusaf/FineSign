# PAdES crypto self-critique (P7) — findings + resolutions

Adversarial cryptography review of `@finesign/pades`, plus an **independent
external check with OpenSSL** (`openssl cms -verify`). All findings fixed and
locked with regression tests.

## External conformance
`openssl cms -verify -binary` **successfully verifies** our PAdES-B-B signatures
(structure via `openssl cms -cmsout -print` shows all four signed attributes incl.
`signingCertificateV2`). This is independent confirmation the CMS is standards-
conformant. (The producer was correct all along — an early "failure" was a missing
`-binary` flag causing OpenSSL to CRLF-mangle the binary PDF content.)

## Findings
| # | Sev | Finding | Resolution |
|---|---|---|---|
| C1 | Critical | `verifyPdf().valid` didn't require `trusted` → a self-signed forgery OR an appended signed revision returned `valid:true` | **fixed**: `valid` now requires every signature sound AND a **trusted** signature covering the whole document; requires a trust store. Tests: untrusted→invalid, no-store→invalid, append-signed-revision→invalid |
| H1 | High | verification time ignored; no cert validity/expiry check | **fixed**: `at` threaded in; leaf `notBefore ≤ at ≤ notAfter` enforced; expired/pinned cert no longer trusted. Test: past-time→not trusted |
| H2 | High | weak-algo gate only checked `SignedData.digestAlgorithms[0]` | **fixed**: screen `SignerInfo.digestAlgorithm` (authoritative), reject weak signature OIDs (MD5/SHA-1), enforce RSA ≥ 2048 |
| M1 | Medium | ByteRange/coverage parsing under-validated (gap contents, bounds, overlap) | **fixed**: structural validation (bounds, ordering, `^\s*<hex>\s*$` gap). Test: malformed ByteRange→invalid |
| M2 | Medium | EC `signatureAlgorithm` hardcoded to ecdsa-with-SHA256 | **fixed**: OID selected from the digest (`ecdsaOid`) |
| M3 | Medium | P12 leaf detection RSA-modulus-only; wrong leaf for EC/CA-first bundles | **fixed**: match by SubjectPublicKeyInfo (RSA+EC) via Node crypto; throw if no match |
| L1 | Low | fail-closed not enforced at completion | **fixed**: `sealRequired` config; `finalize` throws if required-but-missing |
| L2 | Low | signer cert matched by serial only | **fixed**: match issuer + serial (no guessing) |
| L3 | Low | signing-certificate-v2 reader assumed DEFAULT hashAlgorithm omitted | **fixed**: handles an explicit hashAlgorithm |
| L4 | Low | signing-time UTCTime past 2050 | **fixed**: GeneralizedTime for years ≥ 2050 |

## Verified sound by the reviewer (no action)
DER SET OF ordering of signed attributes (consistent tbs↔stored), ESSCertIDv2
structure, `rsaEncryption` + NULL params, RSASSA-PKCS1-v1.5 via `crypto.sign`,
`digestMatches` non-circular, direct-trust byte-equality, server persistence
ordering (sealed bytes stored before save; no race; single `finalize`), no
key/passphrase leakage.

## Still open (tracked in backlog, not shipped as done)
- **External-validator conformance beyond OpenSSL**: Adobe Acrobat + EU DSS demo
  validator (manual step; can't run headless here).
- **B-T / B-LT / B-LTA** levels (timestamps, DSS, archive timestamp).
- Chain-engine `verificationTime` for intermediate certs (leaf validity is checked;
  pkijs chain uses current time).
