/**
 * Composition root — constructs concrete adapters and wires the `EnvelopeApp`.
 * Two presets: `buildProductionContainer` (SQLite + local FS + LibreOffice) and
 * `buildInMemoryContainer` (everything in memory; used by tests and demos).
 */
import fs from "node:fs";
import { SystemClock, CryptoIdGenerator, ConsoleLogger, type Logger, type Clock, type IdGenerator } from "@finesign/shared";
import {
  InMemoryEnvelopeRepository,
  SqliteEnvelopeRepository,
  InMemoryBlobStore,
  LocalFsBlobStore,
  InMemoryWebhookStore,
  SqliteWebhookStore,
  EncryptedBlobStore,
  LocalKeyProvider,
  type WebhookStore,
  type KeyProvider,
} from "@finesign/storage";
import type { WebhookConfig, HostResolver, WebhookFetch } from "./webhooks";
import { CompositeConverter, PdfPassthroughConverter, LibreOfficeDocxConverter, type DocxRunner } from "@finesign/convert";
import { SignEngine } from "finesign-core";
import {
  LocalSigningCredential,
  generateSelfSignedCredential,
  generateSelfSignedTsaCredential,
  generateTestCa,
  createHttpTsa,
  createInProcessTsa,
  createInProcessValidationDataProvider,
  type TimestampAuthority,
  type PadesLevel,
} from "@finesign/pades";
import type { EnvelopeRepository, BlobStore, DocumentConverter } from "@finesign/domain";
import { EnvelopeApp, type AppConfig, type AppDeps } from "./app";
import { ConsoleMailer, type Mailer } from "./mailer";
import { PadesDocumentSealer, type DocumentSealer } from "./sealer";

const DEFAULT_CONFIG: AppConfig = {
  baseUrl: process.env.FINESIGN_BASE_URL ?? "http://localhost:4000",
  signPath: process.env.FINESIGN_SIGN_PATH ?? "/sign",
  tokenTtlMs: 14 * 24 * 3600 * 1000, // 14 days
  maxUploadBytes: 10 * 1024 * 1024, // 10 MB
  devExposeTokens: process.env.FINESIGN_DEV_EXPOSE_TOKENS === "true",
  sealRequired: process.env.FINESIGN_SEAL_REQUIRED === "true",
};

export interface ContainerOverrides {
  repo?: EnvelopeRepository;
  blobs?: BlobStore;
  converter?: DocumentConverter;
  mailer?: Mailer;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
  config?: Partial<AppConfig>;
  /** Injected DOCX runner (tests avoid the real LibreOffice binary). */
  docxRunner?: DocxRunner;
  /** Cryptographic sealer. Pass to enable PAdES sealing (tests inject one). */
  sealer?: DocumentSealer;
  /** Encryption at rest. Pass a `KeyProvider` to wrap the blob store; `null` forces
   *  OFF (production, ignore env). Omit for the preset default (production: from
   *  env; in-memory: off). */
  encryption?: KeyProvider | null;
  /** Webhook fan-out. Pass `null` to DISABLE; omit for the preset default
   *  (in-memory: enabled with an in-memory store; production: SQLite-backed).
   *  Tests inject `resolveHost`/`fetchImpl` + `allowPrivate` to exercise delivery. */
  webhooks?: {
    store?: WebhookStore;
    config?: Partial<WebhookConfig>;
    resolveHost?: HostResolver;
    fetchImpl?: WebhookFetch;
  } | null;
}

/** Decode a 32-byte AES key from hex (64 chars) or base64. */
function parseEncryptionKey(raw: string): Uint8Array {
  const s = raw.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  if (buf.length !== 32) {
    throw new Error("encryption key must decode to 32 bytes (64 hex chars or base64-encoded 32 bytes)");
  }
  return new Uint8Array(buf);
}

/** Build the at-rest encryption key provider from the environment:
 *   - `FINESIGN_ENCRYPTION_KEY` (active key) enables encryption.
 *   - `FINESIGN_ENCRYPTION_DECRYPT_KEYS` (comma-separated) are retired keys kept
 *     for decrypting old blobs after a rotation. Absent → encryption is off. */
function buildKeyProviderFromEnv(logger: Logger): KeyProvider | undefined {
  const active = process.env.FINESIGN_ENCRYPTION_KEY;
  if (!active) return undefined;
  const decryptOnly = (process.env.FINESIGN_ENCRYPTION_DECRYPT_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseEncryptionKey);
  const provider = new LocalKeyProvider(parseEncryptionKey(active), decryptOnly);
  logger.info({ retiredKeys: decryptOnly.length }, "encryption at rest ENABLED (AES-256-GCM)");
  return provider;
}

