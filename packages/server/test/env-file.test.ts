/**
 * Boot-time environment handling.
 *
 * Regressions covered:
 *  - Copying `.env.example` (as the README instructs) and booting — via Compose
 *    `env_file` or a local `.env` — refused to start: `FINESIGN_PADES_LEVEL=""`
 *    was rejected as an unknown level. Empty FineSign settings now mean "default".
 *  - Nothing loaded `.env` for `npm start`, so the dev quickstart exited with
 *    "FINESIGN_SENDER_API_KEY must be set" even with the key in `.env`.
 *  - `DEFAULT_CONFIG` read the environment at import time, before boot code ran,
 *    so a value loaded from `.env` never reached the app config.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { NullLogger } from "@finesign/shared";
import { InMemoryEnvelopeRepository, InMemoryBlobStore } from "@finesign/storage";
import { applyEnvFile, dropEmptySettings, isFineSignSetting, loadEnvFiles } from "../src/env-file";
import { buildInMemoryContainer, buildProductionContainer } from "../src/container";

const ENV_EXAMPLE = path.resolve(__dirname, "../../../.env.example");

/** Run `fn` with FineSign's settings replaced by `vars`, restoring the real
 *  environment afterwards (other tests in this process share `process.env`). */
function withSettings<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = Object.entries(process.env).filter(([k]) => isFineSignSetting(k));
  for (const [k] of saved) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) if (isFineSignSetting(k)) delete process.env[k];
    for (const [k, v] of saved) process.env[k] = v;
  }
}

/** A production container with all I/O stubbed, so only env-driven wiring runs. */
function bootProduction() {
  return buildProductionContainer({
    sqliteFile: "unused.sqlite",
    blobRoot: "unused",
    overrides: {
      repo: new InMemoryEnvelopeRepository(),
      blobs: new InMemoryBlobStore(),
      webhooks: null,
      logger: new NullLogger(),
    },
  });
}

test("isFineSignSetting owns FINESIGN_*, SMTP_* and PORT only", () => {
  for (const k of ["FINESIGN_PADES_LEVEL", "SMTP_HOST", "PORT"]) assert.equal(isFineSignSetting(k), true, k);
  for (const k of ["PATH", "NODE_OPTIONS", "VITE_API_BASE", "PORTAL"]) assert.equal(isFineSignSetting(k), false, k);
});

test("dropEmptySettings removes empty FineSign settings and nothing else", () => {
  const env: NodeJS.ProcessEnv = {
    FINESIGN_PADES_LEVEL: "",
    SMTP_HOST: "",
    PORT: "",
    FINESIGN_BASE_URL: "http://x",
    EDITOR: "",
  };
  const removed = dropEmptySettings(env);
  assert.deepEqual(removed.sort(), ["FINESIGN_PADES_LEVEL", "PORT", "SMTP_HOST"]);
  assert.deepEqual(env, { FINESIGN_BASE_URL: "http://x", EDITOR: "" });
});

test("applyEnvFile: the real environment wins, empty file values are skipped", () => {
  const env: NodeJS.ProcessEnv = { FINESIGN_BASE_URL: "http://from-shell", FINESIGN_SIGN_PATH: "" };
  const applied = applyEnvFile(
    [
      "# a comment",
      "FINESIGN_BASE_URL=http://from-file",
      "FINESIGN_SIGN_PATH=/s",
      "FINESIGN_PADES_LEVEL=",
      'FINESIGN_MAIL_FROM="FineSign <no-reply@example.com>"',
    ].join("\n"),
    env
  );
  assert.equal(env.FINESIGN_BASE_URL, "http://from-shell", "an exported variable overrides the file");
  assert.equal(env.FINESIGN_SIGN_PATH, "/s", "an empty real value counts as unset");
  assert.equal(env.FINESIGN_PADES_LEVEL, undefined, "KEY= in the file means default");
  assert.equal(env.FINESIGN_MAIL_FROM, "FineSign <no-reply@example.com>", "quoted values are unquoted");
  assert.deepEqual(applied.sort(), ["FINESIGN_MAIL_FROM", "FINESIGN_SIGN_PATH"]);
});

test("loadEnvFiles: earlier files win, missing files are skipped, a path is read once", () => {
  const files: Record<string, string> = {
    "/work/.env": "FINESIGN_BASE_URL=http://cwd\n",
    "/repo/.env": "FINESIGN_BASE_URL=http://root\nFINESIGN_SIGN_PATH=/s\n",
  };
  const reads: string[] = [];
  const read = (p: string): string | undefined => {
    reads.push(p);
    return files[p];
  };
  const env: NodeJS.ProcessEnv = {};
  const loaded = loadEnvFiles(["/work/.env", "/missing/.env", "/repo/.env", "/work/.env"], env, read);
  assert.equal(env.FINESIGN_BASE_URL, "http://cwd");
  assert.equal(env.FINESIGN_SIGN_PATH, "/s");
  assert.deepEqual(loaded.map((f) => f.path), ["/work/.env", "/repo/.env"]);
  assert.deepEqual(reads, ["/work/.env", "/missing/.env", "/repo/.env"], "the duplicate path is not re-read");
});

test("the shipped .env.example boots once empty values mean 'default' (Compose env_file path)", () => {
  // Compose passes `KEY=` through as an empty string; reproduce that exactly.
  const asCompose = util.parseEnv(fs.readFileSync(ENV_EXAMPLE, "utf8")) as Record<string, string>;
  const vars = { ...asCompose, FINESIGN_SENDER_API_KEY: "test-key-0123456789abcdef" };

  // Without normalization this is the original boot failure — proves the test can fail.
  assert.throws(() => withSettings(vars, bootProduction), /FINESIGN_PADES_LEVEL="" is not one of/);

  withSettings(vars, () => {
    dropEmptySettings(process.env);
    assert.doesNotThrow(bootProduction);
  });
});

test("app config reads the environment when the container is built, not at import", () => {
  // The container module is already imported (top of this file). A value set
  // afterwards — as boot does after loading .env — must still take effect.
  const { deps } = withSettings({ FINESIGN_BASE_URL: "http://late.example", FINESIGN_SIGN_PATH: "/s" }, () =>
    buildInMemoryContainer({ logger: new NullLogger(), webhooks: null })
  );
  assert.equal(deps.config.baseUrl, "http://late.example");
  assert.equal(deps.config.signPath, "/s");
});
