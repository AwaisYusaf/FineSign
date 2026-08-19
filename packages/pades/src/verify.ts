/**
 * PAdES verification (P3) — the capability that makes a signature legally useful:
 * anyone can independently prove the document wasn't altered after signing.
 *
 * For each signature dictionary it:
 *   1. recomputes the `/ByteRange` digest and verifies the CMS signature;
 *   2. checks WHOLE-DOCUMENT COVERAGE — that nothing lies outside the ByteRange
 *      (defeats the "valid signature over only part of the file / appended
 *      change" attack);
 *   3. checks the `message-digest` and `signing-certificate-v2` signed attributes;
 *   4. validates the certificate chain to a configured trust store;
 *   5. rejects weak digest algorithms (SHA-1/MD5).
 */
import crypto from "crypto";
import * as asn1js from "asn1js";
import {
  ContentInfo,
  SignedData,
  SignerInfo,
  Certificate,
  CertificateRevocationList,
  BasicOCSPResponse,
  IssuerAndSerialNumber,
  CertificateChainValidationEngine,
  AlgorithmIdentifier,
  TSTInfo,
  ExtKeyUsage,
} from "pkijs";
import { PDFDocument, PDFDict, PDFName, PDFArray, PDFRawStream, PDFRef } from "pdf-lib";
import { OID, digestNameFromOid } from "./oids";
import { octetStringValue } from "./cms";
import { ensureEngine } from "./engine";
import type { VerificationResult, SignatureVerdict, PadesLevel, RevocationVerdict } from "./types";

/** Certificate + CRL + OCSP material extracted from a PDF's DSS (PAdES-B-LT). */
interface DssMaterial {
  certs: Certificate[];
  crls: CertificateRevocationList[];
  ocsps: BasicOCSPResponse[];
}

const derHex = (s: { toSchema(): { toBER(sizeOnly: boolean): ArrayBuffer } }): string =>
  Buffer.from(new Uint8Array(s.toSchema().toBER(false))).toString("hex");

const WEAK_DIGESTS = new Set<string>(["1.3.14.3.2.26" /* SHA-1 */, "1.2.840.113549.2.5" /* MD5 */]);
const WEAK_SIGNATURES = new Set<string>([OID.MD5_WITH_RSA, OID.SHA1_WITH_RSA, OID.ECDSA_WITH_SHA1]);
const MIN_RSA_BITS = 2048;

/** Minimal shape for walking asn1js value trees without `any`. */
interface AsnNode {
  idBlock?: { tagNumber?: number };
  valueBlock: { value?: AsnNode[]; valueHexView?: Uint8Array };
  toBER?: (sizeOnly: boolean) => ArrayBuffer;
}

export interface VerifyOptions {
  /** DER trust anchors. A signature is `trusted` when its chain validates to one
   *  of these (for the platform self-signed seal, include the seal cert). */
  trustStore?: Uint8Array[];
  /** DER trust anchors for RFC 3161 timestamp authorities. Governs whether a
   *  timestamp may EXTEND the signer certificate's effective validity window
   *  (defeating seal-cert expiry). When set, a B-T timestamp only moves the
   *  effective signing time if its TSA certificate chains to one of these
   *  (validated as-of genTime). When UNSET, the timestamp is still reported
   *  `present`/`valid` on its own cryptographic merits, but it does NOT move the
   *  clock — because the RFC 3161 token is an UNSIGNED CMS attribute, anyone can
   *  swap in a self-signed TSA, so an un-anchored timestamp must never resurrect
   *  an expired/revoked signer cert (fail-closed, like `trustStore`). */
  tsaTrustStore?: Uint8Array[];
  /** Fail-closed revocation: require every signer's revocation status to be a
   *  CONFIRMED "good" from the embedded DSS material. When set, an `unknown`
   *  status (no usable CRL for the signer) makes the signature untrusted. Default
   *  off (a signature stays trusted on its chain when revocation is indeterminate). */
  requireRevocation?: boolean;
  /** Verification time (injected for determinism). Defaults to now. */
  at?: Date;
}

interface RawSig {
  byteRange: [number, number, number, number];
  signedContent: Buffer;
  cmsDer: Buffer;
  /** A CAdES signature (`/Type /Sig`) or an RFC 3161 document timestamp. */
  kind: "signature" | "document-timestamp";
  /** UPPERCASE-hex SHA-1 of the full `/Contents` bytes — the DSS /VRI key. */
  contentsSha1Upper: string;
  /** The byte offset where this entry's ByteRange coverage ends (`c + d`). */
  byteRangeEnd: number;
  /** Whether coverage starts at byte 0. */
  startsAtZero: boolean;
  /** Set once coverage is resolved (whitespace-only OR benign DSS/DTS appends). */
  coversWholeDocument: boolean;
  /** The ByteRange geometry is structurally valid (bounds, ordering, gap layout). */
  structureValid: boolean;
}

const isWhitespace = (byte: number) => byte === 0x0a || byte === 0x0d || byte === 0x20 || byte === 0x09 || byte === 0x00;

/**
 * Locate every signature / document timestamp: each `/ByteRange [a b c d]` defines
 * a gap [a+b, c) that must hold ONLY the hex `/Contents` (`<...>`). Validates the
 * geometry (M1) so a crafted ByteRange can't hide unsigned bytes, and classifies
 * the enclosing dictionary as a signature or an `ETSI.RFC3161` document timestamp.
 */
