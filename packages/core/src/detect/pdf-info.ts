/**
 * Read structural info from a PDF: page count and per-page size + rotation.
 * Useful for validating field placements and for UIs that render pages.
 */
import { PDFDocument } from "pdf-lib";
import { isPdfBuffer } from "../engine/pdf-guards";
import { NotAPdfError } from "../engine/sign";

export interface PdfPageInfo {
  /** 1-indexed page number. */
  page: number;
  /** Raw (unrotated) page size in PDF points. */
  width: number;
  height: number;
  /** Normalised /Rotate in {0,90,180,270}. */
  rotation: number;
}

export interface PdfInfo {
  pageCount: number;
  pages: PdfPageInfo[];
}

/** Probe a PDF's page count + geometry. Throws `NotAPdfError` for non-PDF bytes. */
export async function getPdfInfo(pdfBytes: Uint8Array): Promise<PdfInfo> {
  if (!isPdfBuffer(pdfBytes)) throw new NotAPdfError();
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages().map((p, i) => {
    const { width, height } = p.getSize();
    const rotation = ((p.getRotation().angle % 360) + 360) % 360;
    return { page: i + 1, width, height, rotation };
  });
  return { pageCount: pages.length, pages };
}
