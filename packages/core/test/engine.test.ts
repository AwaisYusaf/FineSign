import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import {
  SignEngine,
  NotAPdfError,
  detectAnchorsFromAcroForm,
  detectFields,
  isPdfBuffer,
  anchorFromDisplayBox,
  type SignatureAnchor,
} from "../src/index";

/** Build a one-page PDF with two named AcroForm text fields the heuristics
 *  recognise: a signer signature line and a "date signed" box. */
async function makeFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();

  const sig = form.createTextField("signer_signature");
  sig.addToPage(page, { x: 72, y: 120, width: 240, height: 28 });

  const date = form.createTextField("date_signed");
  date.addToPage(page, { x: 360, y: 120, width: 120, height: 28 });

  return doc.save();
}

/** A tiny opaque-stroke PNG data URL to act as a captured signature. */
function makeSignaturePng(): string {
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

test("isPdfBuffer discriminates PDF from junk", async () => {
  const pdf = await makeFormPdf();
  assert.ok(isPdfBuffer(pdf));
  assert.ok(!isPdfBuffer(Buffer.from("hello world")));
});

test("detectFields + detectAnchorsFromAcroForm find the named fields", async () => {
  const pdf = await makeFormPdf();
  const fields = await detectFields(pdf);
  const names = fields.map((f) => f.name).sort();
  assert.deepEqual(names, ["date_signed", "signer_signature"]);
  assert.equal(fields.find((f) => f.name === "date_signed")!.kind, "date");
  assert.equal(fields.find((f) => f.name === "signer_signature")!.kind, "signature");

  const anchors = await detectAnchorsFromAcroForm(pdf);
  assert.equal(anchors.length, 2);
  for (const a of anchors) {
    assert.ok(a.x >= 0 && a.x <= 1 && a.y >= 0 && a.y <= 1);
    assert.ok(a.width > 0 && a.height > 0);
    assert.equal(a.source, "acroform");
  }
});

test("signWithImage stamps signature + date, returns a valid signed PDF", async () => {
  const pdf = await makeFormPdf();
  const anchors = await detectAnchorsFromAcroForm(pdf);
  const engine = new SignEngine({ now: () => new Date("2026-07-09T12:00:00Z") });

  const result = await engine.signWithImage(pdf, anchors, makeSignaturePng());

  assert.equal(result.signatureCount, 1);
  assert.equal(result.dateCount, 1);
  assert.ok(isPdfBuffer(result.pdf));
  // The signed output must re-open as a valid PDF.
  const reopened = await PDFDocument.load(result.pdf);
  assert.equal(reopened.getPageCount(), 1);
  // Date anchor stamped today's date in MM/DD/YYYY.
  const dateStamp = result.stamped.find((s) => s.kind === "date");
  assert.equal(dateStamp!.value, "07/09/2026");
});

test("signWithTypedNames renders a scripted name onto the page", async () => {
  const pdf = await makeFormPdf();
  const engine = new SignEngine();
  const signed = await engine.signWithTypedNames(pdf, [
    {
      signatureName: "Jane Q. Public",
      signatureFont: "great_vibes",
      pageNumber: 1,
      xPercent: 0.12,
      yPercent: 0.85,
      scale: 1.2,
    },
  ]);
  assert.ok(isPdfBuffer(signed));
  const reopened = await PDFDocument.load(signed);
  assert.equal(reopened.getPageCount(), 1);
});

test("signWithImage is idempotent — re-signing the ORIGINAL yields the same counts", async () => {
  const pdf = await makeFormPdf();
  const anchors = await detectAnchorsFromAcroForm(pdf);
  const engine = new SignEngine();
  const a = await engine.signWithImage(pdf, anchors, makeSignaturePng());
  const b = await engine.signWithImage(pdf, anchors, makeSignaturePng());
  assert.equal(a.signatureCount, b.signatureCount);
  assert.equal(a.dateCount, b.dateCount);
});

test("errors: non-PDF input and empty anchors are rejected", async () => {
  const engine = new SignEngine();
  await assert.rejects(
    () => engine.signWithImage(Buffer.from("not a pdf"), [dummyAnchor()], makeSignaturePng()),
    NotAPdfError
  );
  const pdf = await makeFormPdf();
  await assert.rejects(() => engine.signWithImage(pdf, [], makeSignaturePng()), /no anchors/);
});

test("signWithImage rejects a decompression-bomb image before embedding (B1)", async () => {
  const pdf = await makeFormPdf();
  const anchors = await detectAnchorsFromAcroForm(pdf);
  // A tiny PNG whose IHDR declares 20000×20000 (huge decoded, small file).
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "latin1");
  png.writeUInt32BE(20000, 16);
  png.writeUInt32BE(20000, 20);
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const engine = new SignEngine();
  await assert.rejects(() => engine.signWithImage(pdf, anchors, dataUrl), /too large|dimensions/);
});

test("out-of-range placement page throws RangeError", async () => {
  const pdf = await makeFormPdf();
  const engine = new SignEngine();
  await assert.rejects(
    () =>
      engine.signWithTypedNames(pdf, [
        {
          signatureName: "X",
          signatureFont: "pacifico",
          pageNumber: 5,
          xPercent: 0.1,
          yPercent: 0.1,
          scale: 1,
        },
      ]),
    RangeError
  );
});

test("anchorFromDisplayBox validates on-page boxes", () => {
  const ok = anchorFromDisplayBox({
    box: { x: 0.1, y: 0.8, width: 0.3, height: 0.05 },
    page: 1,
    kind: "signature",
  });
  assert.equal(ok.source, "manual");
  assert.throws(() =>
    anchorFromDisplayBox({
      box: { x: 0.9, y: 0.8, width: 0.5, height: 0.05 },
      page: 1,
      kind: "signature",
    })
  );
});

function dummyAnchor(): SignatureAnchor {
  return {
    anchorId: "a1",
    page: 1,
    x: 0.1,
    y: 0.8,
    width: 0.3,
    height: 0.05,
    kind: "signature",
    label: "signer_signature",
    source: "manual",
  };
}
