/**
 * `BlobStore` adapters: an in-memory map (tests/dev) and a local-filesystem
 * store (self-host default). Both address bytes by an opaque key that may
 * contain `/` path segments.
 */
import fs from "fs/promises";
import path from "path";
import type { BlobStore } from "@finesign/domain";
import { NotFoundError } from "@finesign/shared";

export class InMemoryBlobStore implements BlobStore {
  private readonly store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    // Copy so a later mutation of the caller's buffer can't change stored bytes.
    this.store.set(key, { bytes: Uint8Array.from(bytes), contentType });
  }
  async get(key: string): Promise<Uint8Array> {
    const v = this.store.get(key);
    if (!v) throw new NotFoundError(`blob not found: ${key}`);
    return Uint8Array.from(v.bytes);
  }
  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }
}

/** Stores blobs as files under `root`. Keys are sanitized to stay inside root. */
export class LocalFsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    // Prevent path traversal: normalize and confirm the result stays under root.
    const full = path.resolve(this.root, key);
    const rootResolved = path.resolve(this.root);
    if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
      throw new NotFoundError(`invalid blob key: ${key}`);
    }
    return full;
  }

  async put(key: string, bytes: Uint8Array, _contentType: string): Promise<void> {
    void _contentType; // content-type is not persisted by the FS store
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    // Write atomically: a full write to a temp file then rename (rename is atomic
    // on the same filesystem), so a crash or a concurrent put never leaves a
    // truncated/corrupted blob that a signature would later fail to verify (E2).
    const tmp = `${full}.tmp-${process.pid}-${nextTmpSeq()}`;
    try {
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, full);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const full = this.resolve(key); // may throw NotFoundError for a bad key
    try {
      return new Uint8Array(await fs.readFile(full));
    } catch (err) {
      // Only a genuine "missing file" is a NotFound. A permission error, EIO, or
      // any other failure is a REAL error and must not be masked as a 404 (A4).
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new NotFoundError(`blob not found: ${key}`);
      }
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch (err) {
      // Only a genuine "missing file" means absent. A permission/IO error must
      // surface, not be silently reported as "blob does not exist" (E1).
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
}

// Monotonic counter for unique temp-file names within a process (no Math.random
// needed; the pid + counter is unique per concurrent write).
let tmpSeq = 0;
function nextTmpSeq(): number {
  tmpSeq += 1;
  return tmpSeq;
}
