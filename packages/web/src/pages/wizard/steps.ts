import type { Envelope } from "@/lib/types";

export const STEPS = [
  { key: "details", label: "Details" },
  { key: "documents", label: "Documents" },
  { key: "recipients", label: "Recipients" },
  { key: "fields", label: "Fields" },
  { key: "review", label: "Review & send" },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];

export const isStepKey = (v: string | null): v is StepKey => STEPS.some((s) => s.key === v);

/** Recipients who act on the document (a CC only receives the finished copy). */
export const actors = (env: Envelope) => env.recipients.filter((r) => r.role !== "cc");

/**
 * Signers the envelope can't be sent without a field for. Only signers: the
 * server lets an approver have none (they approve the documents as they are),
 * so blocking on approvers refused envelopes the API accepts.
 */
export const signersWithoutFields = (env: Envelope) =>
  env.recipients.filter((r) => r.role === "signer" && !env.fields.some((f) => f.recipientId === r.id));

/**
 * Can the sender open this step yet? Each step needs what the previous ones
 * produce: a draft, then a document, then someone to sign, then a field.
 */
export function stepReachable(step: StepKey, env: Envelope | undefined): boolean {
  switch (step) {
    case "details":
      return true;
    case "documents":
      return !!env;
    case "recipients":
      return !!env && env.documents.length > 0;
    case "fields":
      return !!env && env.documents.length > 0 && actors(env).length > 0;
    case "review":
      return !!env && env.fields.length > 0;
  }
}

/** Where a resumed draft should open: the first step with work left to do. */
export function firstOpenStep(env: Envelope): StepKey {
  if (env.documents.length === 0) return "documents";
  if (actors(env).length === 0) return "recipients";
  if (env.fields.length === 0) return "fields";
  return "review";
}
