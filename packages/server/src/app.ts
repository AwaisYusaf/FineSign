/**
 * `EnvelopeApp` — the application service (composition of pure domain + I/O
 * adapters). It executes the `Effect`s the domain returns: sending mail,
 * stamping PDFs via finesign-core, and writing the certificate. This is where
 * side-effects live; the domain stays pure.
 */
import {
  EnvelopeService,
  ESIGN_CONSENT,
  AccessCodeAttemptError,
  type Envelope,
  type EnvelopeListParams,
  type EnvelopeRepository,
  type BlobStore,
  type DocumentConverter,
  type Effect,
  type NotifyEffect,
  type SignatureInput,
  type SigningContext,
  type FieldInput,
  type DocumentFormat,
  type RecipientRole,
  type RecipientStatus,
  type RecipientAuthMethod,
  type FieldKind,
  type IssuedToken,
} from "@finesign/domain";
import type { Mailer } from "./mailer";
import {
  Clock,
  IdGenerator,
  Logger,
  ValidationError,
  NotFoundError,
  AuthorizationError,
  ConflictError,
  hashToken,
} from "@finesign/shared";
import { SignEngine } from "finesign-core";
import { normalizeDocument } from "@finesign/convert";
import { stampForRecipient } from "./stamping";
import { buildCertificate, appendCertificate, sha256Hex } from "./certificate";
import type { DocumentSealer } from "./sealer";
import type { VerificationResult } from "@finesign/pades";
import type { WebhookStore, WebhookSubscription, WebhookDelivery } from "@finesign/storage";
import {
  WebhookDeliverer,
  buildWebhookBody,
  subscriptionAccepts,
  assertValidWebhookUrl,
  type WebhookConfig,
  type HostResolver,
  type WebhookFetch,
  type DeliverySummary,
} from "./webhooks";

export interface AppConfig {
  /** Public base URL used to build signing links. */
  baseUrl: string;
  /**
   * Path prefix for the human-facing signer page in signing links, i.e. links
   * are `${baseUrl}${signPath}/${token}`. Defaults to "/sign". Point it at the
   * web UI's signer route (e.g. "/s") when a front-end owns that page separately
   * from the API's `/sign/*` JSON routes.
   */
  signPath?: string;
  /** Signing-token lifetime in milliseconds. */
  tokenTtlMs: number;
  /** Max upload size in bytes. */
  maxUploadBytes: number;
  /** When true, completing an envelope REQUIRES a configured sealer; a missing
   *  sealer fails the completion rather than delivering an unsealed document
   *  (fail-closed). */
  sealRequired?: boolean;
  /**
   * DEV ONLY (default false). When true, raw signer links are retained in memory
   * and exposed via `GET /api/envelopes/:id/dev-links` so a local UI can show
   * them without reading email. NEVER enable in production — it defeats the
   * whole point of tokens being delivered only to the recipient.
   */
  devExposeTokens?: boolean;
}

/** A dev-only signer link (see AppConfig.devExposeTokens). */
export interface DevLink {
  recipientId: string;
  name: string;
  email: string;
  link: string;
}

export interface AppDeps {
  repo: EnvelopeRepository;
  blobs: BlobStore;
  converter: DocumentConverter;
  mailer: Mailer;
  engine: SignEngine;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  config: AppConfig;
  /** Optional cryptographic sealer (PAdES). When present, completed documents
   *  are sealed and become verifiable; when absent, they are delivered unsealed. */
  sealer?: DocumentSealer;
  /** Optional webhook fan-out. When present, each new audit event is enqueued to
   *  matching subscriptions and delivered (HMAC-signed, SSRF-guarded, retried). */
  webhooks?: {
    store: WebhookStore;
    config?: Partial<WebhookConfig>;
    /** Injectable DNS resolver + fetch (tests). */
    resolveHost?: HostResolver;
    fetchImpl?: WebhookFetch;
  };
}

/** A subscription with the signing secret stripped (all reads except creation). */
export type RedactedSubscription = Omit<WebhookSubscription, "secret">;

function redactSubscription(sub: WebhookSubscription): RedactedSubscription {
  const { secret: _secret, ...rest } = sub;
  void _secret;
  return rest;
}

/** A signer's view of what they must sign (only their own documents + fields). */
export interface SessionView {
  envelopeId: string;
  title: string;
  /** Envelope status. `sent` is the signing state; `completed` turns the session
   *  into a read-only view of the finished package. */
  status: string;
  /** `status` lets the page show "already signed" to a signer who reopens
   *  their link while others are still signing. */
  recipient: { id: string; name: string; role: RecipientRole; status: RecipientStatus };
  /** True when this recipient must pass an access-code challenge first. */
  authRequired: boolean;
  /** True once authentication is satisfied (or not required). */
  authenticated: boolean;
  /** The ESIGN/UETA consent disclosure the signer must accept before signing. */
  consent: { version: string; disclosure: string };
  /** Empty until the recipient is authenticated (documents are not revealed to
   *  an un-authenticated access-code recipient). */
  documents: {
    id: string;
    name: string;
    pageCount: number | null;
    /** `required` lets the signer UI say what is still missing before the
     *  server would reject the submission. */
    fields: {
      id: string;
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
      kind: FieldKind;
      required: boolean;
    }[];
  }[];
}

