# FS-025 — Slow, salted hashes for access codes

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P2 | S | M7 Accounts & access | FS-001a (scrypt helper) | parity 2 follow-on | Approved |

## Problem
Access codes are stored as unsalted SHA-256 (`hashToken` in
`app.ts`/`shared`). They are short and low-entropy (often 4–6 digits), so anyone
who reads the database can recover every code instantly by hashing all
candidates. The online brute-force lockout does not help against an offline
attacker.

## Goal
Access codes are stored with the same salted, slow hash as passwords, and
existing SHA-256 codes keep working until replaced.

**Out of scope:** longer codes or SMS/email OTP (parity 3).

## Design
- `addRecipient` stores `scrypt$…` (FS-001a's helper) instead of SHA-256.
- `authenticate` verifies either format: `scrypt$…` via scrypt verify, a bare hex
  hash via the current constant-time SHA-256 compare (legacy). Successful
  verification of a legacy hash does not rewrite it (the raw code is only in the
  request; rewriting would be possible but adds a save on a hot path — decide in
  implementation; default: leave legacy as is).
- The domain stays pure: the server hashes and verifies; the domain receives a
  verifier function (as it receives `issueToken`).

## API and data changes
None externally; stored hash format change.

## Acceptance criteria
1. A newly added access code is stored in `scrypt$…` form, and the right code
   authenticates.
2. An envelope created before the change (SHA-256 code) still authenticates with
   the right code and rejects a wrong one.
3. Lockout behaviour is unchanged.

## Test plan
- `domain` + `server`: criteria 1–3, with a fixture recipient holding a legacy
  hash.

## Security and risks
scrypt cost on the public authenticate route: covered by the existing public
rate limit and FS-001a's scrypt concurrency cap.

## Docs to update
SECURITY.md (threat model row), CHANGELOG.
