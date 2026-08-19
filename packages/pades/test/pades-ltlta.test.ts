/**
 * PAdES-B-LT / B-LTA tests — long-term validation material (DSS) and the
 * append-aware coverage that lets legitimate DSS/DocTimeStamp revisions coexist
 * with a signature WITHOUT reopening the append attack.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, type PDFRawStream } from "pdf-lib";
import { FixedClock } from "@finesign/shared";
import {
  generateTestCa,
  generateSelfSignedTsaCredential,
  createInProcessTsa,
  createInProcessValidationDataProvider,
  createHttpValidationDataProvider,
  certFromDer,
  issueCrl,
  issueOcsp,
  sealPdf,
  augmentToBLt,
  augmentToBLta,
  verifyPdf,
  type ValidationFetch,
} from "../src/index";
import { appendIncrementalUpdate } from "../src/incremental";

const NB = new Date("2026-01-01T00:00:00Z");
const T = new Date("2026-07-11T12:00:00Z");

// One CA / leaf / TSA for the whole file (RSA keygen is slow).
const ca = generateTestCa({ commonName: "FineSign Root CA", notBefore: NB });
const leaf = ca.issueLeaf({ commonName: "FineSign LT Seal", notBefore: NB });
const tsaCred = generateSelfSignedTsaCredential({ commonName: "FineSign TSA", notBefore: NB });

const TA = new Date("2026-07-11T13:00:00Z"); // archive timestamp time
function tsa(at: Date = T) {
  return createInProcessTsa({ credential: tsaCred.credential, clock: new FixedClock(at.toISOString()) });
}
function provider(revoke?: () => boolean, source?: "crl" | "ocsp" | "both") {
  return createInProcessValidationDataProvider({ ca, clock: new FixedClock(T.toISOString()), revoke, source });
}
async function makePdf(text = "Long-term agreement.") {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]).drawText(text, { x: 72, y: 700, size: 14, font: await doc.embedFont("Helvetica") });
  return doc.save();
}
async function sealBt() {
  return sealPdf(await makePdf(), leaf.credential, { level: "B-T", timestampAuthority: tsa(), signingTime: T });
}
const verifyOpts = { trustStore: [ca.certificateDer()], tsaTrustStore: [tsaCred.credential.certificate()], at: T };

test("B-LT: augment a B-T seal with a DSS revision, byte-preserving the original", async () => {
  const bt = await sealBt();
  const blt = await augmentToBLt(bt, leaf.credential, provider());
  assert.ok(Buffer.from(blt.subarray(0, bt.length)).equals(Buffer.from(bt)), "the B-T bytes must be preserved verbatim");
  assert.ok(blt.length > bt.length, "the DSS revision is appended");

  // The DSS + its material re-parse.
  const doc = await PDFDocument.load(blt, { ignoreEncryption: true });
  const cat = doc.context.lookup(doc.context.trailerInfo.Root, PDFDict) as PDFDict;
  const dss = doc.context.lookup(cat.get(PDFName.of("DSS")), PDFDict) as PDFDict;
  const certs = doc.context.lookup(dss.get(PDFName.of("Certs")), PDFArray) as PDFArray;
  const crls = doc.context.lookup(dss.get(PDFName.of("CRLs")), PDFArray) as PDFArray;
  const vri = doc.context.lookup(dss.get(PDFName.of("VRI")), PDFDict) as PDFDict;
  assert.equal(certs.size(), 2, "leaf + CA in the DSS");
  assert.equal(crls.size(), 1);
  assert.equal(vri.keys().length, 1, "one VRI entry keyed by the signature Contents");
  const cert0 = doc.context.lookup(certs.get(0)) as PDFRawStream;
  assert.ok(cert0.contents.length > 0, "cert stream carries DER");
});

test("B-LT: verifies as valid at level B-LT (coverage survives the DSS append)", async () => {
  const blt = await augmentToBLt(await sealBt(), leaf.credential, provider());
  const r = await verifyPdf(blt, verifyOpts);
  assert.equal(r.valid, true, JSON.stringify(r.signatures[0].problems));
  assert.equal(r.level, "B-LT");
  const s = r.signatures[0];
  assert.equal(s.kind, "signature");
  assert.equal(s.level, "B-LT");
  assert.equal(s.coversWholeDocument, true);
  assert.equal(s.trusted, true);
  assert.equal(s.timestamp.valid, true);
});

test("B-LT: a REVOKED signer certificate (per the DSS CRL) is not valid", async () => {
  const blt = await augmentToBLt(await sealBt(), leaf.credential, provider(() => true));
  const r = await verifyPdf(blt, verifyOpts);
  const s = r.signatures[0];
  assert.equal(s.revocation.checked, true);
  assert.equal(s.revocation.status, "revoked");
  assert.equal(s.revocation.source, "crl");
  assert.equal(s.trusted, false, "a revoked cert is not trusted");
  assert.equal(r.valid, false);
  assert.ok(s.problems.some((p) => /revoked/i.test(p)));
});

test("B-LT: a GOOD signer certificate reports revocation good and stays valid", async () => {
  const blt = await augmentToBLt(await sealBt(), leaf.credential, provider());
  const s = (await verifyPdf(blt, verifyOpts)).signatures[0];
  assert.equal(s.revocation.status, "good");
  assert.equal(s.revocation.source, "crl");
  assert.equal(s.trusted, true);
});

test("B-LT via OCSP: a GOOD signer verifies with revocation source 'ocsp'", async () => {
  const blt = await augmentToBLt(await sealBt(), leaf.credential, provider(undefined, "ocsp"));
  const s = (await verifyPdf(blt, verifyOpts)).signatures[0];
  assert.equal(s.revocation.status, "good");
  assert.equal(s.revocation.source, "ocsp");
  assert.equal(s.trusted, true);
});

test("B-LT via OCSP: a REVOKED signer is not valid", async () => {
  const blt = await augmentToBLt(await sealBt(), leaf.credential, provider(() => true, "ocsp"));
  const r = await verifyPdf(blt, verifyOpts);
  assert.equal(r.signatures[0].revocation.status, "revoked");
  assert.equal(r.signatures[0].revocation.source, "ocsp");
  assert.equal(r.valid, false);
});

test("B-LT with BOTH CRL + OCSP: a revocation in either source is caught", async () => {
  const good = await augmentToBLt(await sealBt(), leaf.credential, provider(undefined, "both"));
  assert.equal((await verifyPdf(good, verifyOpts)).valid, true);
  const revoked = await augmentToBLt(await sealBt(), leaf.credential, provider(() => true, "both"));
  assert.equal((await verifyPdf(revoked, verifyOpts)).valid, false);
});

test("HTTP validation provider: fetch CRL + OCSP via injected fetch, then B-LT verifies", async () => {
  // A fake responder that serves CA-issued CRL (GET) + OCSP (POST) material.
  const caCert = certFromDer(ca.certificateDer());
  const caKey = await ca.cryptoKey();
  const now = T;
  const next = new Date(T.getTime() + 7 * 864e5);
  const crlDer = await issueCrl(caCert, caKey, [], now, next);
  const ocspDer = await issueOcsp(certFromDer(leaf.certificateDer), caCert, caKey, now, next, false);
  const fetchImpl: ValidationFetch = async (_url, init) => {
    const body = init.method === "GET" ? crlDer : ocspDer;
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => body.slice().buffer };
  };
  const httpProvider = createHttpValidationDataProvider({ fetchImpl, crlUrl: "https://ca.test/crl", ocspUrl: "https://ca.test/ocsp" });

  const blt = await augmentToBLt(await sealBt(), leaf.credential, httpProvider);
  const r = await verifyPdf(blt, verifyOpts);
  assert.equal(r.valid, true, JSON.stringify(r.signatures[0].problems));
  assert.equal(r.level, "B-LT");
  assert.equal(r.signatures[0].revocation.status, "good");
});

test("B-B/B-T (no DSS) leaves revocation not-checked", async () => {
  const bt = await sealBt();
  const s = (await verifyPdf(bt, verifyOpts)).signatures[0];
  assert.equal(s.revocation.checked, false);
  assert.equal(s.revocation.status, "not-checked");
  assert.equal(s.level, "B-T");
});

test("B-LTA: a document timestamp over the DSS verifies at level B-LTA", async () => {
  const blt = await augmentToBLt(await sealBt(), leaf.credential, provider());
  const blta = await augmentToBLta(blt, tsa(TA));
  assert.ok(Buffer.from(blta.subarray(0, blt.length)).equals(Buffer.from(blt)), "the B-LT bytes are preserved");

  const r = await verifyPdf(blta, verifyOpts);
  assert.equal(r.valid, true, JSON.stringify(r.signatures.map((s) => s.problems)));
  assert.equal(r.level, "B-LTA");
  assert.deepEqual(
    { present: r.documentTimestamp.present, valid: r.documentTimestamp.valid, coversDss: r.documentTimestamp.coversDss },
    { present: true, valid: true, coversDss: true }
  );
  assert.equal(r.documentTimestamp.time, TA.toISOString(), "archive time is the doc-timestamp genTime");

  // Two entries: the CAdES signature + the document timestamp.
  assert.equal(r.signatureCount, 2);
  const dts = r.signatures.find((s) => s.kind === "document-timestamp");
  assert.ok(dts, "a document timestamp is classified");
  assert.equal(dts.timestamp.valid, true);
  assert.equal(dts.coversWholeDocument, true);
});

test("B-LTA: tampering appended after the document timestamp is caught", async () => {
  const blta = await augmentToBLta(await augmentToBLt(await sealBt(), leaf.credential, provider()), tsa(TA));
  const junk = Buffer.concat([Buffer.from(blta), Buffer.from("\n% post-archive tamper\n")]);
  const r = await verifyPdf(junk, verifyOpts);
  assert.equal(r.valid, false, "content after the archive timestamp breaks coverage");
});

test("SECURITY: a trusted document timestamp must NOT authenticate an UNTRUSTED signer", async () => {
  // Full B-LTA, but verify with a trustStore that does NOT contain the signer's CA.
  // The CAdES signature is untrusted; the document timestamp is anchored-trusted.
  // A timestamp attests time, not identity — the document must NOT be valid.
  const blta = await augmentToBLta(await augmentToBLt(await sealBt(), leaf.credential, provider()), tsa(TA));
  const otherCa = generateTestCa({ commonName: "Unrelated CA", notBefore: NB });
  const r = await verifyPdf(blta, {
    trustStore: [otherCa.certificateDer()],
    tsaTrustStore: [tsaCred.credential.certificate()],
    at: T,
  });
  const cms = r.signatures.find((s) => s.kind === "signature");
  const dts = r.signatures.find((s) => s.kind === "document-timestamp");
  assert.equal(cms?.trusted, false, "the signer is not in the trust store");
  assert.equal(dts?.trusted, true, "the document timestamp IS anchored-trusted");
  assert.equal(r.valid, false, "a trusted timestamp cannot make an untrusted signer authentic");
});

test("SECURITY: an append satisfying a pre-planted dangling reference breaks coverage", async () => {
  // Sign a PDF whose page /Annots references a not-yet-defined object.
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of("Annots"), doc.context.obj([PDFRef.of(9999, 0)]));
  const bt = await sealPdf(await doc.save(), leaf.credential, { level: "B-T", timestampAuthority: tsa(), signingTime: T });
  const blt = await augmentToBLt(bt, leaf.credential, provider());
  assert.equal((await verifyPdf(blt, verifyOpts)).valid, true, "baseline is valid");

  // Append a revision that DEFINES object 9999 — an injected overlay annotation.
  const d2 = await PDFDocument.load(blt, { ignoreEncryption: true });
  const overlay = d2.context.obj({ Type: "Annot", Subtype: "Widget", Rect: d2.context.obj([0, 0, 500, 700]) });
  const tampered = appendIncrementalUpdate(blt, d2.context, [{ ref: PDFRef.of(9999, 0), obj: overlay }]);

  const r = await verifyPdf(tampered, verifyOpts);
  assert.equal(r.signatures.find((s) => s.kind === "signature")?.coversWholeDocument, false, "a newly render-reachable object breaks coverage");
  assert.equal(r.valid, false);
});

test("coverage security: a DSS append that ALSO tampers with a page is rejected", async () => {
  const blt = await augmentToBLt(await sealBt(), leaf.credential, provider());
  // Append a further revision that re-defines the page object (content tampering).
  const doc = await PDFDocument.load(blt, { ignoreEncryption: true });
  const ctx = doc.context;
  const pageRef = doc.getPages()[0].ref;
  const pageDict = ctx.lookup(pageRef, PDFDict) as PDFDict;
  pageDict.set(PDFName.of("FineSignTamper"), PDFName.of("yes"));
  const tampered = appendIncrementalUpdate(blt, ctx, [{ ref: pageRef, obj: pageDict }]);

  const r = await verifyPdf(tampered, verifyOpts);
  assert.equal(r.signatures[0].coversWholeDocument, false, "re-defining an existing object breaks coverage");
  assert.equal(r.valid, false, "a content-tampering append must not be valid");
});

test("coverage security: appended trailing junk (no incremental xref) is rejected", async () => {
  const blt = await augmentToBLt(await sealBt(), leaf.credential, provider());
  const junk = Buffer.concat([Buffer.from(blt), Buffer.from("\n% sneaky appended change\n")]);
  const r = await verifyPdf(junk, verifyOpts);
  assert.equal(r.signatures[0].coversWholeDocument, false);
  assert.equal(r.valid, false);
});

test("coverage security: a revision that changes the catalog beyond /DSS is rejected", async () => {
  const bt = await sealBt();
  const blt = await augmentToBLt(bt, leaf.credential, provider());
  // Append a revision re-emitting the catalog with an injected /OpenAction.
  const doc = await PDFDocument.load(blt, { ignoreEncryption: true });
  const ctx = doc.context;
  const catRef = ctx.trailerInfo.Root;
  const cat = ctx.lookup(catRef, PDFDict) as PDFDict;
  cat.set(PDFName.of("OpenAction"), PDFName.of("Foo"));
  const tampered = appendIncrementalUpdate(blt, ctx, [{ ref: catRef, obj: cat }]);
  const r = await verifyPdf(tampered, verifyOpts);
  assert.equal(r.signatures[0].coversWholeDocument, false, "a non-/DSS catalog change breaks coverage");
  assert.equal(r.valid, false);
});