/** How many overdue envelopes one expiry-sweep batch claims at a time. */
const SWEEP_BATCH_SIZE = 200;

/** Attempts a load → decide → save operation gets before a lost optimistic-
 *  concurrency race is reported to the caller (see `retryOnConflict`). */
export const CONFLICT_RETRY_LIMIT = 5;

/** The repository's "someone else saved first" signal (contract-tested). */
function isVersionConflict(e: unknown): boolean {
  return e instanceof ConflictError && e.code === "VERSION_CONFLICT";
}

function certKey(envelopeId: string): string {
  return `env/${envelopeId}/certificate.pdf`;
}

export class EnvelopeApp {
  private readonly svc: EnvelopeService;
  /** DEV ONLY: envelopeId → issued signer links (populated only when
   *  config.devExposeTokens is on). See AppConfig.devExposeTokens. */
  private readonly devLinks = new Map<string, DevLink[]>();
  private readonly deliverer?: WebhookDeliverer;
  constructor(private readonly deps: AppDeps) {
    this.svc = new EnvelopeService(deps.clock, deps.ids);
    if (deps.webhooks) {
      this.deliverer = new WebhookDeliverer(
        deps.webhooks.store,
        { clock: deps.clock, logger: deps.logger },
        { config: deps.webhooks.config, resolveHost: deps.webhooks.resolveHost, fetchImpl: deps.webhooks.fetchImpl }
      );
    }
  }

  /** DEV ONLY: the signer links issued for an envelope. Empty unless
   *  config.devExposeTokens is enabled. */
  getDevLinks(envelopeId: string): DevLink[] {
    if (!this.deps.config.devExposeTokens) return [];
    return this.devLinks.get(envelopeId) ?? [];
  }

  private issueToken(): IssuedToken {
    const token = this.deps.ids.token();
    return {
      token,
      tokenHash: hashToken(token),
      expiresAt: new Date(this.deps.clock.now().getTime() + this.deps.config.tokenTtlMs).toISOString(),
    };
  }

  private async load(id: string): Promise<Envelope> {
    const env = await this.deps.repo.findById(id);
    if (!env) throw new NotFoundError(`envelope ${id} not found`, { id });
    return env;
  }

  // ── Draft authoring ─────────────────────────────────────────────────────────

  async createDraft(input: {
    title: string;
    routingType: "sequential" | "parallel";
    senderName: string;
    senderEmail: string;
  }): Promise<Envelope> {
    const env = this.svc.createEnvelope(input);
    await this.deps.repo.create(env);
    return env;
  }

  async getEnvelope(id: string): Promise<Envelope> {
    return this.load(id);
  }

  async listEnvelopes(params?: EnvelopeListParams): Promise<Envelope[]> {
    return this.deps.repo.list(params);
  }

  async addDocument(
    envelopeId: string,
    input: { name: string; format: DocumentFormat; bytes: Uint8Array }
  ): Promise<Envelope> {
    if (input.bytes.length === 0) throw new ValidationError("uploaded document is empty");
    if (input.bytes.length > this.deps.config.maxUploadBytes) {
      throw new ValidationError("uploaded document exceeds the size limit", {
        maxBytes: this.deps.config.maxUploadBytes,
      });
    }
    assertMagic(input.bytes, input.format);

    const env = await this.load(envelopeId);
    const oid = this.deps.ids.id();
    const originalKey = `env/${envelopeId}/original/${oid}`;
    await this.deps.blobs.put(originalKey, input.bytes, mimeFor(input.format));

    const { pdf, pageCount } = await normalizeDocument(this.deps.converter, input.bytes, input.format);
    const pdfKey = `env/${envelopeId}/pdf/${oid}.pdf`;
    await this.deps.blobs.put(pdfKey, pdf, "application/pdf");

    const { envelope } = this.svc.addDocument(env, {
      name: input.name,
      format: input.format,
      originalBlobKey: originalKey,
      pdfBlobKey: pdfKey,
      pageCount,
    });
    await this.deps.repo.save(envelope);
    return envelope;
  }

  async addRecipient(
    envelopeId: string,
    input: {
      name: string;
      email: string;
      role: RecipientRole;
      routingOrder: number;
      authMethod?: RecipientAuthMethod;
      /** Raw access code (hashed here; the raw value is never stored). */
      accessCode?: string;
    }
  ): Promise<Envelope> {
    const env = await this.load(envelopeId);
    const { authMethod, accessCode, ...rest } = input;
    if (authMethod === "access_code" && (!accessCode || accessCode.trim().length < 4)) {
      throw new ValidationError("access code must be at least 4 characters");
    }
    const { envelope } = this.svc.addRecipient(env, {
      ...rest,
      authMethod: authMethod ?? "none",
      ...(authMethod === "access_code" && accessCode ? { accessCodeHash: hashToken(accessCode) } : {}),
    });
    await this.deps.repo.save(envelope);
    return envelope;
  }

