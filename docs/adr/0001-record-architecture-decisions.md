# ADR-0001: Record architecture decisions & foundational choices

- **Status:** accepted
- **Date:** 2026-07-10

## Context

FineSign is being built autonomously in many small steps. We need a durable
record of *why* choices were made so later steps (and reviewers) don't relitigate
or accidentally violate them.

## Decision

1. **Use ADRs.** Every non-obvious decision gets a numbered, append-only record
   in `docs/adr/`. ADRs are immutable once accepted; supersede rather than edit.

2. **Monorepo with npm workspaces**, TypeScript strict throughout. One language,
   one toolchain, shared config via `tsconfig.base.json`.

3. **Ports & adapters (hexagonal).** The domain owns interfaces; concrete I/O
   lives in adapter packages injected at the server composition root. This keeps
   `finesign-core` and `@finesign/domain` pure and testable, and makes storage /
   email / conversion swappable (SQLite→Postgres, local FS→S3) without touching
   business logic.

4. **PDF is the signing substrate; DOCX is normalized to PDF.** Stamping a Word
   file directly is unreliable; every serious e-sign product renders to a fixed
   layout first. `finesign-core` stays PDF-only and pure; a `DocumentConverter`
   port handles DOCX→PDF, with a LibreOffice reference adapter (the pragmatic,
   dependency-free-at-runtime choice for self-hosters).

5. **Visual overlay signatures now, cryptographic (PAdES/PKI) later.** M1–M5 ship
   overlay signatures + a hash-chained, tamper-evident audit trail and a
   certificate of completion. True embedded digital signatures are M6+, tracked
   in the core ROADMAP. We will always label which guarantee is in force.

6. **Determinism for tests.** Time and randomness are injected (`Clock`,
   `IdGenerator`) so the full lifecycle is reproducible.

## Consequences

- Adapters must satisfy a shared contract test (in-memory and SQLite behave
  identically) — more upfront test code, but confidence when swapping backends.
- DOCX signing requires a converter binary at deploy time; where absent, the
  server fails loudly (never silently drops to "PDF only" without saying so).
- Purity is enforced socially by FACTORY §1.3 and will be enforced mechanically
  by a dependency-cruiser check when wired.
