# Roadmap

finesign-core today is a **signing engine**. This is the path from engine → full
open-source DocuSign alternative. Each layer sits *on top of* the pure engine and
keeps it dependency-free.

## Where we are (v0.1 — the engine) ✅

- [x] Image signing (captured signature → detected fields) + auto-dating
- [x] Typed-name signing in four handwriting fonts
- [x] Automatic AcroForm field detection (`/Sig` widgets + named fields)
- [x] Full rotation handling (0/90/180/270) with proven round-trips
- [x] Ink-trimming, decompression-bomb + magic-byte guards
- [x] Bytes-in/bytes-out, zero infra, tested end-to-end

## Near term — hardening the engine

- [ ] **Richer field detection.** An AI signer-field classifier as an
      *optional* `@finesign/detect-ai` add-on (bring-your-own LLM
      client) for forms whose fields are unnamed or whose signature is a bare
      line, not a widget. Keep the core AI-free.
- [ ] **Vision/OCR anchor fallback** for flat (scanned) PDFs with no AcroForm.
- [ ] **Configurable ink color / signature styling** per placement.
- [ ] **Initials & checkbox marks**, not just full signatures + dates.
- [ ] **Multi-page signature propagation** ("apply to all pages").
- [ ] Browser/WASM build so the same engine can sign client-side.

## Mid term — the signing *product* layers

These are new packages that consume the engine; the engine stays pure.

- [ ] **Envelope model** — `@finesign/core`: a document set + ordered/parallel
      **recipients**, per-recipient fields, and a status machine
      (draft → sent → viewed → signed → completed / declined / voided).
- [ ] **Signing sessions** — tokenized, expiring per-recipient links (the public
      "you've been asked to sign" page), one recipient can't see another's link.
- [ ] **Storage & delivery adapters** — thin interfaces (`StorageAdapter`,
      `MailAdapter`) with reference S3 + SES/SMTP implementations, so
      persistence and delivery ship as opt-in adapters.
- [ ] **Reference server** — a small Fastify/Express app wiring engine + adapters
      into a REST API (create envelope, add recipients, send, sign, download).
- [ ] **Signer web UI** — a minimal React page: render PDF, draw/type/upload a
      signature, place or confirm fields, submit.

## Long term — trust & compliance

- [ ] **Tamper-evident audit trail** — per-envelope event log (who, when, IP,
      user-agent), hash-chained, exportable as a certificate page appended to the
      PDF.
- [ ] **Cryptographic signatures (PAdES / PKCS#7)** — embed a real digital
      signature into the PDF (not just a visual overlay), with LTV and optional
      timestamp-authority (RFC 3161) support. This is the biggest gap vs
      DocuSign for legal/eIDAS contexts.
- [ ] **Signature verification** endpoint/CLI — validate embedded signatures and
      surface tamper status.
- [ ] **Compliance docs** — ESIGN/UETA + eIDAS positioning, consent capture,
      retention guidance.

## Non-goals

- Becoming a hosted SaaS. finesign-core is self-host-first by design.
- Locking documents into a proprietary format — everything stays standard PDF.

---

**Contributions welcome.** The engine boundary (pure, no I/O) is the invariant to
protect: new capabilities should either extend the engine as pure functions or
live in a layer above it. Anything that reaches for a database, bucket, or
network belongs in an adapter, not in `src/engine`.
