/**
 * Webhooks (DocuSign-Connect-style event callbacks). The server fans each new
 * audit event out to matching subscriptions as durable outbox rows (see
 * `@finesign/storage` `WebhookStore`), then a drainer POSTs them with an
 * HMAC-SHA256 signature and exponential-backoff retry.
 *
 * Security posture (self-hosted, operator-configured endpoints):
 *  - **SSRF**: the endpoint host is resolved and EVERY resolved IP is checked
 *    against a private/reserved denylist at delivery time (not just at creation),
 *    and redirects are NOT followed — so an endpoint cannot pivot to the loopback,
 *    RFC-1918, link-local (incl. 169.254.169.254 cloud metadata), CGNAT, ULA, or
 *    other reserved ranges. `allowPrivate` opens this up for local dev only.
 *  - **Authenticity + replay**: each POST carries `X-FineSign-Timestamp` and
 *    `X-FineSign-Signature: sha256=HMAC(secret, "<ts>.<body>")`. Binding the
 *    timestamp into the MAC lets receivers reject stale/replayed deliveries.
 *  - **Secret hygiene**: the signing secret is stored to sign outgoing requests
 *    but never logged and redacted from every API read (shown once on creation).
 *
 * Residual (documented): DNS rebinding between our lookup and the socket connect
 * is not fully closed without a pinned-lookup dispatcher; `allowPrivate=false` +
 * no-redirects + short timeout mitigate it, and egress firewalling is advised.
 */
import crypto from "node:crypto";
import net from "node:net";
import { promises as dns } from "node:dns";
import type { Clock, Logger } from "@finesign/shared";
import { ValidationError } from "@finesign/shared";
import type { Envelope, AuditEvent } from "@finesign/domain";
import type { WebhookStore, WebhookSubscription, WebhookDelivery } from "@finesign/storage";

// ── HMAC signing ──────────────────────────────────────────────────────────────

/** `sha256=<hex>` over `"<timestamp>.<body>"` (Stripe-style; binds the timestamp
 *  into the MAC so a receiver can reject replays by rejecting old timestamps). */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  const mac = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `sha256=${mac}`;
}

// ── SSRF: IP classification ─────────────────────────────────────────────────────

interface ParsedIp {
  version: 4 | 6;
  bits: bigint;
}

/** Parse an IPv4/IPv6 literal into a big-endian integer, or null if not an IP. */
export function parseIp(ip: string): ParsedIp | null {
  if (net.isIPv4(ip)) {
    const octets = ip.split(".").map((o) => Number(o));
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    let bits = 0n;
    for (const o of octets) bits = (bits << 8n) | BigInt(o);
    return { version: 4, bits };
  }
  if (net.isIPv6(ip)) {
    // Split off an embedded IPv4 tail (e.g. ::ffff:1.2.3.4).
    let head = ip;
    let tailBits: bigint | null = null;
    const lastColon = ip.lastIndexOf(":");
    const tail = ip.slice(lastColon + 1);
    if (tail.includes(".")) {
      const v4 = parseIp(tail);
      if (!v4) return null;
      tailBits = v4.bits;
      head = ip.slice(0, lastColon + 1) + "0:0"; // placeholder two groups
    }
    const dbl = head.indexOf("::");
    let groups: string[];
    if (dbl >= 0) {
      const left = head.slice(0, dbl).split(":").filter((s) => s !== "");
      const right = head.slice(dbl + 2).split(":").filter((s) => s !== "");
      const missing = 8 - (left.length + right.length);
      if (missing < 0) return null;
      groups = [...left, ...Array(missing).fill("0"), ...right];
    } else {
      groups = head.split(":");
    }
    if (groups.length !== 8) return null;
    let bits = 0n;
    for (let i = 0; i < 8; i++) {
      const g = groups[i];
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      bits = (bits << 16n) | BigInt(parseInt(g, 16));
    }
    if (tailBits !== null) {
      // Overwrite the low 32 bits with the embedded IPv4.
      bits = (bits & ~0xffffffffn) | tailBits;
    }
    return { version: 6, bits };
  }
  return null;
}

function inCidr(ip: ParsedIp, base: string, prefix: number, total: number): boolean {
  const b = parseIp(base);
  if (!b) return false;
  const shift = BigInt(total - prefix);
  return ip.bits >> shift === b.bits >> shift;
}

const V4_DENY: [string, number][] = [
  ["0.0.0.0", 8], // "this host"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. 169.254.169.254 metadata)
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved / 255.255.255.255
];

const V6_DENY: [string, number][] = [
  ["::1", 128], // loopback
  ["::", 128], // unspecified
  ["fc00::", 7], // unique-local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["2001:db8::", 32], // documentation
  ["64:ff9b::", 96], // NAT64 (embeds IPv4; also re-checked below)
];

/** True when an IP is a globally-routable public address (fails closed on parse
 *  errors and on IPv4-mapped/compatible IPv6 that embed a private IPv4). */
