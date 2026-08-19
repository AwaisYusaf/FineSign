/**
 * A `DocumentConverter` that dispatches to the first delegate supporting a
 * format — so the server can wire `[PdfPassthrough, LibreOfficeDocx]` and handle
 * both PDF and DOCX behind one port.
 */
import type { DocumentConverter } from "@finesign/domain";
import { ValidationError } from "@finesign/shared";
import { getPdfInfo } from "finesign-core";

export class CompositeConverter implements DocumentConverter {
  constructor(private readonly delegates: DocumentConverter[]) {}
  supports(format: "pdf" | "docx"): boolean {
    return this.delegates.some((d) => d.supports(format));
  }
  async toPdf(bytes: Uint8Array, format: "pdf" | "docx"): Promise<Uint8Array> {
    const delegate = this.delegates.find((d) => d.supports(format));
    if (!delegate) throw new ValidationError(`no converter registered for "${format}"`);
    return delegate.toPdf(bytes, format);
  }
}

/**
 * Normalize a source document to a signable PDF AND probe its page count in one
 * step — the exact pair the domain needs (`setDocumentNormalized`).
 */
export async function normalizeDocument(
  converter: DocumentConverter,
  bytes: Uint8Array,
  format: "pdf" | "docx"
): Promise<{ pdf: Uint8Array; pageCount: number }> {
  const pdf = await converter.toPdf(bytes, format);
  const info = await getPdfInfo(pdf);
  return { pdf, pageCount: info.pageCount };
}
