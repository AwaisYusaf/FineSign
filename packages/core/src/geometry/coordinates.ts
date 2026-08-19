/**
 * Rotation-aware coordinate transforms between the three spaces Signet juggles:
 *
 *   1. DISPLAY SPACE      — fractions (0–1) of the *displayed* (rotated) page,
 *                           top-left origin, y-down. The public convention.
 *   2. RAW POINT SPACE    — PDF points, top-left origin, UNROTATED page frame.
 *                           What form-extraction tools emit (`PointBox`).
 *   3. PDF-LIB DRAW SPACE  — PDF points, BOTTOM-left origin, y-up, plus a CCW
 *                           `rotate` — what `page.drawText/drawImage` consume.
 *
 * All functions here are PURE (no I/O). Every rotation branch (0/90/180/270) is
 * derived so the transforms are exact inverses of one another; the app this was
 * extracted from proves the round-trips with a 4-corner test.
 *
 * `rotation` is a page's `/Rotate` in degrees (any integer; normalised here).
 */

import type { DisplayBox, PointBox } from "../types";

/** Normalise any `/Rotate` value (−90, 450, …) into {0,90,180,270}. */
export function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
  const n = (((rotation ?? 0) % 360) + 360) % 360;
  return (n === 90 || n === 180 || n === 270 ? n : 0) as 0 | 90 | 180 | 270;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * A single POINT (a placement anchor), display-space fractions → raw PDF
 * user-space coordinates (bottom-left origin, y-up), accounting for `/Rotate`.
 * Used to place typed-name text. Mirrors the app's `toPageCoords`.
 */
export function toPageCoords(
  xPercent: number,
  yPercent: number,
  rawWidth: number,
  rawHeight: number,
  rotation: number
): { absoluteX: number; absoluteY: number } {
  switch (normalizeRotation(rotation)) {
    case 90:
      // Display W = rawHeight, display H = rawWidth. Axes swapped.
      return { absoluteX: yPercent * rawWidth, absoluteY: xPercent * rawHeight };
    case 180:
      // Both axes flipped.
      return {
        absoluteX: (1 - xPercent) * rawWidth,
        absoluteY: yPercent * rawHeight,
      };
    case 270:
      // Landscape, opposite to 90°.
      return {
        absoluteX: (1 - yPercent) * rawWidth,
        absoluteY: (1 - xPercent) * rawHeight,
      };
    default:
      // 0° portrait. Flip Y only (PDF y-up vs display y-down).
      return { absoluteX: xPercent * rawWidth, absoluteY: (1 - yPercent) * rawHeight };
  }
}

/**
 * A raw point-space field box (`PointBox`, top-left origin, unrotated frame) →
 * a DISPLAY-space box (fractions of the rotated page, top-left origin). Handles
 * the width/height swap on 90°/270° and clamps the result onto the page.
 *
 * Derivation (screen coords, y-down; W,H = raw page size; θ = /Rotate clockwise;
 * raw point (rx,ry) maps to display (dx,dy)):
 *   θ=0   : (rx, ry)         display size (W,H)
 *   θ=90  : (H-ry, rx)       display size (H,W)  → w/h SWAP
 *   θ=180 : (W-rx, H-ry)     display size (W,H)
 *   θ=270 : (ry,  W-rx)      display size (H,W)  → w/h SWAP
 */
export function schemaFieldToDisplayBox(
  pos: PointBox,
  pageWpt: number,
  pageHpt: number,
  rotation: number
): DisplayBox {
  const { x, y, w, h } = pos;
  const W = pageWpt;
  const H = pageHpt;

  let box: DisplayBox;
  switch (normalizeRotation(rotation)) {
    case 90:
      box = { x: (H - y - h) / H, y: x / W, width: h / H, height: w / W };
      break;
    case 180:
      box = { x: (W - x - w) / W, y: (H - y - h) / H, width: w / W, height: h / H };
      break;
    case 270:
      box = { x: y / H, y: (W - x - w) / W, width: h / H, height: w / W };
      break;
    default:
      box = { x: x / W, y: y / H, width: w / W, height: h / H };
  }

  const xP = clamp01(box.x);
  const yP = clamp01(box.y);
  return {
    x: xP,
    y: yP,
    width: clamp01(Math.min(box.width, 1 - xP)),
    height: clamp01(Math.min(box.height, 1 - yP)),
  };
}