function extractSignatures(pdf: Buffer): RawSig[] {
  const len = pdf.length;
  const text = pdf.toString("latin1");
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  const out: RawSig[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = Number(m[3]);
    const d = Number(m[4]);

    // Read the gap [a+b, c) and require it to be a well-formed hex `/Contents`
    // (`<...>`). This distinguishes a REAL signature dictionary from a stray
    // `/ByteRange [...]` literal that may appear in a content stream or metadata
    // (A3) — such matches are skipped, not treated as broken signatures.
    const inBounds = a >= 0 && b >= 0 && d >= 0 && a + b <= len && c <= len && c >= a + b;
    const gap = inBounds ? pdf.subarray(a + b, c).toString("latin1") : "";
    const hexMatch = /^\s*<([0-9a-fA-F]*)>\s*$/.exec(gap);
    if (!hexMatch) continue; // not a signature dictionary

    // Classify from the enclosing dictionary: a document timestamp is
    // `/Type /DocTimeStamp` and/or `/SubFilter /ETSI.RFC3161`.
    const dictStart = text.lastIndexOf("<<", m.index);
    const dictWindow = dictStart >= 0 ? text.slice(dictStart, m.index + m[0].length) : "";
    const kind: RawSig["kind"] =
      /\/SubFilter\s*\/ETSI\.RFC3161/.test(dictWindow) || /\/Type\s*\/DocTimeStamp/.test(dictWindow)
        ? "document-timestamp"
        : "signature";

    // Structural coverage invariants for a real signature.
    const structureValid = inBounds && c + d <= len && c > a + b;
    const signedContent = structureValid
      ? Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)])
      : Buffer.alloc(0);
    // Do NOT strip trailing 0x00 — asn1js reads the DER definite length and
    // ignores placeholder padding, and stripping would truncate any CMS that
    // legitimately ends in 0x00 (~1/256 of RSA seals) (A2).
    const cmsDer = Buffer.from(hexMatch[1], "hex");
    const contentsSha1Upper = crypto.createHash("sha1").update(cmsDer).digest("hex").toUpperCase();
    out.push({
      byteRange: [a, b, c, d],
      signedContent,
      cmsDer,
      kind,
      contentsSha1Upper,
      byteRangeEnd: c + d,
      startsAtZero: a === 0,
      coversWholeDocument: false, // resolved async (coverage relaxation for DSS/DTS appends)
      structureValid,
    });
  }
  return out;
}

/**
 * Resolve whether a signature ending at `from` covers the whole document. Bytes
 * after `from` are acceptable ONLY if they are legitimate incremental revisions
 * that ADD new objects (DSS validation material / a document timestamp) and, at
 * most, re-emit the catalog to add `/DSS` — never re-defining an existing object
 * or changing the page tree. This keeps the append-attack defense (a content
 * change re-emits an existing object or swaps /Pages → rejected) while allowing
 * the B-LT/B-LTA long-term-validation revisions.
 */
async function appendsAreBenign(pdf: Buffer, from: number): Promise<boolean> {
  if (from >= pdf.length || pdf.subarray(from).every(isWhitespace)) return true;

  // STRUCTURAL GATE: the trailing bytes must actually FORM one or more incremental
  // updates — a new cross-reference section (`startxref N`) ending in `%%EOF`.
  // Arbitrary trailing junk (a stray comment, appended content) that pdf-lib
  // silently ignores must NOT be accepted as a benign revision (append attack).
  const tailText = pdf.subarray(from).toString("latin1");
  if (!/startxref\s+\d+/.test(tailText) || !/%%EOF\s*$/.test(tailText)) return false;

  let asSigned: PDFDocument;
  let full: PDFDocument;
  try {
    asSigned = await PDFDocument.load(pdf.subarray(0, from), { ignoreEncryption: true });
    full = await PDFDocument.load(pdf, { ignoreEncryption: true });
  } catch {
    return false; // the prefix isn't a standalone PDF, or the whole doc won't parse
  }
  const beforeRoot = asSigned.context.trailerInfo.Root as PDFRef;
  const afterRoot = full.context.trailerInfo.Root as PDFRef;
  if (!beforeRoot || !afterRoot || beforeRoot.objectNumber !== afterRoot.objectNumber) return false;

  const serialize = (obj: { sizeInBytes(): number; copyBytesInto(b: Uint8Array, o: number): number }): string => {
    const buf = Buffer.alloc(obj.sizeInBytes());
    obj.copyBytesInto(buf, 0);
    return buf.toString("latin1");
  };
  const before = new Map<number, string>();
  for (const [ref, obj] of asSigned.context.enumerateIndirectObjects()) before.set(ref.objectNumber, serialize(obj));
  const fullDefined = new Set<number>();
  for (const [ref, obj] of full.context.enumerateIndirectObjects()) {
    fullDefined.add(ref.objectNumber);
    const prev = before.get(ref.objectNumber);
    if (prev === undefined) continue; // a newly-added object — checked for reachability below
    if (prev === serialize(obj)) continue; // unchanged
    if (ref.objectNumber !== afterRoot.objectNumber) return false; // re-defined a non-catalog object
  }

  // No NEWLY-DEFINED object may become reachable from the render tree (the
  // catalog's object graph MINUS the /DSS subtree). This blocks an overlay attack
  // where the signed document carries a DANGLING reference (e.g. a page
  // /Annots [999 0 R] with object 999 absent) that a later "benign" revision
  // satisfies with an injected annotation/XObject — a new object, so the object-diff
  // above allows it, yet a conforming viewer would render it. A reference that stays
  // dangling (still undefined in `full`) is harmless and does NOT trip this.
  for (const num of renderReachable(full)) {
    if (fullDefined.has(num) && !before.has(num)) return false; // newly DEFINED and now render-reachable
  }

  return catalogChangeIsOnlyDss(asSigned, full);
}

/** Object numbers reachable from the catalog's render graph, NOT following the
 *  `/DSS` subtree (whose new cert/CRL/OCSP streams are legitimately added). */
function renderReachable(doc: PDFDocument): Set<number> {
  const ctx = doc.context;
  const rootRef = ctx.trailerInfo.Root as PDFRef | undefined;
  const seen = new Set<number>();
  if (!rootRef) return seen;
  const streamDict = (o: unknown): PDFDict | null => {
    const d = (o as { dict?: unknown } | null)?.dict;
    return d instanceof PDFDict ? d : null;
  };
  const stack: unknown[] = [];
  const pushChildren = (obj: unknown): void => {
    const dict = obj instanceof PDFDict ? obj : streamDict(obj);
    if (dict) {
      for (const [key, val] of dict.entries()) {
        if (key.toString() === "/DSS") continue; // don't descend into the DSS store
        stack.push(val);
      }
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) stack.push(obj.get(i));
    }
  };
  seen.add(rootRef.objectNumber);
  pushChildren(ctx.lookupMaybe(rootRef, PDFDict));
  let guard = 0;
  while (stack.length && guard++ < 200000) {
    const node = stack.pop();
    if (node instanceof PDFRef) {
      if (seen.has(node.objectNumber)) continue;
      seen.add(node.objectNumber);
      pushChildren(ctx.lookup(node));
    } else {
      pushChildren(node);
    }
  }
  return seen;
}

