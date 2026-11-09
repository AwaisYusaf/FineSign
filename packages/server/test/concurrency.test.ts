/**
 * Concurrent writes to one envelope.
 *
 * Regression (found by the browser E2E suite): with parallel routing, a signer
 * whose submission raced any other write to the same envelope — the co-signer
 * signing, or merely opening their link (which records "viewed") — got a raw
 * 409 "envelope … was modified concurrently (expected version 13, found 14)"
 * and their signature was not recorded. The repository's version check was
 * right to refuse the stale save; nothing retried the operation on fresh state.
 *
 * Every operation wrapped in `retryOnConflict` has a race test here, plus the
 * two ways a LOST completion used to leave a wrong standalone certificate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { FixedClock, SeededIdGenerator, NullLogger, ConflictError } from "@finesign/shared";
import { InMemoryBlobStore, InMemoryEnvelopeRepository } from "@finesign/storage";
import type { BlobStore, Envelope, EnvelopeRepository } from "@finesign/domain";
import { buildInMemoryContainer } from "../src/container";
import { CONFLICT_RETRY_LIMIT } from "../src/app";
import { CapturingMailer } from "../src/mailer";
import { makePdf, tokenFromLink } from "./helpers";

/** Wraps a repository so a test can slip a competing write in right before the
 *  next save — the exact interleaving two concurrent requests produce. */
function racingRepo(inner: EnvelopeRepository) {
  let beforeNextSave: (() => Promise<void>) | undefined;
  let alwaysConflict = false;
  let saves = 0;
  const repo = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "save") {
        return async (env: Envelope) => {
          saves++;
          if (alwaysConflict) throw new ConflictError("VERSION_CONFLICT", `envelope ${env.id} was modified concurrently`);
          const competing = beforeNextSave;
          beforeNextSave = undefined; // the competing write's own save goes straight through
          if (competing) await competing();
          return target.save(env);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    repo,
    raceNextSave: (fn: () => Promise<void>) => (beforeNextSave = fn),
    conflictForever: () => (alwaysConflict = true),
    saves: () => saves,
  };
}

/** Wraps a blob store so a test can run a competing request right before the
 *  next write to a matching key. */
function hookableBlobs(inner: BlobStore) {
  let hook: { pattern: RegExp; fn: () => Promise<unknown> } | undefined;
  const blobs = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "put") {
        return async (key: string, ...rest: unknown[]) => {
          const pending = hook;
          if (pending && pending.pattern.test(key)) {
            hook = undefined;
            await pending.fn();
          }
          return (target.put as (...a: unknown[]) => Promise<void>).call(target, key, ...rest);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { blobs, beforeNextPut: (pattern: RegExp, fn: () => Promise<unknown>) => (hook = { pattern, fn }) };
}

const SIG = { kind: "typed" as const, name: "Signer", font: "great_vibes" as const };
const CTX = { ip: "203.0.113.7", userAgent: "test", consented: true };

/**
 * A sent envelope. Default: PARALLEL, Alice + Bob, one signature field each.
 * `solo` sends to Alice alone; `bobAccessCode` puts Bob behind an access code.
 */
async function sentEnvelope(opts: { solo?: boolean; bobAccessCode?: string } = {}) {
  const racing = racingRepo(new InMemoryEnvelopeRepository());
  const blobHook = hookableBlobs(new InMemoryBlobStore());
  const mailer = new CapturingMailer();
  const { app, deps } = buildInMemoryContainer({
    repo: racing.repo,
    blobs: blobHook.blobs,
    mailer,
    clock: new FixedClock("2026-11-09T00:00:00.000Z"),
    ids: new SeededIdGenerator("race"),
    logger: new NullLogger(),
    webhooks: null,
    config: { baseUrl: "https://finesign.test" },
  });
  let env = await app.createDraft({ title: "Race", routingType: "parallel", senderName: "Ops", senderEmail: "ops@co.test" });
  env = await app.addDocument(env.id, { name: "d.pdf", format: "pdf", bytes: await makePdf(1) });
  const documentId = env.documents[0].id;
  env = await app.addRecipient(env.id, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  if (!opts.solo) {
    env = await app.addRecipient(env.id, {
      name: "Bob",
      email: "bob@x.test",
      role: "signer",
      routingOrder: 1,
      ...(opts.bobAccessCode ? { authMethod: "access_code" as const, accessCode: opts.bobAccessCode } : {}),
    });
  }
  for (const [i, r] of env.recipients.entries()) {
    await app.addField(env.id, { documentId, recipientId: r.id, page: 1, x: 0.1, y: 0.2 + i * 0.2, width: 0.3, height: 0.05, kind: "signature" });
  }
  await app.send(env.id);
  /** The newest link mailed to someone (remind/resend/completion re-mint it). */
  const token = (email: string) => tokenFromLink(mailer.to(email).at(-1)!.link);
  const recipientId = (name: string) => env.recipients.find((r) => r.name === name)!.id;
  const status = async () =>
    Object.fromEntries((await app.getEnvelope(env.id)).recipients.map((r) => [r.name, r.status]));
  return { app, deps, racing, blobHook, mailer, envelopeId: env.id, token, recipientId, status };
}

/** The text a PDF carries, with flate streams inflated and hex strings decoded. */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  let out = raw;
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      out += zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
    } catch {
      // not a flate stream
    }
  }
  return out.replace(/<([0-9A-Fa-f]+)>/g, (_, hex: string) => Buffer.from(hex, "hex").toString("latin1"));
}

