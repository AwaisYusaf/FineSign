/**
 * `@finesign/server` — the FineSign REST API and its composition root.
 *
 * Programmatic use: `buildInMemoryContainer` / `buildProductionContainer` +
 * `createHttpServer`. Run directly (`npm start`) to boot a self-hosting server
 * backed by SQLite + local-filesystem blobs.
 *
 * @packageDocumentation
 */
export { EnvelopeApp, type AppConfig, type AppDeps, type SessionView, type DevLink } from "./app";
export { createHttpServer, type HttpOptions } from "./http";
export {
  buildInMemoryContainer,
  buildProductionContainer,
  type ContainerOverrides,
} from "./container";
export { ConsoleMailer, CapturingMailer, type Mailer, type SentMessage } from "./mailer";
export {
  SmtpMailer,
  makeNodemailerTransport,
  type MailTransport,
  type SmtpConfig,
} from "./smtp-mailer";
export { stampForRecipient, type StampSummary } from "./stamping";
export { buildCertificate, sha256Hex } from "./certificate";
export { PadesDocumentSealer, type DocumentSealer } from "./sealer";
export {
  EncryptedBlobStore,
  LocalKeyProvider,
  type KeyProvider,
  type DataKey,
} from "@finesign/storage";
export {
  WebhookDeliverer,
  signWebhook,
  isPublicIp,
  parseIp,
  assertValidWebhookUrl,
  buildWebhookBody,
  subscriptionAccepts,
  DEFAULT_WEBHOOK_CONFIG,
  type WebhookConfig,
  type WebhookFetch,
  type HostResolver,
  type DeliverySummary,
} from "./webhooks";

// ── Boot when run directly ────────────────────────────────────────────────────
if (require.main === module) {
  void (async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const { buildProductionContainer } = await import("./container");
    const { createHttpServer } = await import("./http");
    const { ConsoleLogger } = await import("@finesign/shared");
    const { SmtpMailer, makeNodemailerTransport } = await import("./smtp-mailer");

    const dataDir = process.env.FINESIGN_DATA_DIR ?? path.resolve(process.cwd(), ".finesign-data");
    // Ensure the data dir exists before SQLite opens its file (it won't create
    // parent directories itself).
    fs.mkdirSync(path.join(dataDir, "blobs"), { recursive: true });
    const logger = new ConsoleLogger();

    // Management routes require an API key (S1). Refuse to boot without one
    // rather than exposing an unauthenticated API.
    const senderApiKey = process.env.FINESIGN_SENDER_API_KEY;
    if (!senderApiKey || senderApiKey.length < 16) {
      logger.error({}, "FINESIGN_SENDER_API_KEY must be set (>=16 chars) to protect the management API");
      process.exit(1);
      return;
    }

    // Email delivery: real SMTP when SMTP_HOST is set, else console (logged only).
    const smtpHost = process.env.SMTP_HOST;
    const mailer = smtpHost
      ? new SmtpMailer(
          makeNodemailerTransport({
            host: smtpHost,
            port: Number(process.env.SMTP_PORT ?? 587),
            secure: process.env.SMTP_SECURE === "true",
            auth:
              process.env.SMTP_USER && process.env.SMTP_PASS
                ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
                : undefined,
          }),
          process.env.FINESIGN_MAIL_FROM ?? "FineSign <no-reply@finesign.local>"
        )
      : undefined;
    if (!smtpHost) {
      logger.warn({}, "SMTP_HOST not set — emails are logged, not delivered (set SMTP_* to enable delivery)");
    }

    const { app, deps } = buildProductionContainer({
      sqliteFile: path.join(dataDir, "finesign.sqlite"),
      blobRoot: path.join(dataDir, "blobs"),
      overrides: { logger, ...(mailer ? { mailer } : {}) },
    });
    // Behind a reverse proxy, set FINESIGN_TRUST_PROXY (e.g. "true" or a hop
    // count) so per-IP rate limiting keys off the real client IP.
    const tp = process.env.FINESIGN_TRUST_PROXY;
    const trustProxy = tp === undefined ? false : /^\d+$/.test(tp) ? Number(tp) : tp === "true" ? true : tp;
    const server = await createHttpServer(app, {
      logger,
      senderApiKey,
      trustProxy,
      maxUploadBytes: deps.config.maxUploadBytes,
    });
    const port = Number(process.env.PORT ?? 4000);
    await server.listen({ port, host: "0.0.0.0" });
    logger.info({ port, dataDir }, "FineSign server listening");

    // Background cadence: drain the webhook outbox + expire overdue envelopes.
    // `.unref()` so neither timer blocks a clean shutdown. Both are idempotent and
    // also reachable via `POST /api/webhooks/deliver` + `/api/envelopes/sweep-expired`.
    const pollMs = Number(process.env.FINESIGN_WEBHOOK_POLL_MS ?? 15_000);
    const sweepMs = Number(process.env.FINESIGN_EXPIRY_SWEEP_MS ?? 3_600_000);
    setInterval(() => {
      void app.deliverWebhooks().catch((e) => logger.warn({ err: String(e) }, "webhook drain tick failed"));
    }, pollMs).unref();
    setInterval(() => {
      void app.sweepExpired().catch((e) => logger.warn({ err: String(e) }, "expiry sweep tick failed"));
    }, sweepMs).unref();

    // Graceful shutdown. `docker compose down`, a Kubernetes rollout and Ctrl-C
    // all send SIGTERM/SIGINT; without a handler the process dies immediately —
    // in the middle of stamping a PDF, or between the two writes that keep an
    // envelope row and its token index consistent. Fastify stops accepting new
    // connections and drains in-flight requests first, then the SQLite handle is
    // closed so WAL state lands cleanly.
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return; // a second Ctrl-C should not re-enter this
      shuttingDown = true;
      logger.info({ signal }, "shutting down — draining in-flight requests");
      try {
        await server.close();
        const repo = deps.repo as { close?: () => void };
        if (typeof repo.close === "function") repo.close();
        logger.info({ signal }, "shutdown complete");
        process.exit(0);
      } catch (e) {
        logger.error({ signal, err: e instanceof Error ? e.message : String(e) }, "shutdown failed");
        process.exit(1);
      }
    };
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => void shutdown(signal));
    }
  })();
}