/**
 * INVERSE of `schemaFieldToDisplayBox`: a DISPLAY-space box → a raw `PointBox`
 * (PDF points, top-left origin, unrotated frame). Use it to persist a box drawn
 * on a rendered page back into a form-schema field. Round-trips exactly for
 * in-page boxes.
 */
export function displayBoxToPointBox(
  box: DisplayBox,
  pageWpt: number,
  pageHpt: number,
  rotation: number
): PointBox {
  const W = pageWpt;
  const H = pageHpt;
  const { x: xP, y: yP, width: wP, height: hP } = box;

  let fx: number, fy: number, fw: number, fh: number;
  switch (normalizeRotation(rotation)) {
    case 90:
      fx = yP * W;
      fh = wP * H;
      fw = hP * W;
      fy = H - xP * H - fh;
      break;
    case 180:
      fw = wP * W;
      fh = hP * H;
      fx = W - xP * W - fw;
      fy = H - yP * H - fh;
      break;
    case 270:
      fy = xP * H;
      fh = wP * H;
      fw = hP * W;
      fx = W - yP * W - fw;
      break;
    default:
      fx = xP * W;
      fy = yP * H;
      fw = wP * W;
      fh = hP * H;
  }
  return { x: fx, y: fy, w: fw, h: fh };
}

/**
 * A DISPLAY-space box → a pdf-lib draw rect such that
 * `page.drawImage(img, { x, y, width, height, rotate: degrees(rotateDeg) })`
 * FILLS the box exactly and reads upright on the displayed page.
 *
 * Subtlety: pdf-lib pins the image's LOWER-LEFT corner at (x,y) and rotates the
 * whole width×height rect COUNTER-CLOCKWISE about that corner — so the origin
 * corner and the width/height axis assignment differ per rotation. This returns
 * the box-FILLING rect; aspect-fit + within-box centering is composed on top by
 * the stamping engine using the same `rotateDeg`.
 */
export function displayBoxToPageRect(
  box: DisplayBox,
  pageWpt: number,
  pageHpt: number,
  rotation: number
): { x: number; y: number; width: number; height: number; rotateDeg: number } {
  const H = pageHpt;
  const { x: fx, y: fy, w: fw, h: fh } = displayBoxToPointBox(
    box,
    pageWpt,
    pageHpt,
    rotation
  );

  // The box in pdf-lib's bottom-left, y-up user space.
  const rawXmin = fx;
  const rawXmax = fx + fw;
  const rawYmin = H - (fy + fh);
  const rawYmax = H - fy;
  const bw = rawXmax - rawXmin; // = fw
  const bh = rawYmax - rawYmin; // = fh

  switch (normalizeRotation(rotation)) {
    case 90:
      return { x: rawXmax, y: rawYmin, width: bh, height: bw, rotateDeg: 90 };
    case 180:
      return { x: rawXmax, y: rawYmax, width: bw, height: bh, rotateDeg: 180 };
    case 270:
      return { x: rawXmin, y: rawYmax, width: bh, height: bw, rotateDeg: 270 };
    default:
      return { x: rawXmin, y: rawYmin, width: bw, height: bh, rotateDeg: 0 };
  }
}

/**
 * Validate a caller/hand-drawn display box BEFORE it is stored or stamped. The
 * per-field 0–1 bound cannot express the cross-field constraint that the box
 * stays ON the page; a box like {x:0.9, width:0.5} passes each field yet spills
 * off the right edge. Returns a human message when invalid, or null when valid.
 */
export function drawnBoxError(box: DisplayBox): string | null {
  const EPS = 1e-6;
  const { x, y, width, height } = box;
  if (!(width > 0) || !(height > 0)) return "signature box has zero or negative area";
  if (x < -EPS || y < -EPS) return "signature box starts off the page";
  if (x + width > 1 + EPS) return "signature box extends past the right edge of the page";
  if (y + height > 1 + EPS) return "signature box extends past the bottom edge of the page";
  return null;
}
