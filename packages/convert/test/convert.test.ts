import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import {
  PdfPassthroughConverter,
  LibreOfficeDocxConverter,
  DocxConversionError,
  CompositeConverter,
  normalizeDocument,
} from "../src/index";

async function makePdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return doc.save();
}

test("PdfPassthrough returns PDF bytes unchanged and rejects non-PDF", async () => {
  const c = new PdfPassthroughConverter();
  assert.ok(c.supports("pdf"));
  assert.ok(!c.supports("docx"));
  const pdf = await makePdf();
  const out = await c.toPdf(pdf, "pdf");
  assert.deepEqual(out, pdf);
  await assert.rejects(() => c.toPdf(Buffer.from("nope"), "pdf"), /not a valid PDF/);
  await assert.rejects(() => c.toPdf(pdf, "docx"), /cannot handle/);
});

test("LibreOfficeDocxConverter uses the injected runner and validates output", async () => {
  const pdf = await makePdf();
  const good = new LibreOfficeDocxConverter({ runner: async () => pdf });
  assert.ok(good.supports("docx"));
  const out = await good.toPdf(Buffer.from("PK-docx-bytes"), "docx");
  assert.deepEqual(out, pdf);

  const bad = new LibreOfficeDocxConverter({ runner: async () => Buffer.from("not a pdf") });
  await assert.rejects(() => bad.toPdf(Buffer.from("x"), "docx"), DocxConversionError);
});

test("CompositeConverter dispatches by format", async () => {
  const pdf = await makePdf();
  const composite = new CompositeConverter([
    new PdfPassthroughConverter(),
    new LibreOfficeDocxConverter({ runner: async () => pdf }),
  ]);
  assert.ok(composite.supports("pdf"));
  assert.ok(composite.supports("docx"));
  assert.deepEqual(await composite.toPdf(pdf, "pdf"), pdf);
  assert.deepEqual(await composite.toPdf(Buffer.from("docx"), "docx"), pdf);
});

test("normalizeDocument returns the PDF and probed page count", async () => {
  const pdf = await makePdf(3);
  const composite = new CompositeConverter([new PdfPassthroughConverter()]);
  const res = await normalizeDocument(composite, pdf, "pdf");
  assert.equal(res.pageCount, 3);
  assert.deepEqual(res.pdf, pdf);
});
