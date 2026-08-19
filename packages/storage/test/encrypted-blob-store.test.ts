import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  EncryptedBlobStore,
  LocalKeyProvider,
  UnknownKeyError,
  InMemoryBlobStore,
  LocalFsBlobStore,
  keyIdFor,
  seal,
  open,
  isSealed,
} from "../src/index";

const KEY_A = new Uint8Array(crypto.createHash("sha256").update("key-a").digest());
const KEY_B = new Uint8Array(crypto.createHash("sha256").update("key-b").digest());
const PLAINTEXT = new Uint8Array(Buffer.from("%PDF-1.7 secret document body", "ascii"));

test("seal → open round-trips; the frame is self-describing and not plaintext", async () => {
  const kp = new LocalKeyProvider(KEY_A);
  const dk = await kp.currentKey();
  const framed = seal(dk, PLAINTEXT);
  assert.ok(isSealed(framed), "starts with the FSENC magic");
  assert.notDeepEqual(Buffer.from(framed), Buffer.from(PLAINTEXT));
  assert.ok(!Buffer.from(framed).includes(Buffer.from("secret document")), "plaintext must not appear in the frame");
  const opened = await open(kp, framed);
  assert.deepEqual(Buffer.from(opened), Buffer.from(PLAINTEXT));
});

test("random IV: two seals of the same plaintext differ but both open", async () => {
  const kp = new LocalKeyProvider(KEY_A);
  const dk = await kp.currentKey();
  const a = seal(dk, PLAINTEXT);
  const b = seal(dk, PLAINTEXT);
  assert.notDeepEqual(Buffer.from(a), Buffer.from(b), "IV reuse would make these equal");
  assert.deepEqual(Buffer.from(await open(kp, a)), Buffer.from(PLAINTEXT));
  assert.deepEqual(Buffer.from(await open(kp, b)), Buffer.from(PLAINTEXT));
});

test("tamper detection: flipping ciphertext, tag, or keyId fails authentication", async () => {
  const kp = new LocalKeyProvider(KEY_A);
  const dk = await kp.currentKey();
  const framed = Buffer.from(seal(dk, PLAINTEXT));

  const flipLast = Buffer.from(framed);
  flipLast[flipLast.length - 1] ^= 0xff; // ciphertext byte
  await assert.rejects(() => open(kp, flipLast));

  const flipTag = Buffer.from(framed);
  const tagStart = 5 + 1 + 1 + 16 + 12; // magic+ver+keyIdLen+keyId(16)+iv(12)
  flipTag[tagStart] ^= 0x01;
  await assert.rejects(() => open(kp, flipTag));

  // Corrupt the keyId bytes: either it no longer resolves, or AAD auth fails.
  const flipKeyId = Buffer.from(framed);
  flipKeyId[7] ^= 0x01; // first keyId char (after magic+ver+len)
  await assert.rejects(() => open(kp, flipKeyId));
});

test("a blob sealed under one key cannot be opened by a provider lacking it", async () => {
  const a = new LocalKeyProvider(KEY_A);
  const b = new LocalKeyProvider(KEY_B);
  const framed = seal(await a.currentKey(), PLAINTEXT);
  await assert.rejects(() => open(b, framed), UnknownKeyError);
});

test("keyIdFor is stable per key and distinct across keys; provider rejects short keys", () => {
  assert.equal(keyIdFor(KEY_A), keyIdFor(KEY_A));
  assert.notEqual(keyIdFor(KEY_A), keyIdFor(KEY_B));
  assert.throws(() => new LocalKeyProvider(new Uint8Array(16)), /32 bytes/);
});

test("key rotation: a new active key seals new blobs; the retired key still opens old ones", async () => {
  // Old blob sealed under KEY_A.
  const framedOld = seal(await new LocalKeyProvider(KEY_A).currentKey(), PLAINTEXT);
  // Rotate: KEY_B is active, KEY_A retained decrypt-only.
  const rotated = new LocalKeyProvider(KEY_B, [KEY_A]);
  assert.equal((await rotated.currentKey()).keyId, keyIdFor(KEY_B), "new blobs seal under the active key");
  assert.deepEqual(Buffer.from(await open(rotated, framedOld)), Buffer.from(PLAINTEXT), "old blob still opens");
  const framedNew = seal(await rotated.currentKey(), PLAINTEXT);
  assert.equal(Buffer.from(framedNew.subarray(7, 23)).toString("ascii"), keyIdFor(KEY_B), "frame records the active keyId");
});

test("EncryptedBlobStore: stores ciphertext, serves plaintext, delegates exists", async () => {
  const base = new InMemoryBlobStore();
  const store = new EncryptedBlobStore(base, new LocalKeyProvider(KEY_A));
  await store.put("env/1/doc.pdf", PLAINTEXT, "application/pdf");

  const raw = await base.get("env/1/doc.pdf"); // what actually sits at rest
  assert.ok(isSealed(raw), "the underlying store holds an encrypted frame");
  assert.ok(!Buffer.from(raw).includes(Buffer.from("secret document")));

  const got = await store.get("env/1/doc.pdf");
  assert.deepEqual(Buffer.from(got), Buffer.from(PLAINTEXT));
  assert.equal(await store.exists("env/1/doc.pdf"), true);
  assert.equal(await store.exists("missing"), false);
});

test("EncryptedBlobStore: fail-closed by default; plaintext passthrough is opt-in", async () => {
  const base = new InMemoryBlobStore();
  await base.put("legacy", PLAINTEXT, "application/pdf"); // written before encryption

  // Default is STRICT: a magic-stripped/plaintext blob is refused, not served.
  const strict = new EncryptedBlobStore(base, new LocalKeyProvider(KEY_A));
  await assert.rejects(() => strict.get("legacy"), /not encrypted/);

  // Migration mode must be explicitly opted into.
  const lenient = new EncryptedBlobStore(base, new LocalKeyProvider(KEY_A), { allowPlaintextRead: true });
  assert.deepEqual(Buffer.from(await lenient.get("legacy")), Buffer.from(PLAINTEXT), "legacy blob returned only in migration mode");
});

test("EncryptedBlobStore: a ciphertext relocated to a different key fails to open (AAD binds the key)", async () => {
  const base = new InMemoryBlobStore();
  const kp = new LocalKeyProvider(KEY_A);
  const store = new EncryptedBlobStore(base, kp);
  await store.put("env/1/original.pdf", PLAINTEXT, "application/pdf");

  // An attacker with write access copies one blob's ciphertext over another key.
  const sealedA = await base.get("env/1/original.pdf");
  await base.put("env/2/original.pdf", sealedA, "application/pdf");

  // The relocated ciphertext no longer authenticates under its new key.
  await assert.rejects(() => store.get("env/2/original.pdf"));
  // The original location still opens fine.
  assert.deepEqual(Buffer.from(await store.get("env/1/original.pdf")), Buffer.from(PLAINTEXT));
});

test("EncryptedBlobStore over LocalFsBlobStore: the file on disk is ciphertext", async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "finesign-enc-"));
  try {
    const store = new EncryptedBlobStore(new LocalFsBlobStore(dir), new LocalKeyProvider(KEY_A));
    await store.put("doc.pdf", PLAINTEXT, "application/pdf");
    const onDisk = await fs.readFile(path.join(dir, "doc.pdf"));
    assert.ok(isSealed(new Uint8Array(onDisk)), "the file at rest is an encrypted frame");
    assert.ok(!onDisk.includes(Buffer.from("secret document")), "plaintext never touches disk");
    assert.deepEqual(Buffer.from(await store.get("doc.pdf")), Buffer.from(PLAINTEXT));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