export function isPublicIp(ip: string): boolean {
  const p = parseIp(ip);
  if (!p) return false;
  if (p.version === 4) {
    return !V4_DENY.some(([b, n]) => inCidr(p, b, n, 32));
  }
  // Any IPv6 form that EMBEDS an IPv4 must be judged by that embedded IPv4, or a
  // private address slips through as a "public" v6 literal. Covers IPv4-mapped
  // (::ffff:0:0/96), NAT64 (64:ff9b::/96), the deprecated IPv4-compatible ::/96
  // (incl. :: and ::1 → 0.0.0.0/0.0.0.1, both denied), and 6to4 (2002::/16, which
  // carries the IPv4 in bits 16..48).
  const embeddedV4 = (): bigint | null => {
    if (inCidr(p, "::ffff:0:0", 96, 128)) return p.bits & 0xffffffffn;
    if (inCidr(p, "64:ff9b::", 96, 128)) return p.bits & 0xffffffffn;
    if (p.bits >> 32n === 0n) return p.bits & 0xffffffffn; // IPv4-compatible ::/96
    if (inCidr(p, "2002::", 16, 128)) return (p.bits >> 80n) & 0xffffffffn; // 6to4
    return null;
  };
  const emb = embeddedV4();
  if (emb !== null) {
    const v4 = { version: 4 as const, bits: emb };
    return !V4_DENY.some(([b, n]) => inCidr(v4, b, n, 32));
  }
  return !V6_DENY.some(([b, n]) => inCidr(p, b, n, 128));
}

// ── SSRF: URL validation ────────────────────────────────────────────────────────

export interface WebhookConfig {
  /** Allow http:// and private/reserved destinations (LOCAL DEV ONLY). */
  allowPrivate: boolean;
  timeoutMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  maxBackoffMs: number;
  /** Max deliveries drained per `deliverDue` call. */
  batchLimit: number;
}

export const DEFAULT_WEBHOOK_CONFIG: WebhookConfig = {
  allowPrivate: false,
  timeoutMs: 5000,
  maxAttempts: 8,
  backoffBaseMs: 5000,
  maxBackoffMs: 3600_000,
  batchLimit: 50,
};

/** Static (no-DNS) validation for subscription creation: scheme, embedded creds,
 *  and — when the host is an IP literal — that it is public. Name-based hosts are
 *  only fully checked at delivery time (their DNS may change). */
export function assertValidWebhookUrl(rawUrl: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError("webhook url is not a valid absolute URL");
  }
  const httpsOnly = url.protocol === "https:";
  if (!httpsOnly && !(allowPrivate && url.protocol === "http:")) {
    throw new ValidationError("webhook url must use https");
  }
  if (url.username || url.password) {
    throw new ValidationError("webhook url must not embed credentials");
  }
  if (!url.hostname) {
    throw new ValidationError("webhook url must have a host");
  }
  // Reject an IP-literal host up front when it's private (unless dev-allowed).
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (parseIp(literal) && !allowPrivate && !isPublicIp(literal)) {
    throw new ValidationError("webhook url resolves to a private/reserved address");
  }
  return url;
}

export type HostResolver = (host: string) => Promise<string[]>;
export type WebhookFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; timeoutMs: number }
) => Promise<{ status: number }>;

const defaultResolveHost: HostResolver = async (host) => {
  const literal = host.replace(/^\[|\]$/g, "");
  if (parseIp(literal)) return [literal];
  const records = await dns.lookup(host, { all: true });
  return records.map((r) => r.address);
};

const defaultWebhookFetch: WebhookFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    redirect: "manual", // a 3xx must NOT be followed to an internal host
    signal: AbortSignal.timeout(init.timeoutMs),
  });
  return { status: res.status };
};

/** Resolve `host` and assert EVERY address is public (unless `allowPrivate`).
 *  Throws on any private/unresolvable/empty result — fail closed. The resolve is
 *  bounded by `timeoutMs` so a hostile authoritative DNS can't stall the drain
 *  (`dns.lookup` itself has no timeout). */
