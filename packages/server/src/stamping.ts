/**
 * Bridges the domain's `Field`s to `finesign-core`'s stamping API and burns a
 * recipient's signature onto a document. Both signing styles funnel through
 * core so page rotation, flattening, and auto-dating are handled once:
 *
 *   - image  → `signWithImage` (image on signature/initials fields, auto-date on
 *              date fields).
 *   - typed  → `signWithTypedNames` for the signature/initials fields, then a
 *              date-only `signWithImage` pass to auto-date (chained on the bytes).
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  SignEngine,
  getPdfInfo,
  type SignatureAnchor,
  type SignaturePlacement,
  type PdfInfo,
} from "finesign-core";
import type { Field, SignatureInput } from "@finesign/domain";

/** 1×1 transparent PNG — used for the date-only pass (no signature drawn). */
const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const STAMPABLE_SIGNATURE = new Set(["signature", "initials"]);

function anchorFromField(f: Field): SignatureAnchor {
  const isDate = f.kind === "date_signed";
  return {
    anchorId: f.id,
    page: f.page,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    kind: isDate ? "date" : "signature",
    label: f.kind,
    source: "manual",
    // Each FineSign date field is an INDEPENDENT full date — never a split
    // MM/DD/YYYY cell — so three on a page don't get fragmented by core's
    // group-of-3 heuristic (K1).
    ...(isDate ? { dateFormat: "full" as const } : {}),
  };
}

/** Displayed page height in points for a 1-based page (accounts for rotation). */
function displayedPageHeightPt(info: PdfInfo, page: number): number {
  const p = info.pages[page - 1];
  if (!p) return 792;
  return p.rotation === 90 || p.rotation === 270 ? p.width : p.height;
}

/** Displayed page width in points for a 1-based page (accounts for rotation). */
function displayedPageWidthPt(info: PdfInfo, page: number): number {
  const p = info.pages[page - 1];
  if (!p) return 612;
  return p.rotation === 90 || p.rotation === 270 ? p.height : p.width;
}

function placementFromField(
  f: Field,
  name: string,
  font: SignaturePlacement["signatureFont"],
  info: PdfInfo
): SignaturePlacement {
  const heightPt = f.height * displayedPageHeightPt(info, f.page);
  // Bound the scale by BOTH the field height and its width, so a long typed name
  // in a narrow field can't overflow horizontally (K6). Estimate rendered width
  // at scale 1 as ~0.5em per character of the 20pt base (script fonts are
  // roughly this wide on average); pick the smaller of the two scale limits.
  const heightScale = heightPt / 20;
  const widthPt = f.width * displayedPageWidthPt(info, f.page);
  const estWidthAtScale1 = Math.max(1, name.length * 20 * 0.5);
  const widthScale = widthPt / estWidthAtScale1;
  const scale = Math.max(0.5, Math.min(2.5, Math.min(heightScale, widthScale)));
  return {
    signatureName: name,
    signatureFont: font,
    pageNumber: f.page,
    xPercent: f.x,
    yPercent: f.y,
    scale,
  };
}

export interface StampSummary {
  signatureCount: number;
  dateCount: number;
  /** Text + checkbox fields stamped. */
  fieldCount: number;
  /** Field kinds that were skipped because they aren't stampable. */
  skipped: string[];
}

/**
 * Draw text values + checkbox marks onto their fields (DG2). Coordinates are the
 * domain's top-left display fractions; here converted to pdf-lib's bottom-left
 * points (correct for unrotated pages — the common case). Text is font-safe:
 * unencodable code points fall back to ASCII so the stamp can never throw.
 */
async function stampTextAndCheckboxes(pdfBytes: Uint8Array, fields: Field[]): Promise<{ bytes: Uint8Array; count: number }> {
  const relevant = fields.filter((f) => (f.kind === "text" && (f.value ?? "") !== "") || (f.kind === "checkbox" && f.value === "true"));
  if (relevant.length === 0) return { bytes: pdfBytes, count: 0 };

  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontSafe = (s: string): string => {
    try {
      font.widthOfTextAtSize(s, 12);
      return s;
    } catch {
      return s.replace(/[^\x20-\x7e]/g, "?");
    }
  };
  const pages = doc.getPages();
  let count = 0;
  for (const f of relevant) {
    const page = pages[f.page - 1];
    if (!page) continue;
    const { width: pw, height: ph } = page.getSize();
    const boxW = f.width * pw;
    const boxH = f.height * ph;
    const leftPt = f.x * pw;
    const topPt = ph - f.y * ph; // box top edge in bottom-left coordinates

    if (f.kind === "checkbox") {
      const glyph = "X";
      const size = Math.max(6, Math.min(boxW, boxH) * 0.85);
      const cx = leftPt + Math.max(0, (boxW - font.widthOfTextAtSize(glyph, size)) / 2);
      const cy = topPt - boxH + Math.max(0, (boxH - size) / 2);
      page.drawText(glyph, { x: cx, y: cy, size, font, color: rgb(0.1, 0.1, 0.1) });
      count++;
      continue;
    }

    // Text: fit the font size to the box height, then shrink/truncate to width.
    let text = fontSafe(f.value ?? "");
    let size = Math.max(5, Math.min(14, boxH * 0.7));
    while (size > 5 && font.widthOfTextAtSize(text, size) > boxW - 4) size -= 0.5;
    while (text.length > 1 && font.widthOfTextAtSize(text, size) > boxW - 4) text = text.slice(0, -1);
    const baseline = topPt - boxH + Math.max(1, (boxH - size) / 2) + size * 0.12;
    page.drawText(text, { x: leftPt + 2, y: baseline, size, font, color: rgb(0.1, 0.1, 0.1) });
    count++;
  }
  return { bytes: await doc.save(), count };
}

/**
 * Stamp one recipient's fields onto `pdfBytes`, returning the new signed bytes.
 * `fields` must already be filtered to this recipient + document.
 */
export async function stampForRecipient(
  engine: SignEngine,
  pdfBytes: Uint8Array,
  fields: Field[],
  signature: SignatureInput
): Promise<{ bytes: Uint8Array; summary: StampSummary }> {
  const dateFields = fields.filter((f) => f.kind === "date_signed");
  const sigFields = fields.filter((f) => STAMPABLE_SIGNATURE.has(f.kind));

  let bytes = pdfBytes;
  let signatureCount = 0;
  let dateCount = 0;

  if (signature.kind === "image") {
    const anchors = [...sigFields, ...dateFields].map(anchorFromField);
    if (anchors.length > 0) {
      const res = await engine.signWithImage(bytes, anchors, signature.dataUrl);
      bytes = res.pdf;
      signatureCount = res.signatureCount;
      dateCount = res.dateCount;
    }
  } else {
    const info = await getPdfInfo(bytes);
    if (sigFields.length > 0) {
      const placements = sigFields.map((f) =>
        placementFromField(f, signature.name, signature.font, info)
      );
      bytes = await engine.signWithTypedNames(bytes, placements);
      signatureCount = sigFields.length;
    }
    if (dateFields.length > 0) {
      const res = await engine.signWithImage(
        bytes,
        dateFields.map(anchorFromField),
        TRANSPARENT_PNG
      );
      bytes = res.pdf;
      dateCount = res.dateCount;
    }
  }

  // Text + checkbox values (DG2).
  const tc = await stampTextAndCheckboxes(bytes, fields);
  bytes = tc.bytes;

  return { bytes, summary: { signatureCount, dateCount, fieldCount: tc.count, skipped: [] } };
}
