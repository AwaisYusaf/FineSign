# FineSign — Software Factory Harness

This file is the **constitution** for building FineSign. Every change — human or
AI — obeys it. It exists so an autonomous agent can build the system in many
small, verifiable steps without drifting, cutting corners, or breaking what
already works. If a rule here conflicts with convenience, the rule wins.

> **North star:** FineSign is an open-source, self-hostable **e-signature &
> agreement-management platform** (a DocuSign alternative) built on the
> **`finesign-core`** signing engine. It signs **PDF and Word** documents.

---

## 1. Non-negotiables (the hard rules)

1. **Isolation.** All work lives under `finesign/` (git-ignored). The parent app
   (`va-claim-backend`) is never imported, modified, or depended on. No file
   outside `finesign/` is edited except this one boundary already set in the
   root `.gitignore`.
2. **The gate is law.** No task is "done" until `scripts/gate.sh` passes:
   typecheck + lint + unit tests + build, across every affected package, with
   zero errors and zero warnings. Red gate = not done. No exceptions, no
   "I'll fix it later."
3. **Pure core.** `finesign-core` and `@finesign/domain` are PURE: no I/O, no
   database, no network, no filesystem, no `process.env`. Side effects live only
   in adapter/server packages. A PR that adds `fs`/`net`/`db` to a pure package
   is rejected by definition.
4. **Tests ship with code.** Every new module lands with tests. Domain logic and
   coordinate/crypto math require unit tests; every API route requires an
   integration test. Bug fixes land with a regression test that fails before the
   fix.
5. **No stubs masquerading as done.** A function either works or throws
   `NotImplementedError` and its task stays open. Never return fake data from a
   half-built path. Never silently swallow an error.
6. **Typed boundaries.** Every package exposes a typed public API via its
   `index.ts`. No `any` on public surfaces. Cross-package calls go through
   published types, never deep imports.
7. **Security by default.** Signer links are unguessable tokens, expiring,
   single-recipient. Uploaded bytes are validated by magic number, size-capped,
   and never trusted by extension. No secret is logged. Authz is checked on
   every state transition, not just at the entrance.
8. **Reversible & auditable.** Every state change to an envelope emits an
   append-only audit event. Signing is idempotent and always re-derives from the
   original document.
9. **Document the why.** Non-obvious decisions get an ADR in `docs/adr/`. Public
   functions get JSDoc stating intent, not mechanics.
10. **Small steps.** One task = one coherent, gated change. If a task balloons,
    split it. Never leave the tree red between tasks.

---

## 2. Architecture rules

- **Dependency direction is one-way and acyclic:**

  ```
  core  ─┐
         ├─→  domain  ─→  storage(interfaces)  ─→  server  ─→  web
  shared ┘
  ```

  A package may only depend on packages to its LEFT. `core` depends on nothing
  internal. `web` depends on nothing but HTTP. No cycles, ever
  (`scripts/gate.sh` enforces via `madge` when wired).
- **Ports & adapters.** The domain defines interfaces (`EnvelopeRepository`,
  `BlobStore`, `DocumentConverter`, `Clock`, `Mailer`, `TokenService`). Concrete
  implementations live in adapter packages and are injected. The domain never
  news up an adapter.
- **PDF is the signing substrate.** Word (`.docx`) is supported by *normalizing
  to PDF* through a `DocumentConverter` before any stamping. `finesign-core`
  itself stays PDF-only and pure.
- **One coordinate convention** (display-space fractions, top-left origin) across
  the whole stack — the same `finesign-core` already uses.
- **Explicit state machine.** Envelope/recipient status transitions are defined
  in one place, table-driven, and every transition is validated + audited.

---

## 3. Definition of Done (per task)

A task is DONE only when ALL hold:

- [ ] Code compiles (`tsc`, strict) with no errors.
- [ ] Lint passes with no errors/warnings.
- [ ] New/changed logic has tests; whole suite is green.
- [ ] `scripts/gate.sh` exits 0.
- [ ] Public API is typed and JSDoc'd; no `any` leaks.
- [ ] Pure packages stayed pure (no new I/O deps).
- [ ] An ADR exists for any non-obvious decision.
- [ ] `docs/BACKLOG.md` updated (task checked off; follow-ups filed).
- [ ] No TODO left without a filed backlog item referencing it.

---

## 4. The autonomous build loop

