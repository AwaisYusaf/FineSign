# FS-005 — Server-side search, status filters and counts

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | M | M8 Authoring & dashboard | FS-002 (ownership scoping), FS-018 | PRD FR-R3 | Approved |

## Problem
`GET /api/envelopes` returns one page (50). The dashboard computes its status
counts and its search over that page only (`dashboard.tsx`), so with more than
50 envelopes the tab counts are wrong and search cannot find older envelopes.

## Goal
Counts are true totals, and search and status tabs query the server across every
envelope the user can see, with stable paging.

**Out of scope:** full-text search inside documents, date-range filters, sorting
other than newest first.

## Design
- `EnvelopeRepository.list` params gain `statuses?: EnvelopeStatus[]` and
  `query?: string`; new `countByStatus({ ownerId? })` returning a count per
  status.
- SQL adapters keep a denormalized `search_text` column (title + recipient
  names + emails), **normalized in JavaScript** (NFKC + `toLowerCase()`, since
  SQLite's `lower()` is ASCII-only), rewritten on every save and backfilled by an
  FS-018 migration; the query is normalized the same way and matched with
  `LIKE ? ESCAPE '\'` on escaped input (`%`, `_`, `\`). Index on
  `(owner_id, status, seq)`.
- **Lighter list responses:** the list returns whole aggregates today (audit
  trails included). Add `view=summary` (id, title, status, dates, recipients'
  name/email/role/status, progress) and make the dashboard use it; the full view
  stays the default for compatibility.
- In-memory adapter filters the same way; the shared contract test pins
  identical behavior.
- HTTP: `status` (comma-separated, validated against the enum, `closed` =
  declined + voided + expired), `q` (≤ 200 chars), with `before`/`limit`;
  `GET /api/envelopes/summary` → `{ all, draft, sent, completed, closed }`.
- Web: tabs and search drive the query (`["envelopes", { status, q, before }]`,
  search debounced 300 ms); counts come from the summary; paging cursors reset
  when the filter changes.

## API and data changes
- New query params on `GET /api/envelopes`; new `GET /api/envelopes/summary`.
- Migration adds `search_text` (+ index) to SQLite and Postgres.

## Acceptance criteria
1. With 120 envelopes, the tab counts equal the true totals per status.
2. Searching by a title word, a recipient's name or a recipient's email finds a
   matching envelope that is not on the first page.
3. Status tabs return only matching envelopes and page with `before` without
   repeats.
4. `q` containing `%`, `_` or `\` matches literally.
5. Counts and results respect ownership (a sender never counts another sender's
   envelopes).
6. A database created before this change is migrated and searchable.
7. Searching "łódź" finds an envelope titled "Łódź office lease" (non-ASCII
   case folding).
8. `view=summary` omits audit trails and fields, and the dashboard renders from
   it.

## Test plan
- `storage`: contract — status filter, query match (title/name/email, literal
  wildcards), counts, owner scoping, migration of an old schema.
- `server`: params validation (bad status → 400, long q → 400), summary route.
- `e2e`: seed via the API, search for an envelope beyond page one (stubbed list
  is not enough here — use a per-test owner from FS-002 so other tests can't
  interfere).

## Security and risks
SQL injection (parameterized + escaped LIKE); expensive scans (index + limit
cap; `q` length cap).

## Docs to update
CHANGELOG, BACKLOG, web AGENTS.md (query keys).
