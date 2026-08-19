/**
 * Routing: given an envelope, decide whose turn it is. `cc` recipients never
 * act (they only receive the finished copy); `signer`/`approver` are the acting
 * roles that gate completion.
 *
 *   - sequential: recipients act in `routingOrder` groups; the active group is
 *     the LOWEST order not yet fully signed. A later group is untouched until
 *     every member of the earlier group has signed.
 *   - parallel: every acting recipient is active from send time.
 */

import type { Envelope, Recipient } from "./types";

export function isActingRole(r: Recipient): boolean {
  return r.role === "signer" || r.role === "approver";
}

/** Acting recipients (signer/approver), preserving declaration order. */
export function actingRecipients(env: Envelope): Recipient[] {
  return env.recipients.filter(isActingRole);
}

/**
 * The recipients whose turn is CURRENTLY active (eligible to be notified/sign).
 * For sequential, the lowest unfinished order group; for parallel, all unsigned
 * acting recipients. Excludes those already `signed` or `declined`.
 */
export function activeRecipients(env: Envelope): Recipient[] {
  const acting = actingRecipients(env).filter(
    (r) => r.status !== "signed" && r.status !== "declined"
  );
  if (env.routingType === "parallel") return acting;

  // Sequential: find the lowest routingOrder among acting recipients that still
  // need to act (not signed AND not declined); the active group is everyone
  // still-actionable at that order. Excluding declined keeps routing from
  // stalling on an order whose only member declined (robust even if decline ever
  // becomes non-terminal).
  if (acting.length === 0) return [];
  const lowest = Math.min(...acting.map((r) => r.routingOrder));
  return acting.filter((r) => r.routingOrder === lowest);
}

/** Active recipients still in `pending` — the ones to move to `notified` now. */
export function recipientsToNotify(env: Envelope): Recipient[] {
  return activeRecipients(env).filter((r) => r.status === "pending");
}

/** True when every acting recipient has signed — the completion condition. */
export function allActingSigned(env: Envelope): boolean {
  const acting = actingRecipients(env);
  return acting.length > 0 && acting.every((r) => r.status === "signed");
}

/** True if a specific recipient is allowed to sign right now (their turn). */
export function recipientMayAct(env: Envelope, recipientId: string): boolean {
  return activeRecipients(env).some((r) => r.id === recipientId);
}
