/**
 * The FineSign agreement domain — entity types. Everything here is plain data
 * (serializable), no behavior, no I/O. The aggregate root is `Envelope`, which
 * owns its documents, recipients, fields, and audit log.
 */

import type { SignatureFont } from "finesign-core";

// ── Enums ─────────────────────────────────────────────────────────────────────

export type EnvelopeStatus = "draft" | "sent" | "completed" | "voided" | "declined" | "expired";

/** A recipient's progress. `cc` recipients never reach `signed` — they receive
 *  the completed copy but don't act. */
export type RecipientStatus = "pending" | "notified" | "viewed" | "signed" | "declined";

export type RecipientRole = "signer" | "approver" | "cc";

/** How a recipient must authenticate before signing. `access_code` gates the
 *  session behind a sender-set shared secret (SMS/email OTP is a later addition). */
export type RecipientAuthMethod = "none" | "access_code";

export type RoutingType = "sequential" | "parallel";

export type DocumentFormat = "pdf" | "docx";

/** What a field collects. M4 implements signature + date_signed end-to-end;
 *  initials/text/checkbox are modeled now and stamped in a later milestone. */
export type FieldKind = "signature" | "initials" | "date_signed" | "text" | "checkbox";

// ── Entities ──────────────────────────────────────────────────────────────────

export interface EnvelopeDocument {
  id: string;
  name: string;
  format: DocumentFormat;
  /** Blob key of the original upload (immutable). */
  originalBlobKey: string;
  /** Blob key of the normalized, signable PDF (== original for PDFs). */
  pdfBlobKey: string | null;
  /** Blob key of the current signed PDF, if any signatures have been applied. */
  signedBlobKey: string | null;
  /** Page count of the normalized PDF (null until probed). */
  pageCount: number | null;
}

export interface Recipient {
  id: string;
  name: string;
  email: string;
  role: RecipientRole;
  /** Lower routing orders act first. Recipients sharing an order act in parallel. */
  routingOrder: number;
  status: RecipientStatus;
  /** SHA-256 of the signing-session token (raw token is never stored). */
  tokenHash: string | null;
  /** ISO-8601 token expiry. */
  tokenExpiresAt: string | null;
  viewedAt: string | null;
  signedAt: string | null;
  /** Reason captured when a recipient declines. */
  declineReason: string | null;
  /** Authentication requirement before this recipient can sign. */
  authMethod: RecipientAuthMethod;
  /** SHA-256 of the access code (raw code is never stored), when `authMethod` is
   *  `access_code`. */
  accessCodeHash: string | null;
  /** When the recipient passed authentication (ISO), if required. */
  authenticatedAt: string | null;
  /** Consecutive failed access-code attempts (reset on success). */
  failedAuthAttempts: number;
  /** ISO time until which authentication is locked after too many failures. */
  lockedUntil: string | null;
  /** When the recipient gave ESIGN/UETA electronic-signature consent (ISO). */
  consentedAt: string | null;
  /** The consent-disclosure version the recipient actually agreed to. */
  consentDisclosureVersion: string | null;
  /** Client IP captured at signing (identity evidence for the certificate). */
  signerIp: string | null;
  /** Client user-agent captured at signing. */
  signerUserAgent: string | null;
}

/** A place on a document assigned to exactly one recipient. Box is display-space
 *  fractions (top-left origin) — the same convention as finesign-core. */
export interface Field {
  id: string;
  documentId: string;
  recipientId: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: FieldKind;
  required: boolean;
  /** For `text` fields — the value the recipient entered. */
  value: string | null;
}

export type AuditEventType =
  | "envelope_created"
  | "document_added"
  | "recipient_added"
  | "field_added"
  | "envelope_sent"
  | "recipient_notified"
  | "recipient_authenticated"
  | "recipient_viewed"
  | "recipient_consented"
  | "recipient_signed"
  | "recipient_declined"
  | "recipient_reminded"
  | "recipient_resent"
  | "envelope_completed"
  | "envelope_voided"
  | "envelope_expired";

/** An append-only, hash-chained audit record. `hash = sha256(prevHash ||
 *  canonicalJson({seq,type,at,actor,data}))`. */
export interface AuditEvent {
  id: string;
  seq: number;
  type: AuditEventType;
  at: string;
  /** Who caused it: "system" | "sender" | recipient id. */
  actor: string;
  data: Record<string, unknown>;
  /** Hash of the previous event ("" for the first). */
  prevHash: string;
  hash: string;
}

export interface Envelope {
  id: string;
  title: string;
  status: EnvelopeStatus;
  routingType: RoutingType;
  senderName: string;
  senderEmail: string;
  createdAt: string;
  sentAt: string | null;
  completedAt: string | null;
  voidedReason: string | null;
  /** When the envelope expires (ISO) — set at send. Past this, a `sent` envelope
   *  transitions to `expired` and can no longer be signed. `null` = no expiry. */
  expiresAt: string | null;
  documents: EnvelopeDocument[];
  recipients: Recipient[];
  fields: Field[];
  audit: AuditEvent[];
  /** Optimistic-concurrency version. `save` only succeeds when the stored version
   *  matches this value, then increments it — so two concurrent mutations of the
   *  same envelope (e.g. a double-submitted signature) can't silently lose one. */
  version: number;
}

// ── Sign-time input ───────────────────────────────────────────────────────────

/** What a signer submits to complete their signature fields. */
export type SignatureInput =
  | { kind: "image"; dataUrl: string }
  | { kind: "typed"; name: string; font: SignatureFont };

/** A value a signer enters for a text field, or a checkbox toggle ("true"/"false").
 *  `date_signed` is auto-filled and `signature`/`initials` come from `SignatureInput`. */
export interface FieldInput {
  fieldId: string;
  value: string;
}

/** Client evidence captured when a recipient acts (for the audit trail + the
 *  certificate of completion). Supplied by the server from the HTTP request. */
export interface SigningContext {
  /** Client IP (trustProxy-aware). */
  ip: string | null;
  /** Client user-agent. */
  userAgent: string | null;
  /** The signer explicitly consented to sign electronically (ESIGN/UETA). */
  consented: boolean;
}

/** Version + text of the electronic-record-and-signature consent disclosure the
 *  signer must accept (ESIGN Act / UETA). Bumping the version records which
 *  wording a given consent event agreed to. */
export const ESIGN_CONSENT = {
  version: "1.0",
  disclosure:
    "By selecting “I agree”, you consent to use electronic records and signatures for this " +
    "transaction, to conduct it electronically, and to have your signing IP address, timestamp, " +
    "and this consent recorded. You may request a paper copy or withdraw consent before signing " +
    "by contacting the sender. Your electronic signature is legally binding under the U.S. ESIGN " +
    "Act and UETA (and equivalent laws where applicable).",
} as const;
