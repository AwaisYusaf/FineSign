/**
 * What a recipient's link shows and accepts: document scoping for fieldless
 * recipients, the access code on the finished package, the "already signed"
 * state, and signer input that would be stamped wrongly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { FixedClock, NullLogger, SeededIdGenerator } from "@finesign/shared";
import type { Field } from "@finesign/domain";
import { SignEngine, type SignaturePlacement } from "finesign-core";
import { buildInMemoryContainer } from "../src/container";
import { createHttpServer } from "../src/http";
import { CapturingMailer } from "../src/mailer";
import { initialsOf, stampForRecipient } from "../src/stamping";
import { makePdf, tokenFromLink } from "./helpers";

const API_KEY = "test-sender-key-abc123";
const j = (res: { payload: string }) => JSON.parse(res.payload);

async function setup() {
  const mailer = new CapturingMailer();
  const logger = new NullLogger();
  const { app } = buildInMemoryContainer({
    clock: new FixedClock("2026-07-10T00:00:00.000Z"),
    ids: new SeededIdGenerator("ses"),
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
  return { server, mailer };
}

function mgmt(server: FastifyInstance, method: string, url: string, payload?: unknown) {
  return server.inject({
    method: method as "GET" | "POST",
    url,
    payload: payload as object | undefined,
    headers: { authorization: `Bearer ${API_KEY}` },
  });
}

type RecipientSpec = { name: string; email: string; role: string; routingOrder: number; accessCode?: string };
type FieldSpec = { email: string; kind: string; y?: number };

/** Create and send an envelope with one document. Returns ids by email. */
async function sendEnvelope(
  server: FastifyInstance,
  routingType: "sequential" | "parallel",
  recipients: RecipientSpec[],
  fields: FieldSpec[]
) {
  let res = await mgmt(server, "POST", "/api/envelopes", { title: "T", senderName: "Ops", senderEmail: "ops@co.test", routingType });
  const envId = j(res).id as string;
  const pdf = await makePdf(1);
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/documents`, { name: "d.pdf", format: "pdf", contentBase64: Buffer.from(pdf).toString("base64") });
  const docId = j(res).documents[0].id as string;
  const ids: Record<string, string> = {};
  for (const r of recipients) {
    const { accessCode, ...rest } = r;
    const body = accessCode ? { ...rest, authMethod: "access_code", accessCode } : rest;
    res = await mgmt(server, "POST", `/api/envelopes/${envId}/recipients`, body);
    assert.equal(res.statusCode, 201, res.payload);
    ids[r.email] = (j(res).recipients as { id: string; email: string }[]).find((x) => x.email === r.email)!.id;
  }
  const fieldIds: string[] = [];
  for (const f of fields) {
    res = await mgmt(server, "POST", `/api/envelopes/${envId}/fields`, {
      documentId: docId, recipientId: ids[f.email], page: 1, x: 0.1, y: f.y ?? 0.8, width: 0.3, height: 0.05, kind: f.kind,
    });
    assert.equal(res.statusCode, 201, res.payload);
    fieldIds.push((j(res).fields as { id: string }[]).at(-1)!.id);
  }
  res = await mgmt(server, "POST", `/api/envelopes/${envId}/send`);
  assert.equal(res.statusCode, 200, res.payload);
  return { envId, docId, ids, fieldIds };
}

const linkFor = (mailer: CapturingMailer, email: string, subject = /^Please sign/) =>
  tokenFromLink(mailer.to(email).find((m) => subject.test(m.subject))!.link);

const apply = (server: FastifyInstance, token: string, name: string, extra: Record<string, unknown> = {}) =>
  server.inject({
    method: "POST",
    url: `/sign/${token}/apply`,
    payload: { signature: { kind: "typed", name, font: "great_vibes" }, consent: true, ...extra },
  });

test("an approver with no fields sees the documents while signing is open", async () => {
  // validateForSend lets an approver have no fields; scoping the session to
  // "documents carrying your fields" left them nothing to approve.
  const { server, mailer } = await setup();
  const { docId } = await sendEnvelope(
    server,
    "parallel",
    [
      { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 },
      { name: "Ann", email: "ann@x.test", role: "approver", routingOrder: 1 },
    ],
    [{ email: "alice@x.test", kind: "signature" }]
  );
  const token = linkFor(mailer, "ann@x.test");
  const session = await server.inject({ method: "GET", url: `/sign/${token}` });
  assert.equal(session.statusCode, 200, session.payload);
  assert.deepEqual(j(session).documents.map((d: { id: string }) => d.id), [docId]);
  assert.deepEqual(j(session).documents[0].fields, []);
  const doc = await server.inject({ method: "GET", url: `/sign/${token}/documents/${docId}` });
  assert.equal(doc.statusCode, 200);
  await server.close();
});

test("a cc's access code still guards the completed package", async () => {
  const { server, mailer } = await setup();
  const { docId } = await sendEnvelope(
    server,
    "sequential",
    [
      { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 },
      { name: "Carol", email: "carol@x.test", role: "cc", routingOrder: 2, accessCode: "2468" },
    ],
    [{ email: "alice@x.test", kind: "signature" }]
  );
  assert.equal(j(await apply(server, linkFor(mailer, "alice@x.test"), "Alice")).status, "completed");

  const token = linkFor(mailer, "carol@x.test", /^Completed/);
  let session = j(await server.inject({ method: "GET", url: `/sign/${token}` }));
  assert.equal(session.status, "completed");
  // Previously `authenticated: true` here while the download itself 403'd.
  assert.equal(session.authRequired, true);
  assert.equal(session.authenticated, false);
  assert.deepEqual(session.documents, [], "documents stay hidden until the code is entered");
  const locked = await server.inject({ method: "GET", url: `/sign/${token}/documents/${docId}` });
  assert.equal(locked.statusCode, 403);

  const wrong = await server.inject({ method: "POST", url: `/sign/${token}/authenticate`, payload: { accessCode: "0000" } });
  assert.equal(wrong.statusCode, 403, wrong.payload);
  const right = await server.inject({ method: "POST", url: `/sign/${token}/authenticate`, payload: { accessCode: "2468" } });
  assert.equal(right.statusCode, 200, right.payload);
  assert.equal(j(right).authenticated, true);

  session = j(await server.inject({ method: "GET", url: `/sign/${token}` }));
  assert.equal(session.authenticated, true);
  assert.deepEqual(session.documents.map((d: { id: string }) => d.id), [docId]);
  const doc = await server.inject({ method: "GET", url: `/sign/${token}/documents/${docId}` });
  assert.equal(doc.statusCode, 200);
  await server.close();
});

test("a signer who reopens their link after signing is told they are done", async () => {
  const { server, mailer } = await setup();
  await sendEnvelope(
    server,
    "sequential",
    [
      { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 },
      { name: "Bob", email: "bob@x.test", role: "signer", routingOrder: 2 },
    ],
    [
      { email: "alice@x.test", kind: "signature" },
      { email: "bob@x.test", kind: "signature", y: 0.6 },
    ]
  );
  const token = linkFor(mailer, "alice@x.test");
  let session = j(await server.inject({ method: "GET", url: `/sign/${token}` }));
  assert.equal(session.recipient.status, "viewed");
  assert.equal(j(await apply(server, token, "Alice")).status, "sent");
  session = j(await server.inject({ method: "GET", url: `/sign/${token}` }));
  assert.equal(session.status, "sent", "Bob has not signed yet");
  assert.equal(session.recipient.status, "signed");
  await server.close();
});

test("a typed name the chosen font can't draw is refused, and nothing is saved", async () => {
  // pdf-lib draws a character the handwriting font lacks as an empty box, so
  // this used to stamp boxes onto a signed document without a word.
  const { server, mailer } = await setup();
  const { envId } = await sendEnvelope(
    server,
    "sequential",
    [{ name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 }],
    [{ email: "alice@x.test", kind: "signature" }]
  );
  const token = linkFor(mailer, "alice@x.test");
  const refused = await apply(server, token, "李小龍");
  assert.equal(refused.statusCode, 400, refused.payload);
  assert.equal(j(refused).error.code, "VALIDATION_ERROR");
  assert.match(j(refused).error.message, /Great Vibes signature style can't draw "李", "小", "龍"/);

  const env = j(await mgmt(server, "GET", `/api/envelopes/${envId}`));
  assert.equal(env.status, "sent");
  assert.notEqual(env.recipients[0].status, "signed");
  assert.ok(!env.audit.some((e: { type: string }) => e.type === "recipient_signed"));

  // Accented Latin is fine, and the same signer can then sign.
  assert.equal(j(await apply(server, token, "Zoë Nguyễn")).status, "completed");
  await server.close();
});

test("a text value the document font can't print is refused", async () => {
  const { server, mailer } = await setup();
  const { envId, fieldIds } = await sendEnvelope(
    server,
    "sequential",
    [{ name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 }],
    [
      { email: "alice@x.test", kind: "signature" },
      { email: "alice@x.test", kind: "text", y: 0.6 },
    ]
  );
  const token = linkFor(mailer, "alice@x.test");
  const textField = fieldIds[1]!;
  const refused = await apply(server, token, "Alice", { fieldValues: [{ fieldId: textField, value: "Москва" }] });
  assert.equal(refused.statusCode, 400, refused.payload);
  assert.match(j(refused).error.message, /can't print: "М", "о", "с", "к", "в", "а"/);
  assert.equal(j(await mgmt(server, "GET", `/api/envelopes/${envId}`)).status, "sent");

  // The limit is Latin-1, not "Latin": Central European letters are refused too
  // (until text fields embed a Unicode font, BACKLOG U.18), and the message says so.
  const czech = await apply(server, token, "Alice", { fieldValues: [{ fieldId: textField, value: "Antonín Dvořák" }] });
  assert.equal(czech.statusCode, 400, czech.payload);
  assert.match(j(czech).error.message, /can't print: "ř"\. Text fields support Western European \(Latin-1\) characters only\./);

  // A long run of unprintable text is summarised, not echoed back in full.
  const many = await apply(server, token, "Alice", { fieldValues: [{ fieldId: textField, value: "абвгдежзийклм" }] });
  assert.match(j(many).error.message, /"з", and 5 more\./);

  // WinAnsi covers accented Latin and the euro sign; a pasted newline is flattened,
  // and an accent pasted as a separate combining mark (NFD) is composed first.
  const nfd = "Cafe\u0301 Zoe\u0308";
  const ok = await apply(server, token, "Zoe\u0308 Nguyê\u0303n", { fieldValues: [{ fieldId: textField, value: `${nfd}\n€ 12` }] });
  assert.equal(j(ok).status, "completed", ok.payload);
  await server.close();
});

test("initials fields are stamped with initials, not the full name", async () => {
  class CapturingEngine extends SignEngine {
    placements: SignaturePlacement[] = [];
    override async signWithTypedNames(bytes: Uint8Array, placements: SignaturePlacement[]) {
      this.placements.push(...placements);
      return super.signWithTypedNames(bytes, placements);
    }
  }
  const engine = new CapturingEngine();
  const base = { documentId: "d", recipientId: "r", page: 1, x: 0.1, width: 0.3, height: 0.05, required: true, value: null };
  const fields = [
    { ...base, id: "s", y: 0.8, kind: "signature" },
    { ...base, id: "i", y: 0.6, kind: "initials" },
  ] as Field[];
  await stampForRecipient(engine, await makePdf(1), fields, { kind: "typed", name: "Jane Q. Public", font: "great_vibes" });
  assert.deepEqual(engine.placements.map((p) => p.signatureName), ["Jane Q. Public", "JQP"]);
  // Core fits each name to its field's measured width (script capitals ran past it).
  assert.deepEqual(engine.placements.map((p) => p.maxWidthPercent), [0.3, 0.3]);

  // Stamped as one normalized line: an IME's ideographic space, a newline, or an
  // invisible zero-width space were drawn as boxes (or a second line) before.
  const names = new CapturingEngine();
  for (const name of ["Taro\u3000Yamada", "Jane\nDoe", "Li\u200bLei Wong"]) {
    await stampForRecipient(names, await makePdf(1), [fields[0]!], { kind: "typed", name, font: "great_vibes" });
  }
  assert.deepEqual(names.placements.map((p) => p.signatureName), ["Taro Yamada", "Jane Doe", "LiLei Wong"]);

  assert.equal(initialsOf("  zoë   nguyễn "), "ZN");
  assert.equal(initialsOf("Cher"), "C");
});