/** The re-emitted catalog may ONLY gain a `/DSS` key; every pre-existing key must
 *  be present with the identical value (no /Pages swap, no /OpenAction injection). */
function catalogChangeIsOnlyDss(asSigned: PDFDocument, full: PDFDocument): boolean {
  const oc = asSigned.context.lookup(asSigned.context.trailerInfo.Root, PDFDict);
  const fc = full.context.lookup(full.context.trailerInfo.Root, PDFDict);
  if (!(oc instanceof PDFDict) || !(fc instanceof PDFDict)) return false;
  for (const k of oc.keys()) {
    const fv = fc.get(k);
    if (fv === undefined) return false; // a key was removed
    if (String(fv) !== String(oc.get(k))) return false; // a shared key changed
  }
  for (const k of fc.keys()) {
    if (oc.get(k) === undefined && k.toString() !== "/DSS") return false; // added a non-DSS key
  }
  return true;
}

/**
 * Resolve the certificate that a SignerInfo names — the SAME certificate PKIjs
 * uses to verify the signature. This MUST agree with PKIjs, or trust/EKU/attr
 * checks bind to the wrong cert and an attacker can forge a "trusted" seal by
 * putting a genuine cert at `certificates[0]` while signing with their own key
 * under a SubjectKeyIdentifier `sid`. So we NEVER fall back to `certs[0]`:
 *   - IssuerAndSerialNumber → match issuer + serial (serial alone can collide).
 *   - SubjectKeyIdentifier (SignerInfo v3) → match SHA-1(subjectPublicKey) to the
 *     SKI octets, exactly as PKIjs's SignedData.verify does.
 * No exact match → null (the caller then reports an unresolved signer).
 */
function findSignerCert(sd: SignedData, signerInfo: SignerInfo): Certificate | null {
  const certs = (sd.certificates ?? []).filter((c): c is Certificate => c instanceof Certificate);
  const sid = signerInfo.sid;
  if (sid instanceof IssuerAndSerialNumber) {
    // Identify by BOTH issuer and serial (RFC 5652) — serial alone can collide
    // across issuers (L2).
    const wantSerial = Buffer.from(sid.serialNumber.valueBlock.valueHexView).toString("hex");
    const wantIssuer = Buffer.from(new Uint8Array(sid.issuer.toSchema().toBER(false))).toString("hex");
    for (const cert of certs) {
      const gotSerial = Buffer.from(cert.serialNumber.valueBlock.valueHexView).toString("hex");
      const gotIssuer = Buffer.from(new Uint8Array(cert.issuer.toSchema().toBER(false))).toString("hex");
      if (gotSerial === wantSerial && gotIssuer === wantIssuer) return cert;
    }
    return null; // no exact match — do not guess
  }
  // SubjectKeyIdentifier: the sid is the raw [0]-tagged OCTET STRING of the key id
  // (or a constructed chunked form). Extract the octets exactly as PKIjs does.
  const ski = sid as unknown as {
    idBlock?: { isConstructed?: boolean };
    valueBlock: { valueHexView?: Uint8Array; value?: { valueBlock: { valueHexView?: Uint8Array } }[] };
  };
  const keyId = ski.idBlock?.isConstructed ? ski.valueBlock.value?.[0]?.valueBlock.valueHexView : ski.valueBlock.valueHexView;
  if (!keyId || keyId.length === 0) return null;
  const want = Buffer.from(keyId);
  for (const cert of certs) {
    const spk = cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView;
    const digest = crypto.createHash("sha1").update(Buffer.from(spk)).digest();
    if (digest.equals(want)) return cert;
  }
  return null; // no exact match — do not guess
}

function attr(signerInfo: SignerInfo, type: string): unknown[] | null {
  const attrs = signerInfo.signedAttrs?.attributes ?? [];
  const found = attrs.find((a) => a.type === type);
  return found ? found.values : null;
}

/** Read an UNSIGNED attribute's values (the RFC 3161 timestamp lives here). */
function unsignedAttr(signerInfo: SignerInfo, type: string): unknown[] | null {
  const attrs = signerInfo.unsignedAttrs?.attributes ?? [];
  const found = attrs.find((a) => a.type === type);
  return found ? found.values : null;
}

/** A TSA cert must carry EXACTLY ONE Extended Key Usage — id-kp-timeStamping —
 *  and it must be marked CRITICAL (RFC 3161 §2.3). Anything looser (extra EKUs,
 *  non-critical, or absent) disqualifies the timestamp. */
function hasTimeStampingEku(cert: Certificate): boolean {
  const ext = (cert.extensions ?? []).find((e) => e.extnID === OID.EXT_KEY_USAGE);
  if (!ext || !ext.critical) return false;
  const eku = ext.parsedValue as ExtKeyUsage | undefined;
  const purposes = eku && Array.isArray(eku.keyPurposes) ? eku.keyPurposes : null;
  return !!purposes && purposes.length === 1 && purposes[0] === OID.KP_TIME_STAMPING;
}

interface TimestampResult {
  present: boolean;
  valid: boolean;
  time: string | null;
  /** The trusted signing instant — set only when the timestamp is valid. */
  genTime: Date | null;
}

/**
 * Verify a PAdES-B-T signature timestamp attached to `signerInfo`:
 *   (a) the token's OWN CMS signature (attached eContent — verified without data);
 *   (b) the message-imprint == hash(the outer SignerInfo signature value octets),
 *       using the imprint's OWN hash algorithm (may differ from the signer's);
 *   (c) the TSA cert has a single critical id-kp-timeStamping EKU;
 *   (d) optionally, the TSA cert chains to `tsaTrustStore` as-of `genTime`.
 * Only when all hold is `genTime` returned as the trusted signing instant. A
 * malformed token yields `valid=false` plus a `problems[]` note — never a throw.
 */
