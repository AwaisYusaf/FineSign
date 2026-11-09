/**
 * FineSign end-to-end suite: the web UI's production build (served by
 * `vite preview`) against the real API (SQLite + local blobs, dev PAdES seal +
 * in-process TSA), in Chromium.
 *
 * Run from the repo root with `npm run e2e` (builds the packages first).
 */
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { API_KEY, API_PORT, API_URL, WEB_PORT, WEB_URL } from "./tests/env";

const repoRoot = path.resolve(__dirname, "../..");
const dataDir = path.join(__dirname, ".data");

const isCI = !!process.env.CI;

/**
 * Playwright hands the runner's whole environment to the servers it starts, so a
 * FineSign or SMTP setting exported in a developer's shell (SMTP_HOST, a seal
 * level, …) would reconfigure the test API. Blank every such setting; the server
 * reads an empty value as "use the default", and the explicit values below win.
 */
const inheritedSettings = Object.fromEntries(
  Object.keys(process.env)
    .filter((key) => /^(FINESIGN_|SMTP_)/.test(key))
    .map((key) => [key, ""])
);

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: isCI,
  // No retries: a test that only passes on a second try is a bug to fix, not hide.
  retries: 0,
  workers: isCI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      testIgnore: /mobile\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: [
    {
      // The API, on a database wiped as it boots (here, not at config load: the
      // config is re-read by workers and by --ui reruns while the server is up).
      // Every setting is explicit: inherited shell settings are blanked (above)
      // and FINESIGN_ENV_FILE=none keeps a developer's own .env out of the run.
      command:
        `node -e "require('node:fs').rmSync(process.env.FINESIGN_DATA_DIR, { recursive: true, force: true })"` +
        " && npm start --workspace @finesign/server",
      cwd: repoRoot,
      url: `${API_URL}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        ...inheritedSettings,
        FINESIGN_ENV_FILE: "none",
        FINESIGN_SENDER_API_KEY: API_KEY,
        FINESIGN_DEV_EXPOSE_TOKENS: "true",
        FINESIGN_BASE_URL: WEB_URL,
        FINESIGN_SIGN_PATH: "/s",
        FINESIGN_DEV_SEAL: "true",
        FINESIGN_DEV_TSA: "true",
        FINESIGN_DATA_DIR: dataDir,
        PORT: String(API_PORT),
        // Never drain the webhook outbox in the background: the suite must make
        // no outbound requests (its test endpoint is an unresolvable .invalid host).
        FINESIGN_WEBHOOK_POLL_MS: "86400000",
        // Every parallel test comes from 127.0.0.1, so the per-IP budget meant
        // for one signer would throttle the suite ("too many requests").
        FINESIGN_PUBLIC_RATE_LIMIT_PER_MIN: "100000",
        FINESIGN_RATE_LIMIT_PER_MIN: "100000",
      },
    },
    {
      // The web UI as users get it: a production build, served by `vite preview`,
      // whose proxy forwards /api and /sign to the API above. (The dev server can
      // re-optimize dependencies and reload the page mid-test on a cold cache.)
      command:
        "npm run build --workspace @finesign/web && " +
        `npm run preview --workspace @finesign/web -- --port ${WEB_PORT} --strictPort`,
      cwd: repoRoot,
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
      env: { FINESIGN_API: API_URL },
    },
  ],
});
