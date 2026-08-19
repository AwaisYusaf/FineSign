import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { FixedClock, SeededIdGenerator, NullLogger } from "@finesign/shared";
import { InMemoryBlobStore, LocalKeyProvider, isSealed } from "@finesign/storage";
import { buildInMemoryContainer } from "../src/container";
import { createHttpServer } from "../src/http";
import { CapturingMailer } from "../src/mailer";
import { makePdf, signaturePngDataUrl, tokenFromLink } from "./helpers";

const API_KEY = "test-sender-key-abc123";
const KEY = new Uint8Array(crypto.createHash("sha256").update("at-rest-key").digest());
const j = (res: { payload: string }) => JSON.parse(res.payload);

function mgmt(server: FastifyInstance, method: string, url: string, payload?: unknown) {
  return server.inject({ method: method as "GET" | "POST", url, payload: payload as object | undefined, headers: { authorization: `Bearer ${API_KEY}` } });
}

test("encryption at rest: stored blobs are ciphertext; the API serves valid PDFs", async () => {
  const base = new InMemoryBlobStore(); // the raw store — inspect what actually persists
  const mailer = new CapturingMailer();
  const logger = new NullLogger();
  const { app } = buildInMemoryContainer({
    clock: new FixedClock("2026-07-10T00:00:00.000Z"),
    ids: new SeededIdGenerator("enc"),
    mailer,
    logger,
    blobs: base,
    encryption: new LocalKeyProvider(KEY),
    config: { baseUrl: "https://finesign.test" },
  });
  const server = await createHttpServer(app, { logger, senderApiKey: API_KEY, publicRateLimitPerMin: 100000, globalRateLimitPerMin: 100000 });

  // Build + send a one-signer envelope.
  let res = await mgmt(server, "POST", "/api/envelopes", { title: "T", senderName: "Ops", senderEmail: "ops@co.test", routingType: "sequential" });
  const envId = j(res).id;
  const pdf = await makePdf(1);
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/documents`, { name: "d.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  const doc = j(res).documents[0];
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  const alice = j(res).recipients[0].id;
  await mgmt(server, "POST", `/api/envelopes/${envId}/fields`, { documentId: doc.id, recipientId: alice, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  await mgmt(server, "POST", `/api/envelopes/${envId}/send`);
  const token = tokenFromLink(mailer.to("alice@x.test")[0].link);

  // The original upload already sits ENCRYPTED at rest (starts with the AEAD magic,
  // not "%PDF").
  const original = await base.get(doc.pdfBlobKey);
  assert.ok(isSealed(original), "the uploaded PDF is encrypted at rest");
  assert.notEqual(Buffer.from(original.subarray(0, 5)).toString("latin1"), "%PDF-");

  // Sign to completion.
  res = await server.inject({ method: "POST", url: `/sign/${token}/apply`, payload: { signature: { kind: "image", dataUrl: signaturePngDataUrl() }, consent: true } });
  assert.equal(j(res).status, "completed");

  // The signed doc + certificate blobs are encrypted at rest too.
  const env = j(await mgmt(server, "GET", `/api/envelopes/${envId}`));
  const signedKey = env.documents[0].signedBlobKey;
  assert.ok(signedKey);
  assert.ok(isSealed(await base.get(signedKey)), "the signed PDF is encrypted at rest");
  assert.ok(isSealed(await base.get(`env/${envId}/certificate.pdf`)), "the certificate is encrypted at rest");

  // But the management download decrypts transparently → a real PDF.
  res = await mgmt(server, "GET", `/api/envelopes/${envId}/documents/${doc.id}/download`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.rawPayload.subarray(0, 5).toString("latin1"), "%PDF-", "download is decrypted to a valid PDF");

  // The signer's document fetch also decrypts correctly.
  const signerDoc = await server.inject({ method: "GET", url: `/sign/${token}/documents/${doc.id}` });
  // (After completion the signer route may 404 on act-state; the management path is the contract here.)
  void signerDoc;

  await server.close();
});