/**
 * Shared RFC 3161 token verification — used by BOTH the B-T signature timestamp
 * (imprint over the SignerInfo signature value) and the B-LTA document timestamp
 * (imprint over the document ByteRange). Verifies the token's own CMS signature,
 * the message-imprint against `imprintData`, the TSA's critical single
 * id-kp-timeStamping EKU, and (optionally) TSA trust as-of genTime. `genTime` is
 * returned ONLY for an ANCHORED (tsaTrustStore-trusted) timestamp — an un-anchored
 * token is `valid` on crypto merits but must not move any clock.
 */
async function verifyRfc3161Token(
  tokenCi: ContentInfo,
  imprintData: ArrayBuffer,
  options: VerifyOptions,
  problems: string[]
): Promise<{ valid: boolean; genTime: Date | null; time: string | null }> {
  const out: { valid: boolean; genTime: Date | null; time: string | null } = { valid: false, genTime: null, time: null };
  if (tokenCi.contentType !== OID.SIGNED_DATA) throw new Error("timestamp token is not SignedData");
  const tstSd = new SignedData({ schema: tokenCi.content });
  if (tstSd.encapContentInfo.eContentType !== OID.TST_INFO) throw new Error("timestamp token eContentType is not id-ct-TSTInfo");

  // (a) The token's OWN CMS signature. eContent is ATTACHED. PKIjs's dedicated
  // id-ct-TSTInfo verify path (this version) misreads a CONSTRUCTED eContent OCTET
  // STRING; retyping to id-data routes through the general attached path that uses
  // eContent.getValue() correctly. We do the timestamp checks ourselves below.
  tstSd.encapContentInfo.eContentType = OID.DATA;
  const tv = await tstSd.verify({ signer: 0, extendedMode: true, checkChain: false });
  const tokenSigValid = typeof tv === "boolean" ? tv : (tv as { signatureVerified?: boolean }).signatureVerified === true;
  if (!tokenSigValid) problems.push("timestamp token signature is invalid");

  // (b) Parse TSTInfo (the attached, possibly-constructed OCTET STRING).
  const eContent = tstSd.encapContentInfo.eContent;
  if (!eContent) throw new Error("timestamp token has no attached TSTInfo");
  const eContentBytes = octetStringValue(eContent);
  if (eContentBytes.length === 0) throw new Error("timestamp token has empty TSTInfo content");
  const tstInfo = new TSTInfo({ schema: asn1js.fromBER(eContentBytes.slice().buffer).result });
  out.time = tstInfo.genTime.toISOString();

  const imprintAlgo = tstInfo.messageImprint.hashAlgorithm.algorithmId;
  if (!digestNameFromOid(imprintAlgo) || WEAK_DIGESTS.has(imprintAlgo)) {
    throw new Error(`weak timestamp imprint algorithm ${imprintAlgo}`);
  }

  // (c) The imprint MUST bind to `imprintData` (hashed with the imprint's own algo).
  const imprintOk = await tstInfo.verify({ data: imprintData });
  if (!imprintOk) problems.push("timestamp message-imprint mismatch (does not cover the timestamped data)");

  // (d) TSA cert EKU.
  const tsaSigner = findSignerCert(tstSd, tstSd.signerInfos[0]);
  const ekuOk = tsaSigner ? hasTimeStampingEku(tsaSigner) : false;
  if (!ekuOk) problems.push("timestamp TSA certificate lacks a single critical id-kp-timeStamping EKU");

  // (e) Optional TSA trust, validated AS-OF genTime — DIRECT (pinned self-signed
  // TSA) or CHAIN (CA-issued TSA).
  const anchors = options.tsaTrustStore ?? [];
  const tsaConfigured = anchors.length > 0;
  let tsaTrustOk = true;
  if (tsaConfigured) {
    tsaTrustOk = false;
    const tsaWithinValidity =
      !!tsaSigner && tstInfo.genTime >= tsaSigner.notBefore.value && tstInfo.genTime <= tsaSigner.notAfter.value;
    const tsaSignerDer = tsaSigner ? reEncode(tsaSigner) : null;
    const directlyTrusted =
      !!tsaSignerDer &&
      anchors.some((d) => {
        try {
          return reEncode(Certificate.fromBER(d)).equals(tsaSignerDer);
        } catch {
          return false;
        }
      });
    if (directlyTrusted) {
      tsaTrustOk = tsaWithinValidity;
    } else if (tsaSigner) {
      try {
        const trustedCerts = anchors.map((d) => Certificate.fromBER(d));
        const tsaCerts = (tstSd.certificates ?? []).filter((c): c is Certificate => c instanceof Certificate);
        const engine = new CertificateChainValidationEngine({ trustedCerts, certs: tsaCerts, checkDate: tstInfo.genTime });
        const chain = await engine.verify();
        const path = (chain.certificatePath ?? []) as Certificate[];
        const leafIsTsa = path.length > 0 && reEncode(path[0]).equals(reEncode(tsaSigner));
        tsaTrustOk = chain.result === true && leafIsTsa && tsaWithinValidity;
      } catch (e) {
        problems.push(`timestamp TSA chain validation error: ${(e as Error).message}`);
      }
    }
    if (!tsaTrustOk) problems.push("timestamp TSA certificate is not trusted");
  }

  out.valid = tokenSigValid && imprintOk && ekuOk && tsaTrustOk;
  if (out.valid && tsaConfigured) out.genTime = tstInfo.genTime;
  return out;
}

/** Verify a B-T signature timestamp (unsigned attr over the SignerInfo signature). */
async function verifyTimestampToken(
  signerInfo: SignerInfo,
  options: VerifyOptions,
  problems: string[]
): Promise<TimestampResult> {
  const result: TimestampResult = { present: false, valid: false, time: null, genTime: null };
  const tsVals = unsignedAttr(signerInfo, OID.SIGNATURE_TIMESTAMP_TOKEN);
  if (!tsVals || !tsVals[0]) return result;
  result.present = true;
  try {
    const tokenCi = new ContentInfo({ schema: tsVals[0] as object });
    const sigBytes = new Uint8Array(signerInfo.signature.valueBlock.valueHexView).slice();
    const r = await verifyRfc3161Token(tokenCi, sigBytes.buffer, options, problems);
    result.valid = r.valid;
    result.time = r.time;
    result.genTime = r.genTime;
  } catch (e) {
    problems.push(`timestamp verification failed: ${(e as Error).message}`);
  }
  return result;
}

