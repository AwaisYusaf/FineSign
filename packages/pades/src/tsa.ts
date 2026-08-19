/**
 * RFC 3161 Timestamp Authority (TSA) — the "when" in PAdES-B-T.
 *
 * A signature timestamp proves the signature value existed at a trusted instant
 * `genTime`, independent of the signer's own clock, and lets verification survive
 * the signer certificate's later expiry. This module provides:
 *
 *   - `TimestampAuthority` — the port the CMS builder calls with an already-hashed
 *     imprint, receiving back a DER RFC 3161 `TimeStampToken` (a ContentInfo
 *     wrapping SignedData / id-ct-TSTInfo).
 *   - `createInProcessTsa` — a self-contained TSA for tests and single-org
 *     self-hosting: it builds and signs a TSTInfo with a TSA credential (whose
 *     cert carries the critical id-kp-timeStamping EKU). Time comes from an
 *     injected `Clock`, so tokens are byte-reproducible in tests.
 *   - `createHttpTsa` — a client for an external RFC 3161 TSA over HTTP (the
 *     production path, e.g. a public or CA-run TSA), with an injectable `fetch`.
 *
 * The token is verified by `verifyPdf` (see verify.ts): the token's own CMS
 * signature, the message-imprint == hash(signature value), the TSA-cert EKU, and
 * (optionally) the TSA chain — after which `genTime` drives cert-validity-at-signing.
 */
import crypto from "crypto";
import * as asn1js from "asn1js";
import {
  TSTInfo,
  MessageImprint,
  Accuracy,
  GeneralName,
  TimeStampReq,
  TimeStampResp,
  PKIStatus,
  ContentInfo,
  SignedData,
  SignerInfo,
  Attribute,
  SignedAndUnsignedAttributes,
  IssuerAndSerialNumber,
  AlgorithmIdentifier,
  EncapsulatedContentInfo,
  Certificate,
} from "pkijs";
import { ValidationError, type Clock } from "@finesign/shared";
import type { SigningCredential } from "./types";
import { OID, digestOid, ecdsaOid, nodeDigestName, digestNameFromOid, type DigestAlgorithm } from "./oids";
import { derLess, signingCertificateV2, octetStringValue } from "./cms";
import { ensureEngine } from "./engine";

/**
 * The timestamp seam. `stamp` receives an ALREADY-computed digest (the imprint)
 * and the algorithm that produced it, and returns the DER of an RFC 3161
 * `TimeStampToken` (a `ContentInfo`). Taking the pre-hashed imprint keeps the
 * in-process and HTTP implementations symmetric and lets the caller own the
 * imprint algorithm.
 */
export interface TimestampAuthority {
  stamp(imprintDigest: Uint8Array, hashAlgo: DigestAlgorithm): Promise<Uint8Array>;
}

/** A real RFC 3161 timestamp-reply is a few KB; cap the buffered response so a
 *  hostile or MITM'd TSA endpoint cannot OOM the reader. */
const MAX_TSA_RESPONSE_BYTES = 64 * 1024;

/** Encode bytes as the content octets of a MINIMAL, non-negative DER INTEGER
 *  (serialNumber / nonce, RFC 3161 / RFC 5652): strip redundant leading 0x00
 *  bytes, then re-add exactly one 0x00 if the top bit is set (else the value
 *  would be negative). A non-minimal INTEGER (e.g. `00 01`) is rejected by strict
 *  parsers such as OpenSSL/Adobe. */
function derPositiveInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start + 1 < bytes.length && bytes[start] === 0x00 && (bytes[start + 1] & 0x80) === 0) start++;
  let out = bytes.slice(start);
  if (out.length === 0) out = new Uint8Array([0x00]);
  if ((out[0] & 0x80) !== 0) out = new Uint8Array([0x00, ...out]);
  return out;
}

