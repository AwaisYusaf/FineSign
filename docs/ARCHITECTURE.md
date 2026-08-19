# FineSign — System Architecture

## Package layout (monorepo, npm workspaces)

```
finesign/
  packages/
    core/       finesign-core      Pure PDF signing engine (extracted, standalone OSS)
    shared/     @finesign/shared   Tiny cross-cutting primitives: Result, errors, ids, Clock
    domain/     @finesign/domain   Pure agreement model: entities, status machine, audit, ports
    storage/    @finesign/storage  Adapter impls of domain ports: in-memory + SQLite + blob store
    convert/    @finesign/convert  DocumentConverter: PDF passthrough + DOCX→PDF (LibreOffice ref)
    server/     @finesign/server   Fastify REST API wiring domain + adapters + core
    web/        @finesign/web       Sender + signer UI (React/Vite) — M5
```

**Dependency direction (acyclic, left-only):**

```
core ─┐
      ├─→ domain ─→ storage ─┐
shared┘        └─→ convert ──┼─→ server ─→ web
                             │
                    (core also used directly by server for stamping)
```

- `shared` and `domain` are **pure** (no I/O). `core` is pure except its bundled
  **font-asset loader** (`engine/fonts.ts`), a narrow documented exception
  (ADR-0002) enforced by `scripts/check-boundaries.sh`.
- `storage`, `convert` are **adapters** implementing domain **ports**.
- `server` is the **composition root**: it constructs concrete adapters and
  injects them into domain services.

## Ports (interfaces the domain owns, adapters implement)

| Port | Purpose | Reference adapter |
|---|---|---|
| `EnvelopeRepository` | persist/load envelopes + recipients + fields + events | in-memory, SQLite, Postgres |
| `BlobStore` | store/fetch document bytes by key | local FS, in-memory (S3 later) |
| `DocumentConverter` | normalize a source doc to signable PDF | PDF passthrough, DOCX→PDF |
| `Clock` | current time (injected) | system, fixed (tests) |
| `IdGenerator` | ids + unguessable tokens | crypto-random, seeded (tests) |
| `Mailer` (server-owned) | deliver recipient notifications | console, capturing (tests), SMTP |

## The agreement lifecycle (state machine)

```
Envelope:  draft ──send──▶ sent ──(all recipients done)──▶ completed
                   │                                  ▲
                   ├──────────────void──────────────▶ voided (terminal)
                   └ (a signer declines) ───────────▶ declined (terminal)

Recipient: pending ──(turn arrives)──▶ notified ──open──▶ viewed ──sign──▶ signed
                                                    └─────decline────▶ declined
```

- Transitions are table-driven in `domain/state-machine.ts`; illegal transitions
  throw `IllegalTransitionError`.
- Sequential routing: recipient *k* moves `pending→notified` only when all lower
  routing orders are `signed`. Parallel routing notifies all at send time.
- Completion: when the last required signer signs, the envelope stamps every
  document (via `finesign-core`), writes the certificate, and → `completed`.

## Signing data flow (send → sign → complete)

```
SENDER                          SERVER                         SIGNER
  │ create draft envelope  ────▶ persist (draft)
  │ upload PDF/DOCX        ────▶ convert→PDF (BlobStore, DocumentConverter)
  │ add recipients+fields  ────▶ validate assignment
  │ send                   ────▶ snapshot; issue tokens; Mailer.notify(order 1)
  │                                                        ◀──── open /sign/:token
  │                              validate token+status ───▶ return this recipient's docs+fields
  │                                                        ◀──── submit signature image
  │                              finesign-core.signWithImage per doc
  │                              audit(signed); advance routing; notify next / complete
  │ download completed     ────▶ signed PDFs + certificate
```

`finesign-core` is called only inside the server, on normalized PDF bytes, with
anchors built from the envelope's fields. The engine stays oblivious to
envelopes, recipients, storage — exactly the boundary FACTORY §2 requires.

## Audit & tamper-evidence

- Each envelope has an append-only `AuditEvent[]`.
- Each event carries `hash = sha256(prevHash || canonicalJson(payload))`,
  forming a chain; altering any past event breaks every subsequent hash.
- The **certificate of completion** renders the chain + document hashes into a
  PDF page appended to the final output.

## Errors & HTTP mapping

- Domain throws typed errors with a stable `code` (`ENVELOPE_NOT_FOUND`,
  `ILLEGAL_TRANSITION`, `INVALID_TOKEN`, `FIELD_UNASSIGNED`, …).
- The server has ONE error handler mapping `code → HTTP status`, emitting
  `{ error: { code, message } }`. 500s are masked in production.

## Security model

- Signer links: `IdGenerator.token()` ≥128-bit, stored hashed, single-recipient,
  expiring; status-gated (a used/expired token 410s).
- Uploads: magic-byte validated, size-capped, typed by content not filename.
- Every state transition re-checks authorization for the acting principal.
- Rate limiting on all public (token) routes.

## Testing strategy

- **Pure packages:** exhaustive unit tests (state machine transitions, audit
  chain, geometry via core).
- **Adapters:** one shared *contract test suite* run against every implementation
  (in-memory and SQLite must behave identically).
- **Server:** integration tests driving the full lifecycle over HTTP with the
  in-memory + fixed-clock + seeded-RNG wiring.