/**
 * Verify a B-LTA document timestamp (`/Type /DocTimeStamp`): the RFC 3161 token is
 * over the document ByteRange (`raw.signedContent`). Returns the verdict with
 * `timestamp` populated and `trusted` set to the token's anchored validity.
 */
async function verifyDocumentTimestamp(
  raw: RawSig,
  verdict: SignatureVerdict,
  options: VerifyOptions,
  problems: string[]
): Promise<SignatureVerdict> {
  verdict.timestamp.present = true;
  try {
    const tokenCi = ContentInfo.fromBER(raw.cmsDer);
    const r = await verifyRfc3161Token(tokenCi, new Uint8Array(raw.signedContent).buffer, options, problems);
    verdict.timestamp = { present: true, valid: r.valid, time: r.time };
    verdict.integrity = r.valid;
    // A document timestamp is "trusted" only when its TSA is anchored (genTime set).
    verdict.trusted = r.valid && r.genTime !== null;
    verdict.level = verdict.trusted ? "B-LTA" : "B-B";
    if (!verdict.trusted && r.valid && (options.tsaTrustStore?.length ?? 0) === 0) {
      problems.push("document timestamp is valid but its TSA is not anchored (no tsaTrustStore)");
    }
  } catch (e) {
    problems.push(`document timestamp verification failed: ${(e as Error).message}`);
  }
  return verdict;
}

/** Canonical DER of a certificate (re-encoded so two parses compare equal). */
function reEncode(cert: Certificate): Buffer {
  return Buffer.from(new Uint8Array(cert.toSchema().toBER(false)));
}

function commonName(cert: Certificate): string {
  for (const tv of cert.subject.typesAndValues) {
    if (tv.type === "2.5.4.3") return String(tv.value.valueBlock.value);
  }
  return "";
}

