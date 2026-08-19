/**
 * Boot-time validation of the PAdES sealing environment.
 *
 * Regression: `sealPdf` rejects a level it lacks the inputs for, but it only runs
 * at COMPLETION — inside `finalize()`, during the LAST signer's apply. A level/TSA
 * mismatch therefore surfaced as a rejected final signature on an envelope that
 * could never complete, long after the operator had stopped watching the logs.
 * The composition root now refuses to boot instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NullLogger } from "@finesign/shared";
import { generateSelfSignedCredential } from "@finesign/pades";
import { buildProductionContainer } from "../src/container";
import { InMemoryEnvelopeRepository, InMemoryBlobStore } from "@finesign/storage";
import { makePdf } from "./helpers";

/** Build a production container with all I/O stubbed, so only the env-driven
 *  sealer wiring is under test. */
function boot() {
  return buildProductionContainer({
    sqliteFile: "unused.sqlite",
    blobRoot: "unused",
    overrides: {
      repo: new InMemoryEnvelopeRepository(),
      blobs: new InMemoryBlobStore(),
      webhooks: null,
      encryption: null,
      logger: new NullLogger(),
    },
  });
}

/** Run `fn` with exactly these FINESIGN_* seal/TSA vars set, restoring after. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const managed = [
    "FINESIGN_SEAL_P12",
    "FINESIGN_SEAL_PASSPHRASE",
    "FINESIGN_SEAL_REQUIRED",
    "FINESIGN_SEAL_TRUST_CERTS",
    "FINESIGN_SEAL_CRL_URL",
    "FINESIGN_SEAL_OCSP_URL",
    "FINESIGN_PADES_LEVEL",
    "FINESIGN_DEV_SEAL",
    "FINESIGN_DEV_TSA",
    "FINESIGN_TSA_URL",
    "FINESIGN_TSA_CERT",
  ];
  const saved = Object.fromEntries(managed.map((k) => [k, process.env[k]]));
  for (const k of managed) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const k of managed) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("boot fails when the requested PAdES level needs a TSA that is not configured", () => {
  assert.throws(
    () => withEnv({ FINESIGN_DEV_SEAL: "true", FINESIGN_PADES_LEVEL: "B-T" }, boot),
    /requires a timestamp authority/
  );
});

test("boot fails for a PKCS#12 long-term level with no revocation source", async () => {
  const { pkcs12, passphrase } = generateSelfSignedCredential({ commonName: "Cfg Seal" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finesign-cfg-"));
  const p12 = path.join(dir, "seal.p12");
  fs.writeFileSync(p12, pkcs12);
  try {
    // A self-signed cert publishes neither a CRL distribution point nor an OCSP
    // responder, so B-LT has nothing to collect.
    assert.throws(
      () =>
        withEnv(
          {
            FINESIGN_SEAL_P12: p12,
            FINESIGN_SEAL_PASSPHRASE: passphrase,
            FINESIGN_PADES_LEVEL: "B-LT",
            FINESIGN_DEV_TSA: "true",
          },
          boot
        ),
      /requires revocation material/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a PKCS#12 long-term level boots once a revocation source is supplied", async () => {
  const { pkcs12, passphrase } = generateSelfSignedCredential({ commonName: "Cfg Seal LT" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finesign-cfg-"));
  const p12 = path.join(dir, "seal.p12");
  fs.writeFileSync(p12, pkcs12);
  try {
    const { deps } = withEnv(
      {
        FINESIGN_SEAL_P12: p12,
        FINESIGN_SEAL_PASSPHRASE: passphrase,
        FINESIGN_PADES_LEVEL: "B-LTA",
        FINESIGN_DEV_TSA: "true",
        FINESIGN_SEAL_CRL_URL: "http://crl.example.test/seal.crl",
      },
      boot
    );
    // Previously this configuration threw "not yet supported" outright — the HTTP
    // validation-data provider existed but was never wired into the container.
    assert.ok(deps.sealer, "a B-LTA sealer should be constructed");
    assert.equal(deps.sealer.signerName(), "Cfg Seal LT");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("FINESIGN_PADES_LEVEL is honored in the dev-seal path (not silently upgraded)", async () => {
  // With a TSA available the sealer's own default is B-T; an explicit B-B request
  // used to be dropped because the level was never forwarded here.
  const { deps } = withEnv({ FINESIGN_DEV_SEAL: "true", FINESIGN_DEV_TSA: "true", FINESIGN_PADES_LEVEL: "B-B" }, boot);
  assert.ok(deps.sealer);
  const sealed = await deps.sealer.seal(await makePdf(1));
  const result = await deps.sealer.verify(sealed);
  assert.equal(result.level, "B-B");
  assert.equal(result.signatures[0].timestamp.present, false, "B-B must carry no signature timestamp");
});

test("the dev-seal path still defaults to B-T when a TSA is configured", async () => {
  const { deps } = withEnv({ FINESIGN_DEV_SEAL: "true", FINESIGN_DEV_TSA: "true" }, boot);
  assert.ok(deps.sealer);
  const result = await deps.sealer.verify(await deps.sealer.seal(await makePdf(1)));
  assert.equal(result.level, "B-T");
});