  async addField(
    envelopeId: string,
    input: {
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
  ): Promise<Envelope> {
    const env = await this.load(envelopeId);
    const { envelope } = this.svc.addField(env, input);
    await this.deps.repo.save(envelope);
    return envelope;
  }

  /** Remove a placed field from a draft (a misplaced click is not a dead end). */
  async removeField(envelopeId: string, fieldId: string): Promise<Envelope> {
    const env = await this.load(envelopeId);
    const { envelope } = this.svc.removeField(env, fieldId);
    await this.deps.repo.save(envelope);
    return envelope;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async send(envelopeId: string, options: { expiresInDays?: number } = {}): Promise<Envelope> {
    const env = await this.load(envelopeId);
    const result = this.svc.send(env, () => this.issueToken(), options);
    return this.persistThenDeliver(result.envelope, result.effects);
  }

  /** Manually re-send an active recipient's signing link (fresh token). */
  async resend(envelopeId: string, recipientId: string): Promise<Envelope> {
    return this.retryOnConflict(async () => {
      const env = await this.load(envelopeId);
      const result = this.svc.resend(env, recipientId, () => this.issueToken());
      return this.persistThenDeliver(result.envelope, result.effects);
    });
  }

  /** Nudge an active recipient who hasn't yet signed (fresh token). */
  async remind(envelopeId: string, recipientId: string): Promise<Envelope> {
    return this.retryOnConflict(async () => {
      const env = await this.load(envelopeId);
      const result = this.svc.remind(env, recipientId, () => this.issueToken());
      return this.persistThenDeliver(result.envelope, result.effects);
    });
  }

  /**
   * Expire every `sent` envelope past its `expiresAt`. Returns the count expired.
   * Intended for a periodic sweep; individual accesses also expire lazily via
   * `resolveToken`. Best-effort per envelope — a save conflict is skipped, not fatal.
   *
   * Works in bounded batches off an indexed query rather than scanning the table:
   * this runs on a timer for the life of the process, and the due set is almost
   * always empty, so loading and deserializing every envelope each tick was
   * O(table) work for nothing (and an OOM waiting to happen on a large store).
   * Batches repeat until a pass yields no further progress, so one tick still
   * drains a backlog.
   */
  async sweepExpired(batchSize = SWEEP_BATCH_SIZE): Promise<number> {
    let expired = 0;
    for (;;) {
      const now = this.deps.clock.now();
      const due = await this.deps.repo.listExpirable(now.toISOString(), batchSize);
      if (due.length === 0) return expired;
      let progressed = 0;
      for (const env of due) {
        const result = this.svc.expireIfDue(env, now);
        if (result.envelope.status !== "expired") continue;
        try {
          await this.persistThenDeliver(result.envelope, result.effects);
          expired++;
          progressed++;
        } catch {
          // Concurrent mutation lost the CAS — leave it for the next sweep/access.
        }
      }
      // Nothing in this batch could be advanced (all contended, or all skipped),
      // so another identical query would return the same rows forever.
      if (progressed === 0) return expired;
    }
  }

  async voidEnvelope(envelopeId: string, reason: string): Promise<Envelope> {
    return this.retryOnConflict(async () => {
      const env = await this.load(envelopeId);
      const result = this.svc.voidEnvelope(env, reason);
      // Through persistThenDeliver like every transition: the save, then the
      // webhook fan-out and the "withdrawn" emails (FS-017 — this used to save
      // directly, so neither ever happened).
      return this.persistThenDeliver(result.envelope, result.effects);
    });
  }

  // ── Webhooks (event callbacks) ──────────────────────────────────────────────

  private requireWebhooks(): { store: WebhookStore; deliverer: WebhookDeliverer } {
    if (!this.deps.webhooks || !this.deliverer) {
      throw new ConflictError("WEBHOOKS_DISABLED", "webhooks are not configured on this server");
    }
    return { store: this.deps.webhooks.store, deliverer: this.deliverer };
  }

  /** Register a subscription. Returns it WITH the secret exactly once (so the
   *  operator can copy it); every later read redacts the secret. A missing secret
   *  is generated. The URL is validated (https + no creds + not a private IP). */
  async createWebhookSubscription(input: {
    url: string;
    secret?: string;
    eventTypes?: string[] | null;
  }): Promise<WebhookSubscription> {
    const { store, deliverer } = this.requireWebhooks();
    assertValidWebhookUrl(input.url, deliverer.settings.allowPrivate);
    if (input.eventTypes !== undefined && input.eventTypes !== null) {
      if (!Array.isArray(input.eventTypes) || input.eventTypes.some((t) => typeof t !== "string" || t.length === 0)) {
        throw new ValidationError("eventTypes must be an array of non-empty strings, or null for all events");
      }
    }
    const secret = input.secret && input.secret.length > 0 ? input.secret : this.deps.ids.token();
    if (secret.length < 16) throw new ValidationError("webhook secret must be at least 16 characters");
    const sub: WebhookSubscription = {
      id: this.deps.ids.id(),
      url: input.url,
      secret,
      eventTypes: input.eventTypes ?? null,
      active: true,
      createdAt: this.deps.clock.now().toISOString(),
    };
    await store.createSubscription(sub);
    return sub; // secret included ONCE (route returns it verbatim on create)
  }

  async listWebhookSubscriptions(): Promise<RedactedSubscription[]> {
    const { store } = this.requireWebhooks();
    return (await store.listSubscriptions()).map(redactSubscription);
  }

  async getWebhookSubscription(id: string): Promise<RedactedSubscription> {
    const { store } = this.requireWebhooks();
    const sub = await store.getSubscription(id);
    if (!sub) throw new NotFoundError(`webhook subscription ${id} not found`);
    return redactSubscription(sub);
  }

  async deleteWebhookSubscription(id: string): Promise<void> {
    const { store } = this.requireWebhooks();
    if (!(await store.deleteSubscription(id))) throw new NotFoundError(`webhook subscription ${id} not found`);
  }

  /** Drain the delivery outbox once (POST due deliveries, retry/dead-letter). */
  async deliverWebhooks(limit?: number): Promise<DeliverySummary> {
    const { deliverer } = this.requireWebhooks();
    return deliverer.deliverDue(limit);
  }

  /** Recent deliveries (redacted of nothing — payloads are already non-secret). */
  async listWebhookDeliveries(subscriptionId?: string, limit?: number): Promise<WebhookDelivery[]> {
    const { store } = this.requireWebhooks();
    return store.listDeliveries({ subscriptionId, limit });
  }

  // ── Signer session (token) ──────────────────────────────────────────────────

  private async resolveToken(rawToken: string): Promise<{ envelope: Envelope; recipientId: string }> {
    const hit = await this.deps.repo.findByRecipientTokenHash(hashToken(rawToken));
    if (!hit) throw new AuthorizationError("invalid signing link");
    // Lazy expiry: if this envelope is past its deadline, transition it (and
    // notify the sender) before refusing access — so an abandoned envelope
    // expires on next touch even without a running sweep.
    const due = this.svc.expireIfDue(hit.envelope, this.deps.clock.now());
    if (due.envelope.status === "expired") {
      await this.persistThenDeliver(due.envelope, due.effects);
      throw new ConflictError("ENVELOPE_EXPIRED", "this envelope has expired");
    }
    const rec = hit.envelope.recipients.find((r) => r.id === hit.recipientId)!;
    if (rec.tokenExpiresAt && new Date(rec.tokenExpiresAt).getTime() < this.deps.clock.now().getTime()) {
      throw new ConflictError("TOKEN_EXPIRED", "this signing link has expired");
    }
    return hit;
  }

  async getSession(rawToken: string): Promise<SessionView> {
    return this.retryOnConflict(() => this.getSessionOnce(rawToken));
  }

  private async getSessionOnce(rawToken: string): Promise<SessionView> {
    const { envelope, recipientId } = await this.resolveToken(rawToken);
    // A completed envelope keeps serving this session read-only: the recipient is
    // entitled to the finished package they were told about, and their token is
    // the only credential they hold. Every other status is a dead end.
    if (envelope.status === "completed") return this.completedSession(envelope, recipientId);
    if (envelope.status !== "sent") {
      throw new ConflictError("ENVELOPE_NOT_SENT", `envelope is "${envelope.status}"`);
    }
    const consent = { version: ESIGN_CONSENT.version, disclosure: ESIGN_CONSENT.disclosure };
    const current = envelope.recipients.find((r) => r.id === recipientId)!;

    // Access-code gate: do NOT reveal the documents (or mark viewed) until the
    // recipient has authenticated.
    if (!this.svc.isAuthenticated(current)) {
      return {
        envelopeId: envelope.id,
        title: envelope.title,
        status: envelope.status,
        recipient: { id: current.id, name: current.name, role: current.role, status: current.status },
        authRequired: true,
        authenticated: false,
        consent,
        documents: [],
      };
    }

    // Mark viewed (no-op if already past notified). Only save a real change: a
    // reload by someone who already viewed must not bump the version and so
    // collide with a co-signer's submission.
    const viewed = this.svc.markViewed(envelope, recipientId);
    if (viewed !== envelope) await this.deps.repo.save(viewed);

    const rec = viewed.recipients.find((r) => r.id === recipientId)!;
    const myFields = viewed.fields.filter((f) => f.recipientId === recipientId);
    return {
      envelopeId: viewed.id,
      title: viewed.title,
      status: viewed.status,
      recipient: { id: rec.id, name: rec.name, role: rec.role, status: rec.status },
      authRequired: rec.authMethod !== "none",
      authenticated: true,
      consent,
      documents: this.documentsFor(viewed, recipientId)
        .map((d) => ({
          id: d.id,
          name: d.name,
          pageCount: d.pageCount,
          fields: myFields
            .filter((f) => f.documentId === d.id)
            .map((f) => ({
              id: f.id,
              page: f.page,
              x: f.x,
              y: f.y,
              width: f.width,
              height: f.height,
              kind: f.kind,
              required: f.required,
            })),
        })),
    };
  }

  /**
   * Which documents this recipient may see — while signing, and once completed.
   *
   * Deliberately not "all of them": a recipient sees only the documents carrying
   * their own fields, and completion is not a reason to widen that.
   *
   * The exception is a recipient with NO fields, who was never scoped to a
   * subset in the first place and would otherwise be handed nothing: an
   * approver with nothing to fill in (which `validateForSend` permits — it
   * requires fields of *signers* only) must still see what they are approving,
   * and every `cc` receives the finished agreement — that is their entire role.
   */
  private documentsFor(env: Envelope, recipientId: string): Envelope["documents"] {
    const mine = new Set(env.fields.filter((f) => f.recipientId === recipientId).map((f) => f.documentId));
    if (mine.size === 0) return env.documents;
    return env.documents.filter((d) => mine.has(d.id));
  }

  /**
   * The read-only session a recipient sees once the envelope is completed: the
   * finished, sealed documents, with no fields left to fill.
   *
   * The access code still guards them. A signer passed it before signing, but a
   * `cc` given a code never met the gate during signing, and the finished
   * package is exactly what the sender asked the code to protect. Until it is
   * entered the documents stay hidden (and `getSessionDocument` refuses them).
   */
  private completedSession(env: Envelope, recipientId: string): SessionView {
    const rec = env.recipients.find((r) => r.id === recipientId)!;
    const authenticated = this.svc.isAuthenticated(rec);
    return {
      envelopeId: env.id,
      title: env.title,
      status: env.status,
      recipient: { id: rec.id, name: rec.name, role: rec.role, status: rec.status },
      authRequired: rec.authMethod !== "none",
      authenticated,
      consent: { version: ESIGN_CONSENT.version, disclosure: ESIGN_CONSENT.disclosure },
      documents: (authenticated ? this.documentsFor(env, recipientId) : []).map((d) => ({
        id: d.id,
        name: d.name,
        pageCount: d.pageCount,
        fields: [],
      })),
    };
  }

  /** Authenticate the signer with an access code (hashed here). Returns whether
   *  the session is now authenticated. A wrong code persists the incremented
   *  failure counter (via `AccessCodeAttemptError`) before surfacing the error, so
   *  the per-recipient lockout actually accumulates. */
  async authenticate(rawToken: string, accessCode: string): Promise<{ authenticated: boolean }> {
    // Retried as a whole, so a lost race re-counts a wrong code on fresh state
    // rather than dropping the failure counter that drives the lockout.
    return this.retryOnConflict(async () => {
      const { envelope, recipientId } = await this.resolveToken(rawToken);
      let next: Envelope;
      try {
        next = this.svc.authenticate(envelope, recipientId, hashToken(accessCode));
      } catch (e) {
        if (e instanceof AccessCodeAttemptError) {
          await this.deps.repo.save(e.envelope); // persist the failure counter / lockout
        }
        throw e;
      }
      await this.deps.repo.save(next);
      const rec = next.recipients.find((r) => r.id === recipientId)!;
      return { authenticated: this.svc.isAuthenticated(rec) };
    });
  }

  /**
   * Serve a document's PDF bytes to the SIGNER (token-auth), so their browser can
   * render it. Scoped by `documentsFor` — a signer can't fetch a document they
   * aren't party to. Returns the pre-signature normalized PDF (what they review +
   * sign on top of).
   */
  async getSessionDocument(
    rawToken: string,
    documentId: string
  ): Promise<{ bytes: Uint8Array; filename: string }> {
    const { envelope, recipientId } = await this.resolveToken(rawToken);
    const rec = envelope.recipients.find((r) => r.id === recipientId)!;
    if (!this.svc.isAuthenticated(rec)) {
      throw new AuthorizationError("access code required before viewing documents", { recipientId });
    }
    // Once completed, this serves the SIGNED (and sealed, certificate-bearing)
    // copy — the artifact the recipient was told was available. Before that it is
    // the pre-signature PDF they review and sign on top of.
    const completed = envelope.status === "completed";
    const doc = this.documentsFor(envelope, recipientId).find((d) => d.id === documentId);
    const key = completed ? (doc?.signedBlobKey ?? doc?.pdfBlobKey) : doc?.pdfBlobKey;
    if (!doc || !key) throw new NotFoundError("document not available for this signer");
    const bytes = await this.deps.blobs.get(key);
    const base = doc.name.replace(/\.(docx)$/i, ".pdf");
    return { bytes, filename: completed ? base.replace(/\.pdf$/i, ".signed.pdf") : base };
  }

  async applySignature(
    rawToken: string,
    signature: SignatureInput,
    fieldValues: FieldInput[],
    context: SigningContext
  ): Promise<{ status: string }> {
    return this.retryOnConflict(async () => {
      const { envelope, recipientId } = await this.resolveToken(rawToken);
      const result = this.svc.applySignature(envelope, recipientId, signature, fieldValues, context, () => this.issueToken());
      const finalEnv = await this.persistThenDeliver(result.envelope, result.effects);
      return { status: finalEnv.status };
    });
  }

  async declineByToken(rawToken: string, reason: string): Promise<{ status: string }> {
    return this.retryOnConflict(async () => {
      const { envelope, recipientId } = await this.resolveToken(rawToken);
      const result = this.svc.decline(envelope, recipientId, reason);
      const finalEnv = await this.persistThenDeliver(result.envelope, result.effects);
      return { status: finalEnv.status };
    });
  }

  // ── Downloads ───────────────────────────────────────────────────────────────

  async downloadDocument(
    envelopeId: string,
    documentId: string
  ): Promise<{ bytes: Uint8Array; filename: string }> {
    const env = await this.load(envelopeId);
    const doc = env.documents.find((d) => d.id === documentId);
    if (!doc) throw new NotFoundError(`document ${documentId} not found`);
    const key = doc.signedBlobKey ?? doc.pdfBlobKey;
    if (!key) throw new NotFoundError("document has no signable PDF");
    const bytes = await this.deps.blobs.get(key);
    // Sanitize the (attacker-supplied) document name before it reaches the
    // content-disposition header (S3): keep it to a safe filename charset, strip
    // quotes/control/path chars, and cap length. The header itself is still
    // quoted + validated in the route.
    const base = doc.name
      .replace(/\.(pdf|docx)$/i, "")
      .replace(/[^A-Za-z0-9._ -]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "document";
    return { bytes, filename: `${base}${doc.signedBlobKey ? ".signed" : ""}.pdf` };
  }

  /**
   * Cryptographically verify a document (the PAdES seal): integrity, whole-
   * document coverage, signed attributes, and trust. Available for any document;
   * a still-unsigned document simply has no signatures.
   */
  async verifyDocument(envelopeId: string, documentId: string): Promise<VerificationResult> {
    if (!this.deps.sealer) {
      return {
        valid: false,
        level: "B-B",
        documentTimestamp: { present: false, valid: false, time: null, coversDss: false },
        signatureCount: 0,
        signatures: [],
      };
    }
    const env = await this.load(envelopeId);
    const doc = env.documents.find((d) => d.id === documentId);
    if (!doc) throw new NotFoundError(`document ${documentId} not found`);
    const key = doc.signedBlobKey ?? doc.pdfBlobKey;
    if (!key) throw new NotFoundError("document has no PDF");
    const bytes = await this.deps.blobs.get(key);
    return this.deps.sealer.verify(bytes);
  }

  async downloadCertificate(envelopeId: string): Promise<Uint8Array> {
    const env = await this.load(envelopeId);
    const key = certKey(env.id);
    // The status check is not redundant with the blob check: a certificate must
    // describe the envelope as it is, never a completion that did not happen.
    if (env.status !== "completed" || !(await this.deps.blobs.exists(key))) {
      throw new NotFoundError("certificate is available only after completion");
    }
    return this.deps.blobs.get(key);
  }

  // ── Effect execution ──────────────────────────────────────────────────────

  /**
   * Run a whole load → decide → save operation again when its save loses an
   * optimistic-concurrency race (`VERSION_CONFLICT`).
   *
   * Once an envelope is out, its participants act on it concurrently: a
   * co-signer signs, or just opens their link (which records "viewed"), while
   * someone else's submission is mid-flight. The repository is right to refuse
   * the stale save; the answer is to redo the work on fresh state rather than
   * hand a signer a raw 409. Redoing is safe here: every operation re-reads the
   * envelope, the domain re-derives its decision from it (a decision that is no
   * longer legal throws its own error), and every blob written before the save
   * uses a fresh random key, so a lost attempt leaves an orphan rather than
   * clobbering a blob the winner references. (The one fixed-key blob, the
   * standalone certificate, is written after the save.) Notifications and
   * webhooks only run after a save succeeds, so a retry never double-sends. Bounded, with a short jittered
   * pause so the competing request can finish.
   */
  private async retryOnConflict<T>(op: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (e) {
        if (!isVersionConflict(e) || attempt >= CONFLICT_RETRY_LIMIT) throw e;
        await new Promise((resolve) => setTimeout(resolve, attempt * 10 + Math.floor(Math.random() * 10)));
      }
    }
  }

  /**
   * Execute a domain operation's effects with a crash-safe ordering (K4):
   *   1. run STATE-CHANGING effects (stamp) → they mutate the aggregate;
   *   2. PERSIST the aggregate — so we never email a signing link or advance an
   *      envelope that isn't durably stored (a save failure here aborts before
   *      any external side-effect);
   *   3. run EXTERNAL effects (notify, certificate) — safe to retry/fail without
   *      corrupting state.
   */
  private async persistThenDeliver(env: Envelope, effects: Effect[]): Promise<Envelope> {
    let cur = env;
    let certificate: Uint8Array | undefined;
    const external: Effect[] = [];
    for (const effect of effects) {
      // State-changing effects (mutate the aggregate) run before the save.
      if (effect.type === "stamp") {
        cur = await this.stamp(cur, effect.recipientId, effect.documentIds, effect.signature);
      } else if (effect.type === "finalize") {
        ({ envelope: cur, certificate } = await this.finalize(cur));
      } else {
        external.push(effect);
      }
    }
    await this.deps.repo.save(cur);
    // The standalone certificate lives under a FIXED key, so it is written only
    // once this save has won. Written before it, an attempt that then lost the
    // race (a void, an expiry, a duplicate submission) left behind a certificate
    // describing a completion that never happened, or overwrote the winner's.
    if (certificate) await this.storeCertificate(cur, certificate);
    // Fan new audit events out to webhook subscribers (durable outbox), then run
    // external effects (mail). Both are post-save and best-effort.
    await this.enqueueWebhooks(cur);
    for (const effect of external) {
      if (effect.type === "notify") await this.notifyBestEffort(cur, effect);
    }
    return cur;
  }

  /**
   * Store the standalone certificate of completion after the completing save.
   * The envelope is already durably completed and every signed PDF carries its
   * own copy of the certificate, so a failure here must not report the signature
   * as failed; it is logged loudly instead (the download route then 404s).
   */
  private async storeCertificate(env: Envelope, certificate: Uint8Array): Promise<void> {
    try {
      await this.deps.blobs.put(certKey(env.id), certificate, "application/pdf");
    } catch (e) {
      this.deps.logger.error(
        { envelopeId: env.id, err: e instanceof Error ? e.message : String(e) },
        "could not store the standalone certificate of completion (the signed PDFs still embed it)"
      );
    }
  }

  /**
   * Send one notification, absorbing a delivery failure.
   *
   * The aggregate is already durably saved by the time we get here: the envelope
   * IS sent, the tokens ARE issued, the transition HAS happened. Letting a
   * transient SMTP error escape would report that committed work as a 500 and
   * abandon every remaining notification — the sender would see failure, retry,
   * and get a conflict from an envelope that had in fact moved on.
   *
   * So a failure is logged loudly and the operator recovers with resend/remind.
   * Until the notification outbox lands (backlog R.2) this is the honest
   * boundary: state is durable, delivery is best-effort, and the gap is visible.
   */
  private async notifyBestEffort(env: Envelope, effect: NotifyEffect): Promise<void> {
    try {
      await this.notify(env, effect);
    } catch (e) {
      this.deps.logger.error(
        {
          envelopeId: env.id,
          recipientId: effect.recipientId ?? null,
          toSender: effect.toSender ?? false,
          reason: effect.reason,
          err: e instanceof Error ? e.message : String(e),
        },
        "notification delivery FAILED — envelope state is saved; re-send the signing link to recover"
      );
    }
  }

  /**
   * Enqueue outbox deliveries for this envelope's new audit events across every
   * active, matching subscription. Forward-only + idempotent: the per-(sub,env)
   * high-water-mark (`maxEnqueuedSeq`) plus an `eventId` unique guard mean re-runs
   * never double-enqueue; the `event.at >= sub.createdAt` gate keeps a newly-added
   * subscription from receiving an envelope's pre-subscription history. Failures
   * are logged, never thrown — a webhook must not break the signing flow.
   */
  private async enqueueWebhooks(env: Envelope): Promise<void> {
    const hooks = this.deps.webhooks;
    if (!hooks) return;
    try {
      const subs = (await hooks.store.listSubscriptions()).filter((s) => s.active);
      if (subs.length === 0) return;
      for (const sub of subs) {
        const hwm = await hooks.store.maxEnqueuedSeq(sub.id, env.id);
        const subCreatedMs = new Date(sub.createdAt).getTime();
        for (const event of env.audit) {
          if (event.seq <= hwm) continue;
          if (new Date(event.at).getTime() < subCreatedMs) continue; // forward-only
          if (!subscriptionAccepts(sub, event.type)) continue;
          const deliveryId = this.deps.ids.id();
          const delivery: WebhookDelivery = {
            id: deliveryId,
            subscriptionId: sub.id,
            envelopeId: env.id,
            eventId: event.id,
            eventSeq: event.seq,
            eventType: event.type,
            payload: buildWebhookBody(env, event, deliveryId),
            status: "pending",
            attempts: 0,
            nextAttemptAt: this.deps.clock.now().toISOString(),
            lastError: null,
            createdAt: this.deps.clock.now().toISOString(),
          };
          await hooks.store.enqueueDelivery(delivery);
        }
      }
    } catch (e) {
      this.deps.logger.warn({ envelopeId: env.id, err: e instanceof Error ? e.message : String(e) }, "webhook enqueue failed");
    }
  }

  private async notify(env: Envelope, effect: NotifyEffect): Promise<void> {
    let to: string;
    let name: string;
    if (effect.toSender) {
      to = env.senderEmail;
      name = env.senderName;
    } else {
      const rec = env.recipients.find((r) => r.id === effect.recipientId);
      if (!rec) return;
      to = rec.email;
      name = rec.name;
    }
    const signPath = this.deps.config.signPath ?? "/sign";
    const link = effect.token ? `${this.deps.config.baseUrl}${signPath}/${effect.token}` : undefined;
    // DEV ONLY: retain the raw link so a local UI can display it.
    if (this.deps.config.devExposeTokens && link && effect.recipientId && !effect.toSender) {
      const list = this.devLinks.get(env.id) ?? [];
      list.push({ recipientId: effect.recipientId, name, email: to, link });
      this.devLinks.set(env.id, list);
    }
    let subject = `Update: ${env.title}`;
    let text = `${name}, there is an update on "${env.title}".`;
    switch (effect.reason) {
      case "your_turn":
        subject = `Please sign: ${env.title}`;
        text = `${name}, you have a document to sign: ${env.title}.`;
        break;
      case "completed_copy":
        subject = `Completed: ${env.title}`;
        text = link
          ? `${name}, "${env.title}" is complete. Your signed copy is available at the link below.`
          : `${name}, "${env.title}" is complete. A signed copy is available in your FineSign console.`;
        break;
      case "declined":
        subject = `Declined: ${env.title}`;
        text = `${name}, "${env.title}" was declined${effect.note ? `: ${effect.note}` : ""}.`;
        break;
      case "reminder":
        subject = `Reminder — please sign: ${env.title}`;
        text = `${name}, this is a reminder to sign "${env.title}".`;
        break;
      case "resent":
        subject = `Please sign: ${env.title}`;
        text = `${name}, here is your signing link for "${env.title}".`;
        break;
      case "expired":
        subject = `Expired: ${env.title}`;
        text = `${name}, "${env.title}" expired before all recipients signed.`;
        break;
      case "voided":
        subject = `Withdrawn: ${env.title}`;
        text = `${name}, the sender has withdrawn "${env.title}", so it will not be completed. There is nothing more for you to do.`;
        break;
    }
    await this.deps.mailer.send({ to, subject, text, link });
  }

  private async stamp(
    env: Envelope,
    recipientId: string,
    documentIds: string[],
    signature: SignatureInput
  ): Promise<Envelope> {
    let cur = env;
    for (const documentId of documentIds) {
      const doc = cur.documents.find((d) => d.id === documentId);
      if (!doc || !doc.pdfBlobKey) continue;
      const currentKey = doc.signedBlobKey ?? doc.pdfBlobKey;
      const currentBytes = await this.deps.blobs.get(currentKey);
      const fields = cur.fields.filter((f) => f.recipientId === recipientId && f.documentId === documentId);
      const { bytes, summary } = await stampForRecipient(this.deps.engine, currentBytes, fields, signature);
      const signedKey = `env/${cur.id}/signed/${doc.id}-${this.deps.ids.id()}.pdf`;
      await this.deps.blobs.put(signedKey, bytes, "application/pdf");
      cur = this.svc.setDocumentSigned(cur, doc.id, signedKey);
      if (summary.skipped.length > 0) {
        this.deps.logger.warn(
          { envelopeId: cur.id, documentId, skipped: summary.skipped },
          "some field kinds are not yet stampable and were skipped"
        );
      }
    }
    return cur;
  }

  /**
   * On completion: build the certificate of completion (over the hashes of the
   * signed content) and append it to each signed document so the sealed PDF
   * carries its own certificate (M6.1). Returns the envelope with each
   * document's `signedBlobKey` pointing at the certified copy, plus the
   * certificate itself, which the caller stores standalone only after the save
   * wins (its blob key is fixed; the certified copies' keys are fresh).
   *
   * The `finalize` effect is emitted only on the sent→completed transition
   * (domain-guarded) and a completed envelope rejects further signatures, so
   * only one attempt can ever SAVE a completion. Others may run this and then
   * lose the save race; that is harmless because nothing here writes to a key
   * a saved envelope already references.
   */
  private async finalize(env: Envelope): Promise<{ envelope: Envelope; certificate: Uint8Array }> {
    const hashes: { name: string; sha256: string }[] = [];
    for (const d of env.documents) {
      const key = d.signedBlobKey ?? d.pdfBlobKey;
      if (!key) continue;
      hashes.push({ name: d.name, sha256: sha256Hex(await this.deps.blobs.get(key)) });
    }
    // Fail-closed: never deliver a "completed" document unsealed when a seal is
    // required (L1).
    if (this.deps.config.sealRequired && !this.deps.sealer) {
      throw new ConflictError("SEAL_UNAVAILABLE", "document sealing is required but no sealer is configured");
    }

    // Built here, stored by the caller only after the completing save wins.
    const cert = await buildCertificate(env, hashes);

    let cur = env;
    for (const d of env.documents) {
      // Seal EVERY document in the completed package — including ones nobody had a
      // field on — so a completed envelope never delivers unsealed content and the
      // certificate's document list is always covered by the seal (fixes the
      // no-field / seal-required bypass).
      const sourceKey = d.signedBlobKey ?? d.pdfBlobKey;
      if (!sourceKey) continue; // no signable PDF exists for this document
      const source = await this.deps.blobs.get(sourceKey);
      let finalBytes = await appendCertificate(source, cert);
      // Cryptographically seal the completed document (PAdES) so it is
      // tamper-evident and independently verifiable. The seal covers the whole
      // file, INCLUDING the appended certificate, so it must be the last step.
      if (this.deps.sealer) {
        finalBytes = await this.deps.sealer.seal(finalBytes, { reason: `Agreement "${cur.title}" completed` });
      }
      const certifiedKey = `env/${cur.id}/signed/${d.id}-certified-${this.deps.ids.id()}.pdf`;
      await this.deps.blobs.put(certifiedKey, finalBytes, "application/pdf");
      cur = this.svc.setDocumentSigned(cur, d.id, certifiedKey);
    }
    return { envelope: cur, certificate: cert };
  }
}

// ── Upload validation helpers ───────────────────────────────────────────────

function mimeFor(format: DocumentFormat): string {
  return format === "pdf"
    ? "application/pdf"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

/** Validate the upload's magic bytes match its declared format (never trust the
 *  filename/extension — FACTORY §1.7). */
function assertMagic(bytes: Uint8Array, format: DocumentFormat): void {
  if (format === "pdf") {
    const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
    if (!head.includes("%PDF-")) throw new ValidationError("file is not a valid PDF");
  } else {
    // DOCX is a ZIP: "PK\x03\x04".
    const ok = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    if (!ok) throw new ValidationError("file is not a valid DOCX (zip) document");
  }
}
