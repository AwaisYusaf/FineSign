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
  SignatureImageError,
  UnknownSignatureFontError,
  type SignatureAnchor,
  type SignaturePlacement,
  type PdfInfo,
} from "finesign-core";
import { ValidationError } from "@finesign/shared";
import type { Field, SignatureInput } from "@finesign/domain";
import { encodableText, fieldText, standardHelvetica, typedName, unencodableChars } from "./pdf-text";

/** 1×1 transparent PNG — used for the date-only pass (no signature drawn). */
const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const STAMPABLE_SIGNATURE = new Set(["signature", "initials"]);

/**
 * What a typed signature puts in an initials field: the first letter of each
 * word, upper-cased ("Jane Q. Public" → "JQP"). An initials field holding the
 * full name was both wrong and, in a small box, unreadably shrunk. The signer
 * page previews with the same rule (`packages/web`, SignaturePreview).
 */
export function initialsOf(name: string): string {
  const initials = name
    .trim()
    .split(/\s+/u)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toUpperCase();
  return initials || name;
}

/** "great_vibes" → "Great Vibes", for messages a signer reads. */
function fontLabel(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The offending characters for a message, capped (the input is the signer's). */
const quoteChars = (chars: string[]): string =>
  chars
    .slice(0, 8)
    .map((c) => `"${c}"`)
    .join(", ") + (chars.length > 8 ? `, and ${chars.length - 8} more` : "");

/**
 * Reject signer input that would be stamped wrongly, BEFORE anything is drawn.
 *
 * Both failure modes were silent: a handwriting font draws a character it lacks
 * as an empty box, and the text font (Helvetica, WinAnsi) can't encode non-Latin
 * text at all, so a name in Cyrillic or Chinese came out as boxes or "???" on a
 * legally binding document. Stamping runs before the envelope is saved, so a
 * `ValidationError` here is a clean 400 with nothing persisted.
 */
async function assertStampable(engine: SignEngine, fields: Field[], signature: SignatureInput): Promise<void> {
  if (signature.kind === "typed") {
    const stamped = new Set<string>();
    for (const f of fields) {
      if (f.kind === "signature") stamped.add(signature.name);
      else if (f.kind === "initials") stamped.add(initialsOf(signature.name));
    }
    const missing = [...new Set([...stamped].flatMap((text) => engine.missingGlyphs(signature.font, text)))];
    if (missing.length > 0) {
      throw new ValidationError(
        `The ${fontLabel(signature.font)} signature style can't draw ${quoteChars(missing)}. ` +
          "Choose another style, or draw your signature instead."
      );
    }
  }
  const texts = fields.filter((f) => f.kind === "text" && (f.value ?? "") !== "");
  if (texts.length > 0) {
    const font = await standardHelvetica();
    const bad = [...new Set(texts.flatMap((f) => unencodableChars(fieldText(f.value ?? ""), font)))];
    if (bad.length > 0) {
      throw new ValidationError(
        `A text field contains characters the document can't print: ${quoteChars(bad)}. ` +
          "Text fields support Western European (Latin-1) characters only."
      );
    }
  }
}

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

function placementFromField(
  f: Field,
  name: string,
  font: SignaturePlacement["signatureFont"],
  info: PdfInfo
): SignaturePlacement {
  // Size by the field's height; core then shrinks the name until its MEASURED
  // width fits the field (K6). A per-character estimate let script capitals —
  // initials above all — run well past the box onto the page.
  const heightPt = f.height * displayedPageHeightPt(info, f.page);
  const scale = Math.max(0.5, Math.min(2.5, heightPt / 20));
  return {
    signatureName: name,
    signatureFont: font,
    pageNumber: f.page,
    xPercent: f.x,
    yPercent: f.y,
    scale,
    maxWidthPercent: f.width,
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
 * points (correct for unrotated pages — the common case). `assertStampable`
 * has already rejected text the font can't print; replacing what's left is a
 * guard so the stamp can never throw.
 */
async function stampTextAndCheckboxes(pdfBytes: Uint8Array, fields: Field[]): Promise<{ bytes: Uint8Array; count: number }> {
  const relevant = fields.filter((f) => (f.kind === "text" && (f.value ?? "") !== "") || (f.kind === "checkbox" && f.value === "true"));
  if (relevant.length === 0) return { bytes: pdfBytes, count: 0 };

  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
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
    let text = encodableText(fieldText(f.value ?? ""), font);
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
  try {
    return await stampUnchecked(engine, pdfBytes, fields, signature);
  } catch (e) {
    // The engine is a standalone package and cannot depend on our error types, so
    // it reports bad SIGNER input with its own typed errors. Translate them to a
    // 400 here — the signer's payload is at fault, not the server. Anything else
    // propagates untouched and is still a 500.
    if (e instanceof SignatureImageError || e instanceof UnknownSignatureFontError) {
      throw new ValidationError(e.message);
    }
    throw e;
  }
}

async function stampUnchecked(
  engine: SignEngine,
  pdfBytes: Uint8Array,
  fields: Field[],
  input: SignatureInput
): Promise<{ bytes: Uint8Array; summary: StampSummary }> {
  // Checked and stamped as one normalized line (see `stampableText`): composed
  // accents, no invisible characters, plain spaces only.
  const signature: SignatureInput = input.kind === "typed" ? { ...input, name: typedName(input.name) } : input;
  await assertStampable(engine, fields, signature);
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
        placementFromField(f, f.kind === "initials" ? initialsOf(signature.name) : signature.name, signature.font, info)
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