async function assertResolvedHostPublic(
  host: string,
  resolve: HostResolver,
  allowPrivate: boolean,
  timeoutMs: number
): Promise<void> {
  if (allowPrivate) return;
  const literal = host.replace(/^\[|\]$/g, "");
  const addrs = await withTimeout(resolve(literal), timeoutMs, `DNS resolution of ${host}`);
  if (addrs.length === 0) throw new Error(`host ${host} did not resolve`);
  for (const a of addrs) {
    if (!isPublicIp(a)) throw new Error(`host ${host} resolves to non-public address ${a}`);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// ── Payload ─────────────────────────────────────────────────────────────────────

/** The non-secret event body delivered to subscribers. Stable + free of tokens,
 *  hashes, and access codes. */
export function buildWebhookBody(env: Envelope, event: AuditEvent, deliveryId: string): string {
  const recipientId = typeof event.data.recipientId === "string" ? event.data.recipientId : null;
  const rec = recipientId ? env.recipients.find((r) => r.id === recipientId) : undefined;
  const body = {
    id: deliveryId,
    event: event.type,
    eventId: event.id,
    occurredAt: event.at,
    envelope: {
      id: env.id,
      title: env.title,
      status: env.status,
      expiresAt: env.expiresAt,
    },
    recipient: rec ? { id: rec.id, name: rec.name, email: rec.email, role: rec.role, status: rec.status } : null,
    data: event.data,
  };
  return JSON.stringify(body);
}

/** Does a subscription's type filter accept this event type? */
export function subscriptionAccepts(sub: WebhookSubscription, eventType: string): boolean {
  return sub.eventTypes === null || sub.eventTypes.includes(eventType);
}

// ── Deliverer ────────────────────────────────────────────────────────────────────

export interface DeliverySummary {
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
}

export class WebhookDeliverer {
  private readonly config: WebhookConfig;
  private readonly resolveHost: HostResolver;
  private readonly fetchImpl: WebhookFetch;
  /** In-process guard: at most one drain runs at a time (bounds concurrent load;
   *  cross-process safety comes from the `claimDue` lease). */
  private draining = false;

  constructor(
    private readonly store: WebhookStore,
    private readonly deps: { clock: Clock; logger: Logger },
    opts: { config?: Partial<WebhookConfig>; resolveHost?: HostResolver; fetchImpl?: WebhookFetch } = {}
  ) {
    this.config = { ...DEFAULT_WEBHOOK_CONFIG, ...opts.config };
    this.resolveHost = opts.resolveHost ?? defaultResolveHost;
    this.fetchImpl = opts.fetchImpl ?? defaultWebhookFetch;
  }

  get settings(): WebhookConfig {
    return this.config;
  }

  private backoffMs(attempts: number): number {
    // 2**attempts overflows to Infinity for large exponents; Math.min still clamps
    // it to maxBackoffMs, but guard explicitly so the arithmetic stays finite.
    const exp = Math.min(attempts - 1, 40);
    return Math.min(this.config.maxBackoffMs, this.config.backoffBaseMs * 2 ** exp);
  }

  /** How long a claimed row is hidden from other drains (must exceed one attempt's
   *  wall-clock: the delivery timeout plus DNS/overhead headroom). */
  private get leaseMs(): number {
    return this.config.timeoutMs + 30_000;
  }

  /** Drain due deliveries once. Safe to call on an interval and/or via an endpoint:
   *  a process-level re-entrancy guard serializes overlapping calls, and
   *  `claimDue` leases each row (bumps its next-attempt time) so even across
   *  processes a delivery is only ever in one drain at a time — no double-POST,
   *  no lost attempts increment, no unbounded drain pile-up. */
  async deliverDue(limit = this.config.batchLimit): Promise<DeliverySummary> {
    if (this.draining) return { claimed: 0, delivered: 0, retried: 0, dead: 0 };
    this.draining = true;
    try {
      const now = this.deps.clock.now();
      const due = await this.store.claimDue(now.toISOString(), limit, this.leaseMs);
      const summary: DeliverySummary = { claimed: due.length, delivered: 0, retried: 0, dead: 0 };
      for (const d of due) {
        const sub = await this.store.getSubscription(d.subscriptionId);
        if (!sub || !sub.active) {
          await this.store.updateDelivery({ ...d, status: "dead", lastError: "subscription missing or inactive" });
          summary.dead += 1;
          continue;
        }
        const result = await this.attempt(sub, d);
        const attempts = d.attempts + 1;
        if (result.ok) {
          await this.store.updateDelivery({ ...d, status: "delivered", attempts, lastError: null });
          summary.delivered += 1;
        } else if (attempts >= this.config.maxAttempts) {
          await this.store.updateDelivery({ ...d, status: "dead", attempts, lastError: result.error });
          summary.dead += 1;
          this.deps.logger.warn({ deliveryId: d.id, subscriptionId: sub.id, attempts }, "webhook delivery dead-lettered");
        } else {
          const next = new Date(this.deps.clock.now().getTime() + this.backoffMs(attempts)).toISOString();
          await this.store.updateDelivery({ ...d, status: "pending", attempts, nextAttemptAt: next, lastError: result.error });
          summary.retried += 1;
        }
      }
      return summary;
    } finally {
      this.draining = false;
    }
  }

  private async attempt(
    sub: WebhookSubscription,
    d: WebhookDelivery
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const url = new URL(sub.url);
      await assertResolvedHostPublic(url.hostname, this.resolveHost, this.config.allowPrivate, this.config.timeoutMs);
      // Stamp the signature at the moment of THIS POST (not batch-claim time) so a
      // receiver's timestamp-freshness/replay window measures actual send time.
      const ts = Math.floor(this.deps.clock.now().getTime() / 1000).toString();
      const signature = signWebhook(sub.secret, ts, d.payload);
      const { status } = await this.fetchImpl(sub.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "FineSign-Webhooks/1",
          "x-finesign-event": d.eventType,
          "x-finesign-delivery": d.id,
          "x-finesign-timestamp": ts,
          "x-finesign-signature": signature,
        },
        body: d.payload,
        timeoutMs: this.config.timeoutMs,
      });
      if (status >= 200 && status < 300) return { ok: true };
      return { ok: false, error: `HTTP ${status}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