The agent repeats this loop, one backlog item at a time:

```
1. SELECT   the next unblocked, highest-priority item from docs/BACKLOG.md.
2. SPEC     restate the item as an acceptance checklist (what proves it works).
3. BUILD    implement the smallest slice that satisfies the checklist + tests.
4. GATE     run scripts/gate.sh. If red → fix → repeat. Never proceed on red.
5. CRITIQUE spawn an adversarial reviewer (see §5) against the diff.
6. TRIAGE   for each finding: fix now, or file a backlog item with rationale.
7. RE-GATE  after fixes, gate must be green again.
8. RECORD   check the item off, update backlog, write an ADR if warranted.
9. LOOP     go to 1. Stop only when the milestone's exit criteria are met.
```

**Stop conditions:** stop and surface to the human only when (a) a genuine
product decision is required that isn't covered by the PRD, (b) an external
capability is missing (e.g. a DOCX converter binary) and cannot be stubbed
honestly, or (c) a milestone is complete and ready for review.

---

## 5. Self-critique rubric (the reviewer's lens)

Each critique pass is adversarial — it tries to break the change, not bless it.
Findings are ranked by severity and must be *verified* (a concrete failing
input), not speculative. Dimensions, in priority order:

1. **Correctness** — wrong output, broken state transition, race, off-by-one,
   mishandled rotation/units, lost data.
2. **Security** — authz gaps, token guessability/leakage, injection, unvalidated
   upload, secret exposure, missing rate limits on public routes.
3. **Data integrity** — audit completeness, idempotency, no partial writes,
   migrations reversible.
4. **Architecture** — dependency-direction or purity violations, adapter leaks,
   cyclic deps, god modules.
5. **API contract** — typed, consistent errors, documented, versionable.
6. **Tests** — do they actually assert behavior? Any path uncovered? Any test
   that can't fail?
7. **Simplicity** — dead code, needless abstraction, duplication that should be
   shared.

A finding is only "resolved" when fixed with a regression test OR consciously
deferred as a backlog item with a written reason.

---

## 6. Coding standards

- TypeScript strict everywhere. `noUnusedLocals`, `noUnusedParameters`,
  `noImplicitAny`, `exactOptionalPropertyTypes` where feasible.
- `async/await` only; no floating promises (must be awaited or `void`-marked).
- Errors are typed classes with a stable `code`; HTTP maps `code`→status in ONE
  place. Never throw bare strings.
- Names: `camelCase` values, `PascalCase` types, `kebab-case` files.
- No `console.log` in library/server code — use the injected logger.
- Every exported function: JSDoc with the *why* + non-obvious contracts.
- Time comes from an injected `Clock`; randomness from an injected source — so
  tests are deterministic.

---

## 7. Milestones & exit criteria

| # | Milestone | Exit criteria |
|---|---|---|
| M0 | **Harness + core** | This file + PRD + ARCH + BACKLOG exist; `finesign-core` builds & tests green in the monorepo; gate script works. |
| M1 | **Domain model** | Envelope/Document/Recipient/Field + status machine + audit log, fully unit-tested; pure. |
| M2 | **Doc normalization** | PDF passthrough + DOCX→PDF converter port; a `.docx` can be normalized and signed end-to-end (converter injected). |
| M3 | **Storage** | Repository + blob interfaces with in-memory AND SQLite impls passing one shared contract test. |
| M4 | **API server** | draft → add docs/recipients/fields → send → tokenized signer session → sign → complete → download, with audit; integration-tested. |
| M5 | **Sender + signer web UI** | Create/send an envelope and sign it from a browser against the real API. |
| M6 | **Trust layer** | Tamper-evident audit certificate page; groundwork for PAdES/PKI (see core ROADMAP). |

"Product is ready" (this session's target) = **M0–M4 complete and green**, with
M5 scaffolded and M6 specced. Each milestone ends with a human-review checkpoint.

---

## 8. Ground truth & bookkeeping

- `docs/PRD.md` — what we're building and why (product spec).
- `docs/ARCHITECTURE.md` — how the system fits together.
- `docs/BACKLOG.md` — the living, prioritized task list (source of the build loop).
- `docs/adr/` — decision records, numbered, append-only.
- `packages/*/README.md` — per-package contract.
- `CHANGELOG.md` — human-readable log of what shipped each milestone.

If reality and a doc disagree, fix the doc in the same task. Docs are code.
