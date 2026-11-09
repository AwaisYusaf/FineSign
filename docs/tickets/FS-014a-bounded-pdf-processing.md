# FS-014a — Bound PDF processing

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P2 — **M7 exit criterion if accounts go to people outside the operator's trust** | M | M11 Hardening & operations | — | R.3; NFR-3 | Approved · adversarial review required |

## Problem
Uploaded PDFs are parsed on the main event loop with only a 10 MB size cap. A
crafted PDF (deep nesting, huge xref, decompression bombs in streams) can burn
CPU or memory and stall every request. Parsing happens at upload (page info,
normalization), and again later — field detection (FS-008), stamping, appending
the certificate, sealing, verification — so bounding only the upload would move
the attack to completion and wedge envelopes there.

## Goal
A PDF that cannot be fully parsed within time and memory limits is rejected at
upload, so every later stage only ever sees documents that passed a bounded,
complete parse.

**Out of scope:** DOCX conversion isolation (FS-014b), malware scanning.

## Design
- **Bounded validation at upload:** a child process (not a worker thread —
  `resourceLimits` caps only the V8 heap, while pdf-lib inflates streams into
  ArrayBuffers outside it) with `--max-old-space-size`, an OS-level memory limit
  where available, and a wall-clock timeout (default 20 s,
  `FINESIGN_PDF_TIMEOUT_MS`). It loads the document, walks every page and
  object, and **inflates every stream with a cumulative decompressed-bytes cap**
  (default 200 MB, `FINESIGN_PDF_MAX_INFLATED_MB`). Failure → typed
  `DocumentProcessingError` → 422 "could not process this document".
- Page info and normalization results come back from that process, so the main
  process never parses an unvalidated PDF. Later stages run in-process on
  validated bytes (our own stamped output thereafter).
- A small pool (size configurable) with graceful-shutdown draining (F.11).
- **Testability:** the child entry accepts an injected "spin" task in tests to
  prove the timeout and memory paths deterministically.

## API and data changes
New error code; env vars `FINESIGN_PDF_TIMEOUT_MS`,
`FINESIGN_PDF_MAX_INFLATED_MB`, `FINESIGN_PDF_WORKERS`.

## Acceptance criteria
1. An upload whose parse exceeds the timeout (spin task) is rejected with 422
   within the timeout plus one second, and `/health` answers throughout.
2. A PDF whose streams inflate beyond the cap is rejected with 422 and the server
   process's memory stays bounded (child killed, parent unaffected).
3. A child that crashes does not crash the server; the next upload works.
4. All existing tests pass unchanged; a micro-benchmark shows validation of the
   two-page sample PDF adds under 150 ms.
5. Shutdown terminates in-flight children.

## Test plan
- `server`/`convert`: criteria 1–3 and 5 with the injected spin task and a
  generated inflate-bomb PDF; criterion 4 as a benchmark script run in CI with
  a generous threshold.

## Security and risks
Moves untrusted parsing out of the main process; the residual risk is in-process
parsing of our own output, which only contains validated input.

## Docs to update
SECURITY.md (residuals), `.env.example`, CHANGELOG, BACKLOG (R.3).