async function verifyOne(
  raw: RawSig,
  index: number,
  options: VerifyOptions,
  dss: DssMaterial | null
): Promise<SignatureVerdict> {
  const problems: string[] = [];
  const verdict: SignatureVerdict = {
    index,
    kind: raw.kind,
    level: "B-B",
    integrity: false,
    coversWholeDocument: raw.coversWholeDocument,
    digestMatches: false,
    signingCertMatches: false,
    trusted: false,
    timestamp: { present: false, valid: false, time: null },
    revocation: { checked: false, status: "not-checked", source: null, asOf: null },
    signerCommonName: "",
    signingTime: null,
    problems,
  };
  const at = options.at ?? new Date();
  if (!raw.structureValid) problems.push("malformed signature ByteRange / Contents");
  if (!raw.structureValid) return verdict;

  // B-LTA document timestamps take a distinct (non-CAdES) verification path.
  if (raw.kind === "document-timestamp") {
    if (!raw.coversWholeDocument) problems.push("document timestamp does not cover the whole document");
    return verifyDocumentTimestamp(raw, verdict, options, problems);
  }
  if (!raw.coversWholeDocument) problems.push("signature does not cover the whole document (content changed after signing)");

  let sd: SignedData;
  let signerInfo: SignerInfo;
  try {
    const ci = ContentInfo.fromBER(raw.cmsDer);
    sd = new SignedData({ schema: ci.content });
    signerInfo = sd.signerInfos[0];
  } catch (e) {
    problems.push(`could not parse CMS: ${(e as Error).message}`);
    return verdict;
  }
  // A structurally-valid SignedData can carry an empty SignerInfos SET; degrade
  // to an invalid verdict instead of dereferencing `undefined` (which would throw
  // out of verifyPdf).
  if (!signerInfo) {
    problems.push("CMS contains no SignerInfo");
    return verdict;
  }

  // Reject weak algorithms (H2). The SignerInfo's own digestAlgorithm is
  // authoritative (not just SignedData.digestAlgorithms); also screen the
  // signature algorithm and require a strong key.
  const digAlgo = signerInfo.digestAlgorithm?.algorithmId ?? sd.digestAlgorithms[0]?.algorithmId ?? "";
  const nodeDigest = digestNameFromOid(digAlgo);
  if (!nodeDigest || WEAK_DIGESTS.has(digAlgo)) {
    problems.push(`weak or unsupported digest algorithm ${digAlgo}`);
    return verdict;
  }
  const sigAlgo = signerInfo.signatureAlgorithm?.algorithmId ?? "";
  if (WEAK_SIGNATURES.has(sigAlgo)) {
    problems.push(`weak signature algorithm ${sigAlgo}`);
    return verdict;
  }

  const signerCert = findSignerCert(sd, signerInfo);
  if (!signerCert) {
    problems.push("no signer certificate in CMS matching the SignerInfo");
    return verdict;
  }
  verdict.signerCommonName = commonName(signerCert);

  // Enforce a minimum RSA key size (H2).
  try {
    const spki = Buffer.from(new Uint8Array(signerCert.subjectPublicKeyInfo.toSchema().toBER(false)));
    const pub = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    if (pub.asymmetricKeyType === "rsa") {
      const bits = pub.asymmetricKeyDetails?.modulusLength ?? 0;
      if (bits < MIN_RSA_BITS) {
        problems.push(`RSA key too small (${bits} bits, minimum ${MIN_RSA_BITS})`);
        return verdict;
      }
    }
  } catch {
    /* key parsing issues surface below as an integrity failure */
  }

  // PAdES-B-T: verify any RFC 3161 signature timestamp. A valid timestamp yields
  // a trusted `genTime` that becomes the effective signing instant — so a seal
  // whose cert has since expired still verifies, and a signer clock cannot be
  // trusted to revive an expired/not-yet-valid cert.
  const ts = await verifyTimestampToken(signerInfo, options, problems);
  verdict.timestamp = { present: ts.present, valid: ts.valid, time: ts.time };
  const effectiveTime = ts.genTime ?? at;

  // Certificate validity window at the EFFECTIVE signing time (H1 + B-T). Only a
  // fully-valid timestamp moves the clock off `at`.
  const notBefore = signerCert.notBefore.value;
  const notAfter = signerCert.notAfter.value;
  const withinValidity = effectiveTime >= notBefore && effectiveTime <= notAfter;
  if (!withinValidity) {
    problems.push(
      ts.genTime
        ? "certificate was not valid at the timestamped signing time"
        : "certificate is not valid at the verification time"
    );
  }

  // CMS signature over the ByteRange content (detached).
  try {
    const dataAb = new Uint8Array(raw.signedContent).buffer; // exact-length ArrayBuffer copy
    const v = await sd.verify({ signer: 0, data: dataAb, extendedMode: true });
    verdict.integrity = typeof v === "boolean" ? v : (v as { signatureVerified?: boolean }).signatureVerified === true;
  } catch (e) {
    problems.push(`CMS verification failed: ${(e as Error).message}`);
  }
  if (!verdict.integrity) problems.push("cryptographic signature is invalid");

  // message-digest signed attr == digest of the ByteRange content.
  const mdVals = attr(signerInfo, OID.MESSAGE_DIGEST);
  if (mdVals && mdVals[0]) {
    const stored = Buffer.from((mdVals[0] as { valueBlock: { valueHexView: Uint8Array } }).valueBlock.valueHexView);
    const actual = crypto.createHash(nodeDigest).update(raw.signedContent).digest();
    verdict.digestMatches = stored.equals(actual);
    if (!verdict.digestMatches) problems.push("message-digest attribute does not match the document");
  } else {
    problems.push("missing message-digest signed attribute");
  }

  // signing-certificate-v2 certHash == digest of the signer cert.
  const scVals = attr(signerInfo, OID.SIGNING_CERTIFICATE_V2);
  if (scVals && scVals[0]) {
    try {
      // SigningCertificateV2 SEQ → certs SEQ → ESSCertIDv2 SEQ.
      const sc = scVals[0] as AsnNode;
      const essCertId = sc.valueBlock.value![0].valueBlock.value![0];
      // ESSCertIDv2 ::= SEQUENCE { hashAlgorithm AlgorithmIdentifier DEFAULT sha256,
      //                            certHash OCTET STRING, issuerSerial ... }
      // The hashAlgorithm is present iff the first element is a SEQUENCE (L3);
      // when omitted the default is SHA-256 and certHash is the first element.
      const first = essCertId.valueBlock.value![0];
      const hasHashAlgo = first.idBlock?.tagNumber === 16; // SEQUENCE ⇒ AlgorithmIdentifier
      const hashNode = hasHashAlgo ? essCertId.valueBlock.value![1] : first;
      let hashName = "sha256";
      if (hasHashAlgo && first.toBER) {
        const algo = AlgorithmIdentifier.fromBER(first.toBER(false));
        const mapped = digestNameFromOid(algo.algorithmId);
        if (mapped) hashName = mapped;
      }
      const certHash = Buffer.from(hashNode.valueBlock.valueHexView!);
      const certDer = Buffer.from(new Uint8Array(signerCert.toSchema().toBER(false)));
      const actual = crypto.createHash(hashName).update(certDer).digest();
      verdict.signingCertMatches = certHash.equals(actual);
      if (!verdict.signingCertMatches) problems.push("signing-certificate-v2 does not match the signer certificate");
    } catch (e) {
      problems.push(`could not read signing-certificate-v2: ${(e as Error).message}`);
    }
  } else {
    problems.push("missing signing-certificate-v2 signed attribute (not PAdES-B-B compliant)");
  }

  // signing-time.
  const stVals = attr(signerInfo, OID.SIGNING_TIME);
  if (stVals && stVals[0]) {
    const t = (stVals[0] as { toDate?: () => Date }).toDate?.();
    if (t) verdict.signingTime = t.toISOString();
  }

  // Trust. Two accepted models:
  //  (a) DIRECT TRUST — the signer certificate is pinned in the trust store
  //      (the platform-seal model: you trust that exact organizational cert).
  //  (b) CHAIN TRUST — the signer certificate chains to a trusted CA root.
  if (options.trustStore && options.trustStore.length > 0) {
    const signerDer = reEncode(signerCert);
    const directlyTrusted = options.trustStore.some((d) => {
      try {
        return reEncode(Certificate.fromBER(d)).equals(signerDer);
      } catch {
        return false;
      }
    });
    // A certificate outside its validity window at time `at` is never trusted (H1).
    if (directlyTrusted && withinValidity) {
      verdict.trusted = true;
    } else if (!directlyTrusted) {
      try {
        const trustedCerts = options.trustStore.map((d) => Certificate.fromBER(d));
        // Pool the CMS certs + DSS-embedded chain material (B-LT), DEDUPED by DER —
        // a duplicate leaf makes pkijs's path builder pick a copy whose bytes still
        // match, but ordering can shift so `leafIsSigner` fails.
        const seenDer = new Set<string>();
        const chainCerts: Certificate[] = [];
        for (const c of [
          ...(sd.certificates ?? []).filter((x): x is Certificate => x instanceof Certificate),
          ...(dss?.certs ?? []),
        ]) {
          const h = reEncode(c).toString("hex");
          if (!seenDer.has(h)) {
            seenDer.add(h);
            chainCerts.push(c);
          }
        }
        // Validate the chain AS-OF the effective signing time (the trusted
        // timestamp genTime when present, else `at`) so an expired-but-timestamped
        // seal still chains, and the leaf's own validity is enforced via
        // `withinValidity`.
        const engine = new CertificateChainValidationEngine({ trustedCerts, certs: chainCerts, checkDate: effectiveTime });
        const chain = await engine.verify();
        // CRITICAL: the validated chain's LEAF must be the certificate that
        // actually signed this SignerInfo — otherwise an attacker who signs with
        // a self-signed key and appends any legitimately-chained cert (ordered so
        // pkijs picks it as the leaf) would be reported trusted. Bind trust to the
        // signer cert.
        const path = (chain.certificatePath ?? []) as Certificate[];
        const leafIsSigner = path.length > 0 && reEncode(path[0]).equals(signerDer);
        verdict.trusted = chain.result === true && withinValidity && leafIsSigner;
        if (!verdict.trusted) {
          problems.push(
            leafIsSigner
              ? `certificate not trusted: ${chain.resultMessage || "chain did not validate"}`
              : "certificate not trusted: the validated chain does not terminate at the signer certificate"
          );
        }
      } catch (e) {
        problems.push(`chain validation error: ${(e as Error).message}`);
      }
    }
  } else {
    problems.push("no trust store configured — signer authenticity cannot be established");
  }

  // PAdES-B-LT: revocation status from the DSS OCSP + CRL material, as-of the
  // trusted signing time. Issuers are resolved from the TRUSTED anchors only. A
  // revocation revokes trust; missing/unusable material leaves the signature
  // trusted on its chain alone (status `unknown`) UNLESS `requireRevocation` demands proof.
  if (dss && (dss.crls.length > 0 || dss.ocsps.length > 0)) {
    const trustedIssuers = (options.trustStore ?? []).map((d) => Certificate.fromBER(d));
    const ocspResult =
      dss.ocsps.length > 0
        ? await ocspRevocationStatus(signerCert, trustedIssuers, dss.ocsps, effectiveTime, problems)
        : { checked: false, status: "unknown" as const, source: null, asOf: null };
    const crlResult =
      dss.crls.length > 0
        ? await crlRevocationStatus(signerCert, trustedIssuers, dss.crls, effectiveTime, problems)
        : { checked: false, status: "unknown" as const, source: null, asOf: null };
    verdict.revocation = combineRevocation(ocspResult, crlResult);
    if (verdict.revocation.status === "revoked") {
      verdict.trusted = false;
      problems.push("signer certificate was revoked at the trusted signing time");
    }
  }
  // Fail-closed mode: only a CONFIRMED-good revocation status is acceptable.
  if (options.requireRevocation && verdict.revocation.status !== "good") {
    verdict.trusted = false;
    problems.push("revocation status could not be confirmed good (requireRevocation)");
  }

  return verdict;
}

