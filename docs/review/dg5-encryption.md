# DG5 Encryption-at-rest — adversarial review

Multi-agent adversarial review (3 lenses — AEAD misuse, key management, decorator
integration — → per-finding independent verification) over
`packages/storage/src/encrypted-blob-store.ts` + the `container.ts` wiring.

**Result: 9 findings, 8 CONFIRMED (0 uncertain)** — collapsing to four real issues.
All fixed with regression tests; gate green (170 tests).

## Fixed

1. **MEDIUM — legacy plaintext passthrough defaulted ON and was unreachable to
   disable** (aead, keymgmt, integration lenses; the headline finding). With
   encryption enabled, `get()` decided whether to authenticate purely by sniffing
   the first 5 bytes for the `FSENC` magic; `allowPlaintextRead` defaulted to
   `true` and no config/env switch could turn it off. A write-capable attacker
   (compromised host / misconfigured bucket / insider) could overwrite a sealed
   blob with a forged `%PDF…` (no magic) and have it served verbatim — GCM
   authentication fully bypassed. **Fix:** flipped the default to **fail-closed**
   (`allowPlaintextRead: false` → a non-encrypted blob is refused, not served), and
   made migration mode an explicit, loud env opt-in
   (`FINESIGN_ENCRYPTION_ALLOW_PLAINTEXT_READ=true`, warns at boot). Regression: the
   strict default now rejects a legacy blob; passthrough must be explicitly enabled.

2. **LOW — AAD bound only version+keyId, not the blob's storage key** (keymgmt
   lens): a write-capable attacker could relocate one blob's ciphertext over
   another key (swap two documents) and it would still decrypt. **Fix:** `seal`/
   `open` take an optional `aad`; `EncryptedBlobStore` binds the blob key into the
   AEAD, so a relocated ciphertext fails to open. Regression: a copied ciphertext
   under a new key is rejected; the original location still opens.

3. **LOW — production booted with encryption silently disabled** when
   `FINESIGN_ENCRYPTION_KEY` was unset — no warning (integration, keymgmt).
   **Fix:** `buildProductionContainer` now warns loudly when at-rest encryption is
   off.

4. **LOW — `LocalKeyProvider` doc comment contradicted the code** ("the LAST key
   is active" vs the constructor's first `active` arg). **Fix:** corrected the doc.

## Not changed (by design)

- Confidentiality against a READ-only attacker was never at risk (findings agreed):
  new writes are always sealed, sealed blobs never leak, random 96-bit IV per blob,
  GCM tag verified. The confirmed issues were integrity/tamper-detection and
  operational-safety hardening, now closed.
- KMS/HSM key provider + retention/deletion/legal-hold remain documented follow-ons.
