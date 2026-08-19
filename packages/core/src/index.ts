/**
 * finesign-core — an open-source, self-hostable e-signature engine for PDFs.
 *
 * Bytes in, bytes out. Give it an unsigned PDF and either typed-name placements
 * or a captured signature image + "sign here" anchors, and it returns the signed
 * PDF. It handles page rotation, form-field flattening, ink-trimming, and
 * auto-dating. It does NOT touch storage, a database, auth, or the network —
 * that's your app's job. See README.md for the quick start.
 *
 * @packageDocumentation
 */

// ── Types ────────────────────────────────────────────────────────────────────
export { SIGNATURE_FONTS, isSignatureFont } from "./types";
export type {
  SignatureFont,
  SignatureFieldKind,
  DisplayBox,
  PointBox,
  SignaturePlacement,
  SignatureAnchor,
  StampedAnchor,
  SignatureImage,
} from "./types";

// ── The signing engine (the main entry point) ────────────────────────────────
export {
  SignEngine,
  NotAPdfError,
  newAnchorId,
  type SignEngineOptions,
  type SignWithImageResult,
} from "./engine/sign";

// ── Anchor construction ───────────────────────────────────────────────────────
export { anchorFromPointBox, anchorFromDisplayBox } from "./anchors";

// ── Detection: find "sign here" targets in a PDF ─────────────────────────────
export {
  detectFields,
  detectAnchorsFromAcroForm,
  type DetectedField,
  type DetectOptions,
} from "./detect/acroform-fields";
export {
  isSignerSignatureField,
  isSignerDateField,
  isNonSignerParty,
  hasSignToken,
} from "./detect/field-heuristics";
export { getPdfInfo, type PdfInfo, type PdfPageInfo } from "./detect/pdf-info";

// ── Fonts ─────────────────────────────────────────────────────────────────────
export { FontRegistry, defaultFontRegistry, UnknownSignatureFontError } from "./engine/fonts";

// ── Image helpers ────────────────────────────────────────────────────────────
export {
  decodeSignatureImage,
  trimSignatureImage,
  SignatureImageError,
  MAX_SIGNATURE_IMAGE_BYTES,
  MAX_TRIM_PIXELS,
} from "./engine/image";

// ── PDF guards ────────────────────────────────────────────────────────────────
export { isPdfBuffer } from "./engine/pdf-guards";

// ── Low-level geometry (for advanced/custom pipelines) ───────────────────────
export {
  normalizeRotation,
  toPageCoords,
  schemaFieldToDisplayBox,
  displayBoxToPointBox,
  displayBoxToPageRect,
  drawnBoxError,
} from "./geometry/coordinates";

// ── Low-level stamping + flatten (compose your own signing flow) ─────────────
export { flattenForStamping } from "./engine/flatten";
export { buildDateValues } from "./engine/dates";
export {
  stampTypedName,
  stampImageAnchor,
  stampDateAnchor,
  isPageInRange,
  INK_COLOR,
  BASE_FONT_SIZE,
  SIG_MAX_HEIGHT_MULT,
} from "./engine/stamp";
