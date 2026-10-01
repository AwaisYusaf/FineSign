/**
 * finesign-core — public type contracts.
 *
 * The whole library speaks ONE coordinate convention on its public surface:
 *
 *   DISPLAY SPACE — fractions (0–1) of the *displayed* page (i.e. after the
 *   page's `/Rotate` is applied), origin at the TOP-LEFT, y pointing DOWN.
 *   This is the natural coordinate space of a page rendered in a browser, so a
 *   front-end overlay can hand these numbers straight to the signing engine.
 *
 * Everything rotation/pdf-lib-specific (bottom-left origin, y-up, `/Rotate`
 * quirks) is handled internally by `geometry/coordinates.ts`. Callers never
 * deal with raw PDF user space.
 */

/**
 * The bundled cursive fonts available for *typed-name* signatures, as a runtime
 * list so callers can validate untrusted input against the same source of truth
 * the type is derived from. Add your own by registering a font with
 * `FontRegistry` (see `engine/fonts.ts`) — this set is only the built-in one.
 */
export const SIGNATURE_FONTS = [
  "dancing_script",
  "great_vibes",
  "pacifico",
  "pinyon_script",
] as const;

/** One of the bundled cursive fonts — derived from `SIGNATURE_FONTS`. */
export type SignatureFont = (typeof SIGNATURE_FONTS)[number];

/**
 * Narrow untrusted input to a built-in `SignatureFont`. Use this at your trust
 * boundary: an unrecognized font is a *caller* error, and resolving one is a
 * runtime failure deep inside stamping otherwise.
 */
export function isSignatureFont(value: unknown): value is SignatureFont {
  return typeof value === "string" && (SIGNATURE_FONTS as readonly string[]).includes(value);
}

/** What lands at a target: a signature mark, or the "date signed" beside it. */
export type SignatureFieldKind = "signature" | "date";

/**
 * A rectangle in DISPLAY SPACE — fractions (0–1) of the displayed page, top-left
 * origin. `x,y` is the top-left corner; `width,height` extend right/down.
 */
export interface DisplayBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A field box in RAW PDF-point space (1pt = 1/72"), TOP-LEFT origin, in the
 * page's UNROTATED frame — the shape most form-extraction tools emit. The engine
 * converts these to `DisplayBox` for you via `schemaFieldToDisplayBox`.
 */
export interface PointBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One TYPED-NAME signature placement — a scripted-font rendering of a name at a
 * point on a page. This is the "drag a styled name onto the page" mode.
 *
 * `x`/`y` anchor the VISUAL TOP-LEFT of the rendered text (glyph ascent top) in
 * display space. The stamped font size is `baseFontSize * scale` PDF points
 * (baseFontSize defaults to 20).
 */
export interface SignaturePlacement {
  /** The name to render in the chosen script font. */
  signatureName: string;
  /** Which script font to render it in. */
  signatureFont: SignatureFont;
  /** 1-indexed page number as shown in the viewer. */
  pageNumber: number;
  /** Left edge of the text, as a fraction (0–1) of displayed page width. */
  xPercent: number;
  /** Visual top of the text, as a fraction (0–1) of displayed page height. */
  yPercent: number;
  /** Size multiplier (typically 0.5–2.5); font size = baseFontSize × scale. */
  scale: number;
}

/**
 * A pre-defined "sign here" target on a page — a DocuSign-style anchor. Produced
 * either by the caller, by `detectAnchorsFromAcroForm`, or by converting a
 * form-schema field box with `anchorFromPointBox`. Consumed by the image-signing
 * path (a captured signature image is stamped onto every `signature` anchor and
 * today's date onto every `date` anchor).
 *
 * Coordinates are a `DisplayBox` (display-space fractions, top-left origin).
 */
export interface SignatureAnchor extends DisplayBox {
  /** Stable id (used in the stamped-audit output). */
  anchorId: string;
  /** 1-indexed page number as shown in the viewer. */
  page: number;
  /** Signature mark, or the date that pairs with it. */
  kind: SignatureFieldKind;
  /** Human/audit label, e.g. "signer_signature". Not parsed by the engine. */
  label: string;
  /** Where this anchor came from — audit only. */
  source: "auto" | "manual" | "acroform";
  /** For `date` anchors only: how to fill the date.
   *  - "auto" (default): infer from the label + same-page grouping — a group of
   *    exactly 3 unlabeled date boxes is treated as split MM / DD / YYYY cells
   *    (matches forms that split the date into separate cells).
   *  - "full": always stamp the complete MM/DD/YYYY. Use when each date field is
   *    an independent full date (never a split cell), so three on one page don't
   *    get fragmented. */
  dateFormat?: "auto" | "full";
}

/**
 * Audit record of ONE stamp applied during image signing: the signature image
 * at a `signature` anchor, or the auto-date at a `date` anchor. The signature
 * IMAGE bytes are never echoed here.
 */
export interface StampedAnchor {
  anchorId: string;
  page: number;
  kind: SignatureFieldKind;
  label: string;
  /** For a `date` anchor: the stamped text (e.g. "07/09/2026"). null for a mark. */
  value: string | null;
  /** ISO-8601 timestamp set by the engine at stamp time. */
  signedAt: string;
}

/** A decoded raster signature image ready to embed. */
export interface SignatureImage {
  bytes: Uint8Array;
  format: "png" | "jpeg";
}
