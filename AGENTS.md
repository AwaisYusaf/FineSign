# AGENTS.md — FineSign

The short brief for AI coding agents (and humans in a hurry). The full rules live
in [FACTORY.md](FACTORY.md); this is what you need in your head before touching
code. If this file and the code disagree, the code wins — fix this file in the
same change.

FineSign is an open-source, self-hostable e-signature platform (a DocuSign
alternative): upload PDF/DOCX → place fields → route to signers → sign → a
PAdES-sealed PDF plus a hash-chained audit trail. TypeScript (strict) npm-workspaces
monorepo end to end; the web UI is React 19 + Vite + Tailwind v4 + shadcn/ui.

## Commands

| Command | What it does |
| --- | --- |
| `npm install --legacy-peer-deps` | Install. The flag is **required** (transitive peer conflict). |
| `npm run gate` | The definition of done: boundaries + build + type-aware lint + all tests + web lint/build. ~15 s. Must be green. |
| `npx tsc -b` | Build + typecheck every package in dependency order. |
| `npm test -w @finesign/<pkg>` | One package's tests (`core` is `-w finesign-core`). |
| `cd packages/<pkg> && node --test --import tsx test/<file>.test.ts` | One test file. |
| `npm run lint` · `npm run boundaries` | Lint only · purity/direction check only. |
| `npm run e2e` | Browser end-to-end suite (Playwright): production UI build + real API, desktop and phone. ~15 s. First time: `npx playwright install chromium`. See `packages/e2e/README.md`. |
| `npm run dev:api` · `npm run dev:web` | API on :4000 (loads `.env`) · web UI on :5173 (proxies to :4000). |

**Tests import other packages from their built `dist/`.** After editing `domain`,
`shared`, `storage`, … run `npx tsc -b` before running a dependent package's tests,
or you are testing stale code.

## Layout and dependency direction

| Package | Role | I/O allowed? |
| --- | --- | --- |
| `packages/core` (`finesign-core`) | PDF stamping engine, standalone | **No** (one exception: its own font loader, ADR-0002) |
| `packages/shared` | Typed errors, `Clock`, `IdGenerator`, token hashing, `Logger` | No |
| `packages/domain` | Envelopes, recipients, fields, state machine, routing, hash-chained audit, ports | **No** |
| `packages/convert` | PDF passthrough + DOCX→PDF (LibreOffice) | Yes |
| `packages/storage` | Repositories (in-memory/SQLite; Postgres envelope repo is experimental and unwired), blob stores, webhook store, encryption at rest | Yes |
| `packages/pades` | PAdES B-B → B-LTA sealing + verification | Yes — see [its AGENTS.md](packages/pades/AGENTS.md) |
| `packages/server` | Fastify API + composition root (`container.ts`) | Yes |
| `packages/web` | Sender console + signer page + webhooks admin | Browser — see [its AGENTS.md](packages/web/AGENTS.md) |
| `packages/e2e` | Playwright end-to-end suite (boots its own API + web on :4010 / :5180) | Test-only |

Dependencies point one way: `core`/`shared` → `domain` → `storage`/`convert`/`pades`
→ `server` → (HTTP) → `web`. `domain` imports only `@finesign/shared` and
`finesign-core`. `scripts/check-boundaries.sh` enforces purity and direction.

## Hard rules

1. **The gate is law.** Not done until `npm run gate` is green — zero errors, zero warnings.
2. **Pure stays pure.** No `fs`/`net`/`http`/`child_process`/`process.env`/DB in `core` or `domain`.
3. **Tests ship with code.** Domain logic gets unit tests; every API route gets an
   integration test. A bug fix lands with a regression test that fails without the fix.
4. **No stubs pretending to work.** Unfinished paths throw `NotImplementedError`;
   never return fake data or swallow an error.
5. **Typed public surfaces.** Each package exports through `src/index.ts`. No `any`,
   no deep imports across packages.
6. **Security by default.** Signer links are unguessable, expiring, single-recipient;
   tokens and access codes are stored only as SHA-256 hashes; uploads are checked by
   magic bytes and size-capped; authorization is re-checked on every transition; no
   secret or signer link is ever logged.
7. **Every envelope state change emits an append-only audit event.**
8. **Non-obvious decisions get an ADR** in `docs/adr/`; exported functions get JSDoc
   saying *why*, not *what*.
9. **Public repo.** Examples, fixtures, comments and commit messages stay
   domain-neutral (`signer_signature`, "Jane Q. Public", `example.com`). Never name
   or describe another organization's systems, schema or data.

## How the code is shaped

- **Request path:** `server/src/http.ts` (thin routes, the ONE error→HTTP mapping)
  → `EnvelopeApp` (`server/src/app.ts`) → pure `EnvelopeService` (`domain`), which
  returns `{ nextState, effects[] }` → the app persists, then executes effects
  (mail, stamp, seal, webhooks) in `persistThenDeliver`. Effects are best-effort
  after the save; a mail failure never un-commits a transition.
