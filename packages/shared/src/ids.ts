/**
 * Id and security-token generation, injected so tests are deterministic
 * (FACTORY §6) and so the crypto source is swappable.
 *
 *   - `id()`    — a unique entity id (uuid v4). Fine to expose; not a secret.
 *   - `token()` — an UNGUESSABLE bearer token for signer links: ≥128 bits of
 *                 entropy, URL-safe. NEVER derive one from an id.
 */
import crypto from "crypto";

export interface IdGenerator {
  /** A unique, non-secret entity id. */
  id(): string;
  /** An unguessable, URL-safe security token (default ≥128-bit entropy). */
  token(bytes?: number): string;
}

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Production generator backed by the system CSPRNG. */
export class CryptoIdGenerator implements IdGenerator {
  id(): string {
    return crypto.randomUUID();
  }
  token(bytes = 32): string {
    if (bytes < 16) throw new Error("security tokens must be >= 16 bytes (128 bits)");
    return toBase64Url(crypto.randomBytes(bytes));
  }
}

/**
 * Deterministic generator for tests: ids are `id-1`, `id-2`, …; tokens are
 * derived from a seeded counter via SHA-256 so they are still opaque and
 * fixed-length, but reproducible. NEVER use in production.
 */
export class SeededIdGenerator implements IdGenerator {
  private n = 0;
  constructor(private readonly seed = "test") {}
  id(): string {
    this.n += 1;
    return `id-${this.n}`;
  }
  token(bytes = 32): string {
    this.n += 1;
    const h = crypto
      .createHash("sha256")
      .update(`${this.seed}:${this.n}`)
      .digest();
    return toBase64Url(h.subarray(0, Math.max(16, bytes)));
  }
}

/** Constant-time comparison for verifying a presented token against a stored one. */
export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** SHA-256 hex of one or more string parts (order-significant). The shared,
 *  single place hashing lives so the domain never imports node crypto directly. */
export function sha256Hex(...parts: string[]): string {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
}

/** SHA-256 hex of a token, for at-rest storage (never store the raw token). */
export function hashToken(token: string): string {
  return sha256Hex(token);
}
