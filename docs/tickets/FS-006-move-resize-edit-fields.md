# FS-006 — Move, resize and edit placed fields

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | M | M8 Authoring & dashboard | — | U.2, U.16 (fields part); parity 8 | Approved |

## Problem
A placed field can only be removed and placed again. It cannot be dragged,
resized, nudged with the keyboard, reassigned to another recipient, or made
optional — the editor always creates required fields although the API supports
`required: false`. Keyboard users can place a field (centred) but never put it
where it belongs.

## Goal
In a draft, a sender can drag a field, resize it from a corner, nudge it with the
arrow keys, reassign it, and toggle "required" for text and checkbox fields.

**Out of scope:** multi-select, copy/paste, snapping guides, moving a field to
another document.

## Design
- **Domain:** `updateField(env, fieldId, patch)` with
  `patch: { page?, x?, y?, width?, height?, recipientId?, required? }`. Draft
  only. The resulting box goes through the same validation as `addField`
  (on-page, minimum size, recipient exists and is not a CC). Appends a
  `field_updated` audit event with the changed keys and before/after values.
- **API:** `PATCH /api/envelopes/:id/fields/:fieldId` → the envelope.
- **Concurrency:** draft operations are not wrapped in `retryOnConflict` today
  (`app.ts` add/remove routes), so two overlapping PATCHes on different fields
  would 409 and roll back. All draft operations move under `retryOnConflict`
  (safe: each re-derives from fresh state), and the web serializes mutations per
  envelope (a small queue) so they apply in order.
- **Web (fields step):**
  - Drag the selected field with pointer events (mouse, touch and pen), keeping
    it on the page; save once, on pointer-up.
  - A corner handle resizes, with a minimum of 2% × 1% of the page.
  - Arrow keys nudge by 0.5% of the page, Shift + arrow by 5%. Saves are
    debounced (400 ms), so a held key sends one PATCH.
  - The selected-field panel gains "Assign to" (actors) and, for text and
    checkbox fields, a "Required" switch.
  - Optimistic update with rollback and a toast if the PATCH fails.
- Coordinates stay display-space fractions (AGENTS.md convention).

## API and data changes
New route above; new audit event type `field_updated` (webhook event list and
`describeEvent` in the web).

## Acceptance criteria
1. `updateField` rejects a sent envelope, an off-page or too-small box, an
   unknown or CC recipient, and `required` on signature/initials/date fields.
2. Each successful update appends exactly one `field_updated` event, and the
   audit chain still verifies.
3. Dragging a field in the browser moves it, and the saved position matches
   where it was dropped (within 0.5%).
4. Resizing from the corner changes width and height, and never below the
   minimum.
5. With a field selected, three arrow presses move it by 1.5% and send one PATCH.
6. Reassigning moves the field to the new recipient's colour and list; marking a
   text field optional shows it as optional on the signer page, and the signer
   can finish without filling it.
7. Two rapid edits to two different fields (fired without awaiting) both
   persist, with no error toast.

## Test plan
- `domain`: criteria 1–2.
- `server`: route validation, 409 after send, 404 for an unknown field.
- `e2e`: drag, resize, keyboard nudge (asserting the API values), reassign,
  optional text field signed empty.

## Security and risks
Same authorization path as other field routes (`loadOwned` after FS-002). Risk of
noisy audit trails from drags is avoided by saving on drop/debounce only.

## Docs to update
CHANGELOG, BACKLOG (U.2 done; U.16 fields part), web AGENTS.md (test hooks for
the resize handle), e2e README.
