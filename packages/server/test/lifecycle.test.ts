import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { FixedClock, SeededIdGenerator, NullLogger } from "@finesign/shared";
import { verifyAuditChain } from "@finesign/domain";
import { buildInMemoryContainer } from "../src/container";
import { createHttpServer } from "../src/http";
import { CapturingMailer } from "../src/mailer";
import { makePdf, fakeDocxBytes, signaturePngDataUrl, tokenFromLink } from "./helpers";

const API_KEY = "test-sender-key-abc123";

async function setup(opts: { rateLimit?: number } = {}) {
  const mailer = new CapturingMailer();
  const logger = new NullLogger();
  const clock = new FixedClock("2026-07-10T00:00:00.000Z");
  const pdfForDocx = await makePdf(1);
  const { app } = buildInMemoryContainer({
    clock,
    ids: new SeededIdGenerator("srv"),
    mailer,
    logger,
    docxRunner: async () => pdfForDocx, // fake LibreOffice
    config: { baseUrl: "https://finesign.test" },
  });
  const server = await createHttpServer(app, {
    logger,
    senderApiKey: API_KEY,
    publicRateLimitPerMin: opts.rateLimit ?? 100000,
    globalRateLimitPerMin: 100000,
  });
  return { server, mailer, clock };
}

/** Create + send a one-signer PDF envelope. Returns ids + the signer's token. */
async function sendOneSigner(
  server: FastifyInstance,
  mailer: CapturingMailer,
  body: Record<string, unknown> = {}
) {
  let res = await mgmt(server, "POST", "/api/envelopes", { title: "T", senderName: "Ops", senderEmail: "ops@co.test", routingType: "sequential" });
  const envId = j(res).id;
  const pdf = await makePdf(1);
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/documents`, { name: "d.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  const docId = j(res).documents[0].id;
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  const alice = j(res).recipients[0].id;
  await mgmt(server, "POST", `/api/envelopes/${envId}/fields`, { documentId: docId, recipientId: alice, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/send`, body);
  assert.equal(res.statusCode, 200, res.payload);
  const token = tokenFromLink(mailer.to("alice@x.test")[0].link);
  return { envId, docId, alice, token };
}

const j = (res: { payload: string }) => JSON.parse(res.payload);

/** Inject a MANAGEMENT (/api) request with the sender API key attached. */
function mgmt(server: FastifyInstance, method: string, url: string, payload?: unknown) {
  return server.inject({
    method: method as "GET" | "POST",
    url,
    payload: payload as object | undefined,
    headers: { authorization: `Bearer ${API_KEY}` },
  });
}