/** Parse the DSS (`/Certs`, `/CRLs`) validation material from a PDF, if present.
 *  Returns null when there is no DSS; malformed entries are skipped, not fatal. */
async function parseDss(pdf: Buffer): Promise<DssMaterial | null> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  } catch {
    return null;
  }
  const ctx = doc.context;
  const catRef = ctx.trailerInfo.Root;
  const cat = catRef ? ctx.lookupMaybe(catRef, PDFDict) : undefined;
  if (!cat) return null;
  const dssRef = cat.get(PDFName.of("DSS"));
  const dss = dssRef ? ctx.lookupMaybe(dssRef, PDFDict) : undefined;
  if (!dss) return null;

  const readStreams = (name: string): Uint8Array[] => {
    const arrRef = dss.get(PDFName.of(name));
    const arr = arrRef ? ctx.lookupMaybe(arrRef, PDFArray) : undefined;
    if (!arr) return [];
    const out: Uint8Array[] = [];
    for (let i = 0; i < Math.min(arr.size(), 256); i++) {
      const s = ctx.lookup(arr.get(i)) as PDFRawStream | undefined;
      try {
        if (s instanceof PDFRawStream) out.push(s.getContents());
      } catch {
        /* skip a malformed stream */
      }
    }
    return out;
  };

  const certs: Certificate[] = [];
  for (const d of readStreams("Certs")) {
    try {
      certs.push(Certificate.fromBER(d));
    } catch {
      /* skip */
    }
  }
  const crls: CertificateRevocationList[] = [];
  for (const d of readStreams("CRLs")) {
    try {
      crls.push(CertificateRevocationList.fromBER(d));
    } catch {
      /* skip */
    }
  }
  const ocsps: BasicOCSPResponse[] = [];
  for (const d of readStreams("OCSPs")) {
    try {
      ocsps.push(BasicOCSPResponse.fromBER(d));
    } catch {
      /* skip a malformed / non-Basic OCSP response */
    }
  }
  return { certs, crls, ocsps };
}

/**
 * Revocation status for `signer` from the DSS CRLs, as-of the trusted time `at`.
 * The CRL issuer certificate is taken ONLY from the TRUSTED anchors (`trustedIssuers`)
 * — never an attacker-suppliable DSS cert with a spoofed DN — and the CRL's signature
 * is verified against it. A CRL is usable only if it is signature-valid AND fresh
 * (`thisUpdate <= at <= nextUpdate`, with `nextUpdate` present). Across all usable
 * CRLs a "revoked" hit wins over a "good"; `unknown` when none is usable.
 */
async function crlRevocationStatus(
  signer: Certificate,
  trustedIssuers: Certificate[],
  crls: CertificateRevocationList[],
  at: Date,
  problems: string[]
): Promise<RevocationVerdict> {
  const wantIssuer = derHex(signer.issuer);
  const issuerCert = trustedIssuers.find((c) => derHex(c.subject) === wantIssuer);
  if (!issuerCert) return { checked: false, status: "unknown", source: null, asOf: null };

  let good = false;
  let asOf: string | null = null;
  for (const crl of crls) {
    if (derHex(crl.issuer) !== wantIssuer) continue;
    let sigOk = false;
    try {
      sigOk = await crl.verify({ issuerCertificate: issuerCert });
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      problems.push("DSS CRL signature is invalid");
      continue;
    }
    if (!crl.nextUpdate) {
      problems.push("DSS CRL has no nextUpdate (indeterminate freshness) — ignored");
      continue;
    }
    const thisU = crl.thisUpdate.value;
    if (at < thisU || at > crl.nextUpdate.value) {
      problems.push("DSS CRL is not fresh at the trusted signing time");
      continue;
    }
    if (crl.isCertificateRevoked(signer)) {
      return { checked: true, status: "revoked", source: "crl", asOf: thisU.toISOString() };
    }
    good = true;
    asOf = thisU.toISOString();
  }
  return good ? { checked: true, status: "good", source: "crl", asOf } : { checked: false, status: "unknown", source: null, asOf: null };
}

/**
 * Revocation status for `signer` from the DSS OCSP responses, as-of `at`. The
 * responder signature is verified against the TRUSTED issuer only; the response
 * must be for this cert (CertID match) and fresh. A `revoked` status wins.
 */
