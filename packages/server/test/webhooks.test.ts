import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { FixedClock, SeededIdGenerator, NullLogger } from "@finesign/shared";
import { buildInMemoryContainer } from "../src/container";
import { createHttpServer } from "../src/http";
import { CapturingMailer } from "../src/mailer";
import type { WebhookFetch, HostResolver, WebhookConfig } from "../src/webhooks";
import { makePdf, tokenFromLink } from "./helpers";

const API_KEY = "test-sender-key-abc123";
const SECRET = "supersecretwebhookkey01";

/** A fetch double: records every POST and returns a scriptable status. */
class CaptureFetch {
  readonly calls: { url: string; init: Parameters<WebhookFetch>[1] }[] = [];
  status = 200;
  handler: ((url: string) => number) | null = null;
  readonly fetchImpl: WebhookFetch = async (url, init) => {
    this.calls.push({ url, init });
    return { status: this.handler ? this.handler(url) : this.status };
  };
}

async function setup(opts: {
  resolveTo?: string[];
  config?: Partial<WebhookConfig>;
  fetch?: CaptureFetch;
} = {}) {
  const mailer = new CapturingMailer();
  const logger = new NullLogger();
  const clock = new FixedClock("2026-07-10T00:00:00.000Z");
  const capture = opts.fetch ?? new CaptureFetch();
  const resolveHost: HostResolver = async () => opts.resolveTo ?? ["93.184.216.34"];
  const pdfForDocx = await makePdf(1);
  const { app } = buildInMemoryContainer({
    clock,
    ids: new SeededIdGenerator("wh"),
    mailer,
    logger,
    docxRunner: async () => pdfForDocx,
    config: { baseUrl: "https://finesign.test" },
    webhooks: { config: opts.config, resolveHost, fetchImpl: capture.fetchImpl },
  });
  const server = await createHttpServer(app, {
    logger,
    senderApiKey: API_KEY,
    publicRateLimitPerMin: 100000,
    globalRateLimitPerMin: 100000,
  });
  return { server, mailer, clock, capture };
}

const j = (res: { payload: string }) => JSON.parse(res.payload);

function mgmt(server: FastifyInstance, method: string, url: string, payload?: unknown) {
  return server.inject({ method: method as "GET" | "POST" | "DELETE", url, payload: payload as object | undefined, headers: { authorization: `Bearer ${API_KEY}` } });
}

