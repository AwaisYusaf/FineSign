# FS-007 — Edit and delete drafts

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | L | M8 Authoring & dashboard | FS-018; FS-019 (deletion record); owner checks once FS-002 lands | U.3, U.16 | Approved · adversarial review required (deletion) |

## Problem
In a draft a sender cannot change the title or signing order, edit or remove a
recipient, remove a document, or delete the draft (a draft can only be voided,
which leaves it on the dashboard forever). A typo in an email means starting
over; abandoned drafts accumulate. Neither the repository nor the blob store can
delete anything (`ports.ts` has no `delete`).

## Goal
Everything set up in a draft can be corrected or removed before sending, and a
draft can be deleted outright with all its files — safely against a concurrent
send.

**Out of scope:** correcting a sent envelope (FS-022 covers a recipient's
details); deleting completed envelopes (FS-021).

## Design
- **Domain (draft-only, each audited):** `updateDetails` (`envelope_updated`),
  `updateRecipient` (`recipient_updated`; changing a role to `cc` removes their
  fields, reported in the result so the UI confirms first), `removeRecipient`
  (+ their fields, `recipient_removed`), `removeDocument` (+ its fields,
  `document_removed`).
- **Concurrency:** all draft operations run under `retryOnConflict` (they
  re-derive from fresh state, so retrying is safe) — shared with FS-006.
- **Repository delete with a version check (D8 default: hard delete of drafts):**
  `EnvelopeRepository.delete(id, expectedVersion)` deletes the row and its
  token-index rows only if the version still matches, else `VERSION_CONFLICT`
  (contract-tested in every adapter). The server loads the envelope, refuses
  anything but a draft (409), and deletes at the loaded version — so a send that
  committed first makes the delete fail instead of orphaning live links.
- **Blobs:** `BlobStore.deletePrefix("env/<id>/")` (no-op when absent;
  implemented in every store including `EncryptedBlobStore`), run after the row
  is gone — this also removes blobs written by attempts that lost earlier races
  (they use fresh keys under the same prefix). A crash between the two leaves
  orphaned blobs (logged, harmless), never a row pointing at missing files.
- **Audit exception:** a deleted draft takes its audit trail with it. ADR-0006
  records this exception to rule 7 (drafts carry no signatures and nothing was
  sent); the deletion itself is recorded in the instance activity log (FS-019).
- **Web:** editable details on a resumed draft; recipients list Edit/Remove;
  documents list Remove (the confirmation says how many fields go with it);
  "Delete draft" on the envelope page and in the dashboard row menu, behind a
  confirmation dialog.

## API and data changes
`PATCH /api/envelopes/:id`, `PATCH|DELETE /api/envelopes/:id/recipients/:rid`,
`DELETE /api/envelopes/:id/documents/:did`, `DELETE /api/envelopes/:id`; new
audit event types (webhook list, web `describeEvent`); ports gain `delete` and
`deletePrefix`.

## Acceptance criteria
1. Each edit/remove works on a draft, appends one audit event, returns 409 on a
   sent envelope, and the chain verifies.
2. Removing a recipient or a document removes exactly their fields.
3. A recipient's corrected email in a draft is where the link goes at send.
4. Deleting a draft removes the envelope (404 after), its token-index rows and
   every blob under its prefix, including blobs from lost-race attempts.
5. A delete racing a send never leaves a sent envelope deleted: either the send
   wins (delete gets 409/conflict) or the delete wins (send gets 404).
6. The deletion appears in the activity log with the actor.
7. In the browser: fix a recipient's email, remove a document (its fields go),
   rename the draft, delete it from the dashboard.

## Test plan
- `domain`: criteria 1–2 per operation, including the cc-role change.
- `storage`: `delete(id, version)` and `deletePrefix` contracts (incl. encrypted).
- `server`: criteria 3–6, with a forced race for 5.
- `e2e`: criterion 7.

## Security and risks
Irreversible: drafts only, version-checked, owner-checked, confirmed in the UI,
recorded in the activity log. Adversarial review required.

## Docs to update
ADR-0006, CHANGELOG, BACKLOG (U.3, U.16), README API list, web AGENTS.md.
