import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { generateSelfSignedCredential, LocalSigningCredential, certFromDer } from "../src/index";

// Generated once (RSA keygen is slow) and reused.
const seal = generateSelfSignedCredential({ commonName: "FineSign Test Seal", organization: "FineSign" });

test("self-signed credential exposes cert + CN and signs verifiably", async () => {
  const cred = seal.credential;
  assert.equal(cred.subjectCommonName(), "FineSign Test Seal");
  assert.equal(cred.signatureScheme(), "RSASSA-PKCS1-v1_5");
  assert.equal(cred.digestAlgorithm(), "SHA-256");

  const tbs = crypto.randomBytes(64);
  const sig = await cred.sign(tbs);
  // Verify the signature with the certificate's public key (RSASSA-PKCS1 / SHA-256).
  const cert = certFromDer(cred.certificate());
  const spki = Buffer.from(new Uint8Array(cert.subjectPublicKeyInfo.toSchema().toBER(false)));
  const pubKey = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  assert.ok(crypto.verify("sha256", tbs, pubKey, sig), "signature must verify with the cert public key");
});

test("PKCS#12 round-trips: load with the passphrase, sign the same way", async () => {
  const loaded = LocalSigningCredential.fromPkcs12(seal.pkcs12, seal.passphrase);
  assert.equal(loaded.subjectCommonName(), "FineSign Test Seal");
  const tbs = crypto.randomBytes(32);
  const sig = await loaded.sign(tbs);
  const cert = certFromDer(loaded.certificate());
  const spki = Buffer.from(new Uint8Array(cert.subjectPublicKeyInfo.toSchema().toBER(false)));
  const pubKey = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  assert.ok(crypto.verify("sha256", tbs, pubKey, sig));
});

test("wrong PKCS#12 passphrase is rejected", () => {
  assert.throws(() => LocalSigningCredential.fromPkcs12(seal.pkcs12, "wrong-pass"), /PKCS#12|passphrase/i);
});

export { seal };
