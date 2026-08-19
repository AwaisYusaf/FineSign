/**
 * The Fastify HTTP surface: envelope authoring + lifecycle routes, public
 * tokenized signer routes (rate-limited), downloads, and ONE error handler that
 * maps every `FineSignError.code` to its status (FACTORY §6).
 */
import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { isFineSignError, ValidationError, AuthorizationError, tokensEqual, type Logger } from "@finesign/shared";
import { SIGNATURE_FONTS, isSignatureFont } from "finesign-core";
import type { SignatureInput, FieldInput, RecipientRole, FieldKind, RoutingType, DocumentFormat } from "@finesign/domain";
import type { EnvelopeApp } from "./app";

export interface HttpOptions {
  logger: Logger;
  /**
   * API key required on every management route (`/api/envelopes/*`). Presented as
   * `Authorization: Bearer <key>` or `x-api-key`. This closes the unauthenticated
   * IDOR/enumeration hole (S1); public token routes (`/sign/*`) are NOT gated by
   * it — they authenticate via the per-recipient signing token.
   */
  senderApiKey: string;
  /** Requests per minute per IP on public signing routes. */
  publicRateLimitPerMin?: number;
  /** Requests per minute per IP on all other routes. */
  globalRateLimitPerMin?: number;
  /**
   * Trust the `X-Forwarded-For` header from a reverse proxy so per-IP rate
   * limiting keys off the real client IP (not the proxy's single socket IP,
   * which would collapse every client into one bucket and enable trivial
   * lockout). Set to the proxy hop count or a CIDR/IP list; leave false when the
   * server faces clients directly. (Fastify `trustProxy`.)
   */
  trustProxy?: boolean | string | number;
  /** Max decoded upload size in bytes (used to size the HTTP body limit so the
   *  app-level cap is actually reachable). Default 10 MB. */
  maxUploadBytes?: number;
}

/** Extract the presented API key from a request (Bearer header or x-api-key). */
function presentedKey(headers: Record<string, unknown>): string | null {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  const xkey = headers["x-api-key"];
  if (typeof xkey === "string") return xkey;
  return null;
}

function parseSignature(body: unknown): SignatureInput {
  const b = body as { signature?: Record<string, unknown> };
  const s = b?.signature;
  if (!s || typeof s !== "object") throw new ValidationError("signature is required");
  if (s.kind === "image") {
    if (typeof s.dataUrl !== "string" || s.dataUrl.length === 0) {
      throw new ValidationError("signature.dataUrl is required for image signatures");
    }
    return { kind: "image", dataUrl: s.dataUrl };
  }
  if (s.kind === "typed") {
    if (typeof s.name !== "string" || s.name.trim().length === 0) {
      throw new ValidationError("signature.name is required for typed signatures");
    }
    // The font key is caller-supplied and is resolved deep inside stamping, where
    // an unknown key would surface as an opaque 500. Narrow it here against the
    // engine's own allowlist so a bad value is a 400 that names the valid set.
    if (!isSignatureFont(s.font)) {
      throw new ValidationError("signature.font is not a supported signature font", {
        supported: [...SIGNATURE_FONTS],
      });
    }
    return { kind: "typed", name: s.name, font: s.font };
  }
  throw new ValidationError('signature.kind must be "image" or "typed"');
}

/** Parse the optional `fieldValues: [{fieldId, value}]` (text/checkbox inputs). */
function parseFieldValues(body: unknown): FieldInput[] {
  const raw = (body as { fieldValues?: unknown })?.fieldValues;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ValidationError("fieldValues must be an array");
  return raw.slice(0, 500).map((v) => {
    const o = v as { fieldId?: unknown; value?: unknown };
    if (typeof o?.fieldId !== "string") throw new ValidationError("fieldValues[].fieldId is required");
    return { fieldId: o.fieldId, value: typeof o.value === "string" ? o.value : String(o.value ?? "") };
  });
}

/** Strip credential-equivalent hashes (`tokenHash`, `accessCodeHash`) from any
 *  envelope payload before it reaches a client. Non-envelope payloads (Buffers,
 *  session views, verify results) pass through untouched. */
function redactEnvelopePayload(payload: unknown): unknown {
  const isEnvelope = (p: unknown): p is Record<string, unknown> =>
    !!p && typeof p === "object" && !Buffer.isBuffer(p) && Array.isArray((p as { recipients?: unknown }).recipients);
  const redactEnv = (e: Record<string, unknown>) => ({
    ...e,
    recipients: (e.recipients as Record<string, unknown>[]).map((r) => ({ ...r, tokenHash: null, accessCodeHash: null })),
  });
  if (Array.isArray(payload)) return payload.map((p) => (isEnvelope(p) ? redactEnv(p) : p));
  return isEnvelope(payload) ? redactEnv(payload) : payload;
}

