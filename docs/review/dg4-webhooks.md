# DG4 Webhooks — adversarial review

A multi-agent adversarial review (5 parallel security lenses → independent
per-finding verification with CONFIRMED/REFUTED/UNCERTAIN verdicts) over the
webhook subsystem: `packages/server/src/webhooks.ts`,
`packages/storage/src/webhook-store.ts`, the enqueue path in `app.ts`, the routes
in `http.ts`, and the wiring in `container.ts` / `index.ts`.

**Result: 7 findings, 6 CONFIRMED (0 uncertain).** They collapse to three real
defects (the SSRF one was independently reported by three lenses). All fixed with
regression tests; gate green.

## Fixed

1. **HIGH — non-atomic `claimDue` + overlapping drains** (retry-dos, outbox
   lenses). `claimDue` was a plain `SELECT` with no lease; the background
   `setInterval` drainer had no re-entrancy guard and `deliverDue` walks its batch
   sequentially. A slow endpoint makes one drain exceed the poll interval, so the
   next tick re-selects the same still-`pending` rows → **duplicate POSTs**,
   **attempts-counter races** (two drains both write `attempts=k+1`, so a failing
   endpoint never hits the `maxAttempts` dead-letter cap), and **self-amplifying
   concurrency** (unbounded in-flight fetch/DNS load on the single-threaded host).
   **Fix:** `claimDue` now leases each claimed row atomically (bumps
   `nextAttemptAt` forward by `timeoutMs + 30s` in the same transaction / in-memory
   step), so a concurrent drain can't re-claim it (crash → row reappears after the
   lease lapses, at-least-once). Added an in-process `draining` re-entrancy guard
   so at most one drain runs at a time. Regression: a store-contract lease case +
   a server test firing three concurrent `/deliver` calls asserting no delivery id
   is POSTed twice.

2. **MEDIUM/LOW — `isPublicIp` fails open on IPv4-compatible `::/96` and 6to4
   `2002::/16`** (ssrf, hmac, auth lenses — same bug, 3×). The embedded-IPv4
   re-check covered IPv4-mapped `::ffff:0:0/96` and NAT64 `64:ff9b::/96` but not
   the deprecated IPv4-compatible `::a.b.c.d` nor 6to4, so `::169.254.169.254`,
   `::127.0.0.1`, `2002:7f00:1::` classified as **public** — contradicting the
   code's own comment. Reachability is environment-dependent (modern stacks don't
   route `::a.b.c.d`), but it's a genuine fail-open in a security classifier and a
   full SSRF on NAT64/6to4/proxy paths. **Fix:** the re-check now extracts and
   validates the embedded IPv4 for IPv4-mapped, NAT64, IPv4-compatible `::/96`
   (incl. `::`/`::1` → `0.0.0.0`/`0.0.0.1`, both denied), and 6to4 (IPv4 in bits
   16..48). Regression: the new IPv4-compatible + 6to4 private forms are asserted
   blocked; public-embedded 6to4 (`2002:0808:0808::`) stays allowed.

3. **LOW — signature timestamp reflected batch-claim time, not per-POST time**
   (hmac lens). `X-FineSign-Timestamp` was computed once for the whole batch, so a
   subscriber enforcing a tight timestamp-freshness window could reject
   later-in-batch deliveries. **Fix:** `ts` is now stamped from `clock.now()`
   inside each `attempt()`.

Also hardened while here: bounded the `dns.lookup` in `assertResolvedHostPublic`
with a timeout (it has none natively, so a hostile authoritative DNS could stall a
drain), and clamped the backoff exponent so `2**attempts` can't overflow.

## Accepted residual (unchanged)

- **DNS-rebinding TOCTOU** between our `resolveHost` check and the socket connect.
  Mitigated by default-deny private ranges + `redirect: "manual"` + short timeout;
  a full fix needs a pinned-lookup dispatcher (undici `connect`/`lookup`). Egress
  firewalling is advised for high-assurance deployments. Documented in
  `webhooks.ts`.
