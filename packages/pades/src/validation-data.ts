/**
 * Validation material for PAdES-B-LT — the certificate chain + revocation data
 * (CRLs / OCSP) embedded in the PDF's DSS so a verifier can validate the signature
 * OFFLINE, years later, after the certs expire and the CA's endpoints are gone.
 *
 * The `ValidationDataProvider` port abstracts WHERE the material comes from: an
 * in-process test CA (deterministic, offline), or — production — an HTTP fetch
 * from the certificate's CRL Distribution Point / OCSP AIA (scaffolded in P6c).
 */
import * as asn1js from "asn1js";
import {
  Certificate,
  CertificateRevocationList,
  RevokedCertificate,
  Time,
  BasicOCSPResponse,
  OCSPRequest,
  OCSPResponse,
  CertID,
  SingleResponse,
  getCrypto,
} from "pkijs";
import { ValidationError, type Clock } from "@finesign/shared";
import { ensureEngine } from "./engine";
import type { TestCa, WebCryptoKey } from "./credential";

/** Certs + revocation material to embed in the DSS. Raw DER, uncompressed. */
export interface ValidationData {
  certs: Uint8Array[];
  crls: Uint8Array[];
  ocsps: Uint8Array[];
}

/** Collect the validation material needed to validate `signerCertDer` (whose
 *  issuer chain is `chainDer`, leaf-issuer first) offline. */
export interface ValidationDataProvider {
  collect(signerCertDer: Uint8Array, chainDer: Uint8Array[]): Promise<ValidationData>;
}

/**
 * Build + sign a CRL with the installed pkijs. Reuses the issuer's parsed subject
 * (so `issuer.isEqual` holds during verification) and the target certs' parsed
 * serials (so DER matches). Always SHA-256 (pkijs's `.sign()` default is SHA-1).
 */
export async function issueCrl(
  caCert: Certificate,
  caKey: WebCryptoKey,
  revoked: Certificate[],
  now: Date,
  next: Date
): Promise<Uint8Array> {
  ensureEngine();
  const crl = new CertificateRevocationList({
    version: 1, // v2 CRL — required for extensions / RevokedCertificate entries
    issuer: caCert.subject,
    thisUpdate: new Time({ type: 0, value: now }),
    nextUpdate: new Time({ type: 0, value: next }),
    revokedCertificates: revoked.map(
      (c) =>
        new RevokedCertificate({
          userCertificate: c.serialNumber,
          revocationDate: new Time({ type: 0, value: now }),
        })
    ),
  });
  await crl.sign(caKey, "SHA-256", getCrypto(true));
  return new Uint8Array(crl.toSchema().toBER(false));
}

/**
 * Build + sign an OCSP response (BasicOCSPResponse) for `leaf`, signed by the CA.
 * `good` is a primitive `[0]`, `revoked` a constructed `[1]` RevokedInfo. Always
 * SHA-256 (pkijs's `.sign()`/`CertID` default to SHA-1). Embedded raw in the DSS
 * `/OCSPs` (the BasicOCSPResponse, per the EU-DSS/iText convention).
 */
export async function issueOcsp(
  leaf: Certificate,
  caCert: Certificate,
  caKey: WebCryptoKey,
  now: Date,
  next: Date,
  revoked: boolean
): Promise<Uint8Array> {
  ensureEngine();
  const basic = new BasicOCSPResponse();
  basic.tbsResponseData.responderID = caCert.subject; // byName
  basic.tbsResponseData.producedAt = now;
  const certID = new CertID();
  await certID.createForCertificate(leaf, { hashAlgorithm: "SHA-256", issuerCertificate: caCert }, getCrypto(true));
  const single = new SingleResponse({ certID });
  single.certStatus = revoked
    ? new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 1 }, value: [new asn1js.GeneralizedTime({ valueDate: now })] })
    : new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 } });
  single.thisUpdate = now;
  single.nextUpdate = next;
  basic.tbsResponseData.responses.push(single);
  basic.certs = [caCert];
  await basic.sign(caKey, "SHA-256", getCrypto(true));
  return new Uint8Array(basic.toSchema().toBER(false));
}

