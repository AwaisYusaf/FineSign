import { test } from "node:test";
import assert from "node:assert/strict";
import { FixedClock, SeededIdGenerator, hashToken } from "@finesign/shared";
import { EnvelopeService, AccessCodeAttemptError, type IssuedToken } from "../src/envelope-service";
import { verifyAuditChain } from "../src/audit";
import type { Envelope } from "../src/types";

function make() {
  const clock = new FixedClock("2026-07-10T00:00:00.000Z");
  const ids = new SeededIdGenerator("t");
  const svc = new EnvelopeService(clock, ids);
  let tokenN = 0;
  const issueToken = (): IssuedToken => {
    tokenN += 1;
    const token = `tok-${tokenN}`;
    return {
      token,
      tokenHash: hashToken(token),
      expiresAt: new Date(clock.now().getTime() + 7 * 24 * 3600 * 1000).toISOString(),
    };
  };
  return { clock, ids, svc, issueToken };
}

/** Build a draft with one PDF doc (2 pages) and two sequential signers, each
 *  with a signature field. Returns the ready-to-send envelope + recipient ids. */
function draftTwoSigners(svc: EnvelopeService) {
  let env: Envelope = svc.createEnvelope({
    title: "NDA",
    routingType: "sequential",
    senderName: "Ops",
    senderEmail: "ops@co.test",
  });
  const d = svc.addDocument(env, { name: "nda.pdf", format: "pdf", originalBlobKey: "blob/nda", pageCount: 2 });
  env = d.envelope;
  const r1 = svc.addRecipient(env, { name: "Alice", email: "alice@x.test", role: "signer", routingOrder: 1 });
  env = r1.envelope;
  const r2 = svc.addRecipient(env, { name: "Bob", email: "bob@x.test", role: "signer", routingOrder: 2 });
  env = r2.envelope;
  env = svc.addField(env, { documentId: d.document.id, recipientId: r1.recipient.id, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" }).envelope;
  env = svc.addField(env, { documentId: d.document.id, recipientId: r2.recipient.id, page: 2, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" }).envelope;
  return { env, docId: d.document.id, r1: r1.recipient.id, r2: r2.recipient.id };
}

test("full sequential 2-signer lifecycle: draft → send → sign → sign → completed", () => {
  const { svc, issueToken } = make();
  let { env, r1, r2 } = draftTwoSigners(svc);

  // Send → only Alice (order 1) is notified.
  const sent = svc.send(env, issueToken);
  env = sent.envelope;
  assert.equal(env.status, "sent");
  const notifies = sent.effects.filter((e) => e.type === "notify");
  assert.equal(notifies.length, 1);
  assert.equal(notifies[0].type === "notify" && notifies[0].recipientId, r1);
  assert.equal(env.recipients.find((r) => r.id === r1)!.status, "notified");
  assert.equal(env.recipients.find((r) => r.id === r2)!.status, "pending");

  // Bob cannot sign before his turn.
  assert.throws(
    () => svc.applySignature(env, r2, { kind: "image", dataUrl: "data:image/png;base64,AA" }, [], { ip: null, userAgent: null, consented: true }, issueToken),
    /NOT_YOUR_TURN|not this recipient's turn/
  );

  // Alice signs → stamp effect + Bob notified.
  const s1 = svc.applySignature(env, r1, { kind: "image", dataUrl: "data:image/png;base64,AA" }, [], { ip: null, userAgent: null, consented: true }, issueToken);
  env = s1.envelope;
  assert.equal(env.status, "sent");
  assert.equal(env.recipients.find((r) => r.id === r1)!.status, "signed");
  assert.ok(s1.effects.some((e) => e.type === "stamp" && e.recipientId === r1));
  assert.ok(s1.effects.some((e) => e.type === "notify" && e.recipientId === r2 && e.reason === "your_turn"));
  assert.equal(env.recipients.find((r) => r.id === r2)!.status, "notified");

  // Bob signs → envelope completes, finalize + completed_copy for everyone.
  const s2 = svc.applySignature(env, r2, { kind: "typed", name: "Bob", font: "great_vibes" }, [], { ip: null, userAgent: null, consented: true }, issueToken);
  env = s2.envelope;
  assert.equal(env.status, "completed");
  assert.ok(env.completedAt);
  assert.ok(s2.effects.some((e) => e.type === "finalize"));
  const copies = s2.effects.filter((e) => e.type === "notify" && e.reason === "completed_copy");
  assert.equal(copies.length, 3); // 2 recipients + the sender
  assert.ok(copies.some((e) => e.type === "notify" && e.toSender), "the sender is notified on completion");

  // Audit chain stays valid the whole way.
  assert.equal(verifyAuditChain(env.audit), -1);
  assert.ok(env.audit.some((e) => e.type === "envelope_completed"));
});

const CONSENT = { ip: "203.0.113.7", userAgent: "Mozilla/5.0 Test", consented: true };

test("signing without ESIGN/UETA consent is rejected; consent + identity are recorded", () => {
  const { svc, issueToken } = make();
  let { env, r1 } = draftTwoSigners(svc);
  env = svc.send(env, issueToken).envelope;

  // No consent → rejected.
  assert.throws(
    () => svc.applySignature(env, r1, { kind: "typed", name: "Alice", font: "great_vibes" }, [], { ip: null, userAgent: null, consented: false }, issueToken),
    /consent/i
  );

  // With consent → recorded on the recipient + a recipient_consented audit event.
  const res = svc.applySignature(env, r1, { kind: "typed", name: "Alice", font: "great_vibes" }, [], CONSENT, issueToken);
  const rec = res.envelope.recipients.find((r) => r.id === r1)!;
  assert.equal(rec.consentedAt !== null, true);
  assert.equal(rec.signerIp, "203.0.113.7");
  assert.equal(rec.signerUserAgent, "Mozilla/5.0 Test");
  const consentEvt = res.envelope.audit.find((e) => e.type === "recipient_consented");
  assert.ok(consentEvt, "a recipient_consented event is appended");
  assert.equal((consentEvt!.data as { ip?: string }).ip, "203.0.113.7");
  assert.equal(verifyAuditChain(res.envelope.audit), -1, "audit chain stays valid");
});

test("access-code auth: gates signing until the correct code is presented", () => {
  const { svc, ids, clock } = make();
  // A signer that requires an access code.
  let env = svc.createEnvelope({ title: "Gated", routingType: "sequential", senderName: "Ops", senderEmail: "o@x.test" });
  env = svc.addDocument(env, { name: "d.pdf", format: "pdf", originalBlobKey: "b", pageCount: 1 }).envelope;
  const add = svc.addRecipient(env, { name: "Alice", email: "a@x.test", role: "signer", routingOrder: 1, authMethod: "access_code", accessCodeHash: hashToken("s3cret") });
  env = add.envelope;
  const rid = add.recipient.id;
  env = svc.addField(env, { documentId: env.documents[0].id, recipientId: rid, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" }).envelope;
  const issueToken = (): IssuedToken => ({ token: "t", tokenHash: hashToken("t"), expiresAt: new Date(clock.now().getTime() + 1e7).toISOString() });
  env = svc.send(env, issueToken).envelope;

  // Not authenticated yet → signing is blocked.
  assert.equal(svc.isAuthenticated(env.recipients.find((r) => r.id === rid)!), false);
  assert.throws(() => svc.applySignature(env, rid, { kind: "typed", name: "Alice", font: "great_vibes" }, [], CONSENT, issueToken), /access code required/i);

  // Wrong code → rejected.
  assert.throws(() => svc.authenticate(env, rid, hashToken("wrong")), /access code is incorrect/i);

  // Correct code → authenticated + audit event, and signing now works.
  env = svc.authenticate(env, rid, hashToken("s3cret"));
  const rec = env.recipients.find((r) => r.id === rid)!;
  assert.equal(rec.authenticatedAt !== null, true);
  assert.ok(env.audit.some((e) => e.type === "recipient_authenticated"));
  const signed = svc.applySignature(env, rid, { kind: "typed", name: "Alice", font: "great_vibes" }, [], CONSENT, issueToken);
  assert.equal(signed.envelope.status, "completed");
  assert.equal(verifyAuditChain(signed.envelope.audit), -1);
  void ids;
});

test("access-code brute-force: the recipient locks after repeated wrong codes", () => {
  const { svc, clock } = make();
  let env = svc.createEnvelope({ title: "Gated", routingType: "sequential", senderName: "Ops", senderEmail: "o@x.test" });
  env = svc.addDocument(env, { name: "d.pdf", format: "pdf", originalBlobKey: "b", pageCount: 1 }).envelope;
  const add = svc.addRecipient(env, { name: "A", email: "a@x.test", role: "signer", routingOrder: 1, authMethod: "access_code", accessCodeHash: hashToken("right") });
  env = add.envelope;
  const rid = add.recipient.id;
  env = svc.addField(env, { documentId: env.documents[0].id, recipientId: rid, page: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.05, kind: "signature" }).envelope;
  const issueToken = (): IssuedToken => ({ token: "t", tokenHash: hashToken("t"), expiresAt: new Date(clock.now().getTime() + 1e7).toISOString() });
  env = svc.send(env, issueToken).envelope;

  // Six wrong attempts — each carries the incremented counter; the sixth locks.
  let lockedSeen = false;
  for (let i = 0; i < 6; i++) {
    try {
      svc.authenticate(env, rid, hashToken(`wrong${i}`));
      assert.fail("wrong code must throw");
    } catch (e) {
      assert.ok(e instanceof AccessCodeAttemptError);
      env = e.envelope; // the server persists this
      if (e.locked) lockedSeen = true;
    }
  }
  assert.equal(lockedSeen, true, "the recipient locks within the attempt budget");

  // Even the CORRECT code is refused while locked.
  assert.throws(() => svc.authenticate(env, rid, hashToken("right")), /ACCESS_CODE_LOCKED|locked|try again/i);

  // After the lockout window, the correct code works again.
  clock.advance(16 * 60 * 1000);
  env = svc.authenticate(env, rid, hashToken("right"));
  assert.equal(svc.isAuthenticated(env.recipients.find((r) => r.id === rid)!), true);
});

test("parallel routing notifies all signers at send", () => {
  const { svc, issueToken } = make();
  let { env } = draftTwoSigners(svc);
  env = { ...env, routingType: "parallel" };
  const sent = svc.send(env, issueToken);
  const notifies = sent.effects.filter((e) => e.type === "notify");
  assert.equal(notifies.length, 2);
});

test("text & checkbox fields: captured at signing, required ones enforced (DG2)", () => {
  const { svc, issueToken } = make();
  let { env, docId, r1 } = draftTwoSigners(svc);
  const textF = svc.addField(env, { documentId: docId, recipientId: r1, page: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.03, kind: "text", required: true });
  env = textF.envelope;
  const boxF = svc.addField(env, { documentId: docId, recipientId: r1, page: 1, x: 0.5, y: 0.1, width: 0.03, height: 0.03, kind: "checkbox", required: true });
  env = boxF.envelope;
  env = svc.send(env, issueToken).envelope; // now ACCEPTS text/checkbox at send

  const sig = { kind: "typed" as const, name: "Alice", font: "great_vibes" as const };
  // A required text field left empty → rejected.
  assert.throws(
    () => svc.applySignature(env, r1, sig, [{ fieldId: boxF.field.id, value: "true" }], CONSENT, issueToken),
    /required/i
  );
  // A required checkbox left unchecked → rejected.
  assert.throws(
    () => svc.applySignature(env, r1, sig, [{ fieldId: textF.field.id, value: "Alice A." }], CONSENT, issueToken),
    /required|checked/i
  );
  // Both provided → the values are captured on the fields.
  const res = svc.applySignature(env, r1, sig, [
    { fieldId: textF.field.id, value: "Alice Anderson" },
    { fieldId: boxF.field.id, value: "true" },
  ], CONSENT, issueToken);
  assert.equal(res.envelope.fields.find((f) => f.id === textF.field.id)!.value, "Alice Anderson");
  assert.equal(res.envelope.fields.find((f) => f.id === boxF.field.id)!.value, "true");
});

test("send validation: no fields for a signer is rejected", () => {
  const { svc, issueToken } = make();
  let env = svc.createEnvelope({ title: "x", routingType: "sequential", senderName: "s", senderEmail: "s@x.test" });
  env = svc.addDocument(env, { name: "d.pdf", format: "pdf", originalBlobKey: "b", pageCount: 1 }).envelope;
  env = svc.addRecipient(env, { name: "A", email: "a@x.test", role: "signer", routingOrder: 1 }).envelope;
  assert.throws(() => svc.send(env, issueToken), /not ready to send/);
});

test("expired token is refused at signing", () => {
  const { svc, clock } = make();
  let { env, r1 } = draftTwoSigners(svc);
  const shortToken = () => ({ token: "t", tokenHash: hashToken("t"), expiresAt: new Date(clock.now().getTime() + 1000).toISOString() });
  env = svc.send(env, shortToken).envelope;
  clock.advance(2000); // past expiry
  assert.throws(
    () => svc.applySignature(env, r1, { kind: "image", dataUrl: "data:image/png;base64,AA" }, [], { ip: null, userAgent: null, consented: true }, shortToken),
    /TOKEN_EXPIRED|expired/
  );
});

test("decline terminates the envelope as declined", () => {
  const { svc, issueToken } = make();
  let { env, r1 } = draftTwoSigners(svc);
  env = svc.send(env, issueToken).envelope;
  const res = svc.decline(env, r1, "not my contract");
  assert.equal(res.envelope.status, "declined");
  assert.equal(res.envelope.recipients.find((r) => r.id === r1)!.status, "declined");
  assert.equal(verifyAuditChain(res.envelope.audit), -1);
});

test("editing after send is blocked", () => {
  const { svc, issueToken } = make();
  let { env, docId, r1 } = draftTwoSigners(svc);
  env = svc.send(env, issueToken).envelope;
  assert.throws(
    () => svc.addField(env, { documentId: docId, recipientId: r1, page: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.05, kind: "date_signed" }),
    /only change while draft|NOT_DRAFT/
  );
});

test("void moves draft/sent to voided", () => {
  const { svc, issueToken } = make();
  let { env } = draftTwoSigners(svc);
  env = svc.send(env, issueToken).envelope;
  const voided = svc.voidEnvelope(env, "obsolete");
  assert.equal(voided.status, "voided");
  assert.equal(voided.voidedReason, "obsolete");
});

// ── DG3: expiration ─────────────────────────────────────────────────────────

test("send with expiresInDays stamps expiresAt; expireIfDue fires only past the deadline (DG3)", () => {
  const { svc, issueToken } = make();
  let { env } = draftTwoSigners(svc);
  env = svc.send(env, issueToken, { expiresInDays: 7 }).envelope;
  assert.equal(env.expiresAt, "2026-07-17T00:00:00.000Z");

  // Before the deadline: no-op, no effects, still sent.
  const early = svc.expireIfDue(env, new Date("2026-07-16T23:59:59.000Z"));
  assert.equal(early.envelope.status, "sent");
  assert.equal(early.effects.length, 0);
  assert.equal(early.envelope, env, "no-op returns the same reference");

  // Past the deadline: transitions to expired + notifies the sender.
  const late = svc.expireIfDue(env, new Date("2026-07-17T00:00:01.000Z"));
  assert.equal(late.envelope.status, "expired");
  assert.deepEqual(late.effects, [{ type: "notify", toSender: true, reason: "expired" }]);
  assert.equal(verifyAuditChain(late.envelope.audit), -1, "audit chain stays intact");
  assert.ok(late.envelope.audit.some((a) => a.type === "envelope_expired"));

  // Idempotent: expiring an already-expired envelope is a no-op.
  const again = svc.expireIfDue(late.envelope, new Date("2026-07-20T00:00:00.000Z"));
  assert.equal(again.envelope, late.envelope);
  assert.equal(again.effects.length, 0);
});

test("no expiry set → expireIfDue never fires (DG3)", () => {
  const { svc, issueToken } = make();
  let { env } = draftTwoSigners(svc);
  env = svc.send(env, issueToken).envelope; // no expiresInDays
  assert.equal(env.expiresAt, null);
  const res = svc.expireIfDue(env, new Date("2030-01-01T00:00:00.000Z"));
  assert.equal(res.envelope.status, "sent");
  assert.equal(res.effects.length, 0);
});

test("send rejects a non-positive expiresInDays (DG3)", () => {
  const { svc, issueToken } = make();
  const { env } = draftTwoSigners(svc);
  assert.throws(() => svc.send(env, issueToken, { expiresInDays: 0 }), /positive number/);
  assert.throws(() => svc.send(env, issueToken, { expiresInDays: -3 }), /positive number/);
});

test("signing an expired envelope is refused (DG3)", () => {
  const { svc, issueToken } = make();
  let { env, r1 } = draftTwoSigners(svc);
  env = svc.send(env, issueToken, { expiresInDays: 1 }).envelope;
  env = svc.expireIfDue(env, new Date("2026-07-12T00:00:00.000Z")).envelope;
  assert.equal(env.status, "expired");
  assert.throws(
    () => svc.applySignature(env, r1, { kind: "image", dataUrl: "data:image/png;base64,AA" }, [], { ip: null, userAgent: null, consented: true }, issueToken),
    /ENVELOPE_NOT_SENT|expired/
  );
});

// ── DG3: manual resend + reminders ──────────────────────────────────────────

test("resend re-mints the active signer's token + audits recipient_resent (DG3)", () => {
  const { svc, issueToken } = make();
  let { env, r1 } = draftTwoSigners(svc);
  env = svc.send(env, issueToken).envelope;
  const before = env.recipients.find((r) => r.id === r1)!.tokenHash;

  const res = svc.resend(env, r1, issueToken);
  const after = res.envelope.recipients.find((r) => r.id === r1)!.tokenHash;
  assert.notEqual(after, before, "token hash rotates");
  assert.equal(res.effects.length, 1);
  const eff = res.effects[0];
  assert.ok(
    eff.type === "notify" && eff.reason === "resent" && eff.recipientId === r1 && !!eff.token,
    "resent notify carries the recipient + a fresh raw token for the link"
  );
  assert.ok(res.envelope.audit.some((a) => a.type === "recipient_resent"));
  assert.equal(verifyAuditChain(res.envelope.audit), -1);
});

test("remind nudges the active signer + audits recipient_reminded (DG3)", () => {
  const { svc, issueToken } = make();
  let { env, r1 } = draftTwoSigners(svc);
  env = svc.send(env, issueToken).envelope;
  const res = svc.remind(env, r1, issueToken);
  assert.ok(res.effects[0].type === "notify" && res.effects[0].reason === "reminder");
  assert.ok(res.envelope.audit.some((a) => a.type === "recipient_reminded"));
});

test("resend is refused for a signer whose turn hasn't come + when not sent (DG3)", () => {
  const { svc, issueToken } = make();
  let { env, r2 } = draftTwoSigners(svc);
  // Draft: cannot resend before send.
  assert.throws(() => svc.resend(env, r2, issueToken), /not sent/);
  env = svc.send(env, issueToken).envelope;
  // Sequential: r2 is still pending (not their turn) — nothing to resend.
  assert.throws(() => svc.resend(env, r2, issueToken), /turn/);
});

test("resend is refused once a signer has already signed (DG3)", () => {
  const { svc, issueToken } = make();
  let { env, r1 } = draftTwoSigners(svc);
  env = svc.send(env, issueToken).envelope;
  env = svc.applySignature(env, r1, { kind: "typed", name: "Alice", font: "great_vibes" }, [], { ip: null, userAgent: null, consented: true }, issueToken).envelope;
  assert.throws(() => svc.resend(env, r1, issueToken), /already "signed"/);
});
