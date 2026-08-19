import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { NullLogger, SystemClock } from "@finesign/shared";
import {
  generateSelfSignedCredential,
  generateSelfSignedTsaCredential,
  generateTestCa,
  createInProcessTsa,
  createInProcessValidationDataProvider,
} from "@finesign/pades";
import { buildInMemoryContainer } from "../src/container";
import { createHttpServer } from "../src/http";
import { PadesDocumentSealer } from "../src/sealer";
import { CapturingMailer } from "../src/mailer";
import { makePdf, signaturePngDataUrl, tokenFromLink } from "./helpers";

const API_KEY = "seal-test-key-abcdef1234";
// One self-signed seal for the whole file (RSA keygen is slow).
const seal = generateSelfSignedCredential({ commonName: "FineSign Seal" });
const tsaCred = generateSelfSignedTsaCredential({ commonName: "FineSign Server TSA" });

async function setup() {
  const mailer = new CapturingMailer();
  const { app } = buildInMemoryContainer({
    mailer,
    logger: new NullLogger(),
    sealer: new PadesDocumentSealer(seal.credential),
    config: { devExposeTokens: true },
  });
  const server = await createHttpServer(app, {
    logger: new NullLogger(),
    senderApiKey: API_KEY,
    publicRateLimitPerMin: 100000,
    globalRateLimitPerMin: 100000,
  });
  return { server, mailer };
}

const j = (res: { payload: string }) => JSON.parse(res.payload);
function mgmt(server: FastifyInstance, method: string, url: string, payload?: unknown) {
  return server.inject({ method: method as "GET" | "POST", url, payload: payload as object | undefined, headers: { authorization: `Bearer ${API_KEY}` } });
}

