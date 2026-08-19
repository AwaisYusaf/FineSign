import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { InMemoryBlobStore, LocalFsBlobStore } from "../src/index";
import type { BlobStore } from "@finesign/domain";

async function contract(store: BlobStore): Promise<void> {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  assert.equal(await store.exists("a/b.pdf"), false);
  await store.put("a/b.pdf", bytes, "application/pdf");
  assert.equal(await store.exists("a/b.pdf"), true);
  assert.deepEqual(await store.get("a/b.pdf"), bytes);
  await assert.rejects(() => store.get("missing"), /not found/);
  // Stored bytes are isolated from later mutation of the caller's buffer.
  bytes[0] = 99;
  const got = await store.get("a/b.pdf");
  assert.equal(got[0], 1);
}

test("InMemoryBlobStore satisfies the blob contract", async () => {
  await contract(new InMemoryBlobStore());
});

test("LocalFsBlobStore satisfies the blob contract + blocks traversal", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "finesign-blob-"));
  try {
    const store = new LocalFsBlobStore(dir);
    await contract(store);
    await assert.rejects(() => store.get("../../etc/passwd"), /invalid blob key|not found/);
    await assert.rejects(
      () => store.put("../escape.txt", new Uint8Array([0]), "text/plain"),
      /invalid blob key/
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("LocalFsBlobStore.get does NOT mask a non-ENOENT error as not-found (A4)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "finesign-blob-"));
  try {
    const store = new LocalFsBlobStore(dir);
    // Put a key, then replace the file path with a DIRECTORY so readFile fails
    // with EISDIR (not ENOENT) — this must surface, not become a 404.
    await store.put("d/x", new Uint8Array([1]), "application/pdf");
    await fs.rm(path.join(dir, "d/x"));
    await fs.mkdir(path.join(dir, "d/x"));
    await assert.rejects(
      () => store.get("d/x"),
      (err: NodeJS.ErrnoException) => err.code === "EISDIR"
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
