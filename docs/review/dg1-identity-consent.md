# DG1 — signer identity + ESIGN/UETA consent + access-code auth — review + fixes

A 4-lens adversarial review (access-code brute-force, consent/auth bypass, captured-
identity integrity, audit consistency) with independent per-finding verification.
**6 findings confirmed; all fixed, each with a regression test.** Gate green (125
tests across 8 packages).

## Fixed

### HIGH — hostile signer User-Agent permanently bricked envelope completion
An attacker-controlled `User-Agent` with a non-WinAnsi code point (emoji, CJK, or an
undefined CP1252 byte like `0x81`) was stored raw and rendered via `pdf-lib`'s
`drawText` in the certificate of completion — whose WinAnsi encoder **throws** on
unencodable input. Because certificate generation runs inside `finalize` *before*
the sent→completed state is persisted, the throw wedged the envelope in `sent`
forever (a co-signer could deny completion to everyone). **Fix**: the certificate
renderer now falls back to an ASCII-safe string if `drawText` throws (it can never
fail), and the domain length-caps the captured UA/IP. Regression: a completion with
an emoji/CJK/undefined-byte UA still succeeds and yields a valid PDF.

### HIGH — access code brute-forceable (no per-recipient lockout)
The low-entropy access code was only throttled by the shared per-IP rate limit, so
rotating IPs made guesses unbounded. **Fix**: per-recipient `failedAuthAttempts` +
`lockedUntil` — the recipient locks for 15 min after 6 failures (persisted even on
the throwing path via a state-carrying `AccessCodeAttemptError`), regardless of
source IP; a minimum access-code length is enforced at creation. Regression:
lock-after-N, correct-code-refused-while-locked, unlock-after-window.

### MEDIUM — credential-equivalent hashes serialized in API responses
`GET /api/envelopes/:id` returned the full aggregate including `accessCodeHash` and
`tokenHash`, enabling an offline dictionary attack on the short code from a leaked
response. **Fix**: a `preSerialization` hook strips `tokenHash` + `accessCodeHash`
from every recipient in any envelope payload. Regression asserts they are `null`.

### LOW — `trustProxy=true` allows a forged signer IP; certificate consent version
`trustProxy=true` trusts `X-Forwarded-For` from any hop (forgeable IP in the legal
record) — now warned at boot, recommending an explicit trusted-proxy CIDR. And the
certificate now prints the disclosure version the signer *actually* consented to
(stored per-recipient) rather than the current constant.

## Verified-safe

The consent gate itself (a signature is rejected unless `consented`), the auth gate
(documents/signing refused until authenticated), the constant-time hash compare, and
the audit-chain ordering (consent immediately before signed) were probed and
confirmed correct.
