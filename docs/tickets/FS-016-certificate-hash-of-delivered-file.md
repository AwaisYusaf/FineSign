# FS-016 — Certificate hashes that match the delivered files

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P3 | S | M11 Hardening | — | R.5; PRD FR-A3 | Approved |

## Problem
The certificate of completion lists a SHA-256 for each document, computed over
the signed content **before** the certificate is appended and the PAdES seal is
applied (`finalize` in `app.ts`). Nobody holding the delivered file can
reproduce that hash, so the number a reader is told to trust can't be checked
against what they have.

## Goal
Someone holding a delivered document can verify the hash the certificate gives
them, and the certificate says exactly what each hash covers.

**Out of scope:** changing what the seal covers (it already covers the whole
delivered file).

## Design
- A hash of the final sealed file can't live inside that same file, so:
  - The **standalone** certificate (`/api/envelopes/:id/certificate`), written
    after the seal, lists SHA-256 of each **delivered** sealed PDF. A reader can
    hash the download and compare.
  - The **embedded** certificate keeps the pre-certificate content hash but labels
    it precisely ("SHA-256 of the signed pages, before this certificate was
    appended") and points to the standalone certificate for the delivered-file
    hash.
- The envelope page shows each document's delivered SHA-256 with a copy button.

## API and data changes
`Document.deliveredSha256` stored at completion; standalone certificate content
change; no new routes.

## Acceptance criteria
1. For a completed envelope, `sha256(download)` equals the hash printed in the
   standalone certificate and shown on the envelope page, for every document.
2. The embedded certificate's wording names what its hash covers.
3. Existing completed envelopes (no stored hash) still download and show "not
   recorded" instead of a wrong value.

## Test plan
- `server`: criterion 1 (hash the download, extract certificate text),
  criterion 3 with a pre-change fixture envelope.
- `e2e`: envelope page shows a hash equal to the API download's hash.

## Security and risks
None new; improves verifiability. The standalone certificate's fixed-key write
stays after the completing save (concurrency rule).

## Docs to update
CHANGELOG, BACKLOG (R.5), README (verifying a document).
