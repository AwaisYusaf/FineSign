/**
 * Security regressions for the verifier's signer-resolution and CMS robustness.
 *
 * The critical one: a SignerInfo may name its certificate by SubjectKeyIdentifier
 * (SignerInfo v3), which PKIjs resolves by SHA-1(subjectPublicKey). If the
 * verifier instead binds trust/attr checks to `certificates[0]`, an attacker who
 * places a genuine trusted cert first — but signs with their own key under an SKI
 * `sid` — is reported as a trusted signer. This forges a "trusted" seal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { Signer, SUBFILTER_ETSI_CADES_DETACHED } from "@signpdf/utils";
import signpdf from "@signpdf/signpdf";
import * as asn1js from "asn1js";
import { ContentInfo, SignedData, Certificate, EncapsulatedContentInfo, AlgorithmIdentifier } from "pkijs";
import {
  generateSelfSignedCredential,
  buildCmsSignedData,
  sealPdf,
  verifyPdf,
  OID,
  type SigningCredential,
} from "../src/index";

const trusted = generateSelfSignedCredential({ commonName: "Genuine Platform Seal", organization: "FineSign" });
const attacker = generateSelfSignedCredential({ commonName: "Forger Key", organization: "Evil" });

async function makePdf(text = "Payable to the bearer.") {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText(text, { x: 72, y: 700, size: 14, font: await doc.embedFont("Helvetica") });
  return doc.save();
}

/** Seal a PDF whose CMS is produced by a caller-supplied builder (to inject a
 *  crafted/forged CMS through the normal @signpdf ByteRange mechanics). */
async function sealWithCms(pdf: Uint8Array, buildCms: (content: Uint8Array) => Promise<Uint8Array>): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  pdflibAddPlaceholder({
    pdfDoc,
    reason: "x",
    contactInfo: "",
    name: "x",
    location: "",
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    signatureLength: 16384,
  });
  const withPlaceholder = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  class CustomSigner extends Signer {
    async sign(content: Buffer): Promise<Buffer> {
      return Buffer.from(await buildCms(new Uint8Array(content)));
    }
  }
  return new Uint8Array(await signpdf.sign(withPlaceholder, new CustomSigner()));
}

/** Build the forged CMS: signed attrs (incl. signing-certificate-v2 over the
 *  GENUINE cert) signed by the ATTACKER key, SignerInfo.sid = SKI(attacker key),
 *  certificates = [genuine, attacker]. */
async function forgeSkiCms(content: Uint8Array): Promise<Uint8Array> {
  // A credential that presents the GENUINE cert (so ESS + initial sid point at it)
  // but signs with the ATTACKER key.
  const malicious: SigningCredential = {
    certificate: () => trusted.credential.certificate(),
    chain: () => [],
    digestAlgorithm: () => "SHA-256",
    signatureScheme: () => "RSASSA-PKCS1-v1_5",
    sign: (tbs) => attacker.credential.sign(tbs),
    subjectCommonName: () => "ignored",
  };
  const cmsDer = await buildCmsSignedData({ content, credential: malicious, signingTime: new Date("2026-07-11T12:00:00Z") });

  const sd = new SignedData({ schema: ContentInfo.fromBER(cmsDer).content });
  const genuineCert = Certificate.fromBER(trusted.credential.certificate());
  const attackerCert = Certificate.fromBER(attacker.credential.certificate());
  // SKI = SHA-1(attacker subjectPublicKey) — exactly how PKIjs resolves the signer.
  const ski = crypto
    .createHash("sha1")
    .update(Buffer.from(attackerCert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView))
    .digest();
  sd.signerInfos[0].version = 3;
  // [0] IMPLICIT SubjectKeyIdentifier (context tag 0, primitive).
  sd.signerInfos[0].sid = new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 }, valueHex: new Uint8Array(ski).buffer });
  sd.certificates = [genuineCert, attackerCert]; // genuine cert FIRST (the bait)

  const out = new ContentInfo({ contentType: OID.SIGNED_DATA, content: sd.toSchema(true) });
  return new Uint8Array(out.toSchema().toBER(false));
}

test("SKI-forgery: a genuine cert at certificates[0] with an attacker-signed SKI SignerInfo is NOT trusted", async () => {
  const pdf = await makePdf();
  const forged = await sealWithCms(pdf, forgeSkiCms);

  const result = await verifyPdf(forged, { trustStore: [trusted.credential.certificate()] });
  const s = result.signatures[0];

  // The attacker's signature genuinely verifies (the scenario is real, not a parse failure).
  assert.equal(s.integrity, true, "attacker signature verifies — the forgery is a real CMS");
  // The verifier binds identity to the cert that ACTUALLY signed (the attacker via SKI),
  // not certificates[0]. So it is neither the genuine signer nor trusted, and the doc is invalid.
  assert.equal(s.signerCommonName, "Forger Key", "signer must resolve to the SKI-named (attacker) cert");
  assert.equal(s.trusted, false, "the attacker cert is not in the trust store");
  assert.equal(result.valid, false, "a forged seal must never be reported valid");
});

test("a genuine seal by the same code path still verifies (control)", async () => {
  const pdf = await makePdf();
  const signed = await sealPdf(pdf, trusted.credential, { signingTime: new Date("2026-07-11T12:00:00Z") });
  const result = await verifyPdf(signed, { trustStore: [trusted.credential.certificate()] });
  assert.equal(result.valid, true, JSON.stringify(result.signatures[0].problems));
  assert.equal(result.signatures[0].signerCommonName, "Genuine Platform Seal");
});

test("a CMS with an empty SignerInfos SET is reported invalid, not thrown", async () => {
  const emptyCms = (): Promise<Uint8Array> =>
    Promise.resolve(
      new Uint8Array(
        new ContentInfo({
          contentType: OID.SIGNED_DATA,
          content: new SignedData({
            version: 1,
            digestAlgorithms: [new AlgorithmIdentifier({ algorithmId: OID.SHA256 })],
            encapContentInfo: new EncapsulatedContentInfo({ eContentType: OID.DATA }),
            signerInfos: [],
          }).toSchema(true),
        })
          .toSchema()
          .toBER(false)
      )
    );
  const pdf = await makePdf();
  const signed = await sealWithCms(pdf, emptyCms);

  // Must resolve to a verdict (valid=false), never throw out of verifyPdf.
  const result = await verifyPdf(signed, { trustStore: [trusted.credential.certificate()] });
  assert.equal(result.valid, false);
  assert.ok(
    result.signatures[0].problems.some((p) => /no SignerInfo/i.test(p)),
    JSON.stringify(result.signatures[0].problems)
  );
});
