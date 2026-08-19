/**
 * The envelope + recipient status state machines, table-driven in ONE place
 * (ARCHITECTURE: "explicit state machine"). Illegal transitions throw
 * `IllegalTransitionError`; everything that mutates status routes through here.
 */

import { ConflictError } from "@finesign/shared";
import type { EnvelopeStatus, RecipientStatus } from "./types";

export class IllegalTransitionError extends ConflictError {
  constructor(entity: string, from: string, to: string) {
    super("ILLEGAL_TRANSITION", `${entity} cannot move from "${from}" to "${to}"`, {
      entity,
      from,
      to,
    });
  }
}

const ENVELOPE_TRANSITIONS: Record<EnvelopeStatus, readonly EnvelopeStatus[]> = {
  draft: ["sent", "voided"],
  sent: ["completed", "voided", "declined", "expired"],
  completed: [],
  voided: [],
  declined: [],
  expired: [],
};

const RECIPIENT_TRANSITIONS: Record<RecipientStatus, readonly RecipientStatus[]> = {
  pending: ["notified", "declined"],
  notified: ["viewed", "signed", "declined"],
  viewed: ["signed", "declined"],
  signed: [],
  declined: [],
};

export function canEnvelopeTransition(from: EnvelopeStatus, to: EnvelopeStatus): boolean {
  return ENVELOPE_TRANSITIONS[from].includes(to);
}

export function canRecipientTransition(from: RecipientStatus, to: RecipientStatus): boolean {
  return RECIPIENT_TRANSITIONS[from].includes(to);
}

/** Assert + return `to`, or throw. Use when applying a transition. */
export function assertEnvelopeTransition(
  from: EnvelopeStatus,
  to: EnvelopeStatus
): EnvelopeStatus {
  if (!canEnvelopeTransition(from, to)) throw new IllegalTransitionError("envelope", from, to);
  return to;
}

export function assertRecipientTransition(
  from: RecipientStatus,
  to: RecipientStatus
): RecipientStatus {
  if (!canRecipientTransition(from, to)) throw new IllegalTransitionError("recipient", from, to);
  return to;
}

export function isEnvelopeTerminal(status: EnvelopeStatus): boolean {
  return ENVELOPE_TRANSITIONS[status].length === 0;
}