// ── Signer actions ────────────────────────────────────────────────────────────

test("a signature survives a co-signer opening their link mid-submission", async () => {
  const { app, racing, token, status } = await sentEnvelope();
  racing.raceNextSave(async () => {
    await app.getSession(token("bob@x.test")); // Bob opens his link: marks him viewed and saves
  });

  const res = await app.applySignature(token("alice@x.test"), SIG, [], CTX);

  assert.equal(res.status, "sent");
  assert.deepEqual(await status(), { Alice: "signed", Bob: "viewed" }, "neither write was lost");
});

test("two parallel signers submitting at the same moment both land and the envelope completes", async () => {
  const { app, racing, token, envelopeId } = await sentEnvelope();
  const aliceToken = token("alice@x.test");
  const bobToken = token("bob@x.test");
  let bob: { status: string } | undefined;
  racing.raceNextSave(async () => {
    bob = await app.applySignature(bobToken, SIG, [], CTX); // Bob's whole submission lands first
  });

  const alice = await app.applySignature(aliceToken, SIG, [], CTX);

  assert.equal(bob?.status, "sent", "Bob signed first, so the envelope was still out");
  assert.equal(alice.status, "completed", "Alice's retried submission saw Bob's signature and completed it");
  const env = await app.getEnvelope(envelopeId);
  assert.equal(env.status, "completed");
  assert.equal(env.audit.filter((e) => e.type === "recipient_signed").length, 2);
  assert.equal(env.audit.filter((e) => e.type === "envelope_completed").length, 1, "finalized exactly once");
});

test("two signers opening their links at the same moment are both recorded as viewed", async () => {
  const { app, racing, token, status } = await sentEnvelope();
  racing.raceNextSave(async () => {
    await app.getSession(token("bob@x.test"));
  });

  await app.getSession(token("alice@x.test"));

  assert.deepEqual(await status(), { Alice: "viewed", Bob: "viewed" });
});

test("re-opening a link that was already viewed writes nothing (so it cannot collide)", async () => {
  const { app, racing, token } = await sentEnvelope();
  await app.getSession(token("alice@x.test")); // first open: notified → viewed, one save
  const before = racing.saves();

  await app.getSession(token("alice@x.test"));
  await app.getSession(token("alice@x.test"));

  assert.equal(racing.saves() - before, 0);
});

test("a wrong access code that loses a race still counts toward the lockout", async () => {
  const { app, racing, token, envelopeId } = await sentEnvelope({ bobAccessCode: "4242" });
  racing.raceNextSave(async () => {
    await app.getSession(token("alice@x.test"));
  });

  await assert.rejects(app.authenticate(token("bob@x.test"), "0000"), /access code is incorrect/);

  const bob = (await app.getEnvelope(envelopeId)).recipients.find((r) => r.name === "Bob")!;
  assert.equal(bob.failedAuthAttempts, 1, "the failed attempt was persisted on fresh state, not dropped");
});

test("a decline survives a concurrent write", async () => {
  const { app, racing, token, envelopeId, status } = await sentEnvelope();
  racing.raceNextSave(async () => {
    await app.getSession(token("alice@x.test"));
  });

  const res = await app.declineByToken(token("bob@x.test"), "terms are wrong");

  assert.equal(res.status, "declined");
  assert.equal((await app.getEnvelope(envelopeId)).status, "declined");
  assert.deepEqual(await status(), { Alice: "viewed", Bob: "declined" });
});

// ── Sender actions on a sent envelope ─────────────────────────────────────────

test("remind and resend succeed while a signer is opening their link", async () => {
  const { app, racing, token, envelopeId, recipientId, mailer } = await sentEnvelope();
  const aliceMails = () => mailer.to("alice@x.test").length;
  const mailsBefore = aliceMails();

  racing.raceNextSave(async () => {
    await app.getSession(token("bob@x.test"));
  });
  await app.remind(envelopeId, recipientId("Alice"));

  racing.raceNextSave(async () => {
    await app.getSession(token("alice@x.test"));
  });
  await app.resend(envelopeId, recipientId("Alice"));

  assert.equal(aliceMails() - mailsBefore, 2, "exactly one mail per request — a retry never double-sends");
  const audit = (await app.getEnvelope(envelopeId)).audit.map((e) => e.type);
  assert.equal(audit.filter((t) => t === "recipient_reminded").length, 1);
  assert.equal(audit.filter((t) => t === "recipient_resent").length, 1);
});