/** Parse webhook tuning from the environment (production). */
function webhookConfigFromEnv(): Partial<WebhookConfig> {
  const cfg: Partial<WebhookConfig> = {};
  if (process.env.FINESIGN_WEBHOOK_ALLOW_PRIVATE === "true") cfg.allowPrivate = true;
  const num = (v: string | undefined): number | undefined => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  const timeout = num(process.env.FINESIGN_WEBHOOK_TIMEOUT_MS);
  const attempts = num(process.env.FINESIGN_WEBHOOK_MAX_ATTEMPTS);
  if (timeout !== undefined) cfg.timeoutMs = timeout;
  if (attempts !== undefined) cfg.maxAttempts = attempts;
  return cfg;
}

/** Read a certificate file as DER, accepting either PEM or raw DER. */
function readCertDer(path: string): Uint8Array {
  const raw = fs.readFileSync(path);
  const text = raw.toString("latin1");
  if (text.includes("-----BEGIN CERTIFICATE-----")) {
    const b64 = text.replace(/-----BEGIN CERTIFICATE-----/, "").replace(/-----END CERTIFICATE-----/, "").replace(/\s+/g, "");
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  return new Uint8Array(raw);
}

/**
 * Build the RFC 3161 timestamp authority from the environment (PAdES-B-T):
 *   - `FINESIGN_TSA_URL` → an external RFC 3161 TSA over HTTP (the production
 *     path). Pin its cert with `FINESIGN_TSA_CERT` (PEM/DER) to require the
 *     timestamp's TSA to chain to it; without a pin the timestamp is accepted on
 *     its own cryptographic merits.
 *   - else `FINESIGN_DEV_TSA=true` → an in-process DEV TSA (self-signed, NOT a
 *     trusted third party) so B-T can be exercised locally.
 *   - else → no timestamping (seals are PAdES-B-B).
 */
function buildTsaFromEnv(logger: Logger): { tsa?: TimestampAuthority; tsaTrustStore?: Uint8Array[] } {
  const url = process.env.FINESIGN_TSA_URL;
  const certPath = process.env.FINESIGN_TSA_CERT;
  if (url) {
    const tsa = createHttpTsa({ url });
    const tsaTrustStore = certPath ? [readCertDer(certPath)] : undefined;
    if (!tsaTrustStore) {
      // Without a pinned TSA cert, timestamps are recorded but CANNOT extend seal
      // validity (verify.ts refuses to move the clock for an un-anchored TSA) —
      // otherwise a swapped self-signed timestamp could revive an expired seal.
      logger.warn(
        { url },
        "PAdES-B-T enabled WITHOUT FINESIGN_TSA_CERT — timestamps will be recorded but will NOT extend seal validity (set FINESIGN_TSA_CERT to pin the TSA)"
      );
    } else {
      logger.info({ url, trustPinned: true }, "PAdES-B-T enabled (external RFC 3161 TSA, pinned)");
    }
    return { tsa, tsaTrustStore };
  }
  if (process.env.FINESIGN_DEV_TSA === "true") {
    if (certPath) {
      logger.warn({}, "FINESIGN_TSA_CERT is ignored with FINESIGN_DEV_TSA (the in-process TSA cert is auto-pinned)");
    }
    const { credential } = generateSelfSignedTsaCredential({ commonName: "FineSign Dev TSA", organization: "FineSign" });
    const tsa = createInProcessTsa({ credential, clock: new SystemClock() });
    logger.warn({}, "PAdES-B-T enabled with an IN-PROCESS DEV TSA — not a trusted third-party timestamp");
    return { tsa, tsaTrustStore: [credential.certificate()] };
  }
  if (certPath) {
    logger.warn({}, "FINESIGN_TSA_CERT is set but no FINESIGN_TSA_URL / FINESIGN_DEV_TSA — timestamping is disabled and the cert is ignored");
  }
  return {};
}

/**
 * Build the PAdES sealer from the environment (production):
 *   - `FINESIGN_SEAL_P12` + `FINESIGN_SEAL_PASSPHRASE` → load an org signing cert.
 *   - else `FINESIGN_DEV_SEAL=true` → a self-signed DEV seal (not for real use).
 *   - else → no sealing.
 * A configured TSA (see `buildTsaFromEnv`) upgrades the seal to PAdES-B-T.
 * `FINESIGN_SEAL_REQUIRED=true` makes a missing credential a hard boot failure
 * (fail-closed: never deliver a "completed" doc unsealed when sealing is required).
 */
/** Validate the requested PAdES level env, failing fast on a typo/unknown value. */
function parsePadesLevelEnv(): PadesLevel | undefined {
  const raw = process.env.FINESIGN_PADES_LEVEL;
  if (raw === undefined) return undefined;
  const known: PadesLevel[] = ["B-B", "B-T", "B-LT", "B-LTA"];
  if (!known.includes(raw as PadesLevel)) {
    throw new Error(`FINESIGN_PADES_LEVEL="${raw}" is not one of ${known.join(", ")}`);
  }
  return raw as PadesLevel;
}

function buildSealerFromEnv(logger: Logger): DocumentSealer | undefined {
  const p12Path = process.env.FINESIGN_SEAL_P12;
  const required = process.env.FINESIGN_SEAL_REQUIRED === "true";
  const requestedLevel = parsePadesLevelEnv();
  if (p12Path) {
    // Production B-LT/LTA needs an HTTP validation-data provider (CRL/OCSP fetch),
    // which is deferred — fail fast rather than silently downgrading the seal.
    if (requestedLevel === "B-LT" || requestedLevel === "B-LTA") {
      throw new Error(
        `FINESIGN_PADES_LEVEL="${requestedLevel}" with a PKCS#12 seal is not yet supported (needs an HTTP validation-data provider); use B-T, or FINESIGN_DEV_SEAL for offline B-LT/LTA`
      );
    }
    const bytes = new Uint8Array(fs.readFileSync(p12Path));
    const credential = LocalSigningCredential.fromPkcs12(bytes, process.env.FINESIGN_SEAL_PASSPHRASE ?? "");
    const { tsa, tsaTrustStore } = buildTsaFromEnv(logger);
    logger.info({ signer: credential.subjectCommonName(), level: requestedLevel ?? (tsa ? "B-T" : "B-B") }, "PAdES sealing enabled (PKCS#12)");
    return new PadesDocumentSealer(credential, {
      timestampAuthority: tsa,
      tsaTrustStore,
      ...(requestedLevel ? { level: requestedLevel } : {}),
    });
  }
  if (process.env.FINESIGN_DEV_SEAL === "true") {
    const target = requestedLevel ?? "B-T";
    // Dev B-LT/B-LTA: a self-contained CA→leaf + in-process TSA + validation
    // provider, so long-term levels work offline. (Production B-LT/LTA needs a
    // real CA-issued cert + an HTTP validation provider — deferred.)
    if (target === "B-LT" || target === "B-LTA") {
      const ca = generateTestCa({ commonName: "FineSign Dev Root CA", organization: "FineSign" });
      const leaf = ca.issueLeaf({ commonName: "FineSign Dev Seal", organization: "FineSign" });
      const { credential: tsaCredential } = generateSelfSignedTsaCredential({ commonName: "FineSign Dev TSA", organization: "FineSign" });
      const tsa = createInProcessTsa({ credential: tsaCredential, clock: new SystemClock() });
      const provider = createInProcessValidationDataProvider({ ca, clock: new SystemClock() });
      logger.warn({ level: target }, "PAdES long-term sealing enabled with a DEV CA + in-process TSA/validation — not for production");
      return new PadesDocumentSealer(leaf.credential, {
        level: target,
        timestampAuthority: tsa,
        tsaTrustStore: [tsaCredential.certificate()],
        validationDataProvider: provider,
        trustStore: [ca.certificateDer()], // CA-issued leaf → the CA is the anchor
      });
    }
    const { credential } = generateSelfSignedCredential({ commonName: "FineSign Dev Seal", organization: "FineSign" });
    const { tsa, tsaTrustStore } = buildTsaFromEnv(logger);
    logger.warn({ timestamped: !!tsa }, "PAdES sealing enabled with a SELF-SIGNED DEV certificate — not for production");
    return new PadesDocumentSealer(credential, { timestampAuthority: tsa, tsaTrustStore });
  }
  if (required) {
    throw new Error("FINESIGN_SEAL_REQUIRED=true but no FINESIGN_SEAL_P12 configured");
  }
  if (process.env.FINESIGN_TSA_URL || process.env.FINESIGN_DEV_TSA === "true") {
    logger.warn(
      {},
      "FINESIGN_TSA_* is set but no seal credential (FINESIGN_SEAL_P12 / FINESIGN_DEV_SEAL) — sealing AND timestamping are disabled; documents are delivered unsealed"
    );
  }
  return undefined;
}

export function buildInMemoryContainer(overrides: ContainerOverrides = {}): { app: EnvelopeApp; deps: AppDeps } {
  const logger = overrides.logger ?? new ConsoleLogger();
  // In-memory preset: encryption OFF unless a provider is injected (tests opt in).
  const baseBlobs = overrides.blobs ?? new InMemoryBlobStore();
  const keyProvider = overrides.encryption ?? undefined;
  const deps: AppDeps = {
    repo: overrides.repo ?? new InMemoryEnvelopeRepository(),
    blobs: keyProvider ? new EncryptedBlobStore(baseBlobs, keyProvider) : baseBlobs,
    converter:
      overrides.converter ??
      new CompositeConverter([
        new PdfPassthroughConverter(),
        new LibreOfficeDocxConverter(overrides.docxRunner ? { runner: overrides.docxRunner } : {}),
      ]),
    mailer: overrides.mailer ?? new ConsoleMailer(logger),
    engine: new SignEngine(),
    clock: overrides.clock ?? new SystemClock(),
    ids: overrides.ids ?? new CryptoIdGenerator(),
    logger,
    config: { ...DEFAULT_CONFIG, ...overrides.config },
    sealer: overrides.sealer,
    webhooks:
      overrides.webhooks === null
        ? undefined
        : {
            store: overrides.webhooks?.store ?? new InMemoryWebhookStore(),
            config: overrides.webhooks?.config,
            resolveHost: overrides.webhooks?.resolveHost,
            fetchImpl: overrides.webhooks?.fetchImpl,
          },
  };
  return { app: new EnvelopeApp(deps), deps };
}

export function buildProductionContainer(params: {
  sqliteFile: string;
  blobRoot: string;
  overrides?: ContainerOverrides;
}): { app: EnvelopeApp; deps: AppDeps } {
  const o = params.overrides ?? {};
  const logger = o.logger ?? new ConsoleLogger();
  // Production: encryption at rest is ON when a key provider is configured (env),
  // wrapping whatever blob store is used. `encryption: null` forces it off.
  const baseBlobs = o.blobs ?? new LocalFsBlobStore(params.blobRoot);
  const keyProvider = o.encryption === null ? undefined : (o.encryption ?? buildKeyProviderFromEnv(logger));
  // Fail closed by default: once encryption is on, a non-encrypted (magic-stripped)
  // blob is REFUSED rather than served unauthenticated. The escape hatch is an
  // explicit, loud migration flag for re-writing pre-encryption blobs.
  const allowPlaintextRead = process.env.FINESIGN_ENCRYPTION_ALLOW_PLAINTEXT_READ === "true";
  if (keyProvider && allowPlaintextRead) {
    logger.warn({}, "FINESIGN_ENCRYPTION_ALLOW_PLAINTEXT_READ=true — legacy UNENCRYPTED blobs will be served without tamper detection (migration mode; unset once migrated)");
  }
  if (!keyProvider && o.encryption === undefined) {
    logger.warn({}, "encryption at rest is DISABLED (no FINESIGN_ENCRYPTION_KEY) — documents are stored UNENCRYPTED at rest");
  }
  const deps: AppDeps = {
    repo: o.repo ?? new SqliteEnvelopeRepository(params.sqliteFile),
    blobs: keyProvider ? new EncryptedBlobStore(baseBlobs, keyProvider, { allowPlaintextRead }) : baseBlobs,
    converter:
      o.converter ??
      new CompositeConverter([new PdfPassthroughConverter(), new LibreOfficeDocxConverter()]),
    mailer: o.mailer ?? new ConsoleMailer(logger),
    engine: new SignEngine(),
    clock: o.clock ?? new SystemClock(),
    ids: o.ids ?? new CryptoIdGenerator(),
    logger,
    config: { ...DEFAULT_CONFIG, ...o.config },
    sealer: o.sealer ?? buildSealerFromEnv(logger),
    webhooks:
      o.webhooks === null
        ? undefined
        : {
            // Same SQLite file as the envelope repo (separate handle; WAL allows it).
            store: o.webhooks?.store ?? new SqliteWebhookStore(params.sqliteFile),
            config: { ...webhookConfigFromEnv(), ...o.webhooks?.config },
            resolveHost: o.webhooks?.resolveHost,
            fetchImpl: o.webhooks?.fetchImpl,
          },
  };
  return { app: new EnvelopeApp(deps), deps };
}