/** Create + send a one-signer PDF envelope; returns its id + the signer token. */
async function sendOneSigner(server: FastifyInstance, mailer: CapturingMailer) {
  let res = await mgmt(server, "POST", "/api/envelopes", { title: "T", senderName: "Ops", senderEmail: "ops@co.test", routingType: "sequential" });
  const envId = j(res).id;
  const pdf = await makePdf(1);
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/documents`, { name: "d.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  const docId = j(res).documents[0].id;
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients`, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  const alice = j(res).recipients[0].id;
  await mgmt(server, "POST", `/api/envelopes/${envId}/fields`, { documentId: docId, recipientId: alice, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" });
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/send`);
  assert.equal(res.statusCode, 200, res.payload);
  const token = tokenFromLink(mailer.to("alice@x.test")[0].link);
  return { envId, token };
}

test("webhook: subscribe → send → deliver posts an HMAC-signed, secret-free payload", async () => {
  const { server, mailer, capture } = await setup();

  const created = await mgmt(server, "POST", "/api/webhooks", { url: "https://hooks.receiver.test/finesign", secret: SECRET });
  assert.equal(created.statusCode, 201);
  assert.equal(j(created).secret, SECRET, "the secret is returned exactly once on creation");

  await sendOneSigner(server, mailer);

  const drain = await mgmt(server, "POST", "/api/webhooks/deliver");
  assert.equal(drain.statusCode, 200);
  assert.ok(j(drain).delivered >= 1, "at least one event delivered");
  assert.ok(capture.calls.length >= 1);

  // Find the envelope_sent delivery and verify its signature end-to-end.
  const sent = capture.calls.find((c) => c.init.headers["x-finesign-event"] === "envelope_sent");
  assert.ok(sent, "an envelope_sent event was POSTed");
  const ts = sent!.init.headers["x-finesign-timestamp"];
  const body = sent!.init.body;
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
  assert.equal(sent!.init.headers["x-finesign-signature"], expected, "HMAC signature verifies");

  // Payload is well-formed and carries NO secret/token material.
  const parsed = JSON.parse(body);
  assert.equal(parsed.event, "envelope_sent");
  assert.equal(parsed.envelope.status, "sent");
  assert.ok(!body.includes(SECRET), "secret never appears in the payload");
  assert.ok(!/tokenHash|accessCodeHash/.test(body), "no credential hashes in the payload");

  await server.close();
});

test("webhook: a failing endpoint is retried with backoff, then succeeds", async () => {
  const capture = new CaptureFetch();
  capture.status = 500;
  const { server, mailer, clock } = await setup({ fetch: capture, config: { maxAttempts: 5, backoffBaseMs: 5000 } });
  await mgmt(server, "POST", "/api/webhooks", { url: "https://hooks.receiver.test/x", secret: SECRET });
  await sendOneSigner(server, mailer);

  let drain = j(await mgmt(server, "POST", "/api/webhooks/deliver"));
  assert.ok(drain.retried >= 1, "failed deliveries are retried");
  assert.equal(drain.delivered, 0);

  // Not yet due (backoff) → a second immediate drain claims nothing.
  drain = j(await mgmt(server, "POST", "/api/webhooks/deliver"));
  assert.equal(drain.claimed, 0, "backoff holds the delivery until its next attempt time");

  // Advance past the 5s backoff and let the endpoint recover.
  capture.status = 200;
  clock.advance(6000);
  drain = j(await mgmt(server, "POST", "/api/webhooks/deliver"));
  assert.ok(drain.delivered >= 1, "delivery succeeds once the endpoint recovers");

  await server.close();
});

test("webhook: exhausting maxAttempts dead-letters the delivery", async () => {
  const capture = new CaptureFetch();
  capture.status = 500;
  const { server, mailer, clock } = await setup({ fetch: capture, config: { maxAttempts: 2, backoffBaseMs: 1000 } });
  const sub = j(await mgmt(server, "POST", "/api/webhooks", { url: "https://hooks.receiver.test/x", secret: SECRET }));
  await sendOneSigner(server, mailer);

  j(await mgmt(server, "POST", "/api/webhooks/deliver")); // attempt 1 → retried
  clock.advance(2000);
  j(await mgmt(server, "POST", "/api/webhooks/deliver")); // attempt 2 → dead

  const deliveries = j(await mgmt(server, "GET", `/api/webhooks/${sub.id}/deliveries`)).deliveries as { status: string; attempts: number }[];
  assert.ok(deliveries.some((d) => d.status === "dead" && d.attempts === 2), "delivery is dead-lettered after maxAttempts");

  await server.close();
});

test("webhook SSRF: a host resolving to a private IP is never fetched", async () => {
  const capture = new CaptureFetch();
  // URL host is a NAME (passes creation), but it resolves to the cloud-metadata IP.
  const { server, mailer } = await setup({ fetch: capture, resolveTo: ["169.254.169.254"] });
  await mgmt(server, "POST", "/api/webhooks", { url: "https://metadata.attacker.test/x", secret: SECRET });
  await sendOneSigner(server, mailer);

  const drain = j(await mgmt(server, "POST", "/api/webhooks/deliver"));
  assert.equal(drain.delivered, 0);
  assert.ok(drain.retried >= 1 || drain.dead >= 1, "the delivery failed the SSRF guard");
  assert.equal(capture.calls.length, 0, "fetch is never reached when the host resolves privately");

  await server.close();
});

test("webhook SSRF: creation rejects non-https and private-literal URLs", async () => {
  const { server } = await setup();
  assert.equal((await mgmt(server, "POST", "/api/webhooks", { url: "http://hooks.receiver.test/x", secret: SECRET })).statusCode, 400);
  assert.equal((await mgmt(server, "POST", "/api/webhooks", { url: "https://169.254.169.254/x", secret: SECRET })).statusCode, 400);
  assert.equal((await mgmt(server, "POST", "/api/webhooks", { url: "https://u:p@hooks.receiver.test/x", secret: SECRET })).statusCode, 400);
  assert.equal((await mgmt(server, "POST", "/api/webhooks", { url: "https://hooks.receiver.test/x", secret: "short" })).statusCode, 400);
  await server.close();
});

test("webhook: GET reads never expose the signing secret", async () => {
  const { server } = await setup();
  const sub = j(await mgmt(server, "POST", "/api/webhooks", { url: "https://hooks.receiver.test/x", secret: SECRET }));
  const list = j(await mgmt(server, "GET", "/api/webhooks")).subscriptions as Record<string, unknown>[];
  assert.equal(list.length, 1);
  assert.ok(!("secret" in list[0]), "list must not expose the secret");
  const one = j(await mgmt(server, "GET", `/api/webhooks/${sub.id}`));
  assert.ok(!("secret" in one), "get must not expose the secret");
  await server.close();
});

test("webhook: eventTypes filter delivers only matching events", async () => {
  const { server, mailer, capture } = await setup();
  await mgmt(server, "POST", "/api/webhooks", { url: "https://hooks.receiver.test/x", secret: SECRET, eventTypes: ["envelope_sent"] });
  const { token } = await sendOneSigner(server, mailer);
  // Complete the envelope so non-matching events (recipient_signed, completed) occur.
  await server.inject({ method: "POST", url: `/sign/${token}/apply`, payload: { signature: { kind: "typed", name: "Alice", font: "great_vibes" }, consent: true } });

  j(await mgmt(server, "POST", "/api/webhooks/deliver"));
  const events = new Set(capture.calls.map((c) => c.init.headers["x-finesign-event"]));
  assert.ok(events.has("envelope_sent"));
  assert.deepEqual([...events], ["envelope_sent"], "only the subscribed event type is delivered");

  await server.close();
});

test("webhook: overlapping drains never POST the same delivery twice (lease + re-entrancy guard)", async () => {
  const { server, mailer, capture } = await setup();
  await mgmt(server, "POST", "/api/webhooks", { url: "https://hooks.receiver.test/x", secret: SECRET });
  await sendOneSigner(server, mailer); // several pending deliveries

  // Fire three drains concurrently; the guard + lease must prevent double-delivery.
  await Promise.all([
    mgmt(server, "POST", "/api/webhooks/deliver"),
    mgmt(server, "POST", "/api/webhooks/deliver"),
    mgmt(server, "POST", "/api/webhooks/deliver"),
  ]);

  const deliveryIds = capture.calls.map((c) => c.init.headers["x-finesign-delivery"]);
  assert.equal(deliveryIds.length, new Set(deliveryIds).size, "no delivery id is POSTed more than once");

  await server.close();
});

test("webhook: a deleted subscription stops delivering (pending rows dead-letter)", async () => {
  const { server, mailer, capture } = await setup();
  const sub = j(await mgmt(server, "POST", "/api/webhooks", { url: "https://hooks.receiver.test/x", secret: SECRET }));
  await sendOneSigner(server, mailer);
  assert.equal((await mgmt(server, "DELETE", `/api/webhooks/${sub.id}`)).statusCode, 204);

  const drain = j(await mgmt(server, "POST", "/api/webhooks/deliver"));
  assert.equal(drain.delivered, 0);
  assert.equal(capture.calls.length, 0, "a deleted subscription is never POSTed to");
  assert.ok(drain.dead >= 1, "its queued deliveries are dead-lettered");

  await server.close();
});