/** Which revocation source(s) the in-process provider emits into the DSS. */
export type RevocationSource = "crl" | "ocsp" | "both";

export interface InProcessValidationOptions {
  /** The test CA that issued the signer leaf (issues + signs its CRL). */
  ca: TestCa;
  /** Injected clock — CRL `thisUpdate`; `nextUpdate = now + validityDays`. */
  clock: Clock;
  /** CRL/OCSP validity window in days (default 7). */
  validityDays?: number;
  /** Test hook: return true to REVOKE the leaf (by its serial hex). */
  revoke?: (leafSerialHex: string) => boolean;
  /** Which revocation material to emit. Default `"crl"`. */
  source?: RevocationSource;
}

/**
 * An in-process validation-data provider backed by a test CA: it issues a CRL
 * (empty, or revoking the leaf) signed by the CA. Deterministic given a fixed
 * clock — for tests and single-org self-hosting.
 */
export function createInProcessValidationDataProvider(o: InProcessValidationOptions): ValidationDataProvider {
  return {
    async collect(signerDer: Uint8Array, chainDer: Uint8Array[]): Promise<ValidationData> {
      ensureEngine();
      const leaf = Certificate.fromBER(signerDer);
      const caCert = o.ca.pkijsCert();
      const caKey = await o.ca.cryptoKey();
      const now = o.clock.now();
      const next = new Date(now.getTime() + (o.validityDays ?? 7) * 864e5);
      const serialHex = Buffer.from(leaf.serialNumber.valueBlock.valueHexView).toString("hex");
      const isRevoked = o.revoke?.(serialHex) ?? false;
      const source = o.source ?? "crl";
      const crls = source === "crl" || source === "both" ? [await issueCrl(caCert, caKey, isRevoked ? [leaf] : [], now, next)] : [];
      const ocsps = source === "ocsp" || source === "both" ? [await issueOcsp(leaf, caCert, caKey, now, next, isRevoked)] : [];
      return { certs: [signerDer, ...chainDer], crls, ocsps };
    },
  };
}

// ---- HTTP validation-data provider (production) -----------------------------

/** A minimal fetch surface — the subset the HTTP provider uses (injectable). */
export interface ValidationFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type ValidationFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array }
) => Promise<ValidationFetchResponse>;

export interface HttpValidationOptions {
  /** Injectable fetch (defaults to global `fetch`). */
  fetchImpl?: ValidationFetch;
  /** Explicit CRL URL (overrides the leaf's CRL Distribution Point). */
  crlUrl?: string;
  /** Explicit OCSP responder URL (overrides the leaf's AIA). */
  ocspUrl?: string;
  /** Response body cap (default 5 MB) — a CRL can be large but not unbounded. */
  maxBytes?: number;
}

const MAX_VALIDATION_RESPONSE_BYTES = 5 * 1024 * 1024;

/** The URI (GeneralName type 6) or null. */
function uriFromGeneralName(gn: { type?: number; value?: unknown } | undefined): string | null {
  if (!gn || gn.type !== 6) return null;
  const v = gn.value;
  if (typeof v === "string") return v;
  const inner = (v as { valueBlock?: { value?: unknown } } | null)?.valueBlock?.value;
  return typeof inner === "string" ? inner : null;
}

/** The leaf's CRL Distribution Point HTTP URL (ext 2.5.29.31), if any. */
function crlUrlFromCert(cert: Certificate): string | null {
  try {
    const ext = cert.extensions?.find((e) => e.extnID === "2.5.29.31");
    const cdp = ext?.parsedValue as { distributionPoints?: { distributionPoint?: unknown }[] } | undefined;
    for (const dp of cdp?.distributionPoints ?? []) {
      const names = dp.distributionPoint as { type?: number; value?: unknown }[] | undefined;
      if (Array.isArray(names)) {
        for (const gn of names) {
          const u = uriFromGeneralName(gn);
          if (u && /^https?:/i.test(u)) return u;
        }
      }
    }
  } catch {
    /* best effort */
  }
  return null;
}

