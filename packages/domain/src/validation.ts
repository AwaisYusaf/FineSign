/**
 * Send-time invariants (FR-E4). An envelope may only be sent when it is
 * internally consistent: it has documents, at least one signer, every signer has
 * something to do, and every field points at a real document + acting recipient.
 */

import { ValidationError } from "@finesign/shared";
import type { Envelope } from "./types";
import { isActingRole } from "./routing";

/** Throws `ValidationError` (code VALIDATION_ERROR) listing every problem found. */
export function validateForSend(env: Envelope): void {
  const problems: string[] = [];

  if (env.documents.length === 0) problems.push("envelope has no documents");

  const docIds = new Set(env.documents.map((d) => d.id));
  const recById = new Map(env.recipients.map((r) => [r.id, r]));

  const signers = env.recipients.filter((r) => r.role === "signer" || r.role === "approver");
  if (signers.length === 0) problems.push("envelope has no signer/approver recipients");

  for (const d of env.documents) {
    if (!d.pdfBlobKey) problems.push(`document "${d.name}" has not been normalized to PDF`);
  }

  for (const r of env.recipients) {
    if (!r.email.includes("@")) problems.push(`recipient "${r.name}" has an invalid email`);
  }

  // Every field must reference a real document + recipient, and only acting
  // recipients (signer/approver) may own fields.
  for (const f of env.fields) {
    if (!docIds.has(f.documentId)) {
      problems.push(`field ${f.id} references unknown document ${f.documentId}`);
    }
    const owner = recById.get(f.recipientId);
    if (!owner) {
      problems.push(`field ${f.id} references unknown recipient ${f.recipientId}`);
    } else if (!isActingRole(owner)) {
      problems.push(`field ${f.id} is assigned to a "${owner.role}" recipient (must be signer/approver)`);
    }
    const doc = env.documents.find((d) => d.id === f.documentId);
    if (doc && doc.pageCount != null && (f.page < 1 || f.page > doc.pageCount)) {
      problems.push(`field ${f.id} is on page ${f.page}, document "${doc.name}" has ${doc.pageCount} pages`);
    }
    // All field kinds (signature, initials, date_signed, text, checkbox) are now
    // captured and stamped at signing (DG2).
  }

  // Every signer (not approver-only, not cc) must have at least one field to act on.
  for (const s of env.recipients.filter((r) => r.role === "signer")) {
    const has = env.fields.some((f) => f.recipientId === s.id);
    if (!has) problems.push(`signer "${s.name}" has no fields to complete`);
  }

  if (problems.length > 0) {
    throw new ValidationError("envelope is not ready to send", { problems });
  }
}
