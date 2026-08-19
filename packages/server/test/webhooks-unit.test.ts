import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { isPublicIp, parseIp, signWebhook, assertValidWebhookUrl } from "../src/webhooks";

test("isPublicIp accepts globally-routable addresses", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "2400:cb00::1"]) {
    assert.equal(isPublicIp(ip), true, `${ip} should be public`);
  }
});

test("isPublicIp blocks loopback / RFC1918 / link-local / CGNAT / reserved (SSRF)", () => {
  const blocked = [
    "127.0.0.1", "127.5.5.5", // loopback
    "10.0.0.1", "10.255.255.255", // RFC1918
    "172.16.0.1", "172.31.255.255", // RFC1918 /12
    "192.168.1.1", // RFC1918
    "169.254.169.254", // link-local — cloud metadata!
    "100.64.0.1", // CGNAT
    "0.0.0.0", // this host
    "224.0.0.1", "239.1.1.1", // multicast
    "255.255.255.255", // broadcast/reserved
    "198.18.0.1", // benchmarking
  ];
  for (const ip of blocked) assert.equal(isPublicIp(ip), false, `${ip} must be blocked`);
});

test("isPublicIp blocks IPv6 loopback / ULA / link-local / multicast / mapped-private", () => {
  const blocked = [
    "::1", // loopback
    "::", // unspecified
    "fe80::1", // link-local
    "fc00::1", "fd00::1", // unique-local
    "ff02::1", // multicast
    "2001:db8::1", // documentation
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.1", // IPv4-mapped RFC1918
    "::ffff:169.254.169.254", // IPv4-mapped metadata
    "64:ff9b::7f00:1", // NAT64-embedded 127.0.0.1
    "::127.0.0.1", // IPv4-compatible (deprecated) loopback
    "::169.254.169.254", // IPv4-compatible metadata
    "::10.0.0.1", // IPv4-compatible RFC1918
    "2002:7f00:1::", // 6to4-embedded 127.0.0.1
    "2002:a9fe:a9fe::", // 6to4-embedded 169.254.169.254 (metadata)
    "2002:c0a8:1::", // 6to4-embedded 192.168.0.1
  ];
  for (const ip of blocked) assert.equal(isPublicIp(ip), false, `${ip} must be blocked`);
});

test("isPublicIp allows IPv4-mapped/6to4 forms that embed a PUBLIC IPv4", () => {
  assert.equal(isPublicIp("::ffff:8.8.8.8"), true);
  assert.equal(isPublicIp("2002:0808:0808::"), true, "6to4 embedding 8.8.8.8 is public");
});

test("parseIp rejects non-IP strings and out-of-range octets", () => {
  assert.equal(parseIp("not-an-ip"), null);
  assert.equal(parseIp("999.1.1.1"), null);
  assert.equal(parseIp("example.com"), null);
  assert.ok(parseIp("10.0.0.1"));
  assert.ok(parseIp("::1"));
});

test("signWebhook binds the timestamp into the MAC (Stripe-style)", () => {
  const secret = "supersecretwebhookkey";
  const body = JSON.stringify({ event: "envelope_sent" });
  const sig = signWebhook(secret, "1700000000", body);
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`1700000000.${body}`).digest("hex");
  assert.equal(sig, expected);
  // A different timestamp yields a different signature (replay binding).
  assert.notEqual(sig, signWebhook(secret, "1700000001", body));
});

test("assertValidWebhookUrl enforces https, no creds, no private literal (allowPrivate=false)", () => {
  assert.ok(assertValidWebhookUrl("https://hooks.example.com/x", false));
  assert.throws(() => assertValidWebhookUrl("http://hooks.example.com/x", false), /https/);
  assert.throws(() => assertValidWebhookUrl("ftp://hooks.example.com", false), /https/);
  assert.throws(() => assertValidWebhookUrl("https://user:pass@hooks.example.com", false), /credentials/);
  assert.throws(() => assertValidWebhookUrl("https://169.254.169.254/x", false), /private|reserved/);
  assert.throws(() => assertValidWebhookUrl("https://[::1]/x", false), /private|reserved/);
  assert.throws(() => assertValidWebhookUrl("not a url", false), /valid/);
});

test("assertValidWebhookUrl allows http + private hosts when allowPrivate (dev)", () => {
  assert.ok(assertValidWebhookUrl("http://localhost:3000/x", true));
  assert.ok(assertValidWebhookUrl("http://127.0.0.1:9000/x", true));
});
