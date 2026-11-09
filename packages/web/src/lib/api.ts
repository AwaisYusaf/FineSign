/**
 * Typed FineSign API client. Management calls (`/api/*`) carry the sender API
 * key; signer calls (`/sign/*`) are authenticated by the token in their URL.
 */
import { API_BASE, readApiKey } from "@/lib/config";
import type {
  DeliverySummary,
  DevLink,
  Envelope,
  FieldKind,
  RecipientRole,
  RoutingType,
  Session,
  Signature,
  Verification,
  WebhookSubscription,
} from "@/lib/types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Fired when the server rejects the stored sender key, so the app can sign out. */
export const UNAUTHORIZED_EVENT = "finesign:unauthorized";

/**
 * Did the server refuse the sender API key itself? Its guard answers a generic
 * 403 FORBIDDEN, so the message is what tells it apart from any other refusal.
 */
export function isKeyRejection(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || (error.status === 403 && /api key/i.test(error.message)));
}

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  auth?: boolean;
  /** Use this key instead of the stored one (validating a key before saving it). */
  apiKey?: string;
}

async function request<T>(path: string, { method = "GET", body, auth = false, apiKey }: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth) headers.authorization = `Bearer ${apiKey ?? readApiKey()}`;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Could not reach the FineSign server. Check your connection and try again.", 0, "NETWORK");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body (a proxy error page): fall through to the status message.
  }
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } } | null)?.error ?? {};
    const failure = new ApiError(err.message ?? `Request failed (${res.status})`, res.status, err.code);
    if (auth && !apiKey && isKeyRejection(failure)) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw failure;
  }
  return data as T;
}

// ── Sender: envelopes ─────────────────────────────────────────────────────────

export const api = {
  /** Validate a sender key without storing it (any authed read will do). */
  checkApiKey: (apiKey: string) => request<Envelope[]>("/api/envelopes?limit=1", { auth: true, apiKey }),

  /** Newest first; `before` (the last id already shown) pages back in time. */
  listEnvelopes: ({ limit = 50, before }: { limit?: number; before?: string } = {}) =>
    request<Envelope[]>(`/api/envelopes?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`, { auth: true }),
  getEnvelope: (id: string) => request<Envelope>(`/api/envelopes/${id}`, { auth: true }),
  createEnvelope: (body: { title: string; senderName: string; senderEmail: string; routingType: RoutingType }) =>
    request<Envelope>("/api/envelopes", { method: "POST", body, auth: true }),
  addDocument: (id: string, body: { name: string; format: "pdf" | "docx"; contentBase64: string }) =>
    request<Envelope>(`/api/envelopes/${id}/documents`, { method: "POST", body, auth: true }),
  addRecipient: (
    id: string,
    body: {
      name: string;
      email: string;
      role: RecipientRole;
      routingOrder: number;
      authMethod?: "access_code";
      accessCode?: string;
    }
  ) => request<Envelope>(`/api/envelopes/${id}/recipients`, { method: "POST", body, auth: true }),
  addField: (
    id: string,
    body: {
      documentId: string;
      recipientId: string;
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
      kind: FieldKind;
    }
  ) => request<Envelope>(`/api/envelopes/${id}/fields`, { method: "POST", body, auth: true }),
  removeField: (id: string, fieldId: string) =>
    request<Envelope>(`/api/envelopes/${id}/fields/${fieldId}`, { method: "DELETE", auth: true }),
  send: (id: string, expiresInDays?: number) =>
    request<Envelope>(`/api/envelopes/${id}/send`, {
      method: "POST",
      body: expiresInDays ? { expiresInDays } : {},
      auth: true,
    }),
  void: (id: string, reason: string) =>
    request<Envelope>(`/api/envelopes/${id}/void`, { method: "POST", body: { reason }, auth: true }),
  remind: (id: string, recipientId: string) =>
    request<Envelope>(`/api/envelopes/${id}/recipients/${recipientId}/remind`, { method: "POST", auth: true }),
  resend: (id: string, recipientId: string) =>
    request<Envelope>(`/api/envelopes/${id}/recipients/${recipientId}/resend`, { method: "POST", auth: true }),
  devLinks: (id: string) => request<{ links: DevLink[] }>(`/api/envelopes/${id}/dev-links`, { auth: true }),
  verify: (id: string, documentId: string) =>
    request<Verification>(`/api/envelopes/${id}/documents/${documentId}/verify`, { auth: true }),

  // ── Sender: webhooks ──────────────────────────────────────────────────────
  listWebhooks: () => request<{ subscriptions: WebhookSubscription[] }>("/api/webhooks", { auth: true }),
  createWebhook: (body: { url: string; secret?: string; eventTypes: string[] | null }) =>
    request<WebhookSubscription & { secret: string }>("/api/webhooks", { method: "POST", body, auth: true }),
  deleteWebhook: (id: string) => request<null>(`/api/webhooks/${id}`, { method: "DELETE", auth: true }),
  deliverWebhooks: () => request<DeliverySummary>("/api/webhooks/deliver", { method: "POST", auth: true }),

  // ── Signer (token-authenticated) ──────────────────────────────────────────
  getSession: (token: string) => request<Session>(`/sign/${token}`),
  authenticate: (token: string, accessCode: string) =>
    request<{ authenticated: boolean }>(`/sign/${token}/authenticate`, { method: "POST", body: { accessCode } }),
  apply: (token: string, signature: Signature, consent: boolean, fieldValues: { fieldId: string; value: string }[]) =>
    request<{ status: string }>(`/sign/${token}/apply`, { method: "POST", body: { signature, consent, fieldValues } }),
  decline: (token: string, reason: string) =>
    request<{ status: string }>(`/sign/${token}/decline`, { method: "POST", body: { reason } }),
};

// ── PDFs ──────────────────────────────────────────────────────────────────────

export const managementDocUrl = (id: string, documentId: string) =>
  `${API_BASE}/api/envelopes/${id}/documents/${documentId}/download`;
export const certificateUrl = (id: string) => `${API_BASE}/api/envelopes/${id}/certificate`;
export const signerDocUrl = (token: string, documentId: string) => `${API_BASE}/sign/${token}/documents/${documentId}`;

/** Fetch PDF bytes from an authenticated management route. */
export async function fetchAuthedPdf(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${readApiKey()}` } });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // Not JSON: keep the status message.
    }
    const failure = new ApiError(message, res.status);
    // Same rule as `request`: a rejected key signs the sender out.
    if (isKeyRejection(failure)) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw failure;
  }
  return res.arrayBuffer();
}

/** Fetch PDF bytes from a public signer route. */
export async function fetchPublicPdf(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(`Could not load the document (${res.status})`, res.status);
  return res.arrayBuffer();
}

/**
 * Hand an authenticated PDF to the browser: these routes need the key in a
 * header, so a plain link can't reach them. Opens it in a new tab.
 */
export async function openAuthedPdf(url: string): Promise<void> {
  const blob = new Blob([await fetchAuthedPdf(url)], { type: "application/pdf" });
  const objectUrl = URL.createObjectURL(blob);
  window.open(objectUrl, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

/** Read a File as base64 (no data-URL prefix) for the upload API. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}
