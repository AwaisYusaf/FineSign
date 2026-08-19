/**
 * `@finesign/domain` — the pure FineSign agreement model: entities, status state
 * machine, routing, hash-chained audit, send-time validation, the envelope
 * application service, and the port interfaces adapters implement. No I/O.
 *
 * @packageDocumentation
 */

export type {
  EnvelopeStatus,
  RecipientStatus,
  RecipientRole,
  RecipientAuthMethod,
  RoutingType,
  DocumentFormat,
  FieldKind,
  EnvelopeDocument,
  Recipient,
  Field,
  AuditEvent,
  AuditEventType,
  Envelope,
  SignatureInput,
  SigningContext,
  FieldInput,
} from "./types";
export { ESIGN_CONSENT } from "./types";

export {
  IllegalTransitionError,
  canEnvelopeTransition,
  canRecipientTransition,
  assertEnvelopeTransition,
  assertRecipientTransition,
  isEnvelopeTerminal,
} from "./state-machine";

export { appendAuditEvent, verifyAuditChain, canonicalJson } from "./audit";

export {
  isActingRole,
  actingRecipients,
  activeRecipients,
  recipientsToNotify,
  allActingSigned,
  recipientMayAct,
} from "./routing";

export { validateForSend } from "./validation";

export {
  EnvelopeService,
  AccessCodeAttemptError,
  type IssuedToken,
  type CreateEnvelopeInput,
  type AddDocumentInput,
  type AddRecipientInput,
  type AddFieldInput,
} from "./envelope-service";

export type {
  Effect,
  NotifyEffect,
  StampEffect,
  FinalizeEffect,
  DomainResult,
} from "./effects";

export type {
  EnvelopeRepository,
  BlobStore,
  DocumentConverter,
} from "./ports";
