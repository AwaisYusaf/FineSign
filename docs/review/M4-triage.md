# M4 Self-Critique — consolidated triage (correctness + security + architecture)

`fix` = doing this pass · `backlog` = filed · `ack` = accepted/verified.

## Correctness
| # | Sev | Finding | Decision |
|---|---|---|---|
| K1 | High | 3 `date_signed` fields on a page fragment into MM/DD/YYYY (core group-of-3 split) | **fixed ✓**: add `dateFormat:"full"` to core anchor; stamping sets it for FineSign dates |
| K2 | Med-High | `decline` emails "Completed" + never notifies sender | **fixed ✓**: new `declined` notify reason + sender notification + reason note |
| K3 | Med | audit `id` excluded from hash chain (tamperable) | **fixed ✓**: include `id` in hashed core |
| K4 | Med | effects run before `repo.save` → dead links / wedged envelope on save failure | **fixed ✓**: persist state-changing effects, save, THEN external effects (notify/finalize) |
| K5 | Med/Low | `addField` accepts off-page boxes (no x+w≤1) | **fixed ✓**: validate via core `drawnBoxError` |
| K6 | Low | typed-name scale ignores field width (overflow) | **fixed ✓**: bound scale by width too |
| K7 | Low | routing `activeRecipients` fragile if decline ever non-terminal | **fixed ✓**: exclude declined from lowest-order calc |

## Security
| # | Sev | Finding | Decision |
|---|---|---|---|
| S1 | Critical | No auth on `/api/envelopes/*` (enumeration + IDOR download/void) | **fixed ✓**: sender API-key guard; prod container requires it |
| S2 | High | raw token/link logged by `ConsoleMailer` | **fixed ✓**: never log link/token |
| S3 | Med | `content-disposition` filename injection | **fixed ✓**: sanitize filename |
| S4 | Med | DOCX → LibreOffice untrusted-parser surface | **fix (partial)**: throwaway profile + timeout; **backlog** X.7 full sandbox |
| S5 | Low | authoring routes unrate-limited | **fixed ✓**: global rate limit |
| S6 | Low | error handler echoes non-FineSign 4xx messages | **fixed ✓**: generic per-status message |

## Architecture / rules
| # | Sev | Finding | Decision |
|---|---|---|---|
| A1 | High | `finesign-core` reads fonts from disk (pure-core violation) | **fixed ✓**: ADR-0002 documented exception + correct PRD/ARCH + purity guard allows only `fonts.ts` |
| A2 | Med-High | gate has no lint step (FACTORY requires it) | **fixed ✓**: add ESLint + `lint` gate step |
| A3 | Med | purity/boundaries not machine-enforced | **fixed ✓**: `check-boundaries.sh` gate step |
| A4 | Med | `LocalFsBlobStore.get` masks all errors as NotFound | **fixed ✓**: ENOENT-only translate + test |
| A5 | Low-Med | domain imports node `crypto` directly | **fixed ✓**: route via `@finesign/shared` sha256 |
| A6 | Low | unused `Mailer` port in domain | **fixed ✓**: move Mailer type to server |
| A7 | Low | backlog M0.3 unchecked though done | **fixed ✓**: check it |

## Verified sound (no action)
multi-signer stamp chaining, finalize hashes fresh bytes, re-sign/turn guards,
notify de-dup, canonicalJson nesting, token entropy/hash-only storage, expiry on
both paths, session-view authz, SQLite parameterization, blob traversal defense,
upload caps, signature-image bomb guard, dep direction/ports/no-cycles, audit
verified on critical path, both repos pass one contract.