/** Big-endian minimal byte encoding of a non-negative bigint (≥ 1 byte). */
function bigintToBytes(n: bigint): Uint8Array {
  if (n <= 0n) return new Uint8Array([0x00]);
  const out: number[] = [];
  let v = n;
  while (v > 0n) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return new Uint8Array(out);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Build a `MessageImprint` from an already-computed digest. SHA-2 algorithm
 *  identifiers omit parameters (RFC 5754), so only `algorithmId` is set. */
function messageImprint(imprintDigest: Uint8Array, hashAlgo: DigestAlgorithm): MessageImprint {
  return new MessageImprint({
    hashAlgorithm: new AlgorithmIdentifier({ algorithmId: digestOid(hashAlgo) }),
    hashedMessage: new asn1js.OctetString({ valueHex: imprintDigest }),
  });
}

export interface InProcessTsaOptions {
  /** The TSA's signing credential — its cert MUST carry the critical
   *  id-kp-timeStamping EKU (use `generateSelfSignedTsaCredential`). */
  credential: SigningCredential;
  /** Injected clock — `genTime` is `clock.now()` (never `new Date()`). */
  clock: Clock;
  /** TSA policy OID. Defaults to a private test policy arc. */
  policyOid?: string;
  /** Injectable monotonic serial-number source (for byte-reproducible tests). */
  serial?: () => Uint8Array;
  /** Declared accuracy of `genTime`, in seconds. Default 1. */
  accuracySeconds?: number;
}

/**
 * A TSA that runs in-process (no network). It signs a TSTInfo with the given TSA
 * credential. Suitable for tests and single-organisation self-hosting where the
 * platform operator is also the timestamp trust anchor.
 */
export function createInProcessTsa(options: InProcessTsaOptions): TimestampAuthority {
  const policy = options.policyOid ?? "1.3.6.1.4.1.99999.1"; // private test policy OID
  let counter = 0n;
  const nextSerial =
    options.serial ??
    (() => {
      counter += 1n;
      // Emit the FULL counter (minimal DER), so serials never wrap/collide.
      return derPositiveInteger(bigintToBytes(counter));
    });

  return {
    async stamp(imprintDigest: Uint8Array, hashAlgo: DigestAlgorithm): Promise<Uint8Array> {
      ensureEngine();
      const tsaDigest = options.credential.digestAlgorithm();
      const certDer = options.credential.certificate();
      const cert = Certificate.fromBER(certDer);
      const chain = options.credential.chain().map((d) => Certificate.fromBER(d));

      const tstInfo = new TSTInfo({
        version: 1,
        policy,
        messageImprint: messageImprint(imprintDigest, hashAlgo),
        serialNumber: new asn1js.Integer({ valueHex: nextSerial() }),
        genTime: options.clock.now(),
        accuracy: new Accuracy({ seconds: options.accuracySeconds ?? 1 }),
        ordering: false,
        // tsa [0]: the TSA's own directory name — informational, not verified.
        tsa: new GeneralName({ type: 4, value: cert.subject }),
      });
      // The eContent value octets = the DER of the TSTInfo (this is what the
      // message-digest signed attribute is taken over, and what is embedded
      // ATTACHED in the token's SignedData).
      const eContent = new Uint8Array(tstInfo.toSchema().toBER(false));

      const contentDigest = crypto.createHash(nodeDigestName(tsaDigest)).update(Buffer.from(eContent)).digest();
      const attrs: Attribute[] = [
        new Attribute({ type: OID.CONTENT_TYPE, values: [new asn1js.ObjectIdentifier({ value: OID.TST_INFO })] }),
        new Attribute({ type: OID.MESSAGE_DIGEST, values: [new asn1js.OctetString({ valueHex: contentDigest })] }),
        new Attribute({ type: OID.SIGNING_CERTIFICATE_V2, values: [signingCertificateV2(certDer, cert)] }),
      ];
      const sorted = attrs
        .map((a) => ({ a, enc: new Uint8Array(a.toSchema().toBER(false)) }))
        .sort((x, y) => derLess(x.enc, y.enc))
        .map((x) => x.a);

      const signedAttrs = new SignedAndUnsignedAttributes({ type: 0, attributes: sorted });
      const tbs = new Uint8Array(signedAttrs.toSchema().toBER(false));
      tbs[0] = 0x31; // [0] IMPLICIT → SET OF, as in the document signature
      const signature = await options.credential.sign(tbs);

      const isEc = options.credential.signatureScheme() === "ECDSA";
      const signerInfo = new SignerInfo({
        version: 1,
        sid: new IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
        digestAlgorithm: new AlgorithmIdentifier({ algorithmId: digestOid(tsaDigest) }),
        signedAttrs,
        signatureAlgorithm: new AlgorithmIdentifier({
          algorithmId: isEc ? ecdsaOid(tsaDigest) : OID.RSA_ENCRYPTION,
          ...(isEc ? {} : { algorithmParams: new asn1js.Null() }),
        }),
        signature: new asn1js.OctetString({ valueHex: signature }),
      });

      const signedData = new SignedData({
        version: 3, // eContentType is id-ct-TSTInfo (≠ id-data) ⇒ CMS version 3
        digestAlgorithms: [new AlgorithmIdentifier({ algorithmId: digestOid(tsaDigest) })],
        encapContentInfo: new EncapsulatedContentInfo({
          eContentType: OID.TST_INFO,
          eContent: new asn1js.OctetString({ valueHex: eContent }), // ATTACHED
        }),
        // certReq semantics: the TSA cert IS carried in the token so it verifies offline.
        certificates: [cert, ...chain],
        signerInfos: [signerInfo],
      });

      const token = new ContentInfo({ contentType: OID.SIGNED_DATA, content: signedData.toSchema(true) });
      return new Uint8Array(token.toSchema().toBER(false));
    },
  };
}

/** A minimal fetch surface — the subset `createHttpTsa` uses (injectable). */
export interface TsaFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type TsaFetch = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array }) => Promise<TsaFetchResponse>;

export interface HttpTsaOptions {
  /** The RFC 3161 endpoint (accepts `application/timestamp-query`). */
  url: string;
  /** Injectable fetch (defaults to global `fetch`). */
  fetchImpl?: TsaFetch;
  /** Requested TSA policy OID (optional). */
  reqPolicy?: string;
  /** Injectable nonce source (for deterministic tests). */
  nonce?: () => Uint8Array;
}

