/**
 * PAdES sealing (P2): add an ETSI.CAdES.detached signature to a PDF.
 *
 * `@signpdf` owns the byte-exact PDF mechanics — it inserts the signature
 * dictionary via an incremental update, computes the `/ByteRange`, hands us the
 * bytes to sign, and splices our CMS into `/Contents`. We own the cryptography:
 * a custom `Signer` that returns the PAdES CMS from `buildCmsSignedData`.
 */
import { PDFDocument } from "pdf-lib";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { Signer, SUBFILTER_ETSI_CADES_DETACHED } from "@signpdf/utils";
import signpdf from "@signpdf/signpdf";
import { ValidationError } from "@finesign/shared";
import type { SigningCredential, SealOptions } from "./types";
import type { TimestampAuthority } from "./tsa";
import { signatureTimestampAttributes } from "./tsa";
import { buildCmsSignedData } from "./cms";
import { appendIncrementalUpdate } from "./incremental";
import { buildDssRevision } from "./dss";
import { augmentToBLta } from "./doctimestamp";
import type { ValidationDataProvider } from "./validation-data";

/**
 * Extract the raw `/Contents` bytes (INCLUDING the zero padding) of the LAST
 * signature dictionary in a PDF — the value hashed to key the DSS `/VRI`.
 */
export function lastContentsBytes(pdfBytes: Uint8Array): Uint8Array {
  const text = Buffer.from(pdfBytes).toString("latin1");
  const all = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  if (all.length === 0) throw new ValidationError("no signature found to augment to B-LT");
  const g = all[all.length - 1];
  const [a, b, c] = [Number(g[1]), Number(g[2]), Number(g[3])];
  const gap = Buffer.from(pdfBytes.subarray(a + b, c)).toString("latin1");
  const hex = /<([0-9a-fA-F]*)>/.exec(gap)?.[1];
  if (!hex) throw new ValidationError("could not read signature /Contents to key the DSS");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

/**
 * Augment a signed (B-T) PDF to PAdES-B-LT by appending a DSS revision holding the
 * validation material (certs + CRLs/OCSP) from `provider`. Append-only: the prior
 * bytes — and the existing signature's ByteRange digest — are preserved.
 */
export async function augmentToBLt(
  signedPdf: Uint8Array,
  credential: SigningCredential,
  provider: ValidationDataProvider
): Promise<Uint8Array> {
  const vd = await provider.collect(credential.certificate(), credential.chain());
  const contents = lastContentsBytes(signedPdf);
  const doc = await PDFDocument.load(signedPdf, { ignoreEncryption: true });
  const { changed } = buildDssRevision(doc, vd, contents);
  return appendIncrementalUpdate(signedPdf, doc.context, changed);
}

/** A `@signpdf` signer that produces a PAdES CMS via our credential. When a TSA
 *  is supplied, the CMS carries an RFC 3161 signature timestamp (PAdES-B-T). */
class PadesSigner extends Signer {
  constructor(
    private readonly credential: SigningCredential,
    private readonly signingTime: Date,
    private readonly tsa?: TimestampAuthority
  ) {
    super();
  }

  async sign(content: Buffer): Promise<Buffer> {
    const tsa = this.tsa;
    const cms = await buildCmsSignedData({
      content: new Uint8Array(content),
      credential: this.credential,
      signingTime: this.signingTime,
      ...(tsa ? { timestamp: (sig: Uint8Array) => signatureTimestampAttributes(tsa, sig) } : {}),
    });
    return Buffer.from(cms);
  }
}

/** The baseline seal (B-B, or B-T with a signature timestamp). B-LT/B-LTA build
 *  on a B-T seal via `augmentToBLt`/`augmentToBLta`. */
async function sealBaseline(
  pdfBytes: Uint8Array,
  credential: SigningCredential,
  options: SealOptions,
  timestamped: boolean
): Promise<Uint8Array> {
  const signingTime = options.signingTime ?? new Date();
  const tsa = timestamped ? options.timestampAuthority : undefined;

  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  pdflibAddPlaceholder({
    pdfDoc,
    reason: options.reason ?? "Document completed and sealed by FineSign",
    contactInfo: "",
    name: options.name ?? credential.subjectCommonName(),
    location: options.location ?? "",
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    // A B-T token adds a few KB — reserve more of the /Contents hole by default.
    signatureLength: options.signatureLength ?? (timestamped ? 32768 : 16384),
  });
  const withPlaceholder = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  const signed = await signpdf.sign(withPlaceholder, new PadesSigner(credential, signingTime, tsa));
  return new Uint8Array(signed);
}

/**
 * Seal a PDF to the requested PAdES level (default B-B). Each level builds on the
 * previous: B-T adds a signature timestamp; B-LT appends the DSS validation
 * material; B-LTA appends a document timestamp. B-T/B-LT/B-LTA require a
 * `timestampAuthority`; B-LT/B-LTA also require a `validationDataProvider`. The
 * signature covers the whole file, and each augmentation is an append-only
 * incremental update that preserves the signed bytes.
 */
export async function sealPdf(
  pdfBytes: Uint8Array,
  credential: SigningCredential,
  options: SealOptions = {}
): Promise<Uint8Array> {
  const level = options.level ?? "B-B";
  const needsTsa = level !== "B-B";
  if (needsTsa && !options.timestampAuthority) {
    throw new ValidationError(`PAdES level "${level}" requires a timestampAuthority`);
  }
  if ((level === "B-LT" || level === "B-LTA") && !options.validationDataProvider) {
    throw new ValidationError(`PAdES level "${level}" requires a validationDataProvider`);
  }

  let out = await sealBaseline(pdfBytes, credential, options, needsTsa);
  if (level === "B-B" || level === "B-T") return out;

  out = await augmentToBLt(out, credential, options.validationDataProvider!);
  if (level === "B-LT") return out;

  return augmentToBLta(out, options.timestampAuthority!, { hashAlgo: credential.digestAlgorithm() });
}
