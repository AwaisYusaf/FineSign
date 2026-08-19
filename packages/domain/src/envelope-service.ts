/**
 * The pure application service for the envelope aggregate. Every method takes the
 * current `Envelope`, returns the NEXT `Envelope` (input never mutated) and, for
 * operations with side-effects, a list of `Effect`s for the server to run.
 *
 * Time + ids come from injected `Clock`/`IdGenerator` (deterministic in tests).
 * Token MINTING is delegated to an `issueToken` callback the server supplies
 * (it owns crypto + expiry policy); the domain only stores the token HASH.
 */

import { Clock, IdGenerator, ConflictError, NotFoundError, ValidationError, AuthorizationError } from "@finesign/shared";
import { drawnBoxError } from "finesign-core";
import type {
  Envelope,
  EnvelopeDocument,
  Recipient,
  Field,
  RecipientRole,
  RecipientAuthMethod,
  RoutingType,
  DocumentFormat,
  FieldKind,
  SignatureInput,
  SigningContext,
  FieldInput,
} from "./types";
import { ESIGN_CONSENT } from "./types";

/** Constant-time equality for two equal-length hex strings (access-code hashes). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Access-code brute-force protection: lock a recipient after this many failures. */
const MAX_AUTH_ATTEMPTS = 6;
/** How long a recipient stays locked after hitting the attempt limit. */
const AUTH_LOCKOUT_MS = 15 * 60 * 1000;
/** Cap stored client-evidence strings so a hostile client cannot bloat the record. */
const MAX_UA_LEN = 400;
const MAX_IP_LEN = 64;

/**
 * A wrong access-code attempt. Carries the NEXT envelope state (with the failure
 * counter/lockout incremented) so the server persists it before returning 403 —
 * otherwise the lockout would never accumulate. `code` maps to 403/423.
 */
export class AccessCodeAttemptError extends AuthorizationError {
  constructor(
    readonly envelope: Envelope,
    readonly locked: boolean
  ) {
    super(locked ? "too many incorrect attempts; try again later" : "access code is incorrect");
  }
}
import { appendAuditEvent } from "./audit";
import {
  assertEnvelopeTransition,
  assertRecipientTransition,
} from "./state-machine";
import {
  actingRecipients,
  isActingRole,
  recipientsToNotify,
  allActingSigned,
  recipientMayAct,
} from "./routing";
import { validateForSend } from "./validation";
import type { Effect, NotifyEffect, DomainResult } from "./effects";

export interface IssuedToken {
  token: string;
  tokenHash: string;
  expiresAt: string;
}

export interface CreateEnvelopeInput {
  title: string;
  routingType: RoutingType;
  senderName: string;
  senderEmail: string;
}

export interface AddDocumentInput {
  name: string;
  format: DocumentFormat;
  originalBlobKey: string;
  /** For PDFs the caller may pass the same key as the normalized pdf up front. */
  pdfBlobKey?: string | null;
  pageCount?: number | null;
}

export interface AddRecipientInput {
  name: string;
  email: string;
  role: RecipientRole;
  routingOrder: number;
  /** Authentication requirement (default `"none"`). */
  authMethod?: RecipientAuthMethod;
  /** SHA-256 of the access code (the server hashes it; raw code never stored).
   *  Required when `authMethod` is `access_code`. */
  accessCodeHash?: string;
}

export interface AddFieldInput {
  documentId: string;
  recipientId: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: FieldKind;
  required?: boolean;
}

