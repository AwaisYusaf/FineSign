/**
 * PAdES-B-LTA document timestamp (`/Type /DocTimeStamp`, `/SubFilter /ETSI.RFC3161`).
 *
 * A document timestamp is an RFC 3161 token over the WHOLE current file (the DSS
 * included), appended as its own incremental revision. It protects the long-term
 * validation material and lets a chain of timestamps carry a signature's validity
 * across decades. Unlike a B-T signature timestamp (which is over the SignerInfo
 * signature value and lives inside the CMS), this is a top-level signature dict
 * whose `/Contents` is the bare RFC 3161 token over the document ByteRange.
 *
 * We hand-write the placeholder revision (pdf-lib's/`@signpdf`'s helpers hardcode
 * `/Type /Sig` + an AcroForm field), then reuse `@signpdf`'s placeholder-agnostic
 * splice to compute the ByteRange, hash it, timestamp it, and fill `/Contents`.
 */
import crypto from "crypto";
import { PDFDocument, PDFName, PDFNumber, PDFHexString } from "pdf-lib";
import { Signer } from "@signpdf/utils";
import signpdf from "@signpdf/signpdf";
import { appendIncrementalUpdate } from "./incremental";
import type { TimestampAuthority } from "./tsa";
import { nodeDigestName, type DigestAlgorithm } from "./oids";

const BYTE_RANGE_PLACEHOLDER = "**********";

/** A `@signpdf` signer that returns an RFC 3161 token over the document ByteRange
 *  (imprint over the DOCUMENT, not a signature value). */
class DocTimeStampSigner extends Signer {
  constructor(
    private readonly tsa: TimestampAuthority,
    private readonly hashAlgo: DigestAlgorithm
  ) {
    super();
  }
  async sign(content: Buffer): Promise<Buffer> {
    const imprint = crypto.createHash(nodeDigestName(this.hashAlgo)).update(content).digest();
    const tokenDer = await this.tsa.stamp(new Uint8Array(imprint), this.hashAlgo);
    return Buffer.from(tokenDer); // the bare RFC 3161 ContentInfo, verbatim into /Contents
  }
}

export interface DocTimeStampOptions {
  /** Bytes reserved in /Contents for the token. Default 32768. */
  signatureLength?: number;
  /** Imprint hash algorithm. Default SHA-256. */
  hashAlgo?: DigestAlgorithm;
}

/**
 * Append a document timestamp to a (B-LT) PDF, producing PAdES-B-LTA. Append-only:
 * the prior bytes — the signature, its timestamp, and the DSS — are preserved.
 */
export async function augmentToBLta(
  pdfBytes: Uint8Array,
  tsa: TimestampAuthority,
  options: DocTimeStampOptions = {}
): Promise<Uint8Array> {
  const signatureLength = options.signatureLength ?? 32768;
  const hashAlgo = options.hashAlgo ?? "SHA-256";

  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const ctx = doc.context;

  // The placeholder dict: /ByteRange MUST precede /Contents (insertion order), and
  // the ByteRange is the `[0 /********** /********** /**********]` form @signpdf
  // recognises. No AcroForm field — recognised via /Type /DocTimeStamp.
  const byteRange = ctx.obj([
    PDFNumber.of(0),
    PDFName.of(BYTE_RANGE_PLACEHOLDER),
    PDFName.of(BYTE_RANGE_PLACEHOLDER),
    PDFName.of(BYTE_RANGE_PLACEHOLDER),
  ]);
  const contents = PDFHexString.of("00".repeat(signatureLength));
  const dtsDict = ctx.obj({
    Type: "DocTimeStamp",
    Filter: "Adobe.PPKLite",
    SubFilter: "ETSI.RFC3161",
    ByteRange: byteRange,
    Contents: contents,
  });
  const dtsRef = ctx.register(dtsDict);

  const withPlaceholder = appendIncrementalUpdate(pdfBytes, ctx, [{ ref: dtsRef, obj: dtsDict }]);
  const signed = await signpdf.sign(Buffer.from(withPlaceholder), new DocTimeStampSigner(tsa, hashAlgo));
  return new Uint8Array(signed);
}
