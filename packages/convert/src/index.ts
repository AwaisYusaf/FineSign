/**
 * `@finesign/convert` — adapters for the `DocumentConverter` port. PDF passes
 * through; DOCX is normalized to PDF via LibreOffice (injectable runner).
 *
 * @packageDocumentation
 */
export { PdfPassthroughConverter } from "./pdf-passthrough";
export {
  LibreOfficeDocxConverter,
  makeLibreOfficeRunner,
  DocxConversionError,
  ConverterUnavailableError,
  type DocxRunner,
  type LibreOfficeOptions,
} from "./docx-libreoffice";
export { CompositeConverter, normalizeDocument } from "./composite";
