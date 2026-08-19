# ADR-0002: `finesign-core` may lazily load its own bundled font assets

- **Status:** accepted
- **Date:** 2026-07-11
- **Supersedes/relates:** refines the "pure core" rule in FACTORY §1.3 and the
  purity claims in PRD §NFR-2 and ARCHITECTURE.

## Context

FACTORY §1.3 requires `finesign-core` (and `@finesign/domain`) to be pure — "no
I/O … no filesystem." The self-critique architecture review correctly flagged
that `packages/core/src/engine/fonts.ts` reads the four bundled handwriting-font
`.ttf` files from disk (`fs.readFileSync`) when a **typed-name** signature is
rendered. That is filesystem I/O in a package the constitution calls pure.

Two ways to resolve it:

1. **Byte-injection only** — remove all disk access from core; require callers to
   register font bytes before typed-name signing works.
2. **Documented exception** — allow core to lazily load *its own* bundled font
   assets from the package directory, and nothing else.

## Decision

Adopt **option 2, narrowly scoped**:

- The filesystem may be touched **only** by `packages/core/src/engine/fonts.ts`,
  and only to load fonts bundled inside the package (`assets/fonts/`). This is
  asset loading, not business/environment I/O (no DB, network, `process.env`, no
  user-supplied paths beyond an optional `fontsDir` override).
- Every other file in `core` and **all** of `domain` remain strictly pure. This
  is now **machine-enforced** by `scripts/check-boundaries.sh` (a gate step),
  which forbids `fs`/`net`/`child_process`/`process.env`/etc. everywhere in
  `core` and `domain` **except** that one file.
- `FontRegistry.register()` still lets callers inject bytes and avoid disk
  entirely (e.g. bundlers, browsers), so the byte-pure path remains available.

### Rationale

`finesign-core` is also shipped as a standalone library where
`new SignEngine().signWithTypedNames(...)` must work out of the box. Forcing byte
injection for the built-in fonts would degrade that DX for no real purity benefit
— loading a packaged asset is deterministic and side-effect-free from the
caller's perspective. The important purity boundary for the effects architecture
is the **domain**, which stays 100% pure.

## Consequences

- FACTORY §1.3's "no filesystem" is now understood as "no I/O **except** core's
  bundled-font asset loader (`engine/fonts.ts`)"; the boundary guard encodes
  exactly this.
- PRD §NFR-2 and ARCHITECTURE are corrected to state the exception rather than
  assert an absolute that the code does not honor (FACTORY §8: fix the doc in the
  same change).
- A future browser/WASM build should prefer `FontRegistry.register()` with
  embedded bytes; the disk loader is a Node convenience, not a requirement.
