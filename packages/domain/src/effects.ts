/**
 * Effects — the side-effects the pure domain WANTS performed, returned to the
 * server to execute (send email, stamp PDFs, write a certificate). This is how
 * the domain stays pure: it decides *what* should happen; the server does it.
 */

import type { SignatureInput } from "./types";

/** Notify someone about the envelope. Targets a recipient by id, or the sender
 *  when `toSender` is set (the sender is not in the recipients list). */
export interface NotifyEffect {
  type: "notify";
  reason: "your_turn" | "completed_copy" | "declined" | "reminder" | "resent" | "expired";
  /** Recipient to notify (omitted when `toSender`). */
  recipientId?: string;
  /** Notify the envelope sender instead of a recipient. */
  toSender?: boolean;
  /** Raw token for the link. Present for the notifications that need one: the
   *  turn/reminder/resend prompts, and the completed copy (a fresh read-only
   *  token so a recipient can fetch the finished package). Never stored. */
  token?: string;
  /** Free-text context, e.g. the decline reason. Safe to surface in the message. */
  note?: string;
}

/** Stamp a recipient's fields onto the given documents using their signature. */
export interface StampEffect {
  type: "stamp";
  recipientId: string;
  documentIds: string[];
  signature: SignatureInput;
}

/** The envelope just completed — generate the certificate of completion. */
export interface FinalizeEffect {
  type: "finalize";
}

export type Effect = NotifyEffect | StampEffect | FinalizeEffect;

/** A domain operation's result: the next aggregate state + effects to run. */
export interface DomainResult {
  envelope: import("./types").Envelope;
  effects: Effect[];
}
