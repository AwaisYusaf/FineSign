/**
 * PAdES-B-T (RFC 3161 signature timestamp) tests.
 *
 * Proves the load-bearing properties: a valid timestamp round-trips and reports
 * genTime; the timestamp binds to THIS signature (a wrong imprint is rejected); a
 * valid timestamp resurrects an otherwise-expired-at-verification cert, but ONLY
 * when the timestamp itself is valid/trusted; the TSA cert EKU is enforced; the
 * in-process TSA is deterministic; and the HTTP client validates TSA responses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";
import * as asn1js from "asn1js";
import { ContentInfo, TimeStampReq, TimeStampResp, PKIStatusInfo, PKIStatus } from "pkijs";
import { FixedClock } from "@finesign/shared";
import {
  generateSelfSignedCredential,
  generateSelfSignedTsaCredential,
  createInProcessTsa,
  createHttpTsa,
  sealPdf,
  verifyPdf,
  OID,
  type TimestampAuthority,
  type TsaFetch,
} from "../src/index";

// Generated once (RSA keygen is slow) and reused. `notBefore` is pinned to the
// past so the fixed signing/genTime (noon UTC) is always inside cert validity,
// regardless of the wall-clock time the suite runs at.
const PAST = new Date("2026-01-01T00:00:00Z");
const seal = generateSelfSignedCredential({ commonName: "FineSign B-T Seal", organization: "FineSign", notBefore: PAST });
const tsaCred = generateSelfSignedTsaCredential({ commonName: "FineSign Test TSA", organization: "FineSign", notBefore: PAST });
// A TSA cert whose validity covers the backdated genTime used by the expiry tests.
const backTsaCred = generateSelfSignedTsaCredential({
  commonName: "FineSign Backdated TSA",
  notBefore: new Date("2025-12-01T00:00:00Z"),
  days: 3650,
});

async function makePdf(text = "This agreement is legally binding.") {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont("Helvetica");
  page.drawText(text, { x: 72, y: 700, size: 14, font });
  return doc.save();
}

test("B-T: seal with an in-process TSA and verify (timestamp present + valid + genTime)", async () => {
  const clock = new FixedClock("2026-07-11T12:00:00Z");
  const tsa = createInProcessTsa({ credential: tsaCred.credential, clock });
  const pdf = await makePdf();
  const signed = await sealPdf(pdf, seal.credential, {
    level: "B-T",
    timestampAuthority: tsa,
    signingTime: new Date("2026-07-11T12:00:00Z"),
  });

  const result = await verifyPdf(signed, {
    trustStore: [seal.credential.certificate()],
    tsaTrustStore: [tsaCred.credential.certificate()],
  });
  assert.equal(result.signatureCount, 1);
  const s = result.signatures[0];
  assert.equal(result.valid, true, JSON.stringify(s.problems));
  assert.equal(s.integrity, true);
  assert.equal(s.trusted, true);
  assert.deepEqual(s.timestamp, { present: true, valid: true, time: "2026-07-11T12:00:00.000Z" });
  assert.deepEqual(s.problems, []);
});

test("B-T: timestamp is accepted on crypto merits when no tsaTrustStore is given", async () => {
  const clock = new FixedClock("2026-07-11T12:00:00Z");
  const tsa = createInProcessTsa({ credential: tsaCred.credential, clock });
  const signed = await sealPdf(await makePdf(), seal.credential, { level: "B-T", timestampAuthority: tsa });

  const result = await verifyPdf(signed, { trustStore: [seal.credential.certificate()] });
  const s = result.signatures[0];
  assert.equal(s.timestamp.present, true);
  assert.equal(s.timestamp.valid, true, JSON.stringify(s.problems));
});

test("B-T requires a timestampAuthority", async () => {
  await assert.rejects(
    () => sealPdf(Buffer.from("%PDF-1.4\n"), seal.credential, { level: "B-T" }),
    /B-T.*requires.*timestampAuthority/i
  );
});

test("B-T: the timestamp binds to THIS signature — a wrong imprint is rejected", async () => {
  const clock = new FixedClock("2026-07-11T12:00:00Z");
  const honest = createInProcessTsa({ credential: tsaCred.credential, clock });
  // A malicious/broken TSA that ignores the given imprint and stamps a fixed one.
  const wrongImprintTsa: TimestampAuthority = {
    async stamp(_imprint, hashAlgo) {
      const bogus = new Uint8Array(crypto.createHash("sha256").update("not-this-signature").digest());
      return honest.stamp(bogus, hashAlgo);
    },
  };
  const signed = await sealPdf(await makePdf(), seal.credential, {
    level: "B-T",
    timestampAuthority: wrongImprintTsa,
  });

  const result = await verifyPdf(signed, {
    trustStore: [seal.credential.certificate()],
    tsaTrustStore: [tsaCred.credential.certificate()],
  });
  const s = result.signatures[0];
  assert.equal(s.timestamp.present, true);
  assert.equal(s.timestamp.valid, false);
  assert.ok(s.problems.some((p) => /message-imprint mismatch/i.test(p)), JSON.stringify(s.problems));
});

test("B-T: TSA cert must carry a critical id-kp-timeStamping EKU", async () => {
  // A TSA credential WITHOUT the timeStamping EKU (an ordinary signing cert).
  const clock = new FixedClock("2026-07-11T12:00:00Z");
  const noEkuTsa = createInProcessTsa({ credential: seal.credential, clock });
  const signed = await sealPdf(await makePdf(), seal.credential, { level: "B-T", timestampAuthority: noEkuTsa });

  const result = await verifyPdf(signed, { trustStore: [seal.credential.certificate()] });
  const s = result.signatures[0];
  assert.equal(s.timestamp.present, true);
  assert.equal(s.timestamp.valid, false);
  assert.ok(s.problems.some((p) => /id-kp-timeStamping EKU/i.test(p)), JSON.stringify(s.problems));
});

test("B-T: a valid timestamp resurrects a cert that has expired by verification time", async () => {
  // Signer cert valid for a single day; TSA + genTime inside that window; verify
  // two days later (after the signer cert has expired).
  const shortSigner = generateSelfSignedCredential({
    commonName: "Short-Lived Signer",
    notBefore: new Date("2026-01-01T00:00:00Z"),
    days: 1,
  });
  const genClock = new FixedClock("2026-01-01T01:00:00Z"); // inside the signer window
  const tsa = createInProcessTsa({ credential: backTsaCred.credential, clock: genClock });
  const signed = await sealPdf(await makePdf(), shortSigner.credential, {
    level: "B-T",
    timestampAuthority: tsa,
    signingTime: new Date("2026-01-01T01:00:00Z"),
  });
  const verifyAt = new Date("2026-01-03T00:00:00Z"); // AFTER the signer cert expired

  // With the timestamp: genTime (inside the window) becomes the effective time.
  const withTs = await verifyPdf(signed, {
    trustStore: [shortSigner.credential.certificate()],
    tsaTrustStore: [backTsaCred.credential.certificate()],
    at: verifyAt,
  });
  assert.equal(withTs.valid, true, JSON.stringify(withTs.signatures[0].problems));
  assert.equal(withTs.signatures[0].trusted, true);

  // Compare: a plain B-B seal of the same short-lived cert is INVALID at that time.
  const bb = await sealPdf(await makePdf(), shortSigner.credential, {
    signingTime: new Date("2026-01-01T01:00:00Z"),
  });
  const bbResult = await verifyPdf(bb, { trustStore: [shortSigner.credential.certificate()], at: verifyAt });
  assert.equal(bbResult.valid, false);
  assert.ok(bbResult.signatures[0].problems.some((p) => /not valid at the verification time/i.test(p)));
});

test("B-T: an UNTRUSTED TSA does not move the clock (cannot revive an expired cert)", async () => {
  const shortSigner = generateSelfSignedCredential({
    commonName: "Short-Lived Signer 2",
    notBefore: new Date("2026-01-01T00:00:00Z"),
    days: 1,
  });
  const genClock = new FixedClock("2026-01-01T01:00:00Z");
  // A backdated (valid-at-genTime) TSA, so the ONLY reason the timestamp is
  // rejected is that its cert is absent from the tsaTrustStore below.
  const tsa = createInProcessTsa({ credential: backTsaCred.credential, clock: genClock });
  const signed = await sealPdf(await makePdf(), shortSigner.credential, {
    level: "B-T",
    timestampAuthority: tsa,
    signingTime: new Date("2026-01-01T01:00:00Z"),
  });

  // A tsaTrustStore that does NOT contain our TSA → timestamp invalid → the
  // effective time stays at `at` (expired) → overall invalid.
  const unrelated = generateSelfSignedTsaCredential({ commonName: "Some Other TSA" });
  const result = await verifyPdf(signed, {
    trustStore: [shortSigner.credential.certificate()],
    tsaTrustStore: [unrelated.credential.certificate()],
    at: new Date("2026-01-03T00:00:00Z"),
  });
  const s = result.signatures[0];
  assert.equal(s.timestamp.present, true);
  assert.equal(s.timestamp.valid, false);
  assert.ok(s.problems.some((p) => /TSA certificate is not trusted/i.test(p)));
  assert.equal(result.valid, false);
});

test("B-T: an un-anchored timestamp (no tsaTrustStore) does NOT resurrect an expired cert", async () => {
  // Same setup as the "resurrects" test, but verify WITHOUT a tsaTrustStore. The
  // timestamp is cryptographically valid, yet because it is not anchored it must
  // not move the effective signing time — otherwise anyone could swap in a
  // self-signed TSA and revive an expired seal (the token is an unsigned attr).
  const shortSigner = generateSelfSignedCredential({
    commonName: "Short-Lived Signer 3",
    notBefore: new Date("2026-01-01T00:00:00Z"),
    days: 1,
  });
  const tsa = createInProcessTsa({ credential: backTsaCred.credential, clock: new FixedClock("2026-01-01T01:00:00Z") });
  const signed = await sealPdf(await makePdf(), shortSigner.credential, {
    level: "B-T",
    timestampAuthority: tsa,
    signingTime: new Date("2026-01-01T01:00:00Z"),
  });

  const result = await verifyPdf(signed, {
    trustStore: [shortSigner.credential.certificate()],
    at: new Date("2026-01-03T00:00:00Z"), // after expiry; NO tsaTrustStore configured
  });
  const s = result.signatures[0];
  assert.equal(s.timestamp.present, true);
  assert.equal(s.timestamp.valid, true, "timestamp is cryptographically valid");
  assert.equal(result.valid, false, "but an un-anchored timestamp must not extend validity");
  assert.ok(s.problems.some((p) => /not valid at the verification time/i.test(p)), JSON.stringify(s.problems));
});

test("B-T: a malformed timestamp token is reported, never thrown", async () => {
  // A TSA that returns a valid ContentInfo whose contentType is NOT SignedData.
  const badTsa: TimestampAuthority = {
    async stamp() {
      const ci = new ContentInfo({
        contentType: OID.DATA,
        content: new asn1js.OctetString({ valueHex: new Uint8Array([1, 2, 3, 4]) }),
      });
      return new Uint8Array(ci.toSchema().toBER(false));
    },
  };
  const signed = await sealPdf(await makePdf(), seal.credential, { level: "B-T", timestampAuthority: badTsa });
  const result = await verifyPdf(signed, { trustStore: [seal.credential.certificate()] });
  const s = result.signatures[0];
  assert.equal(s.timestamp.present, true);
  assert.equal(s.timestamp.valid, false);
  assert.ok(s.problems.some((p) => /timestamp verification failed|not SignedData/i.test(p)), JSON.stringify(s.problems));
});

test("in-process TSA is deterministic (fixed clock + serial ⇒ identical token)", async () => {
  const detTsa = createInProcessTsa({
    credential: tsaCred.credential,
    clock: new FixedClock("2026-07-11T12:00:00Z"),
    serial: () => new Uint8Array([0x01]),
  });
  const imprint = new Uint8Array(crypto.createHash("sha256").update("payload").digest());
  const a = await detTsa.stamp(imprint, "SHA-256");
  const b = await detTsa.stamp(imprint, "SHA-256");
  assert.ok(Buffer.from(a).equals(Buffer.from(b)), "RSA PKCS#1 v1.5 tokens must be byte-identical");
});

// ---- HTTP RFC 3161 client ---------------------------------------------------

/** A fake fetch that fulfils an RFC 3161 request via the in-process TSA. */
function fakeTsaFetch(tsa: TimestampAuthority, opts: { contentType?: string } = {}): TsaFetch {
  return async (_url, init) => {
    const req = TimeStampReq.fromBER(init.body.slice().buffer);
    const imprint = new Uint8Array(req.messageImprint.hashedMessage.valueBlock.valueHexView);
    const tokenDer = await tsa.stamp(imprint, "SHA-256");
    const resp = new TimeStampResp({
      status: new PKIStatusInfo({ status: PKIStatus.granted }),
      timeStampToken: ContentInfo.fromBER(tokenDer),
    });
    const der = new Uint8Array(resp.toSchema().toBER(false));
    return {
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? opts.contentType ?? "application/timestamp-reply" : null) },
      arrayBuffer: async () => der.slice().buffer,
    };
  };
}