test("void succeeds while a signer is opening their link", async () => {
  const { app, racing, token, envelopeId, status } = await sentEnvelope();
  racing.raceNextSave(async () => {
    await app.getSession(token("alice@x.test"));
  });

  await app.voidEnvelope(envelopeId, "wrong counterparty");

  assert.equal((await app.getEnvelope(envelopeId)).status, "voided");
  assert.equal((await status()).Alice, "viewed", "the signer's concurrent write was kept too");
});

// ── A completion that loses its race ──────────────────────────────────────────

test("a completion that loses to a void leaves no certificate behind", async () => {
  const { app, deps, racing, token, envelopeId } = await sentEnvelope({ solo: true });
  racing.raceNextSave(async () => {
    await app.voidEnvelope(envelopeId, "pulled back"); // lands while Alice's completion is being sealed
  });

  await assert.rejects(app.applySignature(token("alice@x.test"), SIG, [], CTX));

  assert.equal((await app.getEnvelope(envelopeId)).status, "voided");
  assert.equal(await deps.blobs.exists(`env/${envelopeId}/certificate.pdf`), false);
  await assert.rejects(app.downloadCertificate(envelopeId), /only after completion/);
});

test("a duplicate final submission: the standalone certificate describes the completion that was saved", async () => {
  const { app, blobHook, token, envelopeId } = await sentEnvelope({ solo: true });
  const aliceToken = token("alice@x.test");
  const outcomes: string[] = [];
  const submit = (userAgent: string) =>
    app.applySignature(aliceToken, SIG, [], { ...CTX, userAgent }).then(
      () => outcomes.push(`${userAgent}: completed`),
      () => outcomes.push(`${userAgent}: rejected`)
    );
  // The other submission runs in full right before this one writes the
  // certificate. While that write came BEFORE the save, the losing attempt's
  // certificate landed last and replaced the winner's.
  blobHook.beforeNextPut(/certificate\.pdf$/, () => submit("REQUEST-ONE"));
  await submit("REQUEST-TWO");

  assert.equal(outcomes.filter((o) => o.endsWith("completed")).length, 1, `exactly one completes: ${outcomes.join(", ")}`);
  const saved = (await app.getEnvelope(envelopeId)).recipients[0].signerUserAgent!;
  const lost = saved === "REQUEST-ONE" ? "REQUEST-TWO" : "REQUEST-ONE";
  const certificate = pdfText(await app.downloadCertificate(envelopeId));
  assert.match(certificate, new RegExp(saved), "the certificate describes the saved completion");
  assert.doesNotMatch(certificate, new RegExp(lost), "nothing from the attempt that never saved");
});

// ── Bounded ───────────────────────────────────────────────────────────────────

test("conflict retries are bounded: persistent contention surfaces as a 409, not a hang", async () => {
  const { app, racing, token } = await sentEnvelope();
  const before = racing.saves();
  racing.conflictForever();

  await assert.rejects(app.applySignature(token("alice@x.test"), SIG, [], CTX), (e: unknown) => {
    assert.ok(e instanceof ConflictError);
    assert.equal(e.code, "VERSION_CONFLICT");
    return true;
  });
  assert.equal(racing.saves() - before, CONFLICT_RETRY_LIMIT, "one save per attempt, then give up");
});

test("a void tells each notified recipient once, even when its save loses a race (FS-017)", async () => {
  const { app, racing, mailer, token, envelopeId } = await sentEnvelope();
  // Both parallel signers were notified at send. Alice opens her link while the
  // void is being saved, so the void's first save conflicts and is retried.
  racing.raceNextSave(async () => {
    await app.getSession(token("alice@x.test"));
  });
  const before = mailer.sent.length;

  await app.voidEnvelope(envelopeId, "wrong counterparty");

  const withdrawn = mailer.sent.slice(before);
  assert.deepEqual(withdrawn.map((m) => m.to).sort(), ["alice@x.test", "bob@x.test"]);
  for (const m of withdrawn) {
    assert.match(m.subject, /^Withdrawn:/);
    assert.equal(m.link, undefined, "a withdrawn notice carries no link");
    assert.ok(!m.text.includes("wrong counterparty"), "the sender's reason is not sent to recipients");
  }
});

test("voiding a draft sends no email (FS-017)", async () => {
  const mailer = new CapturingMailer();
  const { app } = buildInMemoryContainer({
    mailer,
    clock: new FixedClock("2026-11-09T00:00:00.000Z"),
    ids: new SeededIdGenerator("draft-void"),
    logger: new NullLogger(),
    webhooks: null,
    config: { baseUrl: "https://finesign.test" },
  });
  const env = await app.createDraft({ title: "Draft", routingType: "sequential", senderName: "Ops", senderEmail: "ops@co.test" });
  await app.addRecipient(env.id, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  await app.voidEnvelope(env.id, "never mind");
  assert.equal((await app.getEnvelope(env.id)).status, "voided");
  assert.equal(mailer.sent.length, 0);
});
