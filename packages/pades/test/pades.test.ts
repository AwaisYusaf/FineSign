import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { generateSelfSignedCredential, sealPdf, verifyPdf } from "../src/index";

const seal = generateSelfSignedCredential({ commonName: "FineSign Seal", organization: "FineSign" });
const other = generateSelfSignedCredential({ commonName: "Someone Else" });

async function makePdf(text = "This agreement is legally binding.") {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont("Helvetica");
  page.drawText(text, { x: 72, y: 700, size: 14, font });
  return doc.save();
}

test("seal a PDF and fully verify it (integrity + coverage + attrs + trust)", async () => {
  const pdf = await makePdf();
  const signed = await sealPdf(pdf, seal.credential, {
    reason: "Completed by all parties",
    signingTime: new Date("2026-07-11T12:00:00Z"),
  });
  assert.equal(Buffer.from(signed.subarray(0, 5)).toString("latin1"), "%PDF-");

  const result = await verifyPdf(signed, { trustStore: [seal.credential.certificate()] });
  assert.equal(result.signatureCount, 1);
  assert.equal(result.valid, true, JSON.stringify(result.signatures[0].problems));
  const s = result.signatures[0];
  assert.equal(s.integrity, true);
  assert.equal(s.coversWholeDocument, true);
  assert.equal(s.digestMatches, true);
  assert.equal(s.signingCertMatches, true);
  assert.equal(s.trusted, true);
  assert.equal(s.signerCommonName, "FineSign Seal");
  assert.equal(s.signingTime, "2026-07-11T12:00:00.000Z");
  assert.deepEqual(s.problems, []);
});

test("tampering with the signed content breaks integrity", async () => {
  const pdf = await makePdf();
  const signed = await sealPdf(pdf, seal.credential);
  const tampered = Buffer.from(signed);
  // Flip a byte early in the file (inside the first ByteRange segment, the page
  // content) — not in the /Contents gap.
  tampered[30] = tampered[30] ^ 0xff;

  const result = await verifyPdf(tampered, { trustStore: [seal.credential.certificate()] });
  assert.equal(result.valid, false);
  assert.equal(result.signatures[0].integrity, false);
});

test("appending bytes after signing is caught by the coverage check", async () => {
  const pdf = await makePdf();
  const signed = await sealPdf(pdf, seal.credential);
  const appended = Buffer.concat([Buffer.from(signed), Buffer.from("\n% sneaky appended change\n")]);

  const result = await verifyPdf(appended, { trustStore: [seal.credential.certificate()] });
  assert.equal(result.signatures[0].coversWholeDocument, false, "appended bytes must break coverage");
  assert.equal(result.valid, false);
  assert.ok(result.signatures[0].problems.some((p) => /whole document/.test(p)));
});

test("an untrusted signer verifies cryptographically but is NOT valid (C1)", async () => {
  const pdf = await makePdf();
  const signed = await sealPdf(pdf, seal.credential);
  // Trust store contains a DIFFERENT cert.
  const result = await verifyPdf(signed, { trustStore: [other.credential.certificate()] });
  assert.equal(result.signatures[0].integrity, true);
  assert.equal(result.signatures[0].trusted, false);
  assert.equal(result.valid, false, "an untrusted (forgeable) signature must not be `valid`");
});

test("valid requires a trust store — no anchors means not authentic (C1)", async () => {
  const pdf = await makePdf();
  const signed = await sealPdf(pdf, seal.credential);
  const result = await verifyPdf(signed); // no trustStore
  assert.equal(result.signatures[0].integrity, true);
  assert.equal(result.valid, false);
});

test("re-sealing with an untrusted certificate does not make a doc valid (C1)", async () => {
  const pdf = await makePdf();
  const legit = await sealPdf(pdf, seal.credential); // trusted platform seal
  // Attacker re-seals with THEIR OWN cert (covers the whole modified file).
  const attacked = await sealPdf(legit, other.credential);

  const result = await verifyPdf(attacked, { trustStore: [seal.credential.certificate()] });
  // The only signature that covers the whole document must be trusted for the
  // doc to be valid; the attacker's covering signature is not trusted.
  const trustedCovering = result.signatures.some((s) => s.trusted && s.coversWholeDocument);
  assert.equal(trustedCovering, false);
  assert.equal(result.valid, false, "an untrusted covering signature must not make the doc valid");
});

test("a certificate outside its validity window is not trusted (H1)", async () => {
  const pdf = await makePdf();
  const signed = await sealPdf(pdf, seal.credential);
  // Verify as-of a time before the cert existed.
  const past = await verifyPdf(signed, { trustStore: [seal.credential.certificate()], at: new Date("2000-01-01T00:00:00Z") });
  assert.equal(past.signatures[0].trusted, false);
  assert.equal(past.valid, false);
  assert.ok(past.signatures[0].problems.some((p) => /valid at the verification time/.test(p)));
});

test("a malformed ByteRange is rejected structurally (M1)", async () => {
  const pdf = await makePdf();
  const signed = Buffer.from(await sealPdf(pdf, seal.credential));
  // Corrupt the ByteRange so the second segment runs past EOF.
  const tampered = signed.toString("latin1").replace(/\/ByteRange\s*\[\s*\d+\s+\d+\s+\d+\s+\d+\s*\]/, "/ByteRange [0 10 20 99999999]");
  const result = await verifyPdf(Buffer.from(tampered, "latin1"), { trustStore: [seal.credential.certificate()] });
  assert.equal(result.valid, false);
});

test("a document with no signature is not valid", async () => {
  const pdf = await makePdf();
  const result = await verifyPdf(pdf);
  assert.equal(result.signatureCount, 0);
  assert.equal(result.valid, false);
});

test("a stray /ByteRange literal in content is not treated as a signature (A3)", async () => {
  // A page whose text embeds a fake ByteRange must not break verification.
  const pdf = await makePdf("Reference: /ByteRange [0 0 0 0] in the appendix.");
  const signed = await sealPdf(pdf, seal.credential);
  const result = await verifyPdf(signed, { trustStore: [seal.credential.certificate()] });
  assert.equal(result.signatureCount, 1, "only the real signature should count");
  assert.equal(result.valid, true, JSON.stringify(result.signatures.map((s) => s.problems)));
});

test("many seals verify — no ~1/256 false negative from trailing 0x00 (A2)", async () => {
  // Seal several fresh documents; every one must verify (previously ~0.4% failed
  // when the CMS DER ended in 0x00 and got truncated).
  for (let i = 0; i < 40; i++) {
    const pdf = await makePdf(`doc ${i}`);
    const signed = await sealPdf(pdf, seal.credential);
    const result = await verifyPdf(signed, { trustStore: [seal.credential.certificate()] });
    assert.equal(result.valid, true, `doc ${i} failed: ${JSON.stringify(result.signatures[0].problems)}`);
  }
});
