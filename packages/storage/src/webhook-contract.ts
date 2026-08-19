/**
 * Shared `WebhookStore` contract — both the in-memory and SQLite impls must
 * behave identically (FACTORY testing strategy). Exercises subscription CRUD,
 * the idempotent outbox, the high-water-mark, and due-claiming.
 */
import assert from "node:assert/strict";
import type { WebhookStore, WebhookDelivery, WebhookSubscription } from "./webhook-store";

function sub(id: string, overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id,
    url: "https://hooks.example.test/x",
    secret: "s3cr3t",
    eventTypes: null,
    active: true,
    createdAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

function delivery(id: string, overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id,
    subscriptionId: "sub1",
    envelopeId: "env1",
    eventId: `evt-${id}`,
    eventSeq: 0,
    eventType: "envelope_sent",
    payload: JSON.stringify({ event: "envelope_sent" }),
    status: "pending",
    attempts: 0,
    nextAttemptAt: "2026-07-10T00:00:00.000Z",
    lastError: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

export async function runWebhookStoreContract(makeStore: () => WebhookStore): Promise<void> {
  // subscription CRUD
  {
    const store = makeStore();
    await store.createSubscription(sub("s1", { eventTypes: ["envelope_completed"] }));
    const got = await store.getSubscription("s1");
    assert.ok(got);
    assert.equal(got!.url, "https://hooks.example.test/x");
    assert.deepEqual(got!.eventTypes, ["envelope_completed"]);
    assert.equal((await store.listSubscriptions()).length, 1);
    assert.equal(await store.deleteSubscription("s1"), true);
    assert.equal(await store.deleteSubscription("s1"), false);
    assert.equal(await store.getSubscription("s1"), null);
  }

  // eventTypes null (all) round-trips
  {
    const store = makeStore();
    await store.createSubscription(sub("s2", { eventTypes: null }));
    assert.equal((await store.getSubscription("s2"))!.eventTypes, null);
  }

  // enqueue is idempotent on (subscription, envelope, eventId)
  {
    const store = makeStore();
    await store.enqueueDelivery(delivery("d1", { eventId: "e-1", eventSeq: 1 }));
    await store.enqueueDelivery(delivery("d1-dup", { eventId: "e-1", eventSeq: 1 })); // same key
    const all = await store.listDeliveries();
    assert.equal(all.length, 1, "duplicate (sub,env,eventId) must be ignored");
  }

  // high-water-mark reflects the max enqueued seq
  {
    const store = makeStore();
    assert.equal(await store.maxEnqueuedSeq("sub1", "env1"), -1);
    await store.enqueueDelivery(delivery("d1", { eventId: "e-1", eventSeq: 2 }));
    await store.enqueueDelivery(delivery("d2", { eventId: "e-2", eventSeq: 5 }));
    assert.equal(await store.maxEnqueuedSeq("sub1", "env1"), 5);
    assert.equal(await store.maxEnqueuedSeq("sub1", "other"), -1);
  }

  // claimDue respects status + nextAttemptAt; updateDelivery persists transitions
  {
    const store = makeStore();
    await store.enqueueDelivery(delivery("due", { eventId: "e-1", nextAttemptAt: "2026-07-10T00:00:00.000Z" }));
    await store.enqueueDelivery(delivery("future", { eventId: "e-2", nextAttemptAt: "2999-01-01T00:00:00.000Z" }));
    const due = await store.claimDue("2026-07-10T12:00:00.000Z", 10);
    assert.deepEqual(due.map((d) => d.id), ["due"]);

    const delivered = { ...due[0], status: "delivered" as const, attempts: 1 };
    await store.updateDelivery(delivered);
    assert.equal((await store.claimDue("2026-07-10T12:00:00.000Z", 10)).length, 0, "delivered rows are not re-claimed");
  }

  // claimDue honors the limit
  {
    const store = makeStore();
    for (let i = 0; i < 5; i++) await store.enqueueDelivery(delivery(`d${i}`, { eventId: `e-${i}` }));
    assert.equal((await store.claimDue("2026-07-10T12:00:00.000Z", 3)).length, 3);
  }

  // claimDue with a lease hides claimed rows from a concurrent claim (no double-claim)
  {
    const store = makeStore();
    await store.enqueueDelivery(delivery("leased", { eventId: "e-1", nextAttemptAt: "2026-07-10T00:00:00.000Z" }));
    const now = "2026-07-10T12:00:00.000Z";
    const first = await store.claimDue(now, 10, 60_000); // lease 60s
    assert.deepEqual(first.map((d) => d.id), ["leased"]);
    assert.equal(first[0].nextAttemptAt, "2026-07-10T00:00:00.000Z", "claimed rows carry PRE-lease state");
    // A second claim at the same instant sees the leased (future) next-attempt → nothing.
    assert.equal((await store.claimDue(now, 10, 60_000)).length, 0, "a leased row is not re-claimed within the lease window");
    // After the lease lapses it becomes visible again (at-least-once on crash).
    assert.equal((await store.claimDue("2026-07-10T12:02:00.000Z", 10, 60_000)).length, 1, "row re-appears once the lease lapses");
  }
}