test("completed document is PAdES-sealed and verifies; tampering is detected", async () => {
  const { server, mailer } = await setup();

  let res = await mgmt(server, "POST", "/api/envelopes", { title: "Sealed Deal", senderName: "Ops", senderEmail: "ops@co.test" });
  const id = j(res).id;
  const pdf = await makePdf(1);
  res = await mgmt(server, "POST", `/api/envelopes/${id}/documents`, { name: "deal.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  const doc = j(res).documents[0];
  res = await mgmt(server, "POST", `/api/envelopes/${id}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  const alice = j(res).recipients[0].id;
  await mgmt(server, "POST", `/api/envelopes/${id}/fields`, { documentId: doc.id, recipientId: alice, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  await mgmt(server, "POST", `/api/envelopes/${id}/send`);
  const token = tokenFromLink(mailer.to("alice@x.test")[0].link);

  res = await server.inject({ method: "POST", url: `/sign/${token}/apply`, payload: { signature: { kind: "image", dataUrl: signaturePngDataUrl() } , consent: true } });
  assert.equal(j(res).status, "completed");

  // Verify endpoint: the completed document carries a valid, trusted seal.
  res = await mgmt(server, "GET", `/api/envelopes/${id}/documents/${doc.id}/verify`);
  assert.equal(res.statusCode, 200);
  const verdict = j(res);
  assert.equal(verdict.valid, true, JSON.stringify(verdict.signatures?.[0]?.problems));
  assert.equal(verdict.signatureCount, 1);
  assert.equal(verdict.signatures[0].integrity, true);
  assert.equal(verdict.signatures[0].coversWholeDocument, true);
  assert.equal(verdict.signatures[0].trusted, true);
  assert.equal(verdict.signatures[0].signerCommonName, "FineSign Seal");

  // The downloaded sealed PDF is a valid PDF that our verifier confirms directly.
  res = await mgmt(server, "GET", `/api/envelopes/${id}/documents/${doc.id}/download`);
  assert.equal(res.rawPayload.subarray(0, 5).toString("latin1"), "%PDF-");
  const sealer = new PadesDocumentSealer(seal.credential);
  const direct = await sealer.verify(new Uint8Array(res.rawPayload));
  assert.equal(direct.valid, true);
  // Tamper the downloaded bytes → verification fails.
  const tampered = Buffer.from(res.rawPayload);
  tampered[40] = tampered[40] ^ 0xff;
  const bad = await sealer.verify(new Uint8Array(tampered));
  assert.equal(bad.valid, false);

  await server.close();
});

test("every document is sealed at completion, including one with no fields (C2)", async () => {
  const { server, mailer } = await setup();
  let res = await mgmt(server, "POST", "/api/envelopes", { title: "Two Docs", senderName: "Ops", senderEmail: "ops@co.test" });
  const id = j(res).id;
  const pdf = await makePdf(1);
  res = await mgmt(server, "POST", `/api/envelopes/${id}/documents`, { name: "signed.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  const withField = j(res).documents[0];
  res = await mgmt(server, "POST", `/api/envelopes/${id}/documents`, { name: "nofield.pdf", format: "pdf", contentBase64: Buffer.from(await makePdf(1)).toString("base64") });
  const noField = j(res).documents[1];
  res = await mgmt(server, "POST", `/api/envelopes/${id}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  const alice = j(res).recipients[0].id;
  await mgmt(server, "POST", `/api/envelopes/${id}/fields`, { documentId: withField.id, recipientId: alice, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  await mgmt(server, "POST", `/api/envelopes/${id}/send`);
  const token = tokenFromLink(mailer.to("alice@x.test")[0].link);
  await server.inject({ method: "POST", url: `/sign/${token}/apply`, payload: { signature: { kind: "typed", name: "Alice", font: "great_vibes" } , consent: true } });

  // BOTH documents — the signed one AND the no-field one — verify as sealed.
  for (const docId of [withField.id, noField.id]) {
    const v = j(await mgmt(server, "GET", `/api/envelopes/${id}/documents/${docId}/verify`));
    assert.equal(v.valid, true, `document ${docId} should be sealed: ${JSON.stringify(v.signatures?.[0]?.problems)}`);
  }
  await server.close();
});

test("a timestamping sealer (B-T) produces a completed doc with a valid timestamp", async () => {
  const mailer = new CapturingMailer();
  const tsa = createInProcessTsa({ credential: tsaCred.credential, clock: new SystemClock() });
  const { app } = buildInMemoryContainer({
    mailer,
    logger: new NullLogger(),
    sealer: new PadesDocumentSealer(seal.credential, {
      timestampAuthority: tsa,
      tsaTrustStore: [tsaCred.credential.certificate()],
    }),
    config: { devExposeTokens: true },
  });
  const server = await createHttpServer(app, {
    logger: new NullLogger(),
    senderApiKey: API_KEY,
    publicRateLimitPerMin: 100000,
    globalRateLimitPerMin: 100000,
  });

  let res = await mgmt(server, "POST", "/api/envelopes", { title: "Timestamped", senderName: "Ops", senderEmail: "ops@co.test" });
  const id = j(res).id;
  res = await mgmt(server, "POST", `/api/envelopes/${id}/documents`, { name: "deal.pdf", format: "pdf", contentBase64: Buffer.from(await makePdf(1)).toString("base64") });
  const doc = j(res).documents[0];
  res = await mgmt(server, "POST", `/api/envelopes/${id}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  const alice = j(res).recipients[0].id;
  await mgmt(server, "POST", `/api/envelopes/${id}/fields`, { documentId: doc.id, recipientId: alice, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  await mgmt(server, "POST", `/api/envelopes/${id}/send`);
  const token = tokenFromLink(mailer.to("alice@x.test")[0].link);
  await server.inject({ method: "POST", url: `/sign/${token}/apply`, payload: { signature: { kind: "image", dataUrl: signaturePngDataUrl() } , consent: true } });

  const verdict = j(await mgmt(server, "GET", `/api/envelopes/${id}/documents/${doc.id}/verify`));
  assert.equal(verdict.valid, true, JSON.stringify(verdict.signatures?.[0]?.problems));
  assert.equal(verdict.signatures[0].timestamp.present, true);
  assert.equal(verdict.signatures[0].timestamp.valid, true, JSON.stringify(verdict.signatures[0].problems));
  assert.ok(verdict.signatures[0].timestamp.time, "timestamp time should be reported");
  await server.close();
});

test("a B-LTA sealer produces a completed doc that verifies at level B-LTA", async () => {
  const mailer = new CapturingMailer();
  const ca = generateTestCa({ commonName: "Server LT CA" });
  const ltLeaf = ca.issueLeaf({ commonName: "Server LT Seal" });
  const tsaLt = createInProcessTsa({ credential: tsaCred.credential, clock: new SystemClock() });
  const { app } = buildInMemoryContainer({
    mailer,
    logger: new NullLogger(),
    sealer: new PadesDocumentSealer(ltLeaf.credential, {
      level: "B-LTA",
      timestampAuthority: tsaLt,
      tsaTrustStore: [tsaCred.credential.certificate()],
      validationDataProvider: createInProcessValidationDataProvider({ ca, clock: new SystemClock() }),
      trustStore: [ca.certificateDer()],
    }),
    config: { devExposeTokens: true },
  });
  const server = await createHttpServer(app, {
    logger: new NullLogger(),
    senderApiKey: API_KEY,
    publicRateLimitPerMin: 100000,
    globalRateLimitPerMin: 100000,
  });

  let res = await mgmt(server, "POST", "/api/envelopes", { title: "LTA", senderName: "Ops", senderEmail: "ops@co.test" });
  const id = j(res).id;
  res = await mgmt(server, "POST", `/api/envelopes/${id}/documents`, { name: "deal.pdf", format: "pdf", contentBase64: Buffer.from(await makePdf(1)).toString("base64") });
  const doc = j(res).documents[0];
  res = await mgmt(server, "POST", `/api/envelopes/${id}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  const alice = j(res).recipients[0].id;
  await mgmt(server, "POST", `/api/envelopes/${id}/fields`, { documentId: doc.id, recipientId: alice, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  await mgmt(server, "POST", `/api/envelopes/${id}/send`);
  const token = tokenFromLink(mailer.to("alice@x.test")[0].link);
  await server.inject({ method: "POST", url: `/sign/${token}/apply`, payload: { signature: { kind: "typed", name: "Alice", font: "great_vibes" } , consent: true } });

  const verdict = j(await mgmt(server, "GET", `/api/envelopes/${id}/documents/${doc.id}/verify`));
  assert.equal(verdict.valid, true, JSON.stringify(verdict.signatures?.map((s: { problems: string[] }) => s.problems)));
  assert.equal(verdict.level, "B-LTA");
  assert.equal(verdict.documentTimestamp.valid, true);
  assert.equal(verdict.documentTimestamp.coversDss, true);
  await server.close();
});

test("access-code auth gates the session; ESIGN consent + trustProxy IP are captured", async () => {
  const mailer = new CapturingMailer();
  const { app } = buildInMemoryContainer({ mailer, logger: new NullLogger(), config: { devExposeTokens: true } });
  const server = await createHttpServer(app, {
    logger: new NullLogger(),
    senderApiKey: API_KEY,
    trustProxy: true,
    publicRateLimitPerMin: 100000,
    globalRateLimitPerMin: 100000,
  });

  let res = await mgmt(server, "POST", "/api/envelopes", { title: "Gated", senderName: "Ops", senderEmail: "ops@co.test" });
  const id = j(res).id;
  res = await mgmt(server, "POST", `/api/envelopes/${id}/documents`, { name: "d.pdf", format: "pdf", contentBase64: Buffer.from(await makePdf(1)).toString("base64") });
  const doc = j(res).documents[0];
  res = await mgmt(server, "POST", `/api/envelopes/${id}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1, authMethod: "access_code", accessCode: "0428" });
  const alice = j(res).recipients[0].id;
  await mgmt(server, "POST", `/api/envelopes/${id}/fields`, { documentId: doc.id, recipientId: alice, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  await mgmt(server, "POST", `/api/envelopes/${id}/send`);
  const token = tokenFromLink(mailer.to("alice@x.test")[0].link);

  // The session is gated: no documents revealed until authenticated.
  let sess = j(await server.inject({ method: "GET", url: `/sign/${token}` }));
  assert.equal(sess.authRequired, true);
  assert.equal(sess.authenticated, false);
  assert.equal(sess.documents.length, 0);
  // Documents are not fetchable before auth.
  assert.equal((await server.inject({ method: "GET", url: `/sign/${token}/documents/${doc.id}` })).statusCode, 403);
  // A wrong code is rejected.
  assert.equal((await server.inject({ method: "POST", url: `/sign/${token}/authenticate`, payload: { accessCode: "9999" } })).statusCode, 403);
  // The correct code authenticates.
  const authRes = await server.inject({ method: "POST", url: `/sign/${token}/authenticate`, payload: { accessCode: "0428" } });
  assert.equal(j(authRes).authenticated, true);

  // Now the session reveals the documents + the consent disclosure.
  sess = j(await server.inject({ method: "GET", url: `/sign/${token}` }));
  assert.equal(sess.authenticated, true);
  assert.ok(sess.documents.length >= 1);
  assert.match(sess.consent.disclosure, /ESIGN/);

  // Sign with consent + a forwarded client IP.
  const sres = await server.inject({
    method: "POST",
    url: `/sign/${token}/apply`,
    headers: { "x-forwarded-for": "198.51.100.9", "user-agent": "TestAgent/9" },
    payload: { signature: { kind: "typed", name: "Alice", font: "great_vibes" }, consent: true },
  });
  assert.equal(j(sres).status, "completed");

  // The captured identity + audit events land on the envelope.
  const env = j(await mgmt(server, "GET", `/api/envelopes/${id}`));
  const rec = env.recipients.find((r: { id: string }) => r.id === alice);
  assert.equal(rec.signerIp, "198.51.100.9", "trustProxy X-Forwarded-For is captured");
  assert.equal(rec.signerUserAgent, "TestAgent/9");
  assert.ok(rec.consentedAt);
  // Credential-equivalent hashes are NEVER serialized to clients.
  assert.equal(rec.accessCodeHash, null, "accessCodeHash must be redacted from API responses");
  assert.equal(rec.tokenHash, null, "tokenHash must be redacted from API responses");
  assert.ok(env.audit.some((e: { type: string }) => e.type === "recipient_authenticated"));
  assert.ok(env.audit.some((e: { type: string }) => e.type === "recipient_consented"));
  await server.close();
});

test("a hostile signer User-Agent (non-WinAnsi) does NOT crash certificate/completion", async () => {
  const { server, mailer } = await setup();
  let res = await mgmt(server, "POST", "/api/envelopes", { title: "UA 😀", senderName: "Ops", senderEmail: "ops@co.test" });
  const id = j(res).id;
  res = await mgmt(server, "POST", `/api/envelopes/${id}/documents`, { name: "d.pdf", format: "pdf", contentBase64: Buffer.from(await makePdf(1)).toString("base64") });
  const doc = j(res).documents[0];
  res = await mgmt(server, "POST", `/api/envelopes/${id}/recipients`, { name: "Signør 😀", email: "s@x.test", role: "signer", routingOrder: 1 });
  const s = j(res).recipients[0].id;
  await mgmt(server, "POST", `/api/envelopes/${id}/fields`, { documentId: doc.id, recipientId: s, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  await mgmt(server, "POST", `/api/envelopes/${id}/send`);
  const token = tokenFromLink(mailer.to("s@x.test")[0].link);

  // A user-agent with emoji + an undefined-WinAnsi byte (0x81) would crash a naive
  // pdf-lib drawText inside finalize — completion must still succeed.
  const sres = await server.inject({
    method: "POST",
    url: `/sign/${token}/apply`,
    headers: { "user-agent": "Mozilla/5.0 😀  中文", "content-type": "application/json" },
    payload: { signature: { kind: "typed", name: "Signør", font: "great_vibes" }, consent: true },
  });
  assert.equal(j(sres).status, "completed", "completion must not crash on a hostile UA");
  // The sealed document (with the appended certificate) is a valid PDF.
  const dl = await mgmt(server, "GET", `/api/envelopes/${id}/documents/${doc.id}/download`);
  assert.equal(dl.rawPayload.subarray(0, 5).toString("latin1"), "%PDF-");
  await server.close();
});

test("text + checkbox fields are captured and stamped into the completed document", async () => {
  const { server, mailer } = await setup();
  let res = await mgmt(server, "POST", "/api/envelopes", { title: "Form", senderName: "Ops", senderEmail: "ops@co.test" });
  const id = j(res).id;
  res = await mgmt(server, "POST", `/api/envelopes/${id}/documents`, { name: "form.pdf", format: "pdf", contentBase64: Buffer.from(await makePdf(1)).toString("base64") });
  const doc = j(res).documents[0];
  res = await mgmt(server, "POST", `/api/envelopes/${id}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  const alice = j(res).recipients[0].id;
  // A signature + a text + a checkbox field.
  await mgmt(server, "POST", `/api/envelopes/${id}/fields`, { documentId: doc.id, recipientId: alice, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  res = await mgmt(server, "POST", `/api/envelopes/${id}/fields`, { documentId: doc.id, recipientId: alice, page: 1, x: 0.1, y: 0.6, width: 0.4, height: 0.03, kind: "text", required: true });
  const textField = j(res).fields.find((f: { kind: string }) => f.kind === "text").id;
  res = await mgmt(server, "POST", `/api/envelopes/${id}/fields`, { documentId: doc.id, recipientId: alice, page: 1, x: 0.1, y: 0.5, width: 0.03, height: 0.03, kind: "checkbox", required: true });
  const checkField = j(res).fields.find((f: { kind: string }) => f.kind === "checkbox").id;
  await mgmt(server, "POST", `/api/envelopes/${id}/send`);
  const token = tokenFromLink(mailer.to("alice@x.test")[0].link);

  // Missing the required text value → rejected (400), envelope not completed.
  const bad = await server.inject({
    method: "POST", url: `/sign/${token}/apply`,
    payload: { signature: { kind: "typed", name: "Alice", font: "great_vibes" }, consent: true, fieldValues: [{ fieldId: checkField, value: "true" }] },
  });
  assert.equal(bad.statusCode, 400, "a missing required field is a 400");

  // Complete → the document completes and is a valid PDF.
  const ok = await server.inject({
    method: "POST", url: `/sign/${token}/apply`,
    payload: {
      signature: { kind: "typed", name: "Alice", font: "great_vibes" },
      consent: true,
      fieldValues: [{ fieldId: textField, value: "Alice Anderson" }, { fieldId: checkField, value: "true" }],
    },
  });
  assert.equal(j(ok).status, "completed");
  const dl = await mgmt(server, "GET", `/api/envelopes/${id}/documents/${doc.id}/download`);
  assert.equal(dl.rawPayload.subarray(0, 5).toString("latin1"), "%PDF-");
  // The captured values are recorded on the envelope fields.
  const env = j(await mgmt(server, "GET", `/api/envelopes/${id}`));
  assert.equal(env.fields.find((f: { id: string }) => f.id === textField).value, "Alice Anderson");
  assert.equal(env.fields.find((f: { id: string }) => f.id === checkField).value, "true");
  await server.close();
});

test("without a sealer, verify reports no signatures (unsealed mode)", async () => {
  const { app } = buildInMemoryContainer({ logger: new NullLogger() }); // no sealer
  const server = await createHttpServer(app, { logger: new NullLogger(), senderApiKey: API_KEY, globalRateLimitPerMin: 100000, publicRateLimitPerMin: 100000 });
  const res = await mgmt(server, "POST", "/api/envelopes", { title: "x", senderName: "s", senderEmail: "s@x.test" });
  const id = j(res).id;
  const r2 = await mgmt(server, "GET", `/api/envelopes/${id}/documents/anything/verify`);
  assert.equal(r2.statusCode, 200);
  assert.equal(j(r2).valid, false);
  assert.equal(j(r2).signatureCount, 0);
  await server.close();
});
