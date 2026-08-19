/**
 * The high-level signing engine — the library's crown jewel.
 *
 * Pure bytes-in / bytes-out: give it an unsigned PDF plus either typed-name
 * placements or a captured signature image + anchors, and it returns the signed
 * PDF bytes (and, for image signing, an audit of what was stamped where). It
 * touches NO database, storage, auth, or network — persistence is the caller's
 * job. That boundary is exactly what makes it reusable.
 *
 * Both modes always re-sign from the ORIGINAL PDF you pass — signing never
 * chains on a previously-signed copy, so it is idempotent to re-run.
 */

import { PDFDocument, PDFFont, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type {
  SignaturePlacement,
  SignatureAnchor,
  StampedAnchor,
  SignatureImage,
} from "../types";
import { isPdfBuffer } from "./pdf-guards";
import { flattenForStamping } from "./flatten";
import { buildDateValues } from "./dates";
import {
  stampTypedName,
  stampImageAnchor,
  stampDateAnchor,
  isPageInRange,
} from "./stamp";
import { FontRegistry, defaultFontRegistry } from "./fonts";
import {
  decodeSignatureImage,
  trimSignatureImage,
  assertImageDecodable,
  SignatureImageError,
} from "./image";

let anchorCounter = 0;
/** Small dependency-free unique id (crypto.randomUUID would also work; kept
 *  local so the engine has no Node-crypto requirement). */
function uid(prefix: string): string {
  anchorCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${anchorCounter.toString(36)}`;
}

export class NotAPdfError extends Error {
  constructor() {
    super("input is not a PDF (missing %PDF- header)");
    this.name = "NotAPdfError";
  }
}

export interface SignEngineOptions {
  /** Font registry for typed-name signatures. Defaults to the bundled fonts. */
  fontRegistry?: FontRegistry;
  /** Clock used for auto-dates + audit timestamps. Defaults to `new Date()`.
   *  Inject a fixed clock in tests for deterministic output. */
  now?: () => Date;
}

export interface SignWithImageResult {
  /** The signed PDF bytes. */
  pdf: Uint8Array;
  /** One record per anchor actually stamped (image marks + dates). */
  stamped: StampedAnchor[];
  /** Number of `signature` anchors stamped. */
  signatureCount: number;
  /** Number of `date` anchors stamped. */
  dateCount: number;
}

export class SignEngine {
  private readonly fonts: FontRegistry;
  private readonly now: () => Date;

  constructor(options: SignEngineOptions = {}) {
    this.fonts = options.fontRegistry ?? defaultFontRegistry;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * TYPED-NAME signing: render one or more scripted-font names onto the PDF.
   * Returns the signed bytes. Throws `NotAPdfError` for non-PDF input and
   * `RangeError` if any placement targets a page outside the document.
   */
  async signWithTypedNames(
    pdfBytes: Uint8Array,
    placements: SignaturePlacement[]
  ): Promise<Uint8Array> {
    if (!isPdfBuffer(pdfBytes)) throw new NotAPdfError();

    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    pdfDoc.registerFontkit(fontkit);
    await flattenForStamping(pdfDoc);

    const totalPages = pdfDoc.getPageCount();
    for (const p of placements) {
      if (p.pageNumber < 1 || p.pageNumber > totalPages) {
        throw new RangeError(
          `placement targets page ${p.pageNumber}, document has ${totalPages} pages`
        );
      }
    }

    const embedded = new Map<string, PDFFont>();
    for (const placement of placements) {
      let font = embedded.get(placement.signatureFont);
      if (!font) {
        font = await pdfDoc.embedFont(this.fonts.getBytes(placement.signatureFont));
        embedded.set(placement.signatureFont, font);
      }
      const page = pdfDoc.getPage(placement.pageNumber - 1);
      stampTypedName(page, {
        name: placement.signatureName,
        xPercent: placement.xPercent,
        yPercent: placement.yPercent,
        scale: placement.scale,
        font,
      });
    }

    return pdfDoc.save();
  }

  /**
   * IMAGE signing: stamp ONE captured signature image onto every `signature`
   * anchor and today's date onto every `date` anchor. The image may be a base64
   * data URL, bare base64, or an already-decoded `SignatureImage`; it is
   * validated and ink-trimmed before embedding.
   *
   * Anchors whose page is out of range are skipped (a document re-generated with
   * fewer pages won't crash a stamp). Throws `NotAPdfError` for non-PDF input,
   * `SignatureImageError` for a bad image, and `Error("no anchors provided")`
   * when `anchors` is empty.
   */
  async signWithImage(
    pdfBytes: Uint8Array,
    anchors: SignatureAnchor[],
    image: string | SignatureImage
  ): Promise<SignWithImageResult> {
    if (anchors.length === 0) throw new Error("no anchors provided");
    if (!isPdfBuffer(pdfBytes)) throw new NotAPdfError();

    const decoded = typeof image === "string" ? decodeSignatureImage(image) : image;
    if (decoded.format !== "png" && decoded.format !== "jpeg") {
      throw new SignatureImageError("signature image must be a PNG or JPEG");
    }
    const trimmed = await trimSignatureImage(decoded);
    // Guard the EMBED decode too — trimming returns original bytes for oversized
    // images, so a decompression bomb would otherwise OOM at embedPng/embedJpg.
    assertImageDecodable(trimmed);

    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    pdfDoc.registerFontkit(fontkit);
    await flattenForStamping(pdfDoc);

    const embeddedImage =
      trimmed.format === "png"
        ? await pdfDoc.embedPng(trimmed.bytes)
        : await pdfDoc.embedJpg(trimmed.bytes);
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const totalPages = pdfDoc.getPageCount();
    const now = this.now();

    const dateValues = buildDateValues(
      anchors.filter((a) => a.kind === "date"),
      now
    );

    const stamped: StampedAnchor[] = [];
    for (const anchor of anchors) {
      if (!isPageInRange(anchor, totalPages)) continue;
      const page = pdfDoc.getPage(anchor.page - 1);

      if (anchor.kind === "date") {
        const value = dateValues.get(anchor.anchorId) ?? "";
        if (value) stampDateAnchor(page, anchor, value, helvetica);
        stamped.push({
          anchorId: anchor.anchorId,
          page: anchor.page,
          kind: "date",
          label: anchor.label,
          value: value || null,
          signedAt: now.toISOString(),
        });
      } else {
        stampImageAnchor(page, embeddedImage, anchor);
        stamped.push({
          anchorId: anchor.anchorId,
          page: anchor.page,
          kind: "signature",
          label: anchor.label,
          value: null,
          signedAt: now.toISOString(),
        });
      }
    }

    const pdf = await pdfDoc.save();
    return {
      pdf,
      stamped,
      signatureCount: stamped.filter((s) => s.kind === "signature").length,
      dateCount: stamped.filter((s) => s.kind === "date").length,
    };
  }
}

/** Mint a `SignatureAnchor` id if the caller doesn't supply one. */
export function newAnchorId(): string {
  return uid("anchor");
}
