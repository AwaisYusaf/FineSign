import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FixedClock,
  CryptoIdGenerator,
  SeededIdGenerator,
  tokensEqual,
  hashToken,
  ValidationError,
  NotFoundError,
  isFineSignError,
  ConsoleLogger,
} from "../src/index";

test("FixedClock is deterministic and advances only when told", () => {
  const c = new FixedClock("2026-07-10T00:00:00.000Z");
  assert.equal(c.now().toISOString(), "2026-07-10T00:00:00.000Z");
  c.advance(1000);
  assert.equal(c.now().toISOString(), "2026-07-10T00:00:01.000Z");
  // now() returns a copy — mutating it must not move the clock.
  const t = c.now();
  t.setFullYear(2000);
  assert.equal(c.now().toISOString(), "2026-07-10T00:00:01.000Z");
});

test("CryptoIdGenerator: unique ids, high-entropy url-safe tokens", () => {
  const g = new CryptoIdGenerator();
  const ids = new Set(Array.from({ length: 1000 }, () => g.id()));
  assert.equal(ids.size, 1000);
  const tok = g.token();
  assert.match(tok, /^[A-Za-z0-9_-]+$/);
  assert.ok(tok.length >= 43); // 32 bytes base64url
  assert.throws(() => g.token(8), /128 bits/);
});

test("SeededIdGenerator is reproducible for identical call sequences", () => {
  const a = new SeededIdGenerator("s");
  const b = new SeededIdGenerator("s");
  // Same sequence of calls on two same-seeded generators → identical outputs.
  assert.equal(a.id(), "id-1");
  assert.equal(b.id(), "id-1");
  assert.equal(a.token(), b.token());
  assert.equal(a.id(), b.id());
  // A different seed diverges the tokens.
  const c = new SeededIdGenerator("other");
  assert.notEqual(new SeededIdGenerator("s").token(), c.token());
});

test("tokensEqual is length-safe and correct", () => {
  assert.ok(tokensEqual("abc", "abc"));
  assert.ok(!tokensEqual("abc", "abd"));
  assert.ok(!tokensEqual("abc", "abcd"));
});

test("hashToken is stable sha256 hex and never returns the raw token", () => {
  const h = hashToken("secret-token");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, "secret-token");
  assert.equal(h, hashToken("secret-token"));
});

test("errors carry stable codes + http status and are guardable", () => {
  const v = new ValidationError("bad", { field: "x" });
  assert.equal(v.code, "VALIDATION_ERROR");
  assert.equal(v.httpStatus, 400);
  assert.deepEqual(v.toJSON().error.details, { field: "x" });
  assert.ok(isFineSignError(v));
  assert.ok(isFineSignError(new NotFoundError("nope")));
  assert.ok(!isFineSignError(new Error("plain")));
});

test("ConsoleLogger: a context key cannot overwrite the severity or message", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => void lines.push(line);
  try {
    // `level` is exactly what a caller wants to log about a PAdES seal, and it
    // used to silently replace the severity — so the record read as
    // {"level":"B-T"} and an ops filter on level=warn would never see it.
    new ConsoleLogger().warn({ level: "B-T", msg: "spoofed", padesLevel: "B-T" }, "real message");
  } finally {
    console.log = original;
  }
  const record = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(record.level, "warn");
  assert.equal(record.msg, "real message");
  assert.equal(record.padesLevel, "B-T");
});
