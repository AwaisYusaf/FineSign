# FS-013 — Unicode text in fields and on the certificate

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P2 | M | M10 Signing completeness | after FS-012 (shared `certificate.ts`) | U.18 | Approved |

## Problem
Text fields and the certificate are drawn with Helvetica (WinAnsi / Latin-1).
Since the review fixes, a text value with "ř", "Ł", "ș", Cyrillic or Greek is
refused with a 400, so a Czech or Polish signer cannot enter their own name in a
form field; names on the certificate print those letters as "?".

## Goal
Text fields and the certificate print Latin (including Central European and
Vietnamese), Cyrillic and Greek text as typed; scripts the bundled font lacks are
refused with a message that tells the operator how to add a font.

**Out of scope:** bundling CJK/Arabic/Indic fonts (multi-megabyte; operator can
configure one), right-to-left layout.

## Design
- Bundle **Noto Sans** Regular and Bold (OFL), subset to Latin, Latin
  Extended-A/B, Latin Extended Additional, Cyrillic, Greek — budget ≤ 600 KB
  total — under `packages/server/assets/fonts/` with its licence; NOTICE
  updated. The subset fonts are **committed**, with a reproducible script
  (`scripts/subset-fonts.sh`, pinned tool version) — no font toolchain in the
  build or the gate.
- `stampTextAndCheckboxes` and the certificate embed it through fontkit (pdf-lib
  subsets only the glyphs used, so PDFs grow little).
- Validation in `assertStampable` switches from WinAnsi encodability to
  `hasGlyphForCodePoint` against the text font (shared helper with core's
  `missingGlyphs`).
- `FINESIGN_TEXT_FONT` (path to a TTF/OTF) lets an operator replace it with a
  font that covers more scripts (e.g. Noto Sans CJK); validated at boot.
- The certificate keeps its never-throw fallback: a character the configured font
  lacks prints as "?" rather than failing completion.
- Web `charset.ts` mirrors coverage by script (Latin, Cyrillic, Greek), like the
  signature fonts; the server stays authoritative.
- The checkbox mark stays as is (draw a vector check instead of "X" while here).

## API and data changes
New env `FINESIGN_TEXT_FONT`; the 400 message changes; no schema change.

## Acceptance criteria
1. "Antonín Dvořák", "Łódź", "Ștefan", "Москва" and "Αθήνα" in a text field are
   accepted and appear in the signed PDF's extracted text exactly as typed.
2. A recipient named "Zoë Łukasz" appears correctly in the certificate's
   extracted text.
3. "李小龍" in a text field is refused with a message naming `FINESIGN_TEXT_FONT`;
   with that variable pointing at a font that covers it, it is accepted.
4. A signed PDF with one short Latin text value grows by less than 60 KB compared
   to today.
5. The signer page flags only characters the server would refuse.
6. The font files ship in the Docker image (the Docker CI job signs a document
   with a Cyrillic text value) — watch the `.dockerignore` gotcha.

## Test plan
- `server`: criteria 1–4, asserting with pdf.js text extraction (or pdf-lib +
  content stream decode) rather than visual checks; a test font fixture for 3.
- `e2e`: update the "unprintable text" spec (Cyrillic now accepted; CJK flagged).

## Security and risks
Font parsing of an operator-supplied file (boot-time validation, trusted input);
PDF size growth (subsetting + criterion 4).

## Docs to update
NOTICE, DEPENDENCY-LICENSES, `.env.example`, CHANGELOG, BACKLOG (U.18), web
AGENTS.md (charset mirror).
