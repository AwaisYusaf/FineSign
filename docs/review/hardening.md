# Hardening-pass self-critique (cert / SMTP / OpenAPI / Postgres)

Adversarial review of the newly-added hardening code, then fixes.

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | High | Postgres `persist` non-atomic (4+ autocommit queries) → token index can briefly vanish (transient 404 on valid links) or be permanently lost on crash | **fixed**: every write runs in a single-connection `BEGIN/COMMIT` (`withTransaction`); `refreshTokens` runs inside it |
| 2 | Medium | `MAX(seq)+1` + SELECT-then-write `create` race under PG concurrency (duplicate `seq`, silent overwrite) | **fixed**: `seq` is a DB-assigned `bigserial`; `create` is a plain INSERT relying on the PK for atomic conflict detection (23505 → "already exists") |
| 3 | Low | `finalize` not defensively idempotent | **fixed**: documented the exactly-once domain guard; behavior verified correct |
| 4 | Low | dead `SmtpConfig.from` (never used by the transport) | **fixed**: removed the field |
| 5 | Low | auth hook prefix-checks raw `req.url` (bypass risk if routing normalization changes) | **fixed**: keys off the matched `req.routeOptions.url` |

Verified sound by the reviewer (no action): certificate placement/hashing/no-
signedBlobKey handling, link-never-logged, email injection resistance, nodemailer
v9 usage, Swagger/OpenAPI + auth-hook scoping, SQL parameterization, the lazy
`ready` init pattern, and `list()` limit/offset branches.

All resolved; gate green (boundaries + build + lint + 65 tests).
