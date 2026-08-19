/**
 * CMS SignedData construction for PAdES-B-B (RFC 5652 + RFC 5035), P2.
 *
 * Builds a DETACHED CMS over the document ByteRange with the four mandatory
 * signed attributes — content-type, message-digest, signing-time, and
 * **signing-certificate-v2** (ESS, binds the signature to a specific cert) — and
 * signs the DER-encoded SET OF signed attributes via the credential's `sign(tbs)`
 * (so the raw key stays in the credential; HSM/KMS-ready).
 */
import crypto from "crypto";
import * as asn1js from "asn1js";
import {
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
import type { SigningCredential } from "./types";
import { OID, digestOid, ecdsaOid, nodeDigestName, type DigestAlgorithm } from "./oids";
import { ensureEngine } from "./engine";

/** DER SET OF ordering: compare octet strings; on a shared prefix the shorter
 *  sorts first (X.690 §11.6). Shared with the RFC 3161 TSA builder so the SET OF
 *  ordering never diverges between the document signature and the timestamp. */
export function derLess(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** Concatenate the value octets of an OCTET STRING, handling the CONSTRUCTED
 *  (chunked) encoding pkijs uses for CMS encapsulated content — where the bytes
 *  live in nested primitive chunks and the outer `valueHexView` is empty. Typed
 *  loosely because pkijs's `ValueBlock` does not expose these fields publicly. */
export function octetStringValue(os: unknown): Uint8Array {
  type Chunked = { valueBlock?: { valueHexView?: Uint8Array; value?: Chunked[] } };
  const valueBlock = (os as Chunked).valueBlock;
  const chunks = valueBlock?.value;
  if (chunks && chunks.length > 0) {
    const parts = chunks.map((c) => new Uint8Array(c.valueBlock?.valueHexView ?? new Uint8Array()));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }
  return new Uint8Array(valueBlock?.valueHexView ?? new Uint8Array());
}

/** Build the ESS signing-certificate-v2 attribute value (RFC 5035). Shared with
 *  the RFC 3161 TSA builder so the ESS binding is constructed identically. */
export function signingCertificateV2(certDer: Uint8Array, cert: Certificate): asn1js.Sequence {
  // SHA-256 is the DEFAULT hashAlgorithm, so it is omitted (X.690 DEFAULT rule).
  const certHash = crypto.createHash("sha256").update(Buffer.from(certDer)).digest();
  // GeneralName: directoryName [4] EXPLICIT Name (the issuer DN).
  const issuerName = new asn1js.Constructed({
    idBlock: { tagClass: 3, tagNumber: 4 },
    value: [cert.issuer.toSchema()],
  });
  const issuerSerial = new asn1js.Sequence({
    value: [new asn1js.Sequence({ value: [issuerName] }), cert.serialNumber],
  });
  const essCertIdV2 = new asn1js.Sequence({
    value: [new asn1js.OctetString({ valueHex: certHash }), issuerSerial],
  });
  // SigningCertificateV2 ::= SEQUENCE { certs SEQUENCE OF ESSCertIDv2 }
  return new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertIdV2] })] });
}

export interface BuildCmsParams {
  /** The detached content (the PDF ByteRange bytes). */
  content: Uint8Array;
  credential: SigningCredential;
  signingTime: Date;
  /** Extra unsigned attributes supplied by the caller BEFORE signing (rare). */
  unsignedAttributes?: Attribute[];
  /**
   * PAdES-B-T hook. Runs AFTER the signature exists and receives the raw
   * SignerInfo signature value octets, returning unsigned attributes to attach
   * (an `id-aa-signatureTimeStampToken`). Because the timestamp imprint is over
   * the signature bytes, it cannot be supplied via `unsignedAttributes` (which
   * the caller builds before the signature exists) — see docs/design.
   */
  timestamp?: (signatureValue: Uint8Array) => Promise<Attribute[]>;
}

/**
 * Build a detached CMS SignedData (DER) for PAdES over `content`. Returns the DER
 * bytes to splice into the PDF `/Contents`.
 */
