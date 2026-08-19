/**
 * De-interactivate all AcroForm fields so drawn content (a stamped signature or
 * date) is visible ABOVE them.
 *
 * Why this is necessary: PDF viewers render widget annotations (form fields) on
 * top of page content. If we merely `drawImage`/`drawText` over a form, an
 * interactive field can still paint over our signature. So before stamping we:
 *   1. generate each field's appearance stream, then `form.flatten()` it to
 *      static content;
 *   2. sweep every remaining `/Widget` annotation off each page (nuclear
 *      fallback for fields flatten couldn't handle);
 *   3. drop `/AcroForm` from the catalog entirely.
 *
 * Mutates `pdfDoc` in place; never throws (a malformed form must not abort a
 * sign). Overlay-based by design — we never write into a `/Sig` widget.
 */

import { PDFDocument, StandardFonts, PDFName, PDFDict, PDFArray } from "pdf-lib";

export async function flattenForStamping(pdfDoc: PDFDocument): Promise<void> {
  // 1. Per-field appearance generation, then flatten.
  try {
    const form = pdfDoc.getForm();
    const helperFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    for (const field of form.getFields()) {
      try {
        (field as unknown as { updateAppearances?: (f: unknown) => void }).updateAppearances?.(
          helperFont
        );
      } catch {
        // Field-level failure — the nuclear sweep below handles it.
      }
    }
    try {
      form.flatten();
    } catch {
      // flatten() may throw on partially-invalid PDFs; sweep handles it.
    }
  } catch {
    // getForm() throws when there is no AcroForm — skip to the sweep.
  }

  // 2. Nuclear /Widget sweep — remove every remaining widget annotation.
  for (const page of pdfDoc.getPages()) {
    const annotsRef = page.node.get(PDFName.of("Annots"));
    if (!annotsRef) continue;
    const annots = pdfDoc.context.lookup(annotsRef);
    if (!(annots instanceof PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      try {
        const annotObj = pdfDoc.context.lookup(annots.get(i));
        if (
          annotObj instanceof PDFDict &&
          annotObj.get(PDFName.of("Subtype"))?.toString() === "/Widget"
        ) {
          annots.remove(i);
        }
      } catch {
        // Cannot resolve annotation ref — leave it untouched.
      }
    }
  }

  // 3. Remove AcroForm from the catalog.
  try {
    pdfDoc.catalog.delete(PDFName.of("AcroForm"));
  } catch {
    // Non-critical.
  }
}