async function ocspRevocationStatus(
  signer: Certificate,
  trustedIssuers: Certificate[],
  ocsps: BasicOCSPResponse[],
  at: Date,
  problems: string[]
): Promise<RevocationVerdict> {
  const wantIssuer = derHex(signer.issuer);
  const issuerCert = trustedIssuers.find((c) => derHex(c.subject) === wantIssuer);
  if (!issuerCert) return { checked: false, status: "unknown", source: null, asOf: null };
  const wantSerial = Buffer.from(signer.serialNumber.valueBlock.valueHexView).toString("hex");

  let good = false;
  let asOf: string | null = null;
  for (const basic of ocsps) {
    let sigOk = false;
    try {
      sigOk = await basic.verify({ trustedCerts: [issuerCert] });
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      problems.push("DSS OCSP response signature is invalid");
      continue;
    }
    const single = basic.tbsResponseData.responses.find(
      (r) => Buffer.from(r.certID.serialNumber.valueBlock.valueHexView).toString("hex") === wantSerial
    );
    if (!single) continue;
    if (!single.nextUpdate) {
      problems.push("DSS OCSP response has no nextUpdate (indeterminate freshness) — ignored");
      continue;
    }
    if (at < single.thisUpdate || at > single.nextUpdate) {
      problems.push("DSS OCSP response is not fresh at the trusted signing time");
      continue;
    }
    let st: { isForCertificate: boolean; status: number };
    try {
      st = await basic.getCertificateStatus(signer, issuerCert);
    } catch {
      continue;
    }
    if (!st.isForCertificate) continue;
    if (st.status === 1) return { checked: true, status: "revoked", source: "ocsp", asOf: single.thisUpdate.toISOString() };
    if (st.status === 0) {
      good = true;
      asOf = single.thisUpdate.toISOString();
    }
    // status 2 (unknown) → keep looking
  }
  return good ? { checked: true, status: "good", source: "ocsp", asOf } : { checked: false, status: "unknown", source: null, asOf: null };
}

/** Combine OCSP + CRL results: a `revoked` from either wins; else a `good`
 *  (OCSP preferred as the fresher source); else `unknown`. */
function combineRevocation(a: RevocationVerdict, b: RevocationVerdict): RevocationVerdict {
  if (a.status === "revoked") return a;
  if (b.status === "revoked") return b;
  if (a.status === "good") return a;
  if (b.status === "good") return b;
  return { checked: false, status: "unknown", source: null, asOf: null };
}

const LEVEL_RANK: Record<PadesLevel, number> = { "B-B": 0, "B-T": 1, "B-LT": 2, "B-LTA": 3 };

/** Verify every signature (and document timestamp) in a PDF; produce a verdict. */
export async function verifyPdf(pdfBytes: Uint8Array, options: VerifyOptions = {}): Promise<VerificationResult> {
  ensureEngine();
  const pdf = Buffer.from(pdfBytes);
  const raws = extractSignatures(pdf);
  const dss = await parseDss(pdf);
  const dssPresent = dss !== null;

  // Resolve coverage (relaxed for benign DSS/DocTimeStamp appends) before verifying.
  for (const raw of raws) {
    raw.coversWholeDocument = raw.structureValid && raw.startsAtZero && (await appendsAreBenign(pdf, raw.byteRangeEnd));
  }

  const signatures: SignatureVerdict[] = [];
  for (let i = 0; i < raws.length; i++) {
    signatures.push(await verifyOne(raws[i], i + 1, options, dss));
  }

  // Document timestamp (B-LTA): the newest ANCHORED-TRUSTED, whole-document
  // /DocTimeStamp that covers the DSS. Crypto-validity alone is NOT enough — an
  // un-anchored (self-signed) TSA or a partial-coverage ByteRange must not raise
  // the level (a timestamp attests time, not content).
  const dtsIdx = raws.map((r, i) => ({ r, i })).filter((x) => x.r.kind === "document-timestamp");
  const dssMarker = pdf.lastIndexOf("/DSS");
  let documentTimestamp = { present: false, valid: false, time: null as string | null, coversDss: false };
  let btaCovered = false;
  for (const { r, i } of dtsIdx) {
    const v = signatures[i];
    const coversDss = dssPresent && dssMarker >= 0 && dssMarker < r.byteRangeEnd;
    // `trusted` on a document-timestamp verdict already means anchored (genTime set).
    const dtsQualifies = v.trusted && v.coversWholeDocument && coversDss;
    if (!documentTimestamp.present || (dtsQualifies && !btaCovered)) {
      documentTimestamp = { present: true, valid: v.timestamp.valid, time: v.timestamp.time, coversDss };
    }
    if (dtsQualifies) btaCovered = true;
  }

  // Level of each CAdES signature: B-LTA (anchored DSS-covering doc-timestamp) >
  // B-LT (DSS + valid sig-timestamp) > B-T (sig-timestamp) > B-B.
  for (const s of signatures) {
    if (s.kind !== "signature") continue;
    s.level =
      btaCovered && dssPresent && s.timestamp.valid
        ? "B-LTA"
        : s.timestamp.valid && dssPresent
          ? "B-LT"
          : s.timestamp.valid
            ? "B-T"
            : "B-B";
  }

  // `valid` means AUTHENTIC + INTACT, not merely "some entity verifies" (C1):
  //   - every CAdES signature is cryptographically sound (integrity + digest +
  //     signing-cert binding), AND
  //   - at least one TRUSTED CAdES SIGNATURE covers the WHOLE document.
  // The trust anchor MUST be a signature, not a timestamp — a timestamp attests
  // *time*, not *signer identity*, so a public-TSA document-timestamp over an
  // attacker's self-signed PDF must NOT make it valid.
  const cmsSigs = signatures.filter((s) => s.kind === "signature");
  const valid =
    cmsSigs.length > 0 &&
    cmsSigs.every((s) => s.integrity && s.digestMatches && s.signingCertMatches) &&
    cmsSigs.some((s) => s.trusted && s.coversWholeDocument);

  const level: PadesLevel = valid
    ? cmsSigs.reduce<PadesLevel>((best, s) => (s.trusted && LEVEL_RANK[s.level] > LEVEL_RANK[best] ? s.level : best), "B-B")
    : "B-B";

  return { valid, level, documentTimestamp, signatureCount: signatures.length, signatures };
}
