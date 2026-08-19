/**
 * Encryption at rest for stored blobs (DG5). `EncryptedBlobStore` is a transparent
 * decorator over ANY `BlobStore` (in-memory, local-FS, future S3): it AEAD-seals
 * bytes on `put` and opens them on `get`, so documents, signed PDFs, and
 * certificates are never written to disk/object-storage in the clear.
 *
 * Crypto: AES-256-GCM with a random 96-bit IV per blob (safe for many blobs under
 * one key) and the frame header as additional authenticated data (AAD), so the
 * recorded key id + version cannot be swapped without failing authentication.
 *
 * Keys come from a `KeyProvider` port (KMS-ready — a KMS impl would GenerateDataKey
 * / Decrypt). `LocalKeyProvider` holds a keyring: NEW blobs use the active key;
 * every blob records the id of the key that sealed it, so rotating in a new active
 * key keeps old blobs readable (add old keys as decrypt-only). Key ids are derived
 * from the key material (SHA-256 prefix) — stable, non-secret, collision-resistant.
 */
import crypto from "node:crypto";
import type { BlobStore } from "@finesign/domain";

export interface DataKey {
  /** Stable, non-secret identifier recorded in each blob (for rotation). */
  keyId: string;
  /** 32-byte AES-256 key. */
  key: Uint8Array;
}

export interface KeyProvider {
  /** The key to seal NEW blobs with. */
  currentKey(): Promise<DataKey>;
  /** Resolve a key by id to OPEN an existing blob; throws if the id is unknown. */
  keyFor(keyId: string): Promise<DataKey>;
}

export class UnknownKeyError extends Error {
  constructor(keyId: string) {
    super(`no decryption key for id "${keyId}" (was it rotated out?)`);
    this.name = "UnknownKeyError";
  }
}

/** Derive a stable, non-secret key id from key material (SHA-256, 16 hex chars). */
export function keyIdFor(key: Uint8Array): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** An in-process keyring. The `active` key (first constructor arg) seals new
 *  blobs; the `decryptOnly` keys only open older blobs after a rotation. All keys
 *  must be exactly 32 bytes. */
export class LocalKeyProvider implements KeyProvider {
  private readonly keys = new Map<string, Uint8Array>();
  private readonly activeId: string;

  /** @param active the key that seals new blobs. @param decryptOnly older keys. */
  constructor(active: Uint8Array, decryptOnly: Uint8Array[] = []) {
    for (const k of [active, ...decryptOnly]) {
      if (k.length !== 32) throw new Error(`encryption key must be 32 bytes, got ${k.length}`);
      this.keys.set(keyIdFor(k), Uint8Array.from(k));
    }
    this.activeId = keyIdFor(active);
  }

  async currentKey(): Promise<DataKey> {
    return { keyId: this.activeId, key: this.keys.get(this.activeId)! };
  }
  async keyFor(keyId: string): Promise<DataKey> {
    const key = this.keys.get(keyId);
    if (!key) throw new UnknownKeyError(keyId);
    return { keyId, key };
  }
}

// ── Frame ──────────────────────────────────────────────────────────────────────
// magic(5) | version(1) | keyIdLen(1) | keyId | iv(12) | tag(16) | ciphertext
const MAGIC = Buffer.from("FSENC", "ascii"); // 5 bytes
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

/** AEAD-seal `plaintext` under `dk`. Returns the self-describing frame. `aad`
 *  (e.g. the blob's storage key) is authenticated but not stored — so ciphertext
 *  moved to a different key/context fails to open (blocks relocation swaps). */
export function seal(dk: DataKey, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
  const keyId = Buffer.from(dk.keyId, "ascii");
  if (keyId.length > 255) throw new Error("keyId too long");
  const iv = crypto.randomBytes(IV_LEN);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION, keyId.length]), keyId]);
  const cipher = crypto.createCipheriv("aes-256-gcm", dk.key, iv);
  cipher.setAAD(aad ? Buffer.concat([header, Buffer.from(aad)]) : header); // bind version+keyId (+context)
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([header, iv, tag, ct]));
}

/** True if `bytes` is an EncryptedBlobStore frame (starts with the magic). */
export function isSealed(bytes: Uint8Array): boolean {
  return bytes.length >= MAGIC.length && Buffer.from(bytes.subarray(0, MAGIC.length)).equals(MAGIC);
}

/** Open a frame produced by `seal`, resolving its key via `keys`. `aad` must match
 *  what `seal` used (e.g. the blob's storage key). Throws on an unknown key, a
 *  truncated frame, or any tamper (GCM auth failure). */
export async function open(keys: KeyProvider, frame: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const buf = Buffer.from(frame);
  if (!isSealed(buf)) throw new Error("not an encrypted blob (bad magic)");
  let off = MAGIC.length;
  const version = buf[off++];
  if (version !== VERSION) throw new Error(`unsupported blob encryption version ${version}`);
  const keyIdLen = buf[off++];
  if (buf.length < off + keyIdLen + IV_LEN + TAG_LEN) throw new Error("truncated encrypted blob");
  const keyId = buf.subarray(off, off + keyIdLen).toString("ascii");
  off += keyIdLen;
  const header = buf.subarray(0, off);
  const iv = buf.subarray(off, off + IV_LEN);
  off += IV_LEN;
  const tag = buf.subarray(off, off + TAG_LEN);
  off += TAG_LEN;
  const ct = buf.subarray(off);
  const dk = await keys.keyFor(keyId);
  const decipher = crypto.createDecipheriv("aes-256-gcm", dk.key, iv);
  decipher.setAAD(aad ? Buffer.concat([header, Buffer.from(aad)]) : header);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
}

export interface EncryptedBlobStoreOptions {
  /**
   * When true, a stored blob WITHOUT the magic (written before encryption was
   * enabled) is returned as-is instead of throwing. **Default false (fail closed)**
   * so that, once encryption is on, tamper detection cannot be bypassed by a
   * write-capable attacker stripping the magic prefix. Enable ONLY for a one-time
   * migration window while re-writing legacy blobs. New writes are always encrypted.
   */
  allowPlaintextRead?: boolean;
}

/** Transparently encrypts on `put` and decrypts on `get`, delegating storage +
 *  `exists` to the wrapped store. The blob key is bound into the AEAD (AAD) so a
 *  ciphertext relocated to a different key fails to open. */
export class EncryptedBlobStore implements BlobStore {
  private readonly allowPlaintextRead: boolean;
  constructor(
    private readonly inner: BlobStore,
    private readonly keys: KeyProvider,
    options: EncryptedBlobStoreOptions = {}
  ) {
    this.allowPlaintextRead = options.allowPlaintextRead ?? false;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const dk = await this.keys.currentKey();
    await this.inner.put(key, seal(dk, bytes, Buffer.from(key, "utf8")), contentType);
  }

  async get(key: string): Promise<Uint8Array> {
    const stored = await this.inner.get(key);
    if (!isSealed(stored)) {
      if (this.allowPlaintextRead) return stored; // legacy pre-encryption blob (opt-in)
      throw new Error(`blob ${key} is not encrypted (strict mode) — refusing to serve unauthenticated bytes`);
    }
    return open(this.keys, stored, Buffer.from(key, "utf8"));
  }

  async exists(key: string): Promise<boolean> {
    return this.inner.exists(key);
  }
}