test("HTTP TSA client: end-to-end B-T seal + verify via an injected fetch", async () => {
  const inproc = createInProcessTsa({ credential: tsaCred.credential, clock: new FixedClock("2026-07-11T12:00:00Z") });
  const httpTsa = createHttpTsa({ url: "https://tsa.example/tsr", fetchImpl: fakeTsaFetch(inproc) });
  const signed = await sealPdf(await makePdf(), seal.credential, { level: "B-T", timestampAuthority: httpTsa });

  const result = await verifyPdf(signed, {
    trustStore: [seal.credential.certificate()],
    tsaTrustStore: [tsaCred.credential.certificate()],
  });
  assert.equal(result.valid, true, JSON.stringify(result.signatures[0].problems));
  assert.equal(result.signatures[0].timestamp.valid, true);
});

test("HTTP TSA client: a rejection status is surfaced as an error", async () => {
  const rejectFetch: TsaFetch = async () => {
    const resp = new TimeStampResp({ status: new PKIStatusInfo({ status: PKIStatus.rejection }) });
    const der = new Uint8Array(resp.toSchema().toBER(false));
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/timestamp-reply" },
      arrayBuffer: async () => der.slice().buffer,
    };
  };
  const httpTsa = createHttpTsa({ url: "https://tsa.example/tsr", fetchImpl: rejectFetch });
  await assert.rejects(() => httpTsa.stamp(new Uint8Array(32), "SHA-256"), /rejected|status/i);
});

test("HTTP TSA client: a wrong content-type is rejected", async () => {
  const inproc = createInProcessTsa({ credential: tsaCred.credential, clock: new FixedClock("2026-07-11T12:00:00Z") });
  const httpTsa = createHttpTsa({
    url: "https://tsa.example/tsr",
    fetchImpl: fakeTsaFetch(inproc, { contentType: "text/html" }),
  });
  await assert.rejects(() => httpTsa.stamp(new Uint8Array(32), "SHA-256"), /content-type/i);
});
