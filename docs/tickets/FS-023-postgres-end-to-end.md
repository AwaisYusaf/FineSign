# FS-023 — Postgres in production, end to end (if D7 says yes)

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P3 | M | M11 Hardening & operations | Decision D7, FS-018 | X.1; NFR-1 | Approved (P3 under D7: build only if Postgres support is wanted) |

## Problem
`PostgresEnvelopeRepository` exists and passes the contract test on pg-mem, but
the server never constructs it (`index.ts`, `container.ts` wire only SQLite), and
the webhook store has no Postgres adapter. The README presents Postgres as an
option; in practice nobody can run on it. Meanwhile AGENTS.md asks every new
store to have three adapters, which would mean writing Postgres code for about
five new stores that nothing can use.

## Goal
Either Postgres is a real, tested production option for every store, or the
project says plainly that SQLite is the supported store and stops requiring
Postgres adapters. Decision D7 picks; this ticket covers "support it".

**Out of scope (either way):** MySQL; clustering guidance beyond "several
FineSign processes on one Postgres".

## Design (if supported)
- `DATABASE_URL` selects Postgres at boot (via `pg`, with a pool); SQLite stays
  the default.
- Postgres adapters for the webhook store and every store added by M7–M9
  (users, sessions, tokens, one-time tokens, activity log), using FS-018
  migrations with an advisory lock.
- CI: a Postgres service container runs the storage contract tests against real
  Postgres (not only pg-mem) and one end-to-end lifecycle test.
- Docker compose profile `postgres`.

## If not supported
Correct the README and AGENTS.md (two adapters: in-memory + SQLite; the Postgres
envelope repository marked experimental), and drop the three-adapter rule from
new tickets.

## Acceptance criteria (if supported)
1. With `DATABASE_URL`, the server boots on Postgres, migrates, and passes the
   lifecycle integration test.
2. Every store's contract test runs green against real Postgres in CI.
3. Two FineSign processes on one database complete a parallel signing without
   lost updates.

## Test plan
CI Postgres service; contract suites parameterized by adapter; a two-process
test reusing the concurrency suite.

## Security and risks
Connection strings are secrets (never logged); TLS to the database documented.

## Docs to update
README, AGENTS.md (storage rule), `.env.example`, docker compose, CHANGELOG.
