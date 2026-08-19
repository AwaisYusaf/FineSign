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
  createHttpValidationDataProvider,
  revocationSourcesForCert,
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

/**
 * Refuse to boot with a seal level the wiring cannot actually produce.
 * `sealPdf` enforces the same rule, but it only runs at COMPLETION — inside
 * `finalize()`, during the last signer's apply. Failing there rejects that
 * signature and leaves an envelope that can never complete, so the check has to
 * happen while the operator is still looking at the logs.
 */
function assertSealableLevel(level: PadesLevel, have: { tsa: boolean; revocation: boolean }): void {
  if (level !== "B-B" && !have.tsa) {
    throw new Error(
      `FINESIGN_PADES_LEVEL="${level}" requires a timestamp authority — set FINESIGN_TSA_URL (or FINESIGN_DEV_TSA=true for local testing)`
    );
  }
  if ((level === "B-LT" || level === "B-LTA") && !have.revocation) {
    throw new Error(
      `FINESIGN_PADES_LEVEL="${level}" requires revocation material, but the seal certificate publishes neither a CRL distribution point nor an OCSP responder — use a CA-issued certificate, or set FINESIGN_SEAL_CRL_URL / FINESIGN_SEAL_OCSP_URL`
    );
  }
}

/**
 * Verification trust anchors from `FINESIGN_SEAL_TRUST_CERTS` (comma-separated
 * PEM/DER paths). A CA-issued seal certificate should be verified against its
 * issuing CA, not against itself; without this the sealer falls back to direct
 * trust in the leaf, which still verifies but proves less. Returns undefined
 * when unset so that fallback stays the default.
 */
function readTrustAnchorsFromEnv(): Uint8Array[] | undefined {
  const raw = process.env.FINESIGN_SEAL_TRUST_CERTS;
  if (!raw) return undefined;
  const paths = raw.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
  if (paths.length === 0) return undefined;
  return paths.map((path) => readCertDer(path));
}

/**
 * Build the PAdES sealer from the environment (production):
 *   - `FINESIGN_SEAL_P12` + `FINESIGN_SEAL_PASSPHRASE` → load an org signing cert.
 *   - else `FINESIGN_DEV_SEAL=true` → a self-signed DEV seal (not for real use).
 *   - else → no sealing.
 *
 * The level comes from `FINESIGN_PADES_LEVEL`, defaulting to the strongest the
 * wiring supports (B-T with a TSA configured, else B-B). B-T and above need a
 * TSA (`buildTsaFromEnv`); B-LT/B-LTA additionally need revocation material,
 * fetched over HTTP from the seal certificate's own CRL distribution point / AIA
 * OCSP responder. Every requirement is checked HERE, at boot — see
 * `assertSealableLevel` for why that matters.
 *
 * `FINESIGN_SEAL_REQUIRED=true` makes a missing credential a hard boot failure
 * (fail-closed: never deliver a "completed" doc unsealed when sealing is required).
 */
function buildSealerFromEnv(logger: Logger): DocumentSealer | undefined {
  const p12Path = process.env.FINESIGN_SEAL_P12;
  const required = process.env.FINESIGN_SEAL_REQUIRED === "true";
  const requestedLevel = parsePadesLevelEnv();
  if (p12Path) {
    const bytes = new Uint8Array(fs.readFileSync(p12Path));
    const credential = LocalSigningCredential.fromPkcs12(bytes, process.env.FINESIGN_SEAL_PASSPHRASE ?? "");
    const { tsa, tsaTrustStore } = buildTsaFromEnv(logger);
    // B-LT/B-LTA additionally need revocation material. In production that comes
    // over HTTP from the leaf's own CRL Distribution Point / AIA OCSP responder,
    // overridable when the certificate carries no usable URL.
    const longTerm = requestedLevel === "B-LT" || requestedLevel === "B-LTA";
    const crlUrl = process.env.FINESIGN_SEAL_CRL_URL;
    const ocspUrl = process.env.FINESIGN_SEAL_OCSP_URL;
    const provider = longTerm
      ? createHttpValidationDataProvider({
          ...(crlUrl ? { crlUrl } : {}),
          ...(ocspUrl ? { ocspUrl } : {}),
        })
      : undefined;
    // The provider is best-effort: it returns empty material rather than failing,
    // so its mere existence proves nothing. Ask the certificate itself whether
    // there is anything to fetch, or take the operator's explicit override.
    const published = longTerm ? revocationSourcesForCert(credential.certificate()) : null;
    const haveRevocation = !!crlUrl || !!ocspUrl || !!published?.crlUrl || !!published?.ocspUrl;
    const level = requestedLevel ?? (tsa ? "B-T" : "B-B");
    // Fail at BOOT, not at the last signer's apply: `sealPdf` rejects a level it
    // lacks the inputs for, and that throw would otherwise land inside
    // `finalize()` — rejecting the final signature and wedging the envelope,
    // which can never complete afterwards.
    assertSealableLevel(level, { tsa: !!tsa, revocation: haveRevocation });
    const trustStore = readTrustAnchorsFromEnv();
    logger.info(
      { signer: credential.subjectCommonName(), padesLevel: level, trustAnchors: trustStore?.length ?? 0 },
      "PAdES sealing enabled (PKCS#12)"
    );
    return new PadesDocumentSealer(credential, {
      level,
      timestampAuthority: tsa,
      tsaTrustStore,
      ...(provider ? { validationDataProvider: provider } : {}),
      ...(trustStore ? { trustStore } : {}),
    });
  }
  if (process.env.FINESIGN_DEV_SEAL === "true") {
    const target = requestedLevel ?? "B-T";
    // Dev B-LT/B-LTA: a self-contained CA→leaf + in-process TSA + validation
    // provider, so long-term levels work offline with no external CA or TSA.
    // (Production uses FINESIGN_SEAL_P12 + FINESIGN_TSA_URL and fetches the
    // revocation material over HTTP — see the PKCS#12 branch above.)
    if (target === "B-LT" || target === "B-LTA") {
      const ca = generateTestCa({ commonName: "FineSign Dev Root CA", organization: "FineSign" });
      const leaf = ca.issueLeaf({ commonName: "FineSign Dev Seal", organization: "FineSign" });
      const { credential: tsaCredential } = generateSelfSignedTsaCredential({ commonName: "FineSign Dev TSA", organization: "FineSign" });
      const tsa = createInProcessTsa({ credential: tsaCredential, clock: new SystemClock() });
      const provider = createInProcessValidationDataProvider({ ca, clock: new SystemClock() });
      logger.warn({ padesLevel: target }, "PAdES long-term sealing enabled with a DEV CA + in-process TSA/validation — not for production");
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
    // Forward the requested level explicitly — omitting it let the sealer pick its
    // own default and silently ignore FINESIGN_PADES_LEVEL here.
    assertSealableLevel(target, { tsa: !!tsa, revocation: false });
    logger.warn({ padesLevel: target, timestamped: !!tsa }, "PAdES sealing enabled with a SELF-SIGNED DEV certificate — not for production");
    return new PadesDocumentSealer(credential, { level: target, timestampAuthority: tsa, tsaTrustStore });
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
