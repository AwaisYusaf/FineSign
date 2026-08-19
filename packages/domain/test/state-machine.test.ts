import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canEnvelopeTransition,
  canRecipientTransition,
  assertEnvelopeTransition,
  assertRecipientTransition,
  isEnvelopeTerminal,
  IllegalTransitionError,
} from "../src/state-machine";

test("legal envelope transitions", () => {
  assert.ok(canEnvelopeTransition("draft", "sent"));
  assert.ok(canEnvelopeTransition("draft", "voided"));
  assert.ok(canEnvelopeTransition("sent", "completed"));
  assert.ok(canEnvelopeTransition("sent", "voided"));
  assert.ok(canEnvelopeTransition("sent", "declined"));
});

test("illegal envelope transitions are rejected", () => {
  assert.ok(!canEnvelopeTransition("draft", "completed"));
  assert.ok(!canEnvelopeTransition("completed", "sent"));
  assert.ok(!canEnvelopeTransition("voided", "sent"));
  assert.throws(() => assertEnvelopeTransition("completed", "sent"), IllegalTransitionError);
});

test("terminal states have no exits", () => {
  assert.ok(isEnvelopeTerminal("completed"));
  assert.ok(isEnvelopeTerminal("voided"));
  assert.ok(isEnvelopeTerminal("declined"));
  assert.ok(!isEnvelopeTerminal("draft"));
  assert.ok(!isEnvelopeTerminal("sent"));
});

test("recipient transitions", () => {
  assert.ok(canRecipientTransition("pending", "notified"));
  assert.ok(canRecipientTransition("notified", "viewed"));
  assert.ok(canRecipientTransition("notified", "signed"));
  assert.ok(canRecipientTransition("viewed", "signed"));
  assert.ok(!canRecipientTransition("signed", "viewed"));
  assert.ok(!canRecipientTransition("pending", "signed"));
  assert.throws(() => assertRecipientTransition("signed", "notified"), IllegalTransitionError);
});
