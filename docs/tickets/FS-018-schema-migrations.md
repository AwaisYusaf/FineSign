# FS-018 — Versioned schema migrations

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P0 (enabler) | M | M6.9 Fix first | Decision D7 (which SQL stores are supported) | NFR-6 | Approved |

## Problem
The SQL adapters create tables "if not exists" and patch old databases with ad
hoc probes (`migrateExpiresAt` in `sqlite-repository.ts` checks `PRAGMA
table_info`). The plan adds about five tables and three columns (users,
sessions, tokens, one-time tokens, activity log, `owner_id`, `search_text`,
`next_notify_at`). Doing each with another probe is fragile, unordered and
impossible to reason about across upgrades.

## Goal
Each SQL store has an explicit, ordered list of migrations recorded in a
`schema_version` table, applied once at boot under a lock, so any older database
upgrades predictably.

**Out of scope:** down-migrations (forward-only; restore from backup instead),
data migrations of blobs.

## Design
- `storage/src/migrations/` — per adapter, an ordered array of `{ id, up(db) }`.
  Migration 1 reproduces today's schema exactly (including `expires_at`), so an
  existing database is recognized and stamped at version 1 without changes.
- Runner: open a transaction (SQLite `BEGIN IMMEDIATE`; Postgres advisory lock if
  D7 keeps Postgres), read `schema_version`, apply pending steps in order, record
  each. A database newer than the code refuses to boot with a clear message.
- The existing `migrateExpiresAt` probe becomes migration 2's job (kept
  idempotent for databases that already have the column).
- Docs: a short "Upgrading and backups" section — back up the SQLite file (or
  database), the blob directory and the encryption/seal keys together.

## API and data changes
New `schema_version` table; no API change.

## Acceptance criteria
1. A database created by the current release (with and without `expires_at`)
   boots, is stamped at the latest version, and its data is intact.
2. A fresh database ends at the latest version with the same schema as an
   upgraded one (compared by `sqlite_master` / `information_schema`).
3. Two processes booting at once apply each migration exactly once.
4. A database at a higher version than the code refuses to boot with a message
   naming both versions.
5. A failing migration rolls back and the server does not start.

## Test plan
- `storage`: criteria 1–5 on SQLite (fixture databases created with the old
  code paths) and on pg-mem if D7 keeps Postgres.

## Security and risks
Data loss on a bad migration: transaction per step, backup guidance, refuse
unknown versions.

## Docs to update
README (upgrading and backups), AGENTS.md (how to add a migration), CHANGELOG.