- **State machines** are table-driven in `domain/src/state-machine.ts`. New status
  or transition → add it there, with tests; illegal transitions throw.
- **Errors** are typed classes in `shared/src/errors.ts` with a stable `code` and
  `httpStatus`. Never throw strings. In tests, `assert.throws(fn, /re/)` matches the
  **message**, not the code.
- **Determinism:** inject `Clock` and `IdGenerator` (`FixedClock`, `SeededIdGenerator`
  in tests); inject `fetchImpl`, `resolveHost`, `docxRunner`, the mailer. Tests never
  touch the network or the real LibreOffice binary.
- **Logging:** the injected `Logger` only. `console.*` is a lint error outside
  `shared/src/logger.ts`.
- **Configuration** is read only in `server` (`container.ts`, `index.ts`), at
  build/boot time — never at module import. An empty FineSign setting (`KEY=`) means
  "default". A new setting goes in `.env.example` with a comment, and if it gates
  sealing, in `assertSealableLevel` too.
- **Concurrency:** repositories save with an optimistic version check. Any
  operation that can race other participants on a sent envelope (signer
  actions, remind/resend/void) runs inside `retryOnConflict` in `app.ts`. Wrap
  new ones the same way. Anything written BEFORE the save must be harmless if
  that attempt loses: blobs get fresh keys, and a fixed-key blob (the standalone
  certificate) is written only after the save succeeds.
- **Storage adapters share contract tests** (`storage/test/repositories.test.ts`,
  `storage/src/webhook-contract.ts`). SQLite is the supported production store
  (decision D7); new stores need in-memory + SQLite adapters. A new envelope field
  means: update the contract fixtures and every envelope repository (the
  experimental Postgres one included, while it exists); SQL repos keep a
  denormalized `expires_at` that must track the aggregate.
- **Coordinates:** one convention everywhere — display-space fractions (0–1),
  top-left origin. `core` converts to PDF points.

## Gotchas that have bitten before

- `ConsoleLogger` spreads context **before** `level`/`msg` so a context key can't
  overwrite severity. Don't "tidy" it.
- `.dockerignore` needs `**/*.tsbuildinfo` (with `**/`), or the image builds with
  no entrypoint.
- No CORS on the server: dev uses the Vite proxy, Docker uses the nginx proxy —
  the browser always sees one origin.
- With an encryption key set, a stored blob without the `FSENC` header is
  **refused** (fail-closed). Migration needs `FINESIGN_ENCRYPTION_ALLOW_PLAINTEXT_READ=true`.
- The human signer page is the SPA route `/s/:token`; `/sign/:token` is the JSON API.
- Dev-only flags that must never reach production: `FINESIGN_DEV_EXPOSE_TOKENS`,
  `FINESIGN_DEV_SEAL`, `FINESIGN_DEV_TSA`, `FINESIGN_WEBHOOK_ALLOW_PRIVATE`,
  `FINESIGN_ENCRYPTION_ALLOW_PLAINTEXT_READ`.

## How work is planned

No feature starts in code. First a **problem analysis** (what's missing and why
it matters — `docs/plan/`), then a **ticket** per change from
`docs/tickets/TEMPLATE.md` (problem, design, numbered acceptance criteria, test
plan, risks), then a **review** of the plan (an independent reviewer, then the
product owner approves), then implementation one ticket at a time, with commits
naming the ticket (`… (FS-006)`). A bug found while implementing a ticket is
fixed inside that ticket. See [`docs/tickets/README.md`](docs/tickets/README.md).

## Definition of done

- [ ] `npm run gate` green.
- [ ] Touched the web UI or a signer/sender flow? `npm run e2e` green too (CI runs it).
- [ ] New or changed behavior has tests; a bug fix has a regression test.
- [ ] Docs match reality: `docs/BACKLOG.md` (check off / file follow-ups),
      `CHANGELOG.md` (Unreleased), README / `.env.example` if usage or config changed.
- [ ] Security-sensitive change (crypto, auth, tokens, webhooks/SSRF, encryption,
      upload parsing)? Run an adversarial review against the diff — FACTORY §5's
      rubric; findings count only with a concrete failing input.

## Where to look

| Need | File |
| --- | --- |
| Product scope | `docs/PRD.md`, `docs/DOCUSIGN-PARITY.md` |
| Architecture | `docs/ARCHITECTURE.md`, `docs/adr/` |
| Current state, deeper context | `docs/SESSION-HANDOFF.md` |
| What to build next | `docs/tickets/README.md` (board), `docs/plan/` (why) |
| History of done / deferred items | `docs/BACKLOG.md` |
| Threat model | `SECURITY.md`, `docs/review/` |
| Every env var | `.env.example` |
