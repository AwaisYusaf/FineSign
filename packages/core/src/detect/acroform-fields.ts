/**
 * Generic "sign here" detection straight from a PDF's AcroForm — no AI, no
 * external services. This is the DocuSign "auto-detect signature fields"
 * capability, done deterministically:
 *
 *   - every `/Sig` (signature) widget becomes a `signature` anchor;
 *   - every text/date field whose name looks like a signer signature or a
 *     "date signed" (via `field-heuristics`) becomes a `signature`/`date` anchor.
 *
 * It reads each widget's `/Rect` and the page geometry (`MediaBox` + `/Rotate`)
 * and converts to display-space anchors with the same coordinate math the
 * stamping engine uses — so a detected anchor round-trips to exactly where the
 * mark lands.
 *
 * Forms without an AcroForm (flat scans, or signature LINES with no field) yield
 * nothing — detect those with OCR/vision upstream and pass anchors in manually.
 */

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFNumber,
  PDFString,
  PDFHexString,
} from "pdf-lib";
import type { PointBox, SignatureAnchor, SignatureFieldKind } from "../types";
import { schemaFieldToDisplayBox } from "../geometry/coordinates";
import { isSignerSignatureField, isSignerDateField } from "./field-heuristics";
import { newAnchorId } from "../engine/sign";

/** A signature/date field found in the PDF, before display-space conversion. */
export interface DetectedField {
  /** Fully-qualified field name (parent chain joined by "."). */
  name: string;
  /** 1-indexed page. */
  page: number;
  /** AcroForm field type: Sig | Tx | Btn | Ch | unknown. */
  fieldType: "Sig" | "Tx" | "Btn" | "Ch" | "unknown";
  /** Why it was selected. */
  kind: SignatureFieldKind;
  /** Raw point-space box (top-left origin, unrotated frame). */
  position: PointBox;
}

export interface DetectOptions {
  /** Include `/Sig` widgets. Default true. */
  includeSignatureWidgets?: boolean;
  /** Include text fields whose NAME matches signer-signature/date heuristics.
   *  Default true. Set false to trust only real `/Sig` widgets. */
  includeNamedFields?: boolean;
}

function readName(dict: PDFDict): string | null {
  const t = dict.get(PDFName.of("T"));
  if (t instanceof PDFString || t instanceof PDFHexString) return t.decodeText();
  return null;
}

/** Walk /Parent to build the fully-qualified name and resolve the field type. */
function resolveField(
  doc: PDFDocument,
  widget: PDFDict
): { name: string; fieldType: DetectedField["fieldType"] } {
  const parts: string[] = [];
  let ft: DetectedField["fieldType"] = "unknown";
  let node: PDFDict | undefined = widget;
  const seen = new Set<PDFDict>();

  while (node && !seen.has(node)) {
    seen.add(node);
    const name = readName(node);
    if (name) parts.unshift(name);
    const ftName = node.get(PDFName.of("FT"));
    if (ft === "unknown" && ftName instanceof PDFName) {
      const v = ftName.toString();
      if (v === "/Sig") ft = "Sig";
      else if (v === "/Tx") ft = "Tx";
      else if (v === "/Btn") ft = "Btn";
      else if (v === "/Ch") ft = "Ch";
    }
    const parentRef = node.get(PDFName.of("Parent"));
    const parent: unknown = parentRef ? doc.context.lookup(parentRef) : undefined;
    node = parent instanceof PDFDict ? parent : undefined;
  }

  return { name: parts.join("."), fieldType: ft };
}

function readRect(widget: PDFDict): [number, number, number, number] | null {
  const rectRef = widget.get(PDFName.of("Rect"));
  const rect = rectRef ? (rectRef as PDFArray) : null;
  if (!(rect instanceof PDFArray) || rect.size() < 4) return null;
  const nums = [0, 1, 2, 3].map((i) => {
    const n = rect.get(i);
    return n instanceof PDFNumber ? n.asNumber() : NaN;
  });
  if (nums.some((n) => Number.isNaN(n))) return null;
  return nums as [number, number, number, number];
}

/**
 * Find every signature/date field in the PDF and return them as raw detected
 * fields (with point-space boxes). Lower-level than `detectAnchorsFromAcroForm`;
 * use it if you want to build your own review UI before converting to anchors.
 */
export async function detectFields(
  pdfBytes: Uint8Array,
  options: DetectOptions = {}
): Promise<DetectedField[]> {
  const includeSig = options.includeSignatureWidgets ?? true;
  const includeNamed = options.includeNamedFields ?? true;

  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  const found: DetectedField[] = [];

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const { height: pageH } = page.getSize();
    const annotsRef = page.node.get(PDFName.of("Annots"));
    const annots = annotsRef ? doc.context.lookup(annotsRef) : null;
    if (!(annots instanceof PDFArray)) continue;

    for (let i = 0; i < annots.size(); i++) {
      const annot = doc.context.lookup(annots.get(i));
      if (!(annot instanceof PDFDict)) continue;
      if (annot.get(PDFName.of("Subtype"))?.toString() !== "/Widget") continue;

      const rect = readRect(annot);
      if (!rect) continue;
      const { name, fieldType } = resolveField(doc, annot);

      let kind: SignatureFieldKind | null = null;
      if (fieldType === "Sig") {
        if (includeSig) kind = "signature";
      } else if (includeNamed && name) {
        if (isSignerDateField(name)) kind = "date";
        else if (isSignerSignatureField(name)) kind = "signature";
      }
      if (!kind) continue;

      // /Rect is bottom-left origin PDF user space → convert to a top-left
      // origin, unrotated-frame PointBox for the shared geometry.
      const [x1, y1, x2, y2] = rect;
      const xMin = Math.min(x1, x2);
      const yMax = Math.max(y1, y2);
      const w = Math.abs(x2 - x1);
      const h = Math.abs(y2 - y1);
      const position: PointBox = { x: xMin, y: pageH - yMax, w, h };

      found.push({ name: name || "(unnamed)", page: pageIndex + 1, fieldType, kind, position });
    }
  }

  return found;
}

/**
 * Detect signature/date fields and return them as ready-to-stamp
 * `SignatureAnchor[]` (display-space, top-left origin) — feed straight into
 * `SignEngine.signWithImage`. Returns `[]` for a form with no matching fields.
 */
export async function detectAnchorsFromAcroForm(
  pdfBytes: Uint8Array,
  options: DetectOptions = {}
): Promise<SignatureAnchor[]> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  const fields = await detectFields(pdfBytes, options);

  const anchors: SignatureAnchor[] = [];
  for (const f of fields) {
    const page = pages[f.page - 1];
    if (!page) continue;
    const { width, height } = page.getSize();
    const rotation = page.getRotation().angle;
    const box = schemaFieldToDisplayBox(f.position, width, height, rotation);
    anchors.push({
      anchorId: newAnchorId(),
      page: f.page,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      kind: f.kind,
      label: f.name,
      source: "acroform",
    });
  }
  return anchors;
}
