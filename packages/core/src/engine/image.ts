/**
 * Signature-image decoding, validation, and ink-trimming.
 *
 * A captured signature (canvas draw or photo upload) arrives as a base64 data
 * URL. Before embedding it we:
 *   1. decode + validate it is really a PNG/JPEG (magic bytes, size cap), and
 *   2. crop the transparent / near-white margins a canvas capture leaves around
 *      the strokes — otherwise aspect-fitting the mostly-empty image into a thin
 *      signature box shrinks the actual signature to a fraction of the field.
 *
 * Both steps are hardened against decompression bombs: a highly-compressible PNG
 * can sit under the encoded byte cap yet decode to gigabytes of RGBA.
 */

import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { SignatureImage } from "../types";

export class SignatureImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureImageError";
  }
}

/** Max DECODED signature-image bytes (base64 is ~1.33× this on the wire). */
export const MAX_SIGNATURE_IMAGE_BYTES = 2 * 1024 * 1024;

/** Max pixels (w×h) we will decode for trimming — a real signature is a few
 *  million px at most; above this we skip trimming rather than risk an OOM. */
export const MAX_TRIM_PIXELS = 16_000_000; // ~4000×4000

/**
 * Decode a base64 data URL (or bare base64) into image bytes, confirming it is a
 * real PNG or JPEG by magic bytes. Throws `SignatureImageError` on empty /
 * oversize / non-image input rather than letting pdf-lib crash downstream.
 */
export function decodeSignatureImage(dataUrl: string): SignatureImage {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    throw new SignatureImageError("signature image is required");
  }
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) {
    throw new SignatureImageError("signature image is not valid base64");
  }
  if (buf.length > MAX_SIGNATURE_IMAGE_BYTES) {
    throw new SignatureImageError("signature image is too large (max 2MB)");
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return { bytes: buf, format: "png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { bytes: buf, format: "jpeg" };
  }
  throw new SignatureImageError("signature image must be a PNG or JPEG");
}

/**
 * Read an image's declared pixel dimensions from its HEADER (PNG IHDR / JPEG
 * SOF) WITHOUT decoding the pixels — so a decompression bomb can be rejected
 * before `loadImage` allocates. Returns null if unreadable.
 */
function readImageDimensions(
  bytes: Uint8Array,
  format: "png" | "jpeg"
): { w: number; h: number } | null {
  try {
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (format === "png") {
      // 8-byte sig + 4 len + 4 "IHDR" → width@16, height@20 (big-endian).
      if (b.length < 24) return null;
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    }
    // JPEG: scan segment markers for a Start-Of-Frame (SOFn).
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const segLen = b.readUInt16BE(i + 2);
      if (segLen < 2) return null;
      i += 2 + segLen;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Reject an image whose declared pixel dimensions exceed the decode ceiling,
 * BEFORE it is handed to a decoder (pdf-lib embedPng/embedJpg). `trimSignatureImage`
 * skips trimming for oversized images and returns the original bytes, so without
 * this guard a decompression bomb would still be decoded at embed time and OOM
 * the process. Cheap (reads only the header).
 */
export function assertImageDecodable(image: SignatureImage): void {
  const dims = readImageDimensions(image.bytes, image.format);
  if (dims && dims.w * dims.h > MAX_TRIM_PIXELS) {
    throw new SignatureImageError(`signature image dimensions too large (${dims.w}×${dims.h}, max ${MAX_TRIM_PIXELS} px)`);
  }
}

/**
 * Crop a signature image to its INK bounding box, removing transparent /
 * near-white margins. A pixel is "ink" when it is sufficiently OPAQUE and NOT
 * near-white — which handles both a transparent-background PNG and a
 * white-background JPEG/PNG. Re-encodes the crop as PNG.
 *
 * FAIL-SAFE: on any decode error, an all-blank image, an already-tight crop, or
 * an oversize image, returns the ORIGINAL bytes/format unchanged — trimming must
 * never break signing.
 */
export async function trimSignatureImage(
  image: SignatureImage
): Promise<SignatureImage> {
  const { bytes, format } = image;
  try {
    const declared = readImageDimensions(bytes, format);
    if (declared && declared.w * declared.h > MAX_TRIM_PIXELS) {
      return { bytes, format };
    }

    const img = await loadImage(Buffer.from(bytes));
    const w = img.width;
    const h = img.height;
    if (!w || !h) return { bytes, format };
    if (w * h > MAX_TRIM_PIXELS) return { bytes, format };

    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h); // RGBA, row-major

    const ALPHA_MIN = 16; // below → transparent background
    const LUM_MAX = 245; // above → (near-)white background
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < ALPHA_MIN) continue;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum > LUM_MAX) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    if (maxX < minX || maxY < minY) return { bytes, format }; // no ink

    const PAD = 3;
    minX = Math.max(0, minX - PAD);
    minY = Math.max(0, minY - PAD);
    maxX = Math.min(w - 1, maxX + PAD);
    maxY = Math.min(h - 1, maxY + PAD);
    const cw = maxX - minX + 1;
    const ch = maxY - minY + 1;

    if (cw >= w && ch >= h) return { bytes, format }; // already tight

    const out = createCanvas(cw, ch);
    out.getContext("2d").drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
    return { bytes: new Uint8Array(out.toBuffer("image/png")), format: "png" };
  } catch {
    return { bytes, format };
  }
}
