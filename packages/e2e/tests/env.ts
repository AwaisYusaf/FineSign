/**
 * Ports and credentials for the end-to-end stack. Shared by the Playwright
 * config (which boots the servers) and the specs (which talk to them).
 *
 * The ports are deliberately NOT the dev defaults (4000 / 5173), so the suite can
 * run while you have the app open, and never talks to your dev database.
 */
export const API_PORT = 4010;
export const WEB_PORT = 5180;
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

/** Test-only sender key for the throwaway server this suite boots. */
export const API_KEY = "e2e-sender-key-0123456789abcdef";

/** The web UI keeps the sender key here (packages/web/src/config.js). */
export const API_KEY_STORAGE = "finesign_api_key";
