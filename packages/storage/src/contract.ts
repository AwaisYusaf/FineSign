/**
 * The shared repository contract. Every `EnvelopeRepository` implementation must
 * pass this identical suite, so in-memory and SQLite are guaranteed to behave
 * the same (FACTORY testing strategy). Exported so downstream adapters (Postgres,
 * etc.) can self-verify too.
 */
import assert from "node:assert/strict";
import type { Envelope, EnvelopeRepository } from "@finesign/domain";

function sampleEnvelope(id: string, overrides: Partial<Envelope> = {}): Envelope {
  return {
    id,
    title: `Env ${id}`,
    status: "draft",
    routingType: "sequential",
    senderName: "Sender",
    senderEmail: "sender@x.test",
    createdAt: "2026-07-10T00:00:00.000Z",
    sentAt: null,
    completedAt: null,
    voidedReason: null,
    expiresAt: null,
    documents: [],
    recipients: [],
    fields: [],
    audit: [],
    version: 0,
    ...overrides,
  };
}

/**
 * Run the full contract against a fresh repository from `makeRepo`. Throws (via
 * assert) on the first violation. Wrap in a single `test(...)` per adapter.
 */
export async function runEnvelopeRepositoryContract(
  makeRepo: () => EnvelopeRepository
): Promise<void> {
  // create + findById returns an equal-but-not-same aggregate.
  {
    const repo = makeRepo();
    const env = sampleEnvelope("e1");
    await repo.create(env);
    const loaded = await repo.findById("e1");
    assert.ok(loaded, "created envelope should be found");
    assert.deepEqual(loaded, env);
    assert.notEqual(loaded, env, "must return a copy, not the same reference");
  }

  // create twice with the same id is rejected.
  {
    const repo = makeRepo();
    await repo.create(sampleEnvelope("dup"));
    await assert.rejects(() => repo.create(sampleEnvelope("dup")), /already exists/);
  }

  // findById on a missing id → null.
  {
    const repo = makeRepo();
    assert.equal(await repo.findById("nope"), null);
  }

  // save persists updates.
  {
    const repo = makeRepo();
    await repo.create(sampleEnvelope("e2"));
    await repo.save(sampleEnvelope("e2", { status: "sent", sentAt: "2026-07-10T01:00:00.000Z" }));
    const loaded = await repo.findById("e2");
    assert.equal(loaded!.status, "sent");
    assert.equal(loaded!.sentAt, "2026-07-10T01:00:00.000Z");
  }

  // findByRecipientTokenHash resolves an envelope + recipient by token hash.
  {
    const repo = makeRepo();
    const env = sampleEnvelope("e3", {
      status: "sent",
      recipients: [
        {
          id: "r1",
          name: "A",
          email: "a@x.test",
          role: "signer",
          routingOrder: 1,
          status: "notified",
          tokenHash: "hash-abc",
          tokenExpiresAt: "2026-07-17T00:00:00.000Z",
          viewedAt: null,
          signedAt: null,
          declineReason: null,
          authMethod: "none",
          accessCodeHash: null,
          authenticatedAt: null,
          failedAuthAttempts: 0,
          lockedUntil: null,
          consentedAt: null,
          consentDisclosureVersion: null,
          signerIp: null,
          signerUserAgent: null,
        },
      ],
    });
    await repo.create(env);
    const hit = await repo.findByRecipientTokenHash("hash-abc");
    assert.ok(hit, "token hash should resolve");
    assert.equal(hit!.recipientId, "r1");
    assert.equal(hit!.envelope.id, "e3");
    assert.equal(await repo.findByRecipientTokenHash("missing"), null);
  }

  // token index updates on save (old hash gone, new hash resolves).
  {
    const repo = makeRepo();
    const base = sampleEnvelope("e4", {
      status: "sent",
      recipients: [
        {
          id: "r1", name: "A", email: "a@x.test", role: "signer", routingOrder: 1,
          status: "notified", tokenHash: "old", tokenExpiresAt: null,
          viewedAt: null, signedAt: null, declineReason: null,
          authMethod: "none", accessCodeHash: null, authenticatedAt: null,
          failedAuthAttempts: 0, lockedUntil: null,
          consentedAt: null, consentDisclosureVersion: null, signerIp: null, signerUserAgent: null,
        },
      ],
    });
    await repo.create(base);
    const rotated = structuredClone(base);
    rotated.recipients[0].tokenHash = "new";
    await repo.save(rotated);
    assert.equal(await repo.findByRecipientTokenHash("old"), null, "stale token must not resolve");
    const hit = await repo.findByRecipientTokenHash("new");
    assert.equal(hit!.recipientId, "r1");
  }

  // Optimistic concurrency: two loads of the same version — the first save wins,
  // the second (stale-version) save is rejected instead of silently overwriting.
  {
    const repo = makeRepo();
    await repo.create(sampleEnvelope("cas"));
    const a = await repo.findById("cas");
    const b = await repo.findById("cas");
    assert.equal(a!.version, b!.version, "both loads see the same version");
    await repo.save({ ...a!, title: "A wins" }); // stored version bumps
    await assert.rejects(
      () => repo.save({ ...b!, title: "B loses" }),
      /VERSION_CONFLICT|concurrent/,
      "a stale-version save must be rejected"
    );
    const after = await repo.findById("cas");
    assert.equal(after!.title, "A wins");
    // A subsequent save at the new version succeeds.
    await repo.save({ ...after!, title: "A again" });
    assert.equal((await repo.findById("cas"))!.title, "A again");
  }

  // list returns created envelopes in insertion order, with paging.
  {
    const repo = makeRepo();
    await repo.create(sampleEnvelope("a"));
    await repo.create(sampleEnvelope("b"));
    await repo.create(sampleEnvelope("c"));
    const all = await repo.list();
    assert.deepEqual(all.map((e) => e.id), ["a", "b", "c"]);
    const page = await repo.list({ limit: 2, offset: 1 });
    assert.deepEqual(page.map((e) => e.id), ["b", "c"]);
  }

  // Mutating a returned aggregate must not corrupt the store.
  {
    const repo = makeRepo();
    await repo.create(sampleEnvelope("iso"));
    const a = await repo.findById("iso");
    a!.title = "MUTATED";
    a!.recipients.push({
      id: "x", name: "", email: "", role: "cc", routingOrder: 0, status: "pending",
      tokenHash: null, tokenExpiresAt: null, viewedAt: null, signedAt: null, declineReason: null,
      authMethod: "none", accessCodeHash: null, authenticatedAt: null,
      failedAuthAttempts: 0, lockedUntil: null,
      consentedAt: null, consentDisclosureVersion: null, signerIp: null, signerUserAgent: null,
    });
    const b = await repo.findById("iso");
    assert.equal(b!.title, "Env iso", "store must be isolated from returned copies");
    assert.equal(b!.recipients.length, 0);
  }
}