export async function createHttpServer(app: EnvelopeApp, options: HttpOptions): Promise<FastifyInstance> {
  // Size the HTTP body limit above the decoded upload cap (base64 is ~1.33×) so
  // the app-level `maxUploadBytes` check is actually reachable and tunable (D2).
  const maxUpload = options.maxUploadBytes ?? 10 * 1024 * 1024;
  const bodyLimit = Math.ceil(maxUpload * 1.4) + 64 * 1024;
  const server = Fastify({ logger: false, bodyLimit, trustProxy: options.trustProxy ?? false });

  if (!options.senderApiKey) {
    throw new Error("createHttpServer requires a senderApiKey (management-route auth)");
  }
  if (options.trustProxy === true) {
    // Boolean `true` trusts X-Forwarded-For from ANY hop — if the origin is also
    // reachable directly, the captured signer IP (a legal-record field) is
    // forgeable. Prefer an explicit trusted-proxy CIDR/IP or hop count.
    options.logger.warn(
      {},
      "trustProxy=true trusts X-Forwarded-For from any client — set an explicit trusted-proxy IP/CIDR unless the origin is only reachable via your proxy"
    );
  }

  // Never serialize credential-equivalent hashes to any client: strip
  // `tokenHash` + `accessCodeHash` from every recipient in an envelope payload.
  server.addHook("preSerialization", async (_req, _reply, payload) => redactEnvelopePayload(payload));

  // Global rate limit on everything (S5), with a stricter override on the public
  // signing routes.
  await server.register(rateLimit, {
    global: true,
    max: options.globalRateLimitPerMin ?? 300,
    timeWindow: "1 minute",
  });

  // OpenAPI: generate a spec from the registered routes and serve Swagger UI at
  // /docs + the raw document at /openapi.json (both public — they carry no data).
  await server.register(swagger, {
    openapi: {
      info: { title: "FineSign API", version: "0.1.0", description: "Open-source e-signature & agreement platform." },
      components: {
        securitySchemes: {
          senderApiKey: { type: "apiKey", name: "authorization", in: "header" },
        },
      },
    },
  });
  await server.register(swaggerUi, { routePrefix: "/docs" });

  const publicLimit = { config: { rateLimit: { max: options.publicRateLimitPerMin ?? 30 } } };

  // Management-route authentication (S1): every /api/ route requires the sender
  // API key. Public /sign/* and /health are intentionally exempt.
  server.addHook("onRequest", async (req) => {
    // Key auth off the MATCHED route pattern, not the raw URL — so a crafted
    // path (`//api/…`, case tricks) that Fastify normalizes to an /api handler
    // can't slip past a raw-string prefix check (Finding 5). Unmatched requests
    // (routeOptions.url undefined) fall through to Fastify's 404.
    const routeUrl = req.routeOptions?.url;
    if (!routeUrl || !routeUrl.startsWith("/api/")) return;
    const provided = presentedKey(req.headers as Record<string, unknown>);
    if (!provided || !tokensEqual(provided, options.senderApiKey)) {
      throw new AuthorizationError("missing or invalid API key");
    }
  });

  // ── Single error handler ────────────────────────────────────────────────────
  server.setErrorHandler((error: unknown, _req, reply) => {
    if (isFineSignError(error)) {
      return reply.code(error.httpStatus).send(error.toJSON());
    }
    // Framework/library errors (validation, rate-limit, unknown) → never echo
    // their internal message to the client (L6); use a fixed message per status.
    const e = error as { statusCode?: number; message?: string };
    const statusCode = e.statusCode ?? 500;
    if (statusCode >= 500) {
      options.logger.error({ err: e.message ?? "unknown" }, "unhandled server error");
      return reply.code(500).send({ error: { code: "INTERNAL", message: "internal server error" } });
    }
    const generic: Record<number, string> = {
      400: "bad request",
      401: "unauthorized",
      403: "forbidden",
      404: "not found",
      429: "too many requests",
    };
    return reply
      .code(statusCode)
      .send({ error: { code: "REQUEST_ERROR", message: generic[statusCode] ?? "request error" } });
  });

  server.get("/health", async () => ({ status: "ok" }));

  // The generated OpenAPI document (public API documentation, no data).
  server.get("/openapi.json", async () => (server as unknown as { swagger: () => unknown }).swagger());

  // ── Envelope authoring ──────────────────────────────────────────────────────
  server.post("/api/envelopes", async (req, reply) => {
    const b = req.body as { title?: string; routingType?: RoutingType; senderName?: string; senderEmail?: string };
    if (!b?.title || !b.senderName || !b.senderEmail) throw new ValidationError("title, senderName, senderEmail are required");
    const env = await app.createDraft({
      title: b.title,
      routingType: b.routingType === "parallel" ? "parallel" : "sequential",
      senderName: b.senderName,
      senderEmail: b.senderEmail,
    });
    return reply.code(201).send(env);
  });

  server.get("/api/envelopes", async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    // Validate + clamp so bad input can't 500 or dump the whole table (D3).
    const clampInt = (v: string | undefined, def: number, min: number, max: number) => {
      const n = Number.parseInt(v ?? "", 10);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
    };
    return app.listEnvelopes({
      limit: clampInt(q.limit, 50, 1, 200),
      offset: clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    });
  });

  server.get("/api/envelopes/:id", async (req) => {
    const { id } = req.params as { id: string };
    return app.getEnvelope(id);
  });

  server.post("/api/envelopes/:id/documents", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { name?: string; format?: DocumentFormat; contentBase64?: string };
    if (!b?.name || !b.format || !b.contentBase64) throw new ValidationError("name, format, contentBase64 are required");
    if (b.format !== "pdf" && b.format !== "docx") throw new ValidationError('format must be "pdf" or "docx"');
    const bytes = new Uint8Array(Buffer.from(b.contentBase64, "base64"));
    const env = await app.addDocument(id, { name: b.name, format: b.format, bytes });
    return reply.code(201).send(env);
  });

  server.post("/api/envelopes/:id/recipients", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as {
      name?: string;
      email?: string;
      role?: RecipientRole;
      routingOrder?: number;
      authMethod?: "none" | "access_code";
      accessCode?: string;
    };
    if (!b?.name || !b.email) throw new ValidationError("name and email are required");
    if (b.authMethod === "access_code" && !b.accessCode) throw new ValidationError("accessCode is required for access_code auth");
    const env = await app.addRecipient(id, {
      name: b.name,
      email: b.email,
      role: b.role ?? "signer",
      routingOrder: b.routingOrder ?? 1,
      authMethod: b.authMethod ?? "none",
      ...(b.accessCode ? { accessCode: b.accessCode } : {}),
    });
    return reply.code(201).send(env);
  });

  server.post("/api/envelopes/:id/fields", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as {
      documentId?: string; recipientId?: string; page?: number;
      x?: number; y?: number; width?: number; height?: number; kind?: FieldKind; required?: boolean;
    };
    for (const k of ["documentId", "recipientId", "page", "x", "y", "width", "height", "kind"] as const) {
      if (b?.[k] === undefined) throw new ValidationError(`${k} is required`);
    }
    const env = await app.addField(id, {
      documentId: b.documentId!, recipientId: b.recipientId!, page: b.page!,
      x: b.x!, y: b.y!, width: b.width!, height: b.height!, kind: b.kind!, required: b.required,
    });
    return reply.code(201).send(env);
  });

  server.post("/api/envelopes/:id/send", async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { expiresInDays?: number } | undefined;
    const opts: { expiresInDays?: number } = {};
    if (b?.expiresInDays !== undefined) {
      const n = Number(b.expiresInDays);
      if (!Number.isFinite(n) || n <= 0) throw new ValidationError("expiresInDays must be a positive number");
      opts.expiresInDays = n;
    }
    return app.send(id, opts);
  });

  server.post("/api/envelopes/:id/recipients/:recipientId/resend", async (req) => {
    const { id, recipientId } = req.params as { id: string; recipientId: string };
    return app.resend(id, recipientId);
  });

  server.post("/api/envelopes/:id/recipients/:recipientId/remind", async (req) => {
    const { id, recipientId } = req.params as { id: string; recipientId: string };
    return app.remind(id, recipientId);
  });

  // Expire every overdue sent envelope now (idempotent). Cron/ops can poke this;
  // token accesses also expire lazily, so a missed sweep is not a correctness gap.
  server.post("/api/envelopes/sweep-expired", async () => {
    const expired = await app.sweepExpired();
    return { expired };
  });

  server.post("/api/envelopes/:id/void", async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { reason?: string };
    return app.voidEnvelope(id, b?.reason ?? "voided by sender");
  });

  // DEV ONLY (empty unless devExposeTokens is on): the signer links for an
  // envelope, so a local UI can display them without reading email.
  server.get("/api/envelopes/:id/dev-links", async (req) => {
    const { id } = req.params as { id: string };
    return { links: app.getDevLinks(id) };
  });

  // ── Webhooks (management; behind the sender API key) ─────────────────────────
  server.post("/api/webhooks", async (req, reply) => {
    const b = req.body as { url?: string; secret?: string; eventTypes?: string[] | null };
    if (!b?.url) throw new ValidationError("url is required");
    // Response includes the signing secret EXACTLY ONCE (create-time only).
    const sub = await app.createWebhookSubscription({ url: b.url, secret: b.secret, eventTypes: b.eventTypes });
    return reply.code(201).send(sub);
  });

  server.get("/api/webhooks", async () => {
    return { subscriptions: await app.listWebhookSubscriptions() };
  });

  server.get("/api/webhooks/:id", async (req) => {
    const { id } = req.params as { id: string };
    return app.getWebhookSubscription(id);
  });

  server.delete("/api/webhooks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await app.deleteWebhookSubscription(id);
    return reply.code(204).send();
  });

  server.get("/api/webhooks/:id/deliveries", async (req) => {
    const { id } = req.params as { id: string };
    return { deliveries: await app.listWebhookDeliveries(id) };
  });

  // Drain the delivery outbox now (idempotent). A cron/worker pokes this; the
  // server also drains on an interval when webhooks are enabled.
  server.post("/api/webhooks/deliver", async () => {
    return app.deliverWebhooks();
  });

  // ── Public signer session (rate-limited) ────────────────────────────────────
  server.get("/sign/:token", { ...publicLimit }, async (req) => {
    const { token } = req.params as { token: string };
    return app.getSession(token);
  });

  // Access-code challenge (rate-limited like the other public routes).
  server.post("/sign/:token/authenticate", { ...publicLimit }, async (req) => {
    const { token } = req.params as { token: string };
    const b = req.body as { accessCode?: string };
    if (!b?.accessCode) throw new ValidationError("accessCode is required");
    return app.authenticate(token, b.accessCode);
  });

  server.post("/sign/:token/apply", { ...publicLimit }, async (req) => {
    const { token } = req.params as { token: string };
    // Capture signer identity evidence (trustProxy-aware IP + UA) and the explicit
    // ESIGN/UETA consent flag alongside the signature + field values.
    const context = {
      ip: req.ip ?? null,
      userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      consented: (req.body as { consent?: unknown } | undefined)?.consent === true,
    };
    return app.applySignature(token, parseSignature(req.body), parseFieldValues(req.body), context);
  });

  server.post("/sign/:token/decline", { ...publicLimit }, async (req) => {
    const { token } = req.params as { token: string };
    const b = req.body as { reason?: string };
    return app.declineByToken(token, b?.reason ?? "declined");
  });

  // The signer's own copy of a document, for rendering in their browser.
  server.get("/sign/:token/documents/:documentId", { ...publicLimit }, async (req, reply) => {
    const { token, documentId } = req.params as { token: string; documentId: string };
    const { bytes, filename } = await app.getSessionDocument(token, documentId);
    return reply
      .type("application/pdf")
      .header("content-disposition", `inline; filename="${filename.replace(/[^A-Za-z0-9._ -]/g, "_")}"`)
      .send(Buffer.from(bytes));
  });

  // ── Downloads ───────────────────────────────────────────────────────────────
  server.get("/api/envelopes/:id/documents/:documentId/download", async (req, reply) => {
    const { id, documentId } = req.params as { id: string; documentId: string };
    const { bytes, filename } = await app.downloadDocument(id, documentId);
    return reply
      .type("application/pdf")
      .header("content-disposition", `attachment; filename="${filename}"`)
      .send(Buffer.from(bytes));
  });

  server.get("/api/envelopes/:id/certificate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const bytes = await app.downloadCertificate(id);
    return reply.type("application/pdf").send(Buffer.from(bytes));
  });

  // Cryptographically verify a document's PAdES seal.
  server.get("/api/envelopes/:id/documents/:documentId/verify", async (req) => {
    const { id, documentId } = req.params as { id: string; documentId: string };
    return app.verifyDocument(id, documentId);
  });

  return server;
}
