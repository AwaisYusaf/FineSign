/** Shared helpers for the examples: build a demo form PDF and a demo signature. */
import { PDFDocument } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";

export async function makeDemoForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont("Helvetica");
  page.drawText("SAMPLE AGREEMENT — DEMO FORM", { x: 72, y: 720, size: 16, font });
  page.drawText("Sign and date below:", { x: 72, y: 180, size: 11, font });

  const form = doc.getForm();
  form.createTextField("signer_signature").addToPage(page, {
    x: 72,
    y: 120,
    width: 260,
    height: 30,
  });
  page.drawText("Signature", { x: 72, y: 108, size: 8, font });
  form.createTextField("date_signed").addToPage(page, {
    x: 380,
    y: 120,
    width: 140,
    height: 30,
  });
  page.drawText("Date signed", { x: 380, y: 108, size: 8, font });
  return doc.save();
}

export function makeDemoSignaturePng(): string {
  const canvas = createCanvas(360, 120);
  const ctx = canvas.getContext("2d");
  ctx.strokeStyle = "#101060";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(15, 90);
  ctx.bezierCurveTo(90, 5, 180, 110, 250, 40);
  ctx.bezierCurveTo(280, 15, 320, 60, 350, 30);
  ctx.stroke();
  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}
