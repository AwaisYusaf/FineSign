# FS-020 — Observability: request logs, readiness, queue health

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P2 | M | M11 Hardening & operations | FS-009a (retry queue) for its counters | NFR-1 (self-hostable) | Approved |

## Problem
Fastify runs with `logger: false` (`http.ts`), so there are no request logs.
`/health` always answers `ok` without checking the database, the blob store or
SMTP. There is no way to see webhook dead letters, mail failures or expiry-sweep
health except by reading the database. An operator learns something is broken
when a user complains.

## Goal
Operators get structured request logs that never contain secrets, a readiness
check that reflects real dependencies, and an admin view of background queues.

**Out of scope:** bundling Prometheus/Grafana; tracing.

## Design
- Request logging through the injected `Logger` (method, route pattern, status,
  duration, request id). Signer routes are logged by **pattern** (`/sign/:token`)
  so the token never appears; query strings dropped; `authorization` and cookies
  never logged.
- `GET /health` stays a cheap liveness probe; new `GET /ready` checks the store
  (a trivial query), the blob store (write+read+delete of a probe key under a
  reserved prefix) and, when SMTP is configured, a cached transport `verify()`
  (at most once a minute). Returns 503 with which check failed (no secrets).
- `GET /api/admin/queues` (admin): webhook outbox pending / dead-lettered, mail
  retries pending / failed (FS-009a), last expiry and reminder sweep times.
  Shown on an Admin → "System" page.
- Optional `/metrics` (Prometheus text format, behind `FINESIGN_METRICS=true`)
  with the same counters; decided in implementation if cheap.

## API and data changes
`GET /ready`, `GET /api/admin/queues`, optional `GET /metrics`; Docker healthcheck
switches to `/ready`.

## Acceptance criteria
1. Every request produces one log line with method, route pattern, status and
   duration; a request to `/sign/<token>` logs `/sign/:token`, and no log line in
   the test suite contains a token, cookie or API key.
2. `/ready` returns 503 naming the failing dependency when the store or blob
   store is unavailable, and 200 otherwise.
3. The queues endpoint reports correct counts for seeded pending and
   dead-lettered webhook deliveries; senders get 403.

## Test plan
- `server`: capturing logger over the whole integration suite asserting no
  secret patterns (token formats, `Bearer`, `fs_session`); `/ready` with a failing
  fake store and blob store; queue counts.

## Security and risks
Logs are the classic secret leak: redaction by route pattern and a suite-wide
assertion. `/ready` must not reveal configuration details.

## Docs to update
README (operations), docker compose healthcheck, SECURITY.md, CHANGELOG.
