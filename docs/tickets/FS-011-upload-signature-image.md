# FS-011 — Upload a signature image

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | S | M10 Signing completeness | — | PRD FR-S2; parity 10 | Approved · adversarial review required (untrusted images) |

## Problem
PRD FR-S2 lists three ways to provide a signature: drawn, **uploaded image**, or
typed. The signature dialog offers only Type and Draw. People who already have a
scanned signature have no way to use it.

## Goal
A signer can upload a PNG or JPEG of their signature, preview it, and adopt it
like a drawn one.

**Out of scope:** background removal beyond what core's ink trimming does; saved
signatures across envelopes (needs signer accounts).

## Design
- A third tab, "Upload", in `signature-dialog.tsx`: a file input (accept
  `image/png,image/jpeg`, ≤ 5 MB on the client), decoded with
  `createImageBitmap`, scaled down to at most 1200 × 400, drawn onto a canvas and
  exported as a PNG data URL — so the server receives a normal image signature,
  small and with any EXIF stripped. Photos are noisy and compress badly, so the
  client converts to grayscale and, if the PNG is still over 1.5 MB, re-encodes
  smaller until it fits (core refuses images over 2 MB). Preview on white;
  "Choose another file".
- Errors (not an image, too large, undecodable) show inline; adoption stays
  disabled.
- No server change expected: image signatures already go through core's
  validation, bomb guard and ink trimming. Verify the largest output fits the
  body limit; add a server test with a 1200 × 400 PNG.

## API and data changes
None (uses the existing `{ kind: "image", dataUrl }` signature).

## Acceptance criteria
1. Uploading a PNG or JPEG shows a preview, and adopting it fills every
   signature/initials field preview.
2. Signing with it completes, and the stamped document differs from the original
   where the signature field is.
3. A non-image file, or one over the size limit, shows an error and cannot be
   adopted.
4. A 4000 × 3000 photo and a 1200 × 400 image of random noise (the worst case
   for compression) are both reduced to a data URL of at most 1.5 MB, and signing
   with either succeeds.

## Test plan
- `server`: apply with a 1200 × 400 PNG data URL succeeds.
- `e2e`: criteria 1–4 with generated fixtures (a PNG made with the canvas in the
  test, a text file renamed `.png`).

## Security and risks
Untrusted images are decoded by the browser (client) and re-validated by core on
the server (existing guards).

## Docs to update
CHANGELOG, README features, e2e README.