/**
 * A client for an external RFC 3161 TSA over HTTP — the production timestamp
 * path. Builds a `TimeStampReq` (with `certReq: true` so the token embeds the TSA
 * cert), POSTs it, and validates the response's status, echoed imprint, and nonce
 * before returning the token DER.
 */
export function createHttpTsa(options: HttpTsaOptions): TimestampAuthority {
  const doFetch: TsaFetch = options.fetchImpl ?? ((globalThis.fetch as unknown) as TsaFetch);
  const makeNonce = options.nonce ?? (() => new Uint8Array(crypto.randomBytes(16)));

  return {
    async stamp(imprintDigest: Uint8Array, hashAlgo: DigestAlgorithm): Promise<Uint8Array> {
      ensureEngine();
      if (!digestNameFromOid(digestOid(hashAlgo))) {
        throw new ValidationError(`unsupported timestamp imprint algorithm ${hashAlgo}`);
      }
      const nonce = derPositiveInteger(makeNonce());
      const request = new TimeStampReq({
        version: 1,
        messageImprint: messageImprint(imprintDigest, hashAlgo),
        ...(options.reqPolicy ? { reqPolicy: options.reqPolicy } : {}),
        certReq: true,
        nonce: new asn1js.Integer({ valueHex: nonce }),
      });
      const body = new Uint8Array(request.toSchema().toBER(false));

      const res = await doFetch(options.url, {
        method: "POST",
        headers: { "Content-Type": "application/timestamp-query" },
        body,
      });
      if (!res.ok) throw new ValidationError(`TSA HTTP error ${res.status}`);
      // Media types are case-insensitive (RFC 7231 §3.1.1.1).
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.includes("application/timestamp-reply")) {
        throw new ValidationError(`TSA returned unexpected content-type "${res.headers.get("content-type") ?? ""}"`);
      }

      // Bound the response before buffering it — a hostile/MITM'd TSA must not OOM
      // the reader (a real timestamp-reply is a few KB).
      const declaredLen = Number(res.headers.get("content-length") ?? "0");
      if (declaredLen > MAX_TSA_RESPONSE_BYTES) throw new ValidationError("TSA response too large");
      const bodyBytes = new Uint8Array(await res.arrayBuffer());
      if (bodyBytes.length > MAX_TSA_RESPONSE_BYTES) throw new ValidationError("TSA response too large");
      const resp = TimeStampResp.fromBER(bodyBytes);
      if (resp.status.status !== PKIStatus.granted && resp.status.status !== PKIStatus.grantedWithMods) {
        throw new ValidationError(`TSA rejected the request (status ${resp.status.status})`);
      }
      if (!resp.timeStampToken) throw new ValidationError("TSA response contained no timeStampToken");

      // Validate the echoed imprint + nonce BEFORE trusting the token.
      const tokenSd = new SignedData({ schema: resp.timeStampToken.content });
      const eContent = tokenSd.encapContentInfo.eContent;
      if (!eContent) throw new ValidationError("TSA token has no attached TSTInfo");
      const eContentBytes = octetStringValue(eContent);
      const parsed = asn1js.fromBER(eContentBytes.slice().buffer);
      if (parsed.offset === -1 || !parsed.result) throw new ValidationError("malformed TSA token (TSTInfo)");
      const tstInfo = new TSTInfo({ schema: parsed.result });
      const echoedImprint = new Uint8Array(tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView);
      if (!bytesEqual(echoedImprint, imprintDigest)) {
        throw new ValidationError("TSA token message-imprint does not match the request");
      }
      if (tstInfo.nonce) {
        const echoedNonce = new Uint8Array(tstInfo.nonce.valueBlock.valueHexView);
        if (!bytesEqual(echoedNonce, nonce)) throw new ValidationError("TSA token nonce does not match the request");
      }

      return new Uint8Array(resp.timeStampToken.toSchema().toBER(false));
    },
  };
}

/**
 * Build the `id-aa-signatureTimeStampToken` UNSIGNED attribute for a signature
 * value. The imprint is `hash(signatureValue)` — the raw SignerInfo signature
 * octets, NOT the OCTET STRING TLV — using `hashAlgo` (default SHA-256). Wired
 * into `buildCmsSignedData` via its `timestamp` hook.
 */
export async function signatureTimestampAttributes(
  tsa: TimestampAuthority,
  signatureValue: Uint8Array,
  hashAlgo: DigestAlgorithm = "SHA-256"
): Promise<Attribute[]> {
  const imprint = crypto.createHash(nodeDigestName(hashAlgo)).update(Buffer.from(signatureValue)).digest();
  const tokenDer = await tsa.stamp(new Uint8Array(imprint), hashAlgo);
  // The token is already a ContentInfo — embed its schema directly (do NOT
  // double-wrap it in another ContentInfo/OctetString).
  return [
    new Attribute({
      type: OID.SIGNATURE_TIMESTAMP_TOKEN,
      values: [ContentInfo.fromBER(tokenDer).toSchema()],
    }),
  ];
}
