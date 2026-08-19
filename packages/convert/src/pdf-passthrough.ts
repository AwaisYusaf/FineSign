/**
 * The trivial converter: a PDF is already signable, so `toPdf` validates and
 * returns the bytes unchanged.
 */
import type { DocumentConverter } from "@finesign/domain";
import { isPdfBuffer } from "finesign-core";
import { ValidationError } from "@finesign/shared";

export class PdfPassthroughConverter implements DocumentConverter {
  supports(format: "pdf" | "docx"): boolean {
    return format === "pdf";
  }
  async toPdf(bytes: Uint8Array, format: "pdf" | "docx"): Promise<Uint8Array> {
    if (format !== "pdf") throw new ValidationError(`PdfPassthroughConverter cannot handle "${format}"`);
    if (!isPdfBuffer(bytes)) throw new ValidationError("uploaded file is not a valid PDF");
    return bytes;
  }
}
