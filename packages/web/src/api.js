// Thin FineSign API client. Management calls (`/api/*`) attach the sender API
// key; signer calls (`/sign/*`) are token-authenticated and need no key.
import { API_BASE, getApiKey } from "./config.js";

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = "GET", body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth) headers["authorization"] = `Bearer ${getApiKey()}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(err.message ?? `Request failed (${res.status})`, res.status, err.code);
  }
  return data;
}

// ── Management (sender) ─────────────────────────────────────────────────────
export const listEnvelopes = ({ limit = 50, offset = 0 } = {}) =>
  request(`/api/envelopes?limit=${limit}&offset=${offset}`, { auth: true });
export const getEnvelope = (id) => request(`/api/envelopes/${id}`, { auth: true });
export const createEnvelope = (payload) =>
  request("/api/envelopes", { method: "POST", body: payload, auth: true });
export const addDocument = (id, payload) =>
  request(`/api/envelopes/${id}/documents`, { method: "POST", body: payload, auth: true });
export const addRecipient = (id, payload) =>
  request(`/api/envelopes/${id}/recipients`, { method: "POST", body: payload, auth: true });
export const addField = (id, payload) =>
  request(`/api/envelopes/${id}/fields`, { method: "POST", body: payload, auth: true });
export const removeField = (id, fieldId) =>
  request(`/api/envelopes/${id}/fields/${fieldId}`, { method: "DELETE", auth: true });
export const sendEnvelope = (id, expiresInDays) =>
  request(`/api/envelopes/${id}/send`, {
    method: "POST",
    body: expiresInDays ? { expiresInDays } : {},
    auth: true,
  });
export const voidEnvelope = (id, reason) =>
  request(`/api/envelopes/${id}/void`, { method: "POST", body: { reason }, auth: true });
export const resendRecipient = (id, recipientId) =>
  request(`/api/envelopes/${id}/recipients/${recipientId}/resend`, { method: "POST", auth: true });
export const remindRecipient = (id, recipientId) =>
  request(`/api/envelopes/${id}/recipients/${recipientId}/remind`, { method: "POST", auth: true });
export const getDevLinks = (id) => request(`/api/envelopes/${id}/dev-links`, { auth: true });
// Cryptographic verification of a document's PAdES seal.
export const verifyDocument = (id, documentId) =>
  request(`/api/envelopes/${id}/documents/${documentId}/verify`, { auth: true });

// ── Webhooks (management) ────────────────────────────────────────────────────
export const listWebhooks = () => request("/api/webhooks", { auth: true });
export const createWebhook = (payload) =>
  request("/api/webhooks", { method: "POST", body: payload, auth: true });
export const deleteWebhook = (id) =>
  request(`/api/webhooks/${id}`, { method: "DELETE", auth: true });
export const listWebhookDeliveries = (id) =>
  request(`/api/webhooks/${id}/deliveries`, { auth: true });
export const deliverWebhooks = () =>
  request("/api/webhooks/deliver", { method: "POST", auth: true });

// The sender views a document (pre/post-sign) via the management download route.
export const managementDocUrl = (id, documentId) =>
  `${API_BASE}/api/envelopes/${id}/documents/${documentId}/download`;
// The certificate of completion (available once the envelope completes).
export const certificateUrl = (id) => `${API_BASE}/api/envelopes/${id}/certificate`;

/**
 * Fetch an authenticated PDF and hand it to the browser. These routes need the
 * API key in a header, so a plain link cannot reach them — fetch, then open the
 * blob. The object URL is revoked once the new tab has taken it.
 */
export async function openAuthedPdf(url) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${getApiKey()}` } });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      message = body?.error?.message ?? message;
    } catch {
      // Not JSON — keep the status-based message.
    }
    throw new ApiError(message, res.status);
  }
  const url_ = URL.createObjectURL(await res.blob());
  window.open(url_, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url_), 60_000);
}

// ── Signer (token) ──────────────────────────────────────────────────────────
export const getSession = (token) => request(`/sign/${token}`);
export const authenticateSession = (token, accessCode) =>
  request(`/sign/${token}/authenticate`, { method: "POST", body: { accessCode } });
export const applySignature = (token, signature, consent, fieldValues = []) =>
  request(`/sign/${token}/apply`, { method: "POST", body: { signature, consent, fieldValues } });
export const declineSession = (token, reason) =>
  request(`/sign/${token}/decline`, { method: "POST", body: { reason } });
export const signerDocUrl = (token, documentId) =>
  `${API_BASE}/sign/${token}/documents/${documentId}`;

export { ApiError };