test("full lifecycle: PDF + DOCX, two sequential signers, draft → completed", async () => {
  const { server, mailer } = await setup();

  let res = await mgmt(server, "POST", "/api/envelopes", { title: "Master Agreement", senderName: "Ops", senderEmail: "ops@co.test", routingType: "sequential" });
  assert.equal(res.statusCode, 201);
  const envId = j(res).id;

  const pdf = await makePdf(2);
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/documents`, { name: "agreement.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  assert.equal(res.statusCode, 201);
  const doc1 = j(res).documents[0];
  assert.equal(doc1.pageCount, 2);

  res = await mgmt(server, "POST", `/api/envelopes/${envId}/documents`, { name: "addendum.docx", format: "docx", contentBase64: Buffer.from(fakeDocxBytes()).toString("base64") });
  assert.equal(res.statusCode, 201);
  const doc2 = j(res).documents[1];
  assert.equal(doc2.format, "docx");
  assert.equal(doc2.pageCount, 1);

  res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  const alice = j(res).recipients.find((r: { name: string }) => r.name === "Alice").id;
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients`, { name: "Bob", email: "bob@x.test", role: "signer", routingOrder: 2 });
  const bob = j(res).recipients.find((r: { name: string }) => r.name === "Bob").id;

  await mgmt(server, "POST", `/api/envelopes/${envId}/fields`, { documentId: doc1.id, recipientId: alice, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  await mgmt(server, "POST", `/api/envelopes/${envId}/fields`, { documentId: doc1.id, recipientId: alice, page: 1, x: 0.5, y: 0.8, width: 0.2, height: 0.04, kind: "date_signed" });
  await mgmt(server, "POST", `/api/envelopes/${envId}/fields`, { documentId: doc2.id, recipientId: bob, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });

  res = await mgmt(server, "POST", `/api/envelopes/${envId}/send`);
  assert.equal(res.statusCode, 200);
  assert.equal(j(res).status, "sent");
  assert.equal(mailer.to("alice@x.test").length, 1);
  assert.equal(mailer.to("bob@x.test").length, 0);
  const aliceToken = tokenFromLink(mailer.to("alice@x.test")[0].link);

  // Public signer route — NO API key needed (token authenticates).
  res = await server.inject({ method: "GET", url: `/sign/${aliceToken}` });
  assert.equal(res.statusCode, 200);
  const session = j(res);
  assert.equal(session.recipient.name, "Alice");
  assert.equal(session.documents.length, 1);
  assert.equal(session.documents[0].fields.length, 2);

  // The signer can fetch their document's PDF bytes to render it.
  res = await server.inject({ method: "GET", url: `/sign/${aliceToken}/documents/${doc1.id}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.rawPayload.subarray(0, 5).toString("latin1"), "%PDF-");
  // But not a document they carry no field on.
  res = await server.inject({ method: "GET", url: `/sign/${aliceToken}/documents/${doc2.id}` });
  assert.equal(res.statusCode, 404);

  res = await server.inject({ method: "POST", url: `/sign/${aliceToken}/apply`, payload: { signature: { kind: "image", dataUrl: signaturePngDataUrl() } , consent: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(j(res).status, "sent");
  assert.equal(mailer.to("bob@x.test").length, 1);
  const bobToken = tokenFromLink(mailer.to("bob@x.test")[0].link);

  res = await server.inject({ method: "POST", url: `/sign/${bobToken}/apply`, payload: { signature: { kind: "typed", name: "Bob Roberts", font: "great_vibes" } , consent: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(j(res).status, "completed");

  assert.ok(mailer.to("alice@x.test").some((m) => m.subject.startsWith("Completed")));
  assert.ok(mailer.to("bob@x.test").some((m) => m.subject.startsWith("Completed")));

  res = await mgmt(server, "GET", `/api/envelopes/${envId}/documents/${doc1.id}/download`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/pdf");
  assert.equal(res.rawPayload.subarray(0, 5).toString("latin1"), "%PDF-");
  // M6.1: the certificate of completion is appended, so the sealed doc has MORE
  // pages than the original 2.
  const { PDFDocument } = await import("pdf-lib");
  const sealed = await PDFDocument.load(res.rawPayload);
  assert.ok(sealed.getPageCount() > 2, `expected certificate pages appended, got ${sealed.getPageCount()}`);

  res = await mgmt(server, "GET", `/api/envelopes/${envId}/certificate`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.rawPayload.subarray(0, 5).toString("latin1"), "%PDF-");

  res = await mgmt(server, "GET", `/api/envelopes/${envId}`);
  const env = j(res);
  assert.equal(env.status, "completed");
  assert.ok(env.documents[0].signedBlobKey);
  assert.ok(env.documents[1].signedBlobKey);
  assert.equal(verifyAuditChain(env.audit), -1);
  assert.ok(env.audit.some((e: { type: string }) => e.type === "envelope_completed"));

  await server.close();
});

test("management routes reject requests without the API key (S1)", async () => {
  const { server } = await setup();
  // No auth header → 403, and the list endpoint must NOT leak envelopes.
  let res = await server.inject({ method: "GET", url: "/api/envelopes" });
  assert.equal(res.statusCode, 403);
  // Wrong key → 403.
  res = await server.inject({ method: "GET", url: "/api/envelopes", headers: { authorization: "Bearer wrong" } });
  assert.equal(res.statusCode, 403);
  // Correct key → 200.
  res = await mgmt(server, "GET", "/api/envelopes");
  assert.equal(res.statusCode, 200);
  await server.close();
});

test("createHttpServer refuses to start without a senderApiKey", async () => {
  const { app } = buildInMemoryContainer();
  await assert.rejects(
    () => createHttpServer(app, { logger: new NullLogger(), senderApiKey: "" }),
    /senderApiKey/
  );
});

test("decline notifies sender + participants with a 'Declined' message, not 'Completed'", async () => {
  const { server, mailer } = await setup();
  let res = await mgmt(server, "POST", "/api/envelopes", { title: "Deal", senderName: "Ops", senderEmail: "ops@co.test" });
  const id = j(res).id;
  const pdf = await makePdf(1);
  res = await mgmt(server, "POST", `/api/envelopes/${id}/documents`, { name: "d.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  const doc = j(res).documents[0];
  res = await mgmt(server, "POST", `/api/envelopes/${id}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  const alice = j(res).recipients[0].id;
  await mgmt(server, "POST", `/api/envelopes/${id}/fields`, { documentId: doc.id, recipientId: alice, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  await mgmt(server, "POST", `/api/envelopes/${id}/send`);
  const token = tokenFromLink(mailer.to("alice@x.test")[0].link);

  res = await server.inject({ method: "POST", url: `/sign/${token}/decline`, payload: { reason: "wrong terms" } });
  assert.equal(res.statusCode, 200);
  assert.equal(j(res).status, "declined");
  // Sender is told, and the message says Declined (not "Completed"/"signed copy").
  const senderMsgs = mailer.to("ops@co.test");
  assert.ok(senderMsgs.some((m) => m.subject.startsWith("Declined") && /wrong terms/.test(m.text)));
  assert.ok(!mailer.sent.some((m) => /signed copy is available/.test(m.text)));
  await server.close();
});

test("field placed off the page edge is rejected (K5)", async () => {
  const { server } = await setup();
  let res = await mgmt(server, "POST", "/api/envelopes", { title: "x", senderName: "s", senderEmail: "s@x.test" });
  const id = j(res).id;
  const pdf = await makePdf(1);
  res = await mgmt(server, "POST", `/api/envelopes/${id}/documents`, { name: "d.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  const doc = j(res).documents[0];
  res = await mgmt(server, "POST", `/api/envelopes/${id}/recipients`, { name: "A", email: "a@x.test", role: "signer", routingOrder: 1 });
  const rid = j(res).recipients[0].id;
  // x + width = 1.4 → spills off the right edge.
  res = await mgmt(server, "POST", `/api/envelopes/${id}/fields`, { documentId: doc.id, recipientId: rid, page: 1, x: 0.9, y: 0.5, width: 0.5, height: 0.05, kind: "signature" });
  assert.equal(res.statusCode, 400);
  assert.match(j(res).error.message, /off the page|right edge/);
  await server.close();
});

test("invalid signing token is rejected with 403", async () => {
  const { server } = await setup();
  const res = await server.inject({ method: "GET", url: "/sign/not-a-real-token" });
  assert.equal(res.statusCode, 403);
  assert.equal(j(res).error.code, "FORBIDDEN");
  await server.close();
});

test("upload with mismatched magic bytes is rejected with 400", async () => {
  const { server } = await setup();
  let res = await mgmt(server, "POST", "/api/envelopes", { title: "x", senderName: "s", senderEmail: "s@x.test" });
  const id = j(res).id;
  res = await mgmt(server, "POST", `/api/envelopes/${id}/documents`, { name: "fake.pdf", format: "pdf", contentBase64: Buffer.from("not a pdf at all").toString("base64") });
  assert.equal(res.statusCode, 400);
  assert.equal(j(res).error.code, "VALIDATION_ERROR");
  await server.close();
});

test("sending an incomplete envelope returns a validation error", async () => {
  const { server } = await setup();
  let res = await mgmt(server, "POST", "/api/envelopes", { title: "empty", senderName: "s", senderEmail: "s@x.test" });
  const id = j(res).id;
  res = await mgmt(server, "POST", `/api/envelopes/${id}/send`);
  assert.equal(res.statusCode, 400);
  assert.equal(j(res).error.code, "VALIDATION_ERROR");
  await server.close();
});

test("dev-links endpoint is empty unless devExposeTokens is on", async () => {
  // Default: off → no links even after send.
  const off = await setup();
  let res = await mgmt(off.server, "POST", "/api/envelopes", { title: "x", senderName: "s", senderEmail: "s@x.test" });
  const id = j(res).id;
  const pdf = await makePdf(1);
  res = await mgmt(off.server, "POST", `/api/envelopes/${id}/documents`, { name: "d.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  const doc = j(res).documents[0];
  res = await mgmt(off.server, "POST", `/api/envelopes/${id}/recipients`, { name: "A", email: "a@x.test", role: "signer", routingOrder: 1 });
  const rid = j(res).recipients[0].id;
  await mgmt(off.server, "POST", `/api/envelopes/${id}/fields`, { documentId: doc.id, recipientId: rid, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  await mgmt(off.server, "POST", `/api/envelopes/${id}/send`);
  res = await mgmt(off.server, "GET", `/api/envelopes/${id}/dev-links`);
  assert.equal(j(res).links.length, 0);
  await off.server.close();

  // On → the sent envelope's signer link is exposed.
  const mailer = new CapturingMailer();
  const { app } = buildInMemoryContainer({ mailer, config: { devExposeTokens: true } });
  const server = await createHttpServer(app, { logger: new NullLogger(), senderApiKey: API_KEY, globalRateLimitPerMin: 100000, publicRateLimitPerMin: 100000 });
  res = await mgmt(server, "POST", "/api/envelopes", { title: "y", senderName: "s", senderEmail: "s@x.test" });
  const id2 = j(res).id;
  res = await mgmt(server, "POST", `/api/envelopes/${id2}/documents`, { name: "d.pdf", format: "pdf", contentBase64: Buffer.from(await makePdf(1)).toString("base64") });
  const doc2 = j(res).documents[0];
  res = await mgmt(server, "POST", `/api/envelopes/${id2}/recipients`, { name: "A", email: "a@x.test", role: "signer", routingOrder: 1 });
  const rid2 = j(res).recipients[0].id;
  await mgmt(server, "POST", `/api/envelopes/${id2}/fields`, { documentId: doc2.id, recipientId: rid2, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  await mgmt(server, "POST", `/api/envelopes/${id2}/send`);
  res = await mgmt(server, "GET", `/api/envelopes/${id2}/dev-links`);
  const links = j(res).links;
  assert.equal(links.length, 1);
  assert.match(links[0].link, /\/sign\//);
  await server.close();
});

test("serves an OpenAPI document enumerating the routes", async () => {
  const { server } = await setup();
  const res = await server.inject({ method: "GET", url: "/openapi.json" });
  assert.equal(res.statusCode, 200);
  const spec = j(res);
  assert.match(spec.openapi, /^3\./);
  assert.equal(spec.info.title, "FineSign API");
  const paths = Object.keys(spec.paths);
  assert.ok(paths.includes("/api/envelopes"), "should document envelope routes");
  assert.ok(paths.some((p) => p.includes("/sign/{token}/apply")), "should document the signer apply route");
  await server.close();
});

test("public signing routes are rate-limited", async () => {
  const { server } = await setup({ rateLimit: 1 });
  const first = await server.inject({ method: "GET", url: "/sign/whatever" });
  assert.notEqual(first.statusCode, 429);
  const second = await server.inject({ method: "GET", url: "/sign/whatever" });
  assert.equal(second.statusCode, 429);
  await server.close();
});

// ── DG3: expiration + resend + reminders ────────────────────────────────────

test("DG3: an expired envelope refuses signing (lazy) and notifies the sender", async () => {
  const { server, mailer, clock } = await setup();
  const { token } = await sendOneSigner(server, mailer, { expiresInDays: 7 });

  // Before the deadline the session opens fine.
  assert.equal((await server.inject({ method: "GET", url: `/sign/${token}` })).statusCode, 200);

  clock.advance(8 * 24 * 3600 * 1000); // jump past the 7-day deadline

  // Next touch expires it lazily → 409, and refuses the session.
  const res = await server.inject({ method: "GET", url: `/sign/${token}` });
  assert.equal(res.statusCode, 409);
  assert.match(j(res).error.message, /expired/i);

  // The sender was emailed exactly once about the expiry.
  const expiredMsgs = mailer.to("ops@co.test").filter((m) => m.subject.startsWith("Expired"));
  assert.equal(expiredMsgs.length, 1);

  await server.close();
});

test("DG3: sweep-expired transitions overdue envelopes and is idempotent", async () => {
  const { server, mailer, clock } = await setup();
  const { envId } = await sendOneSigner(server, mailer, { expiresInDays: 1 });

  // Not yet due → sweep is a no-op.
  let res = await mgmt(server, "POST", "/api/envelopes/sweep-expired");
  assert.equal(j(res).expired, 0);

  clock.advance(2 * 24 * 3600 * 1000);

  res = await mgmt(server, "POST", "/api/envelopes/sweep-expired");
  assert.equal(j(res).expired, 1);
  assert.equal(j(await mgmt(server, "GET", `/api/envelopes/${envId}`)).status, "expired");

  // Second sweep finds nothing (already expired).
  res = await mgmt(server, "POST", "/api/envelopes/sweep-expired");
  assert.equal(j(res).expired, 0);

  await server.close();
});

test("DG3: send rejects a non-positive expiresInDays", async () => {
  const { server } = await setup();
  // Build an envelope but drive send directly to assert the validation.
  let res = await mgmt(server, "POST", "/api/envelopes", { title: "T", senderName: "Ops", senderEmail: "ops@co.test", routingType: "sequential" });
  const envId = j(res).id;
  const pdf = await makePdf(1);
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/documents`, { name: "d.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  const docId = j(res).documents[0].id;
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  const alice = j(res).recipients[0].id;
  await mgmt(server, "POST", `/api/envelopes/${envId}/fields`, { documentId: docId, recipientId: alice, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/send`, { expiresInDays: -1 });
  assert.equal(res.statusCode, 400);
  assert.match(j(res).error.message, /positive number/);
  await server.close();
});

test("DG3: resend re-mints a working link; the old token stops resolving", async () => {
  const { server, mailer } = await setup();
  const { envId, alice, token: firstToken } = await sendOneSigner(server, mailer);
  assert.equal(mailer.to("alice@x.test").length, 1);

  const res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients/${alice}/resend`);
  assert.equal(res.statusCode, 200);
  assert.equal(mailer.to("alice@x.test").length, 2);

  const newToken = tokenFromLink(mailer.to("alice@x.test")[1].link);
  assert.notEqual(newToken, firstToken, "resend mints a fresh token");

  // The rotated (old) token no longer resolves; the new one does.
  assert.equal((await server.inject({ method: "GET", url: `/sign/${firstToken}` })).statusCode, 403);
  assert.equal((await server.inject({ method: "GET", url: `/sign/${newToken}` })).statusCode, 200);

  await server.close();
});

test("DG3: remind emails the signer with a 'Reminder' subject", async () => {
  const { server, mailer } = await setup();
  const { envId, alice } = await sendOneSigner(server, mailer);

  const res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients/${alice}/remind`);
  assert.equal(res.statusCode, 200);
  assert.ok(mailer.to("alice@x.test").some((m) => m.subject.startsWith("Reminder")));

  await server.close();
});

test("DG3: resend after an envelope completes is a 409", async () => {
  const { server, mailer } = await setup();
  const { envId, alice, token } = await sendOneSigner(server, mailer);
  const signed = await server.inject({ method: "POST", url: `/sign/${token}/apply`, payload: { signature: { kind: "typed", name: "Alice", font: "great_vibes" }, consent: true } });
  assert.equal(j(signed).status, "completed");

  const res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients/${alice}/resend`);
  assert.equal(res.statusCode, 409);

  await server.close();
});

// ── Signer-input validation: bad signature payloads are 400s, not 500s ────────
// Regression: an unknown font key and a malformed signature image both used to
// escape as opaque 500 "internal server error" (and log at error level), because
// the font was cast unchecked at the HTTP boundary and finesign-core's typed
// errors were never mapped. Both are SIGNER input — they must be 400.

test("apply: an unknown typed-signature font is a 400 naming the supported fonts", async () => {
  const { server, mailer } = await setup();
  const { token } = await sendOneSigner(server, mailer);

  const res = await server.inject({
    method: "POST",
    url: `/sign/${token}/apply`,
    payload: { signature: { kind: "typed", name: "Alice", font: "comic_sans" }, consent: true },
  });
  assert.equal(res.statusCode, 400, res.payload);
  assert.equal(j(res).error.code, "VALIDATION_ERROR");
  assert.deepEqual(j(res).error.details.supported, [
    "dancing_script",
    "great_vibes",
    "pacifico",
    "pinyon_script",
  ]);

  await server.close();
});

test("apply: an empty typed-signature name is a 400", async () => {
  const { server, mailer } = await setup();
  const { token } = await sendOneSigner(server, mailer);

  const res = await server.inject({
    method: "POST",
    url: `/sign/${token}/apply`,
    payload: { signature: { kind: "typed", name: "   ", font: "great_vibes" }, consent: true },
  });
  assert.equal(res.statusCode, 400, res.payload);

  await server.close();
});

test("apply: a malformed signature image is a 400, and the envelope stays signable", async () => {
  const { server, mailer } = await setup();
  const { token } = await sendOneSigner(server, mailer);

  const bad = await server.inject({
    method: "POST",
    url: `/sign/${token}/apply`,
    payload: { signature: { kind: "image", dataUrl: "data:image/png;base64,bm90YW5pbWFnZQ==" }, consent: true },
  });
  assert.equal(bad.statusCode, 400, bad.payload);
  assert.equal(j(bad).error.code, "VALIDATION_ERROR");
  assert.match(j(bad).error.message, /PNG or JPEG/);

  // The rejected attempt must not have consumed the recipient's turn.
  const ok = await server.inject({
    method: "POST",
    url: `/sign/${token}/apply`,
    payload: { signature: { kind: "image", dataUrl: signaturePngDataUrl() }, consent: true },
  });
  assert.equal(ok.statusCode, 200, ok.payload);
  assert.equal(j(ok).status, "completed");

  await server.close();
});

// ── Notification delivery is best-effort AFTER the state is durable ───────────
// Regression: `persistThenDeliver` saves the aggregate and then sends mail. A
// transient SMTP failure escaped as a 500 for work that had already committed —
// the envelope was sent and the tokens issued, but the sender saw failure and a
// retry would 409. State is durable; delivery is best-effort and logged.

test("send: a mailer failure does not fail the request or lose the transition", async () => {
  const mailer = new CapturingMailer();
  const logger = new NullLogger();
  const failing = {
    async send(message: Parameters<typeof mailer.send>[0]) {
      if (message.to === "alice@x.test") throw new Error("smtp connect ECONNREFUSED");
      await mailer.send(message);
    },
  };
  const { app } = buildInMemoryContainer({
    clock: new FixedClock("2026-07-10T00:00:00.000Z"),
    ids: new SeededIdGenerator("mailfail"),
    mailer: failing,
    logger,
    config: { baseUrl: "https://finesign.test" },
  });
  const server = await createHttpServer(app, {
    logger,
    senderApiKey: API_KEY,
    publicRateLimitPerMin: 100000,
    globalRateLimitPerMin: 100000,
  });

  let res = await mgmt(server, "POST", "/api/envelopes", { title: "T", senderName: "Ops", senderEmail: "ops@co.test", routingType: "parallel" });
  const envId = j(res).id;
  const pdf = await makePdf(1);
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/documents`, { name: "d.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  const docId = j(res).documents[0].id;
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  const alice = j(res).recipients[0].id;
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients`, { name: "Bob", email: "bob@x.test", role: "signer", routingOrder: 1 });
  const bob = j(res).recipients[1].id;
  for (const r of [alice, bob]) {
    await mgmt(server, "POST", `/api/envelopes/${envId}/fields`, { documentId: docId, recipientId: r, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  }

  res = await mgmt(server, "POST", `/api/envelopes/${envId}/send`);
  assert.equal(res.statusCode, 200, res.payload);
  assert.equal(j(res).status, "sent");

  // Alice's delivery blew up; Bob's must still have gone out, and both are
  // recorded as notified so the sender can recover with resend.
  assert.equal(mailer.to("bob@x.test").length, 1);
  assert.equal(mailer.to("alice@x.test").length, 0);
  const stored = j(await mgmt(server, "GET", `/api/envelopes/${envId}`));
  assert.equal(stored.recipients.find((r: { id: string }) => r.id === alice).status, "notified");
  assert.equal(stored.recipients.find((r: { id: string }) => r.id === bob).status, "notified");

  await server.close();
});

test("DG3: the sweep drains a backlog larger than one batch", async () => {
  // The sweep now claims bounded batches off an indexed query instead of
  // scanning the table, so it must keep going until the due set is empty.
  const mailer = new CapturingMailer();
  const logger = new NullLogger();
  const clock = new FixedClock("2026-07-10T00:00:00.000Z");
  const { app } = buildInMemoryContainer({
    clock,
    ids: new SeededIdGenerator("sweep"),
    mailer,
    logger,
    config: { baseUrl: "https://finesign.test" },
  });
  const server = await createHttpServer(app, {
    logger,
    senderApiKey: API_KEY,
    publicRateLimitPerMin: 100000,
    globalRateLimitPerMin: 100000,
  });

  const pdf = Buffer.from(await makePdf(1)).toString("base64");
  for (let i = 0; i < 5; i++) {
    let res = await mgmt(server, "POST", "/api/envelopes", { title: `E${i}`, senderName: "Ops", senderEmail: "ops@co.test", routingType: "sequential" });
    const envId = j(res).id;
    res = await mgmt(server, "POST", `/api/envelopes/${envId}/documents`, { name: "d.pdf", format: "pdf", contentBase64: pdf });
    const docId = j(res).documents[0].id;
    res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients`, { name: "A", email: `a${i}@x.test`, role: "signer", routingOrder: 1 });
    const rid = j(res).recipients[0].id;
    await mgmt(server, "POST", `/api/envelopes/${envId}/fields`, { documentId: docId, recipientId: rid, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
    await mgmt(server, "POST", `/api/envelopes/${envId}/send`, { expiresInDays: 1 });
  }

  clock.set("2026-07-12T00:00:00.000Z");
  // A batch size below the backlog forces the loop to iterate.
  assert.equal(await app.sweepExpired(2), 5);
  assert.equal(await app.sweepExpired(2), 0, "a second sweep finds nothing");

  const listed = j(await mgmt(server, "GET", "/api/envelopes")) as { status: string }[];
  assert.ok(listed.every((e) => e.status === "expired"), "every envelope should be expired");

  await server.close();
});

// ── After completion, a recipient can actually GET the copy they were promised ─
// Regression: the completion mail told every recipient "a signed copy is
// available", but carried no link, and their token 409'd because `getSession`
// required status `sent`. A cc recipient never had a token at all.

test("completion: a signer's link keeps working and serves the signed copy", async () => {
  const { server, mailer } = await setup();
  const { docId, token } = await sendOneSigner(server, mailer);

  const signed = await server.inject({
    method: "POST",
    url: `/sign/${token}/apply`,
    payload: { signature: { kind: "typed", name: "Alice", font: "great_vibes" }, consent: true },
  });
  assert.equal(j(signed).status, "completed");

  // The completion mail must carry a link the recipient can follow.
  const completionMail = mailer.to("alice@x.test").find((m) => m.subject.startsWith("Completed"));
  assert.ok(completionMail?.link, "the completed-copy mail carries a link");
  const freshToken = tokenFromLink(completionMail.link);

  const session = await server.inject({ method: "GET", url: `/sign/${freshToken}` });
  assert.equal(session.statusCode, 200, session.payload);
  assert.equal(j(session).status, "completed");
  assert.equal(j(session).documents.length, 1);
  assert.deepEqual(j(session).documents[0].fields, [], "nothing left to fill in");

  const doc = await server.inject({ method: "GET", url: `/sign/${freshToken}/documents/${docId}` });
  assert.equal(doc.statusCode, 200);
  assert.equal(doc.headers["content-type"], "application/pdf");
  assert.match(String(doc.headers["content-disposition"]), /\.signed\.pdf/);

  // It must be the SIGNED artifact, not the blank original they signed on top of.
  const senderCopy = await mgmt(server, "GET", `/api/envelopes/${j(session).envelopeId}/documents/${docId}/download`);
  assert.equal(doc.rawPayload.length, senderCopy.rawPayload.length);

  await server.close();
});

test("completion: a cc recipient is given a link to the finished package", async () => {
  const { server, mailer } = await setup();

  let res = await mgmt(server, "POST", "/api/envelopes", { title: "T", senderName: "Ops", senderEmail: "ops@co.test", routingType: "sequential" });
  const envId = j(res).id;
  const pdf = await makePdf(1);
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/documents`, { name: "d.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  const docId = j(res).documents[0].id;
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  const alice = j(res).recipients[0].id;
  await mgmt(server, "POST", `/api/envelopes/${envId}/recipients`, { name: "Watcher", email: "cc@x.test", role: "cc", routingOrder: 2 });
  await mgmt(server, "POST", `/api/envelopes/${envId}/fields`, { documentId: docId, recipientId: alice, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  await mgmt(server, "POST", `/api/envelopes/${envId}/send`);

  const token = tokenFromLink(mailer.to("alice@x.test")[0].link);
  await server.inject({
    method: "POST",
    url: `/sign/${token}/apply`,
    payload: { signature: { kind: "typed", name: "Alice", font: "great_vibes" }, consent: true },
  });

  // A cc recipient hears nothing until completion — then gets the whole package.
  const ccMail = mailer.to("cc@x.test");
  assert.equal(ccMail.length, 1);
  assert.ok(ccMail[0].link, "the cc recipient gets a link");
  const ccSession = await server.inject({ method: "GET", url: `/sign/${tokenFromLink(ccMail[0].link)}` });
  assert.equal(ccSession.statusCode, 200, ccSession.payload);
  assert.equal(j(ccSession).documents.length, 1);

  await server.close();
});

test("completion: a signer cannot reach a document they were never party to", async () => {
  const { server, mailer } = await setup();

  let res = await mgmt(server, "POST", "/api/envelopes", { title: "T", senderName: "Ops", senderEmail: "ops@co.test", routingType: "sequential" });
  const envId = j(res).id;
  const pdf = await makePdf(1);
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/documents`, { name: "mine.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  const mine = j(res).documents[0].id;
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/documents`, { name: "theirs.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  const theirs = j(res).documents[1].id;
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  const alice = j(res).recipients[0].id;
  await mgmt(server, "POST", `/api/envelopes/${envId}/fields`, { documentId: mine, recipientId: alice, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  await mgmt(server, "POST", `/api/envelopes/${envId}/send`);

  const token = tokenFromLink(mailer.to("alice@x.test")[0].link);
  await server.inject({
    method: "POST",
    url: `/sign/${token}/apply`,
    payload: { signature: { kind: "typed", name: "Alice", font: "great_vibes" }, consent: true },
  });
  const fresh = tokenFromLink(mailer.to("alice@x.test").find((m) => m.subject.startsWith("Completed"))!.link);

  // Completion is not a reason to widen what a recipient may see.
  const session = await server.inject({ method: "GET", url: `/sign/${fresh}` });
  assert.deepEqual(j(session).documents.map((d: { id: string }) => d.id), [mine]);
  const denied = await server.inject({ method: "GET", url: `/sign/${fresh}/documents/${theirs}` });
  assert.equal(denied.statusCode, 404, denied.payload);

  await server.close();
});

test("fields: a misplaced field can be removed from a draft, but not after send", async () => {
  const { server, mailer } = await setup();

  let res = await mgmt(server, "POST", "/api/envelopes", { title: "T", senderName: "Ops", senderEmail: "ops@co.test", routingType: "sequential" });
  const envId = j(res).id;
  const pdf = await makePdf(1);
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/documents`, { name: "d.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  const docId = j(res).documents[0].id;
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  const alice = j(res).recipients[0].id;
  const box = { documentId: docId, recipientId: alice, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05 };
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/fields`, { ...box, kind: "signature" });
  const keep = j(res).fields[0].id;
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/fields`, { ...box, y: 0.5, kind: "initials" });
  const stray = j(res).fields[1].id;

  res = await server.inject({
    method: "DELETE",
    url: `/api/envelopes/${envId}/fields/${stray}`,
    headers: { authorization: `Bearer ${API_KEY}` },
  });
  assert.equal(res.statusCode, 200, res.payload);
  assert.deepEqual(j(res).fields.map((f: { id: string }) => f.id), [keep]);

  const missing = await server.inject({
    method: "DELETE",
    url: `/api/envelopes/${envId}/fields/does-not-exist`,
    headers: { authorization: `Bearer ${API_KEY}` },
  });
  assert.equal(missing.statusCode, 404);

  await mgmt(server, "POST", `/api/envelopes/${envId}/send`);
  const afterSend = await server.inject({
    method: "DELETE",
    url: `/api/envelopes/${envId}/fields/${keep}`,
    headers: { authorization: `Bearer ${API_KEY}` },
  });
  assert.equal(afterSend.statusCode, 409, "a sent envelope's fields are immutable");
  void mailer;

  await server.close();
});

test("completion: an approver with no fields still receives the package", async () => {
  // `validateForSend` requires fields of SIGNERS only, so an approver can have
  // none — and then has no "their own documents" to scope to. Keying the
  // completed-package exception on the cc ROLE (rather than on having no fields)
  // handed such an approver an empty list after they had signed.
  const { server, mailer } = await setup();

  let res = await mgmt(server, "POST", "/api/envelopes", { title: "T", senderName: "Ops", senderEmail: "ops@co.test", routingType: "parallel" });
  const envId = j(res).id;
  const pdf = await makePdf(1);
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/documents`, { name: "d.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  const docId = j(res).documents[0].id;
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  const alice = j(res).recipients[0].id;
  await mgmt(server, "POST", `/api/envelopes/${envId}/recipients`, { name: "Ann", email: "ann@x.test", role: "approver", routingOrder: 1 });
  await mgmt(server, "POST", `/api/envelopes/${envId}/fields`, { documentId: docId, recipientId: alice, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  await mgmt(server, "POST", `/api/envelopes/${envId}/send`);

  const sign = async (email: string) => {
    const token = tokenFromLink(mailer.to(email)[0].link);
    return server.inject({
      method: "POST",
      url: `/sign/${token}/apply`,
      payload: { signature: { kind: "typed", name: email, font: "great_vibes" }, consent: true },
    });
  };
  await sign("alice@x.test");
  const done = await sign("ann@x.test");
  assert.equal(j(done).status, "completed", done.payload);

  const link = mailer.to("ann@x.test").find((m) => m.subject.startsWith("Completed"))!.link;
  const session = await server.inject({ method: "GET", url: `/sign/${tokenFromLink(link)}` });
  assert.equal(session.statusCode, 200, session.payload);
  assert.deepEqual(j(session).documents.map((d: { id: string }) => d.id), [docId]);

  const doc = await server.inject({ method: "GET", url: `/sign/${tokenFromLink(link)}/documents/${docId}` });
  assert.equal(doc.statusCode, 200);

  await server.close();
});
