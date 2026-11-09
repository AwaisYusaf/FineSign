import { fieldKindLabel } from "@/lib/config";
import type { AuditEvent, AuditEventType, Envelope, EnvelopeStatus, FieldKind, Recipient, RecipientRole, RecipientStatus } from "@/lib/types";

export const ROLE_LABEL: Record<RecipientRole, string> = { signer: "Signer", approver: "Approver", cc: "CC" };

/** Events from building the draft — useful, but noise next to what happened after sending. */
const SETUP_EVENTS = new Set<AuditEventType>(["document_added", "recipient_added", "field_added", "field_removed"]);
export const isSetupEvent = (e: AuditEvent) => SETUP_EVENTS.has(e.type);

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export const ENVELOPE_STATUS: Record<EnvelopeStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  sent: { label: "Out for signature", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
  voided: { label: "Voided", tone: "neutral" },
  expired: { label: "Expired", tone: "warning" },
};

/** What a recipient's status means, given the envelope around them. */
export function recipientStatus(r: Recipient, env: Pick<Envelope, "status">): { label: string; tone: Tone } {
  // A CC never "signs": once the envelope completes they have been sent their copy.
  if (r.role === "cc") {
    return env.status === "completed" ? { label: "Copy sent", tone: "success" } : { label: "Gets a copy", tone: "neutral" };
  }
  const map: Record<RecipientStatus, { label: string; tone: Tone }> = {
    pending: { label: "Waiting", tone: "neutral" },
    notified: { label: "Sent", tone: "info" },
    viewed: { label: "Viewed", tone: "info" },
    signed: { label: r.role === "approver" ? "Approved" : "Signed", tone: "success" },
    declined: { label: "Declined", tone: "danger" },
  };
  return map[r.status];
}

/** Signers/approvers who have finished, out of those who must. */
export function signingProgress(env: Envelope): { done: number; total: number } {
  const actors = env.recipients.filter((r) => r.role !== "cc");
  return { done: actors.filter((r) => r.status === "signed").length, total: actors.length };
}

/** A sentence for one audit event, naming the recipient when there is one. */
export function describeEvent(e: AuditEvent, env: Envelope): string {
  const rid = typeof e.data.recipientId === "string" ? e.data.recipientId : e.actor;
  const who = env.recipients.find((r) => r.id === rid)?.name ?? "A recipient";
  const doc = typeof e.data.name === "string" ? e.data.name : "a document";
  const kind = typeof e.data.kind === "string" ? fieldKindLabel(e.data.kind as FieldKind).toLowerCase() : null;
  switch (e.type) {
    case "envelope_created":
      return "Envelope created";
    case "document_added":
      return `Added ${doc}`;
    case "recipient_added":
      return `Added ${who}`;
    case "field_added":
      return kind ? `Placed a ${kind} field` : "Placed a field";
    case "field_removed":
      return kind ? `Removed a ${kind} field` : "Removed a field";
    case "envelope_sent":
      return "Sent for signature";
    case "recipient_notified":
      return `Emailed ${who} a signing link`;
    case "recipient_authenticated":
      return `${who} entered the access code`;
    case "recipient_viewed":
      return `${who} opened the documents`;
    case "recipient_consented":
      return `${who} agreed to sign electronically`;
    case "recipient_signed":
      return `${who} signed`;
    case "recipient_declined":
      return `${who} declined to sign`;
    case "recipient_reminded":
      return `Reminded ${who}`;
    case "recipient_resent":
      return `Re-sent ${who}'s signing link`;
    case "envelope_completed":
      return "Completed and sealed";
    case "envelope_voided":
      return "Voided by the sender";
    case "envelope_expired":
      return "Expired before everyone signed";
  }
}