/** The leaf's OCSP responder HTTP URL from AIA (ext 1.3.6.1.5.5.7.1.1), if any. */
function ocspUrlFromCert(cert: Certificate): string | null {
  try {
    const ext = cert.extensions?.find((e) => e.extnID === "1.3.6.1.5.5.7.1.1");
    const aia = ext?.parsedValue as { accessDescriptions?: { accessMethod?: string; accessLocation?: { type?: number; value?: unknown } }[] } | undefined;
    for (const ad of aia?.accessDescriptions ?? []) {
      if (ad.accessMethod === "1.3.6.1.5.5.7.48.1") {
        const u = uriFromGeneralName(ad.accessLocation);
        if (u && /^https?:/i.test(u)) return u;
      }
    }
  } catch {
    /* best effort */
  }
  return null;
}

/**
 * A production validation-data provider that fetches the CRL from the leaf's CRL
 * Distribution Point (or an explicit `crlUrl`) and an OCSP response from its AIA
 * responder (or an explicit `ocspUrl`). Mirrors `createHttpTsa`: an injectable
 * `fetchImpl` makes it unit-testable without a live CA. Malformed / oversized
 * responses are skipped, not fatal (best-effort long-term material).
 */
export function createHttpValidationDataProvider(options: HttpValidationOptions = {}): ValidationDataProvider {
  const doFetch: ValidationFetch = options.fetchImpl ?? ((globalThis.fetch as unknown) as ValidationFetch);
  const cap = options.maxBytes ?? MAX_VALIDATION_RESPONSE_BYTES;

  const getBytes = async (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }): Promise<Uint8Array | null> => {
    const res = await doFetch(url, init).catch(() => null);
    if (!res || !res.ok) return null;
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > cap) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length > cap ? null : bytes;
  };

  return {
    async collect(signerDer: Uint8Array, chainDer: Uint8Array[]): Promise<ValidationData> {
      ensureEngine();
      const leaf = Certificate.fromBER(signerDer);
      const issuer = chainDer.length > 0 ? Certificate.fromBER(chainDer[0]) : null;
      const crlUrl = options.crlUrl ?? crlUrlFromCert(leaf);
      const ocspUrl = options.ocspUrl ?? ocspUrlFromCert(leaf);

      const crls: Uint8Array[] = [];
      const ocsps: Uint8Array[] = [];

      if (crlUrl) {
        const der = await getBytes(crlUrl, { method: "GET", headers: {} });
        if (der) {
          try {
            CertificateRevocationList.fromBER(der); // validate it parses
            crls.push(der);
          } catch {
            /* not a CRL — skip */
          }
        }
      }

      if (ocspUrl && issuer) {
        try {
          const request = new OCSPRequest();
          await request.createForCertificate(leaf, { hashAlgorithm: "SHA-256", issuerCertificate: issuer }, getCrypto(true));
          const reqDer = new Uint8Array(request.toSchema(true).toBER(false));
          const respDer = await getBytes(ocspUrl, {
            method: "POST",
            headers: { "Content-Type": "application/ocsp-request" },
            body: reqDer,
          });
          const basicDer = respDer ? unwrapBasicOcsp(respDer) : null;
          if (basicDer) ocsps.push(basicDer);
        } catch {
          /* OCSP fetch/parse failed — skip */
        }
      }

      return { certs: [signerDer, ...chainDer], crls, ocsps };
    },
  };
}

/** Extract the BasicOCSPResponse DER from an OCSP response, tolerating either the
 *  OCSPResponse wrapper (successful status) or a bare BasicOCSPResponse. */
function unwrapBasicOcsp(der: Uint8Array): Uint8Array | null {
  try {
    const resp = OCSPResponse.fromBER(der);
    if (resp.responseStatus.valueBlock.valueDec !== 0) throw new ValidationError("OCSP responder returned a non-successful status");
    const inner = resp.responseBytes?.response.valueBlock.valueHexView;
    if (inner) {
      BasicOCSPResponse.fromBER(inner); // validate
      return new Uint8Array(inner);
    }
  } catch {
    /* fall through to try a bare BasicOCSPResponse */
  }
  try {
    BasicOCSPResponse.fromBER(der);
    return der;
  } catch {
    return null;
  }
}
