/**
 * The three low-level stamping primitives, operating directly on a pdf-lib page:
 *   - `stampTypedName`  — a scripted-font name at a point (typed-signature mode)
 *   - `stampImageAnchor` — a captured signature image filling an anchor box
 *   - `stampDateAnchor`  — auto-date text centered in an anchor box
 *
 * All three share the same rotation handling: the anchor/point is in display
 * space, and the drawn mark is rotated to read upright on the displayed page.
 * Signature/date marks are drawn in dark blue (the classic "wet ink" look).
 */

import { PDFFont, PDFImage, PDFPage, rgb, degrees } from "pdf-lib";
import type { DisplayBox, SignatureAnchor } from "../types";
import { toPageCoords, displayBoxToPageRect } from "../geometry/coordinates";

/** "Wet ink" dark blue used for stamped marks and dates. */
export const INK_COLOR = rgb(0, 0, 0.5);

/**
 * The MediaBox lower-left origin. `page.getSize()` gives the MediaBox width/height
 * but drops the origin — for a PDF whose MediaBox is e.g. `[10 10 620 802]`,
 * user-space (0,0) is NOT the page corner, so a mark computed in a 0-origin frame
 * lands offset (or off-page). Add this to the final draw coordinates.
 */
function mediaBoxOffset(page: PDFPage): { x: number; y: number } {
  const mb = page.getMediaBox();
  return { x: mb.x, y: mb.y };
}

/** Base font size (PDF points) for a typed name at scale 1.0. */
export const BASE_FONT_SIZE = 20;

/** How much taller than a (thin) signature-line box an image may grow when
 *  filling the width — signatures naturally rise above the line. Bounded so it
 *  can't push into the row above. */
export const SIG_MAX_HEIGHT_MULT = 1.6;

/**
 * Draw a scripted-font `name` with its glyph TOP-LEFT at the display-space point
 * (xPercent,yPercent). pdf-lib draws from the text baseline, so we shift down by
 * one ascent (along the display-down direction, which depends on `/Rotate`).
 */
export function stampTypedName(
  page: PDFPage,
  params: {
    name: string;
    xPercent: number;
    yPercent: number;
    scale: number;
    font: PDFFont;
  }
): void {
  const { width: rawWidth, height: rawHeight } = page.getSize();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;

  const { absoluteX, absoluteY } = toPageCoords(
    params.xPercent,
    params.yPercent,
    rawWidth,
    rawHeight,
    rotation
  );

  const fontSize = BASE_FONT_SIZE * params.scale;
  // { descender: false } → ascent only, so the glyph TOP lands at the anchor.
  const ascent = params.font.heightAtSize(fontSize, { descender: false });

  let baselineX = absoluteX;
  let baselineY = absoluteY;
  if (rotation === 90) baselineX += ascent; // display-down = raw +x
  else if (rotation === 180) baselineY += ascent; // display-down = raw +y
  else if (rotation === 270) baselineX -= ascent; // display-down = raw -x
  else baselineY -= ascent; // display-down = raw -y

  const mb = mediaBoxOffset(page);
  page.drawText(params.name, {
    x: baselineX + mb.x,
    y: baselineY + mb.y,
    size: fontSize,
    font: params.font,
    color: INK_COLOR,
    rotate: degrees(rotation),
  });
}

/**
 * Fill an anchor box with a signature image. A signature-line box is thin+wide,
 * so aspect-fitting (min scale) makes the mark tiny; instead we fill the box
 * WIDTH and cap height at `SIG_MAX_HEIGHT_MULT × box`, bottom-aligned so the
 * signature sits on the line and any extra height rises above it. The image
 * should be pre-trimmed to its ink bbox so "fill width" fills with strokes.
 */
export function stampImageAnchor(
  page: PDFPage,
  image: PDFImage,
  anchor: DisplayBox
): void {
  const { width: rawW, height: rawH } = page.getSize();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;

  const rect = displayBoxToPageRect(anchor, rawW, rawH, rotation);
  const dims = image.scale(1);
  const s = Math.min(
    rect.width / dims.width,
    (rect.height * SIG_MAX_HEIGHT_MULT) / dims.height
  );
  const imgW = dims.width * s;
  const imgH = dims.height * s;
  const offX = (rect.width - imgW) / 2; // center horizontally
  const offY = 0; // bottom-align onto the line
  const rad = (rect.rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const mb = mediaBoxOffset(page);
  page.drawImage(image, {
    x: rect.x + offX * cos - offY * sin + mb.x,
    y: rect.y + offX * sin + offY * cos + mb.y,
    width: imgW,
    height: imgH,
    rotate: degrees(rect.rotateDeg),
  });
}

/**
 * Stamp `dateText` centered in an anchor box, font-fit to the box height then
 * shrunk to fit the width so a full MM/DD/YYYY never overflows a narrow split
 * cell. Same rotation handling as the image.
 */
export function stampDateAnchor(
  page: PDFPage,
  anchor: DisplayBox,
  dateText: string,
  font: PDFFont
): void {
  const { width: rawW, height: rawH } = page.getSize();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;

  const rect = displayBoxToPageRect(anchor, rawW, rawH, rotation);
  let size = Math.min(rect.height * 0.7, 12);
  const textW0 = font.widthOfTextAtSize(dateText, size);
  const maxW = rect.width * 0.95;
  if (textW0 > maxW && textW0 > 0) size = (size * maxW) / textW0;
  const textW = font.widthOfTextAtSize(dateText, size);
  const ascent = font.heightAtSize(size, { descender: false });
  const offX = Math.max(0, (rect.width - textW) / 2);
  const offY = Math.max(0, (rect.height - ascent) / 2);
  const rad = (rect.rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const mb = mediaBoxOffset(page);
  page.drawText(dateText, {
    x: rect.x + offX * cos - offY * sin + mb.x,
    y: rect.y + offX * sin + offY * cos + mb.y,
    size,
    font,
    color: INK_COLOR,
    rotate: degrees(rect.rotateDeg),
  });
}

/** Convenience: is an anchor's page within [1, totalPages] and integer? */
export function isPageInRange(anchor: SignatureAnchor, totalPages: number): boolean {
  return Number.isInteger(anchor.page) && anchor.page >= 1 && anchor.page <= totalPages;
}
