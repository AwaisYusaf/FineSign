# FS-008 — Suggest fields from a PDF's own form fields

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | M | M8 Authoring & dashboard | — | PRD FR-D4 | Approved · adversarial review required (untrusted PDF parsing) |

## Problem
PRD FR-D4 requires auto-detecting signature and date fields from a PDF's
AcroForm. `finesign-core` implements detection (`detectFields`,
`detectAnchorsFromAcroForm`), but neither the server nor the web uses it, so a
form that already has "Signature" and "Date" boxes is fielded by hand.

## Goal
When a PDF with form fields is uploaded, the field editor offers those boxes as
suggestions the sender accepts for a recipient in one action.

**Out of scope:** text-tag/anchor placement by keyword (parity 9), AI detection
(X.6), DOCX form controls.

## Design
- On `addDocument`, after normalization, the server runs core detection on the
  PDF and stores `suggestions` on the document: `{ id, page, x, y, width, height,
  kind, label }`, display-space fractions. Kind mapping: signature widget →
  `signature`; names/labels matching the core date heuristics → `date_signed`;
  checkbox → `checkbox`; other text widgets → `text`. Capped (e.g. 200) and
  skipped quietly (logged) if detection fails — upload must not fail because of
  it.
- Accepting uses a bulk `POST /api/envelopes/:id/fields/batch` (all-or-nothing,
  one `field_added` event per field) — not `fields:batch`, which Fastify would
  parse as a route parameter. Accepted suggestions are removed from the list;
  "Dismiss" clears them and is audited (`suggestions_dismissed`) like every
  other draft change.
- Detection runs on the PDF already validated by FS-014a once that lands.
- BACKLOG M2.3 says auto-detect integration is done although nothing calls it;
  this ticket corrects that entry.
- Web: a banner in the fields step — "This PDF has 4 form fields. Assign them to
  [recipient ▾] · Dismiss" — plus faint dashed outlines for each suggestion on
  the page; clicking an outline accepts it for the current assignee.

## API and data changes
`Document.suggestions` (new, optional, defaults to `[]` for old data);
`POST /api/envelopes/:id/fields/batch`; `DELETE
/api/envelopes/:id/documents/:did/suggestions`; audit event
`suggestions_dismissed`.

## Acceptance criteria
1. Uploading a PDF with a signature widget, a date-named text widget, a checkbox
   and a text widget yields four suggestions with the right kinds and boxes
   (within 1% of the widget rectangles).
2. A PDF without a form, or one whose detection throws, uploads normally with no
   suggestions.
3. "Assign all to Alice" creates the four fields for Alice in one request, and
   the suggestions disappear.
4. Clicking a single outline accepts just that one; "Dismiss" removes the rest
   without creating fields.

## Test plan
- `server`: criteria 1–2 with generated form PDFs (pdf-lib can create AcroForm
  widgets, as core's tests do).
- `domain`: batch add validation (all-or-nothing).
- `e2e`: criteria 3–4.

## Security and risks
Detection parses untrusted PDFs: runs under the same caps as normalization (and
the bounded validation from FS-014a once it lands).

## Docs to update
CHANGELOG, BACKLOG, README features, e2e README.
