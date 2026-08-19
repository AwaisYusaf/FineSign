# M4 Self-Critique — Security findings + triage

From the adversarial security pass (FACTORY §5). Status: `fix` = doing now,
`backlog` = filed, `ack` = accepted/documented.

| # | Sev | Finding | Decision |
|---|---|---|---|
| C1 | Critical | No auth on `/api/envelopes/*` — mass enumeration + IDOR download/void | **fix**: add a required sender API-key guard on management routes; production container throws if unset; loud boot warning otherwise |
| H2 | High | `ConsoleMailer` logs the raw signing link/token | **fix**: never log link/token; log only `to`+`subject` |
| M3 | Medium | `content-disposition` filename injection via `doc.name` | **fix**: sanitize filename (RFC-safe) |
| M4 | Medium | DOCX parsed by LibreOffice (untrusted-parser surface) | **fix (partial)**: throwaway profile + timeout + `--norestore`; **backlog** X.7 full sandbox |
| L5 | Low | Authoring routes unrate-limited | **fix**: global rate limit in addition to public routes |
| L6 | Low | Error handler echoes 4xx messages from non-FineSign errors | **fix**: generic per-status message; only echo `FineSignError` |

Verified sound (recorded, no action): token entropy/hash-only storage, expiry on
both signing paths, session-view authz (recipient sees only own fields/docs),
SQLite parameterization, blob path-traversal defense, upload magic+size caps,
signature-image bomb guard.