export async function buildCmsSignedData(params: BuildCmsParams): Promise<Uint8Array> {
  ensureEngine(); // the B-T timestamp path uses PKIjs async crypto helpers
  const { content, credential, signingTime } = params;
  const digest: DigestAlgorithm = credential.digestAlgorithm();
  const certDer = credential.certificate();
  const cert = Certificate.fromBER(certDer);
  const chain = credential.chain().map((d) => Certificate.fromBER(d));

  const messageDigest = crypto.createHash(nodeDigestName(digest)).update(Buffer.from(content)).digest();

  // signing-time: CMS `Time` CHOICE — UTCTime before 2050, GeneralizedTime after
  // (RFC 5652); UTCTime's 2-digit year is ambiguous past 2049.
  const timeValue =
    signingTime.getUTCFullYear() >= 2050
      ? new asn1js.GeneralizedTime({ valueDate: signingTime })
      : new asn1js.UTCTime({ valueDate: signingTime });

  // The four PAdES-B-B mandatory signed attributes.
  const attributes: Attribute[] = [
    new Attribute({ type: OID.CONTENT_TYPE, values: [new asn1js.ObjectIdentifier({ value: OID.DATA })] }),
    new Attribute({ type: OID.SIGNING_TIME, values: [timeValue] }),
    new Attribute({ type: OID.MESSAGE_DIGEST, values: [new asn1js.OctetString({ valueHex: messageDigest })] }),
    new Attribute({ type: OID.SIGNING_CERTIFICATE_V2, values: [signingCertificateV2(certDer, cert)] }),
  ];

  // DER SET OF ordering (X.690 §11.6): the attributes are stored in this exact
  // order in the SignerInfo, so a strict validator that re-encodes/re-sorts the
  // signed attributes reproduces the same octets we sign.
  const sorted = attributes
    .map((a) => ({ a, enc: new Uint8Array(a.toSchema().toBER(false)) }))
    .sort((x, y) => derLess(x.enc, y.enc))
    .map((x) => x.a);

  // The signature is computed over the DER of the signed attributes with the
  // IMPLICIT [0] tag replaced by an EXPLICIT SET OF tag (RFC 5652 §5.4). We derive
  // the to-be-signed bytes from the SAME `SignedAndUnsignedAttributes` object we
  // store, guaranteeing the signed bytes equal the stored attributes re-tagged
  // (byte 0: 0xA0 → 0x31). This is what OpenSSL/Adobe/DSS reconstruct to verify.
  const signedAttrs = new SignedAndUnsignedAttributes({ type: 0, attributes: sorted });
  const tbs = new Uint8Array(signedAttrs.toSchema().toBER(false));
  tbs[0] = 0x31; // [0] IMPLICIT (0xA0) → universal SET OF (0x31)
  const signature = await credential.sign(tbs);

  // Assemble the unsigned attributes: any caller-supplied ones plus, for B-T, the
  // signature timestamp computed over the signature value we just produced.
  let unsignedAttributes: Attribute[] = params.unsignedAttributes ? [...params.unsignedAttributes] : [];
  if (params.timestamp) {
    unsignedAttributes = [...unsignedAttributes, ...(await params.timestamp(signature))];
  }

  const isEc = credential.signatureScheme() === "ECDSA";
  const signerInfo = new SignerInfo({
    version: 1,
    sid: new IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
    digestAlgorithm: new AlgorithmIdentifier({ algorithmId: digestOid(digest) }),
    signedAttrs,
    signatureAlgorithm: new AlgorithmIdentifier({
      // EC: the OID encodes the digest, so it must match `digest` (M2).
      // RSA: rsaEncryption + NULL params, digest conveyed by digestAlgorithm.
      algorithmId: isEc ? ecdsaOid(digest) : OID.RSA_ENCRYPTION,
      ...(isEc ? {} : { algorithmParams: new asn1js.Null() }),
    }),
    signature: new asn1js.OctetString({ valueHex: signature }),
    ...(unsignedAttributes.length > 0
      ? { unsignedAttrs: new SignedAndUnsignedAttributes({ type: 1, attributes: unsignedAttributes }) }
      : {}),
  });

  const signedData = new SignedData({
    version: 1,
    digestAlgorithms: [new AlgorithmIdentifier({ algorithmId: digestOid(digest) })],
    encapContentInfo: new EncapsulatedContentInfo({ eContentType: OID.DATA }), // detached
    certificates: [cert, ...chain],
    signerInfos: [signerInfo],
  });

  const cms = new ContentInfo({ contentType: OID.SIGNED_DATA, content: signedData.toSchema(true) });
  return new Uint8Array(cms.toSchema().toBER(false));
}
