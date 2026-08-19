import { PDFDocument } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";

/** A simple multi-page PDF (no form fields — fields are placed via the API). */
export async function makePdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Page ${i + 1}`, { x: 72, y: 720, size: 14, font });
  }
  return doc.save();
}

/** Minimal DOCX magic bytes (a real ZIP header) — enough to pass upload magic
 *  validation; the fake converter turns it into a real PDF. */
export function fakeDocxBytes(): Uint8Array {
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
}

/** A drawn signature as a PNG data URL. */
export function signaturePngDataUrl(): string {
  const canvas = createCanvas(300, 100);
  const ctx = canvas.getContext("2d");
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(10, 80);
  ctx.bezierCurveTo(80, 10, 160, 90, 290, 20);
  ctx.stroke();
  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}

/** Pull the signing token out of a mailed link (`.../sign/<token>`). */
export function tokenFromLink(link: string | undefined): string {
  if (!link) throw new Error("no link in message");
  const m = link.match(/\/sign\/([^/]+)$/);
  if (!m) throw new Error(`no token in link: ${link}`);
  return m[1];
}
