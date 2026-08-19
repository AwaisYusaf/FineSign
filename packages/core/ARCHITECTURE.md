# Architecture

finesign-core is a thin, pure engine. Everything is organized around one job: take PDF
bytes + where-to-sign + what-to-stamp, and return signed PDF bytes.

## Module map

```
src/
  types.ts                  Public contracts (Placement, Anchor, StampedAnchor, boxes)
  index.ts                  Public API barrel

  geometry/
    coordinates.ts          All rotation-aware coordinate math (pure, no I/O)

  engine/
    pdf-guards.ts           isPdfBuffer — byte-level capability gate
    image.ts                decode + validate + ink-trim signature images
    fonts.ts                FontRegistry — bundled + custom signature fonts
    flatten.ts              flattenForStamping — de-interactivate AcroForm fields
    dates.ts                buildDateValues — assign MM/DD/YYYY to date anchors
    stamp.ts                low-level draw primitives (typed name / image / date)
    sign.ts                 SignEngine — the high-level orchestrator

  detect/
    field-heuristics.ts     name-based signer/date/non-signer classification
    acroform-fields.ts      read /Sig widgets + fields → anchors (no AI)

  anchors.ts                build anchors from a point-box or a drawn display-box

assets/fonts/               four OFL handwriting fonts
examples/                   runnable end-to-end demos
test/                       geometry round-trips + full signing suite
```

## The three coordinate spaces

The single hardest thing in PDF signing is coordinates. finesign-core moves between
three spaces, all handled in `geometry/coordinates.ts`:

| Space | Origin | Units | Used by |
| --- | --- | --- | --- |
| **Display** | top-left, y-down | fractions 0–1 of the *rotated* page | public API, browser overlays |
| **Raw point** | top-left, y-down | PDF points, *unrotated* page frame | form-schema field boxes |
| **pdf-lib draw** | bottom-left, y-up | PDF points + a CCW `rotate` | `page.drawText/drawImage` |

Key transforms:

- `schemaFieldToDisplayBox` — raw point box → display box (with the width/height
  swap on 90°/270°). Its inverse is `displayBoxToPointBox`.
- `displayBoxToPageRect` — display box → a pdf-lib draw rect that *fills* the box
  and reads upright, accounting for pdf-lib pinning the image's lower-left corner
  and rotating CCW about it.
- `toPageCoords` — a single display-space point → raw user-space coordinates, for
  placing typed text.

These are exact inverses. `test/geometry.test.ts` proves the round-trips and the
4-corner bounding-box identity at every rotation — if you touch this file, those
tests are your safety net.

## Signing flow

Both modes follow the same shape (`engine/sign.ts`):

```
load original PDF  (isPdfBuffer guard → NotAPdfError)
  → flattenForStamping        de-interactivate every form field so nothing
                              paints over the mark; overlay-only, never writes
                              into a /Sig widget
  → embed font / image        fontkit for TTF; embedPng/embedJpg for the image
  → for each placement/anchor:
        typed name  → stampTypedName   (baseline-shifted to the anchor's top)
        signature   → stampImageAnchor (fill width, cap height 1.6×, ink-trimmed)
        date        → stampDateAnchor  (font-fit, centered, auto-dated)
  → pdfDoc.save()             signed bytes out
```

Two guarantees fall out of this design:

- **Idempotent.** Signing always starts from the *original* bytes you pass, never
  a previously-signed copy, so re-running yields the same result.
- **Best-effort flattening.** A malformed AcroForm never aborts a sign — flatten
  degrades through appearance-gen → `form.flatten()` → a nuclear `/Widget` sweep
  → dropping `/AcroForm`, each step wrapped so it can't throw.

## Field detection (`detect/`)

`detectAnchorsFromAcroForm` walks each page's `/Annots`, keeps `/Widget`
annotations, resolves each widget's fully-qualified field name and type by
walking the `/Parent` chain, and selects:

- every `/Sig` signature widget → a `signature` anchor;
- every text field whose **name** matches the signer-signature/date heuristics
  (`field-heuristics.ts`) → a `signature`/`date` anchor.

Each widget's `/Rect` (bottom-left user space) is converted to a top-left
point-box and then to a display-space anchor with the same geometry the stamping
path uses — so detection and stamping can't drift.

**Limitation:** this only sees real AcroForm fields. Flat scans, or signature
*lines* with no underlying field, yield nothing — detect those upstream (OCR /
vision) and pass anchors in via `anchorFromDisplayBox`. Porting the source
platform's AI signer-field classifier is the intended richer detector (see the
roadmap).

## Design constraints (kept from the source platform)

- **No document-type coupling.** The engine never asks "is this a claim form?".
  It only asks "is this a PDF, and where are the anchors?". Policy about *who*
  signs *what* lives in your app.
- **Overlay, not PKI.** Marks are drawn on the page. This is visually identical
  to how most e-sign tools present a signature, but it is not a cryptographic
  document signature — see the roadmap for PAdES/PKI as a future layer.
- **Injectable clock.** `new SignEngine({ now })` makes auto-dates and audit
  timestamps deterministic for tests.
