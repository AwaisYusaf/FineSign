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
export const listEnvelopes = () => request("/api/envelopes", { auth: true });
export const getEnvelope = (id) => request(`/api/envelopes/${id}`, { auth: true });
export const createEnvelope = (payload) =>
  request("/api/envelopes", { method: "POST", body: payload, auth: true });
export const addDocument = (id, payload) =>
  request(`/api/envelopes/${id}/documents`, { method: "POST", body: payload, auth: true });
export const addRecipient = (id, payload) =>
  request(`/api/envelopes/${id}/recipients`, { method: "POST", body: payload, auth: true });
export const addField = (id, payload) =>
  request(`/api/envelopes/${id}/fields`, { method: "POST", body: payload, auth: true });
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