export class EnvelopeService {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator
  ) {}

  private now(): string {
    return this.clock.now().toISOString();
  }

  private requireDraft(env: Envelope): void {
    if (env.status !== "draft") {
      throw new ConflictError(
        "ENVELOPE_NOT_DRAFT",
        `envelope is "${env.status}"; documents/recipients/fields can only change while draft`
      );
    }
  }

  private audit(
    env: Envelope,
    type: Parameters<typeof appendAuditEvent>[1]["type"],
    actor: string,
    data?: Record<string, unknown>
  ): Envelope {
    return {
      ...env,
      audit: appendAuditEvent(env.audit, { id: this.ids.id(), type, at: this.now(), actor, data }),
    };
  }

  // ── Construction / draft editing ────────────────────────────────────────────

  createEnvelope(input: CreateEnvelopeInput): Envelope {
    const now = this.now();
    const base: Envelope = {
      id: this.ids.id(),
      title: input.title,
      status: "draft",
      routingType: input.routingType,
      senderName: input.senderName,
      senderEmail: input.senderEmail,
      createdAt: now,
      sentAt: null,
      completedAt: null,
      voidedReason: null,
      expiresAt: null,
      documents: [],
      recipients: [],
      fields: [],
      audit: [],
      version: 0,
    };
    return this.audit(base, "envelope_created", "sender", { title: input.title });
  }

  addDocument(env: Envelope, input: AddDocumentInput): { envelope: Envelope; document: EnvelopeDocument } {
    this.requireDraft(env);
    const document: EnvelopeDocument = {
      id: this.ids.id(),
      name: input.name,
      format: input.format,
      originalBlobKey: input.originalBlobKey,
      pdfBlobKey: input.pdfBlobKey ?? (input.format === "pdf" ? input.originalBlobKey : null),
      signedBlobKey: null,
      pageCount: input.pageCount ?? null,
    };
    const withDoc: Envelope = { ...env, documents: [...env.documents, document] };
    return { envelope: this.audit(withDoc, "document_added", "sender", { documentId: document.id, name: document.name }), document };
  }

  /** Record the result of normalizing a document to PDF (server calls after conversion). */
  setDocumentNormalized(
    env: Envelope,
    documentId: string,
    params: { pdfBlobKey: string; pageCount: number }
  ): Envelope {
    const doc = env.documents.find((d) => d.id === documentId);
    if (!doc) throw new NotFoundError(`document ${documentId} not found`);
    return {
      ...env,
      documents: env.documents.map((d) =>
        d.id === documentId ? { ...d, pdfBlobKey: params.pdfBlobKey, pageCount: params.pageCount } : d
      ),
    };
  }

  addRecipient(env: Envelope, input: AddRecipientInput): { envelope: Envelope; recipient: Recipient } {
    this.requireDraft(env);
    if (!input.email.includes("@")) throw new ValidationError("recipient email is invalid", { email: input.email });
    if (!Number.isFinite(input.routingOrder)) throw new ValidationError("routingOrder must be a number");
    const authMethod = input.authMethod ?? "none";
    if (authMethod === "access_code" && !input.accessCodeHash) {
      throw new ValidationError("accessCodeHash is required when authMethod is access_code");
    }
    const recipient: Recipient = {
      id: this.ids.id(),
      name: input.name,
      email: input.email,
      role: input.role,
      routingOrder: input.routingOrder,
      status: "pending",
      tokenHash: null,
      tokenExpiresAt: null,
      viewedAt: null,
      signedAt: null,
      declineReason: null,
      authMethod,
      accessCodeHash: authMethod === "access_code" ? (input.accessCodeHash ?? null) : null,
      authenticatedAt: null,
      failedAuthAttempts: 0,
      lockedUntil: null,
      consentedAt: null,
      consentDisclosureVersion: null,
      signerIp: null,
      signerUserAgent: null,
    };
    const withRec: Envelope = { ...env, recipients: [...env.recipients, recipient] };
    return { envelope: this.audit(withRec, "recipient_added", "sender", { recipientId: recipient.id, role: recipient.role }), recipient };
  }

  addField(env: Envelope, input: AddFieldInput): { envelope: Envelope; field: Field } {
    this.requireDraft(env);
    const doc = env.documents.find((d) => d.id === input.documentId);
    if (!doc) throw new NotFoundError(`document ${input.documentId} not found`);
    const rec = env.recipients.find((r) => r.id === input.recipientId);
    if (!rec) throw new NotFoundError(`recipient ${input.recipientId} not found`);
    if (!isActingRole(rec)) throw new ValidationError("fields can only be assigned to signer/approver recipients");
    // Validate the box is on-page with positive area — including the cross-field
    // constraint (x+width ≤ 1, y+height ≤ 1) that per-field bounds can't express,
    // so a field can never be placed partly off the page and silently clipped.
    const boxError = drawnBoxError({
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
    });
    if (boxError) throw new ValidationError(`invalid field box: ${boxError}`);
    const field: Field = {
      id: this.ids.id(),
      documentId: input.documentId,
      recipientId: input.recipientId,
      page: input.page,
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      kind: input.kind,
      required: input.required ?? true,
      value: null,
    };
    const withField: Envelope = { ...env, fields: [...env.fields, field] };
    return { envelope: this.audit(withField, "field_added", "sender", { fieldId: field.id, kind: field.kind }), field };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Send the envelope: validate, transition draft→sent, and notify the active
   * routing group (minting each an individual signing token via `issueToken`).
   */
  send(env: Envelope, issueToken: () => IssuedToken, options: { expiresInDays?: number } = {}): DomainResult {
    this.requireDraft(env);
    validateForSend(env);
    if (options.expiresInDays !== undefined && (!Number.isFinite(options.expiresInDays) || options.expiresInDays <= 0)) {
      throw new ValidationError("expiresInDays must be a positive number");
    }

    const sentAtMs = this.clock.now().getTime();
    let next: Envelope = {
      ...env,
      status: assertEnvelopeTransition(env.status, "sent"),
      sentAt: this.now(),
      expiresAt:
        options.expiresInDays !== undefined
          ? new Date(sentAtMs + options.expiresInDays * 24 * 3600 * 1000).toISOString()
          : env.expiresAt,
    };
    next = this.audit(next, "envelope_sent", "sender", {
      recipients: actingRecipients(next).length,
    });

    const effects: Effect[] = [];
    for (const r of recipientsToNotify(next)) {
      const res = this.notify(next, r.id, issueToken);
      next = res.envelope;
      effects.push(res.effect);
    }
    return { envelope: next, effects };
  }

  /** Mint a token, mark a recipient notified, audit it, and produce the effect. */
  private notify(
    env: Envelope,
    recipientId: string,
    issueToken: () => IssuedToken
  ): { envelope: Envelope; effect: NotifyEffect } {
    const rec = env.recipients.find((r) => r.id === recipientId);
    if (!rec) throw new NotFoundError(`recipient ${recipientId} not found`);
    const issued = issueToken();
    const updated: Recipient = {
      ...rec,
      status: assertRecipientTransition(rec.status, "notified"),
      tokenHash: issued.tokenHash,
      tokenExpiresAt: issued.expiresAt,
    };
    let next: Envelope = {
      ...env,
      recipients: env.recipients.map((r) => (r.id === recipientId ? updated : r)),
    };
    next = this.audit(next, "recipient_notified", "system", { recipientId });
    return { envelope: next, effect: { type: "notify", recipientId, reason: "your_turn", token: issued.token } };
  }

  /** Whether a recipient has satisfied their authentication requirement. */
  isAuthenticated(rec: Recipient): boolean {
    return rec.authMethod === "none" || rec.authenticatedAt !== null;
  }

  /**
   * Authenticate a recipient with an access code (compared as SHA-256 hashes),
   * gating the signing session. A no-op when no access code is required, and
   * idempotent once authenticated. A wrong code increments a per-recipient failure
   * counter; after `MAX_AUTH_ATTEMPTS` the recipient is LOCKED for
   * `AUTH_LOCKOUT_MS` — so the low-entropy code cannot be brute-forced regardless
   * of the attacker's source IP. Records `recipient_authenticated` on success.
   */
  authenticate(env: Envelope, recipientId: string, providedAccessCodeHash: string): Envelope {
    if (env.status !== "sent") {
      throw new ConflictError("ENVELOPE_NOT_SENT", `envelope is "${env.status}", not accepting authentication`);
    }
    const rec = env.recipients.find((r) => r.id === recipientId);
    if (!rec) throw new NotFoundError(`recipient ${recipientId} not found`);
    if (rec.authMethod !== "access_code" || !rec.accessCodeHash) return env; // no auth required
    if (rec.authenticatedAt) return env; // already authenticated
    const nowMs = this.clock.now().getTime();
    if (rec.lockedUntil && new Date(rec.lockedUntil).getTime() > nowMs) {
      throw new ConflictError("ACCESS_CODE_LOCKED", "too many incorrect attempts; try again later", { recipientId });
    }

    if (!constantTimeEqual(providedAccessCodeHash, rec.accessCodeHash)) {
      const attempts = (rec.failedAuthAttempts ?? 0) + 1;
      const locked = attempts >= MAX_AUTH_ATTEMPTS;
      const failedRec: Recipient = {
        ...rec,
        failedAuthAttempts: locked ? 0 : attempts,
        lockedUntil: locked ? new Date(nowMs + AUTH_LOCKOUT_MS).toISOString() : rec.lockedUntil,
      };
      // Persist the counter (the server saves the returned envelope even on the
      // thrown path is NOT guaranteed, so the caller must save; but we still
      // return via throw — so mutate through an error carrying the next state).
      throw new AccessCodeAttemptError(
        { ...env, recipients: env.recipients.map((r) => (r.id === recipientId ? failedRec : r)) },
        locked
      );
    }

    const updated: Recipient = { ...rec, authenticatedAt: this.now(), failedAuthAttempts: 0, lockedUntil: null };
    const next: Envelope = { ...env, recipients: env.recipients.map((r) => (r.id === recipientId ? updated : r)) };
    return this.audit(next, "recipient_authenticated", recipientId, { recipientId, method: "access_code" });
  }

  /** Record that a recipient opened their documents. Idempotent-ish. */
  markViewed(env: Envelope, recipientId: string): Envelope {
    const rec = env.recipients.find((r) => r.id === recipientId);
    if (!rec) throw new NotFoundError(`recipient ${recipientId} not found`);
    if (rec.status !== "notified") return env; // already viewed/signed/declined → no-op
    const updated: Recipient = { ...rec, status: "viewed", viewedAt: this.now() };
    const next: Envelope = { ...env, recipients: env.recipients.map((r) => (r.id === recipientId ? updated : r)) };
    return this.audit(next, "recipient_viewed", recipientId, { recipientId });
  }

  /**
   * Apply a recipient's signature: verify it's their turn and their token is
   * unexpired, mark them signed, emit a StampEffect for their documents, and
   * either advance routing (notify the next group) or complete the envelope.
   */
  applySignature(
    env: Envelope,
    recipientId: string,
    signature: SignatureInput,
    fieldValues: FieldInput[],
    context: SigningContext,
    issueToken: () => IssuedToken
  ): DomainResult {
    if (env.status !== "sent") {
      throw new ConflictError("ENVELOPE_NOT_SENT", `envelope is "${env.status}", not accepting signatures`);
    }
    const rec = env.recipients.find((r) => r.id === recipientId);
    if (!rec) throw new NotFoundError(`recipient ${recipientId} not found`);
    if (!isActingRole(rec)) throw new ConflictError("RECIPIENT_NOT_SIGNER", "this recipient does not sign");
    if (!recipientMayAct(env, recipientId)) {
      throw new ConflictError("NOT_YOUR_TURN", "it is not this recipient's turn to sign");
    }
    if (rec.tokenExpiresAt && new Date(rec.tokenExpiresAt).getTime() < this.clock.now().getTime()) {
      throw new ConflictError("TOKEN_EXPIRED", "the signing link has expired");
    }
    // Identity + consent gates (ESIGN/UETA): the recipient must have passed any
    // required authentication and explicitly consented to sign electronically.
    if (rec.authMethod === "access_code" && !rec.authenticatedAt) {
      throw new AuthorizationError("access code required before signing", { recipientId });
    }
    if (!context.consented) {
      throw new ValidationError("electronic-signature consent (ESIGN/UETA) is required before signing");
    }

    // Capture this recipient's text/checkbox field values and enforce required
    // fields. `date_signed` auto-fills; signature/initials come from `signature`.
    const valueById = new Map(fieldValues.map((v) => [v.fieldId, v.value]));
    const fieldProblems: string[] = [];
    const updatedFields = env.fields.map((f) => {
      if (f.recipientId !== recipientId) return f;
      if (f.kind === "text") {
        const v = (valueById.get(f.id) ?? "").slice(0, 5000);
        if (f.required && v.trim() === "") fieldProblems.push(`text field ${f.id} is required`);
        return { ...f, value: v };
      }
      if (f.kind === "checkbox") {
        const checked = valueById.get(f.id) === "true";
        if (f.required && !checked) fieldProblems.push(`checkbox ${f.id} must be checked`);
        return { ...f, value: checked ? "true" : "false" };
      }
      return f;
    });
    if (fieldProblems.length > 0) {
      throw new ValidationError("required fields are incomplete", { problems: fieldProblems });
    }

    // Mark signed, capturing consent + client identity evidence (length-capped so
    // a hostile client can't bloat the audit record / certificate).
    const now = this.now();
    const signedRec: Recipient = {
      ...rec,
      status: assertRecipientTransition(rec.status, "signed"),
      signedAt: now,
      consentedAt: now,
      consentDisclosureVersion: ESIGN_CONSENT.version,
      signerIp: context.ip ? context.ip.slice(0, MAX_IP_LEN) : null,
      signerUserAgent: context.userAgent ? context.userAgent.slice(0, MAX_UA_LEN) : null,
    };
    let next: Envelope = {
      ...env,
      recipients: env.recipients.map((r) => (r.id === recipientId ? signedRec : r)),
      fields: updatedFields,
    };
    // Consent is recorded immediately before the signature it authorizes.
    next = this.audit(next, "recipient_consented", recipientId, {
      recipientId,
      disclosureVersion: ESIGN_CONSENT.version,
      ip: context.ip,
      userAgent: context.userAgent,
    });
    next = this.audit(next, "recipient_signed", recipientId, { recipientId, ip: context.ip });

    // Which documents carry this recipient's fields?
    const documentIds = [...new Set(next.fields.filter((f) => f.recipientId === recipientId).map((f) => f.documentId))];
    const effects: Effect[] = [{ type: "stamp", recipientId, documentIds, signature }];

    if (allActingSigned(next)) {
      next = { ...next, status: assertEnvelopeTransition(next.status, "completed"), completedAt: this.now() };
      next = this.audit(next, "envelope_completed", "system", {});
      effects.push({ type: "finalize" });
      // Deliver the completed copy to everyone: the sender AND every recipient.
      effects.push({ type: "notify", toSender: true, reason: "completed_copy" });
      for (const r of next.recipients) {
        effects.push({ type: "notify", recipientId: r.id, reason: "completed_copy" });
      }
    } else {
      // Advance routing: notify whoever is newly active.
      for (const r of recipientsToNotify(next)) {
        const res = this.notify(next, r.id, issueToken);
        next = res.envelope;
        effects.push(res.effect);
      }
    }
    return { envelope: next, effects };
  }

  /** A recipient declines → the whole envelope is declined (terminal). */
  decline(env: Envelope, recipientId: string, reason: string): DomainResult {
    if (env.status !== "sent") {
      throw new ConflictError("ENVELOPE_NOT_SENT", `envelope is "${env.status}", cannot decline`);
    }
    const rec = env.recipients.find((r) => r.id === recipientId);
    if (!rec) throw new NotFoundError(`recipient ${recipientId} not found`);
    const declinedRec: Recipient = {
      ...rec,
      status: assertRecipientTransition(rec.status, "declined"),
      declineReason: reason,
    };
    let next: Envelope = {
      ...env,
      recipients: env.recipients.map((r) => (r.id === recipientId ? declinedRec : r)),
      status: assertEnvelopeTransition(env.status, "declined"),
    };
    next = this.audit(next, "recipient_declined", recipientId, { recipientId, reason });
    // Notify the SENDER with the decline reason. Notify only recipients who were
    // already PART of the flow (notified/viewed/signed) — and WITHOUT the raw
    // free-text reason — so declining doesn't leak the envelope's existence to
    // downstream (still-pending) recipients or expose the decliner's words to them.
    const participated = (s: Recipient["status"]) => s === "notified" || s === "viewed" || s === "signed";
    const effects: Effect[] = [
      { type: "notify", toSender: true, reason: "declined", note: reason },
      ...next.recipients
        .filter((r) => r.id !== recipientId && participated(r.status))
        .map((r) => ({ type: "notify" as const, recipientId: r.id, reason: "declined" as const })),
    ];
    return { envelope: next, effects };
  }

  /**
   * Expire a `sent` envelope whose `expiresAt` has passed (idempotent no-op
   * otherwise). Notifies the sender. Callable lazily on access or by a sweep.
   */
  expireIfDue(env: Envelope, now: Date): DomainResult {
    if (env.status !== "sent" || !env.expiresAt || now.getTime() <= new Date(env.expiresAt).getTime()) {
      return { envelope: env, effects: [] };
    }
    let next: Envelope = { ...env, status: assertEnvelopeTransition(env.status, "expired") };
    next = this.audit(next, "envelope_expired", "system", { expiresAt: env.expiresAt });
    return { envelope: next, effects: [{ type: "notify", toSender: true, reason: "expired" }] };
  }

  /** Re-mint an active recipient's signing link and re-notify them. `reason`
   *  distinguishes a manual resend from a reminder nudge. */
  private renotify(
    env: Envelope,
    recipientId: string,
    reason: "reminder" | "resent",
    issueToken: () => IssuedToken
  ): DomainResult {
    if (env.status !== "sent") {
      throw new ConflictError("ENVELOPE_NOT_SENT", `envelope is "${env.status}", not sent — cannot ${reason}`);
    }
    const rec = env.recipients.find((r) => r.id === recipientId);
    if (!rec) throw new NotFoundError(`recipient ${recipientId} not found`);
    if (!isActingRole(rec)) throw new ConflictError("RECIPIENT_NOT_SIGNER", "this recipient does not sign");
    if (rec.status === "signed" || rec.status === "declined") {
      throw new ConflictError("RECIPIENT_NOT_ACTIVE", `recipient already "${rec.status}" — nothing to ${reason}`);
    }
    if (!recipientMayAct(env, recipientId)) {
      throw new ConflictError("NOT_YOUR_TURN", "not this recipient's turn yet — nothing to resend");
    }
    // Re-mint the token (the raw prior token was never stored, so a fresh link is
    // the only way to re-deliver an accessible link).
    const issued = issueToken();
    const updated: Recipient = { ...rec, tokenHash: issued.tokenHash, tokenExpiresAt: issued.expiresAt };
    let next: Envelope = { ...env, recipients: env.recipients.map((r) => (r.id === recipientId ? updated : r)) };
    next = this.audit(next, reason === "reminder" ? "recipient_reminded" : "recipient_resent", "sender", { recipientId });
    return { envelope: next, effects: [{ type: "notify", recipientId, reason, token: issued.token }] };
  }

  /** Manually re-send an active recipient's signing link. */
  resend(env: Envelope, recipientId: string, issueToken: () => IssuedToken): DomainResult {
    return this.renotify(env, recipientId, "resent", issueToken);
  }

  /** Nudge an active recipient who hasn't yet signed. */
  remind(env: Envelope, recipientId: string, issueToken: () => IssuedToken): DomainResult {
    return this.renotify(env, recipientId, "reminder", issueToken);
  }

  /** Void a draft or sent envelope (terminal). */
  voidEnvelope(env: Envelope, reason: string, actor = "sender"): Envelope {
    const next: Envelope = {
      ...env,
      status: assertEnvelopeTransition(env.status, "voided"),
      voidedReason: reason,
    };
    return this.audit(next, "envelope_voided", actor, { reason });
  }

  /** Record a document's freshly-stamped signed copy (server calls after core stamps). */
  setDocumentSigned(env: Envelope, documentId: string, signedBlobKey: string): Envelope {
    const doc = env.documents.find((d) => d.id === documentId);
    if (!doc) throw new NotFoundError(`document ${documentId} not found`);
    return {
      ...env,
      documents: env.documents.map((d) => (d.id === documentId ? { ...d, signedBlobKey } : d)),
    };
  }
}
