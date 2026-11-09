/**
 * The FineSign REST API's JSON, as the web UI consumes it. Written by hand from
 * the server's responses: the web package depends on the API over HTTP only,
 * never on server/domain code (FACTORY §2).
 */

export type EnvelopeStatus = "draft" | "sent" | "completed" | "voided" | "declined" | "expired";
export type RecipientStatus = "pending" | "notified" | "viewed" | "signed" | "declined";
export type RecipientRole = "signer" | "approver" | "cc";
export type RoutingType = "sequential" | "parallel";
export type FieldKind = "signature" | "initials" | "date_signed" | "text" | "checkbox";
export type SignatureFont = "great_vibes" | "dancing_script" | "pacifico" | "pinyon_script";

export type AuditEventType =
  | "envelope_created"
  | "document_added"
  | "recipient_added"
  | "field_added"
  | "field_removed"
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

export interface EnvelopeDocument {
  id: string;
  name: string;
  format: "pdf" | "docx";
  pageCount: number | null;
  /** Set once someone has signed it (and, at completion, the sealed copy). */
  signedBlobKey: string | null;
}

export interface Recipient {
  id: string;
  name: string;
  email: string;
  role: RecipientRole;
  routingOrder: number;
  status: RecipientStatus;
  authMethod: "none" | "access_code";
  viewedAt: string | null;
  signedAt: string | null;
  declineReason: string | null;
  consentedAt: string | null;
}

export interface Field {
  id: string;
  documentId: string;
  recipientId: string;
  page: number;
  /** Display-space fractions (0–1), top-left origin — the API's one convention. */
  x: number;
  y: number;
  width: number;
  height: number;
  kind: FieldKind;
  required: boolean;
}

export interface AuditEvent {
  id: string;
  seq: number;
  type: AuditEventType;
  at: string;
  /** "system" | "sender" | a recipient id. */
  actor: string;
  data: Record<string, unknown>;
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
  expiresAt: string | null;
  documents: EnvelopeDocument[];
  recipients: Recipient[];
  fields: Field[];
  audit: AuditEvent[];
}

export interface DevLink {
  recipientId: string;
  name: string;
  email: string;
  link: string;
}

export interface Verification {
  valid: boolean;
  level: string | null;
  signatureCount: number;
  documentTimestamp?: { present: boolean; valid: boolean };
}

export interface WebhookSubscription {
  id: string;
  url: string;
  /** `null` means every event type. */
  eventTypes: string[] | null;
  active: boolean;
  createdAt: string;
}

export interface DeliverySummary {
  delivered: number;
  retried: number;
  dead: number;
}

/** A field as the signer sees it (no other recipient's fields are ever sent). */
export interface SessionField {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: FieldKind;
  required: boolean;
}

export interface SessionDocument {
  id: string;
  name: string;
  pageCount: number | null;
  fields: SessionField[];
}

export interface Session {
  envelopeId: string;
  title: string;
  /** "sent" while signing; "completed" makes the session a read-only download page. */
  status: EnvelopeStatus;
  /** `status: "signed"` while the envelope is still `sent`: this recipient is done. */
  recipient: { id: string; name: string; role: RecipientRole; status: RecipientStatus };
  authRequired: boolean;
  authenticated: boolean;
  consent: { version: string; disclosure: string };
  documents: SessionDocument[];
}

/** The signature payload `POST /sign/:token/apply` expects. */
export type Signature = { kind: "image"; dataUrl: string } | { kind: "typed"; name: string; font: SignatureFont };
