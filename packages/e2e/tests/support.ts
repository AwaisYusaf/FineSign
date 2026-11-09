/**
 * Shared fixtures and helpers for the end-to-end specs.
 *
 * Locators prefer what a person sees — roles, labels, visible text — so the
 * specs keep working through a visual redesign. The only test ids are on things
 * with no accessible handle: rendered PDF pages and the signature canvas.
 */
import { test as base, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { API_KEY, API_KEY_STORAGE, API_URL } from "./env";

// ── API types (the subset the specs read) ────────────────────────────────────

export interface Recipient {
  id: string;
  name: string;
  email: string;
  role: "signer" | "approver" | "cc";
  routingOrder: number;
  status: string;
}
export interface Field {
  id: string;
  documentId: string;
  recipientId: string;
  page: number;
  x: number;
  y: number;
  kind: string;
}
export interface Envelope {
  id: string;
  title: string;
  status: string;
  expiresAt?: string | null;
  documents: { id: string; name: string; pageCount?: number }[];
  recipients: Recipient[];
  fields: Field[];
  audit: { type: string }[];
}
interface DevLink {
  recipientId: string;
  link: string;
}

/** A thin client for the management API, authenticated with the test key. */
export class Api {
  constructor(private readonly ctx: APIRequestContext) {}

  private async call<T>(method: string, path: string, data?: unknown): Promise<T> {
    const res = await this.ctx.fetch(path, { method, data });
    const text = await res.text();
    if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get = (id: string) => this.call<Envelope>("GET", `/api/envelopes/${id}`);
  create = (body: { title: string; routingType: "sequential" | "parallel" }) =>
    this.call<Envelope>("POST", "/api/envelopes", {
      ...body,
      senderName: "Jane Q. Public",
      senderEmail: "jane@example.com",
    });
  addPdf = async (id: string, name = "nda.pdf") =>
    this.call<Envelope>("POST", `/api/envelopes/${id}/documents`, {
      name,
      format: "pdf",
      contentBase64: (await samplePdf()).toString("base64"),
    });
  addRecipient = (id: string, body: Record<string, unknown>) =>
    this.call<Envelope>("POST", `/api/envelopes/${id}/recipients`, body);
  addField = (id: string, body: Record<string, unknown>) =>
    this.call<Envelope>("POST", `/api/envelopes/${id}/fields`, body);
  send = (id: string, expiresInDays?: number) =>
    this.call<Envelope>("POST", `/api/envelopes/${id}/send`, expiresInDays ? { expiresInDays } : {});
  verify = (id: string, documentId: string) =>
    this.call<{ valid: boolean; level: string; signatureCount: number }>(
      "GET",
      `/api/envelopes/${id}/documents/${documentId}/verify`
    );
  download = async (id: string, documentId: string): Promise<Buffer> => {
    const res = await this.ctx.get(`/api/envelopes/${id}/documents/${documentId}/download`);
    expect(res.ok(), `download → ${res.status()}`).toBe(true);
    return res.body();
  };

  /**
   * The newest signing link issued to a recipient (needs the server's
   * FINESIGN_DEV_EXPOSE_TOKENS). Links are re-minted on remind, resend and
   * completion, and an older link stops working — so "newest" matters.
   */
  async linkFor(envelopeId: string, recipientId: string): Promise<string | undefined> {
    const { links } = await this.call<{ links: DevLink[] }>("GET", `/api/envelopes/${envelopeId}/dev-links`);
    return links.filter((l) => l.recipientId === recipientId).at(-1)?.link;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

export const test = base.extend<{ senderPage: Page }, { api: Api }>({
  api: [
    async ({ playwright }, use) => {
      const ctx = await playwright.request.newContext({
        baseURL: API_URL,
        extraHTTPHeaders: { authorization: `Bearer ${API_KEY}` },
      });
      await use(new Api(ctx));
      await ctx.dispose();
    },
    { scope: "worker" },
  ],
  /** A page already holding the sender API key, as after the key prompt. */
  senderPage: async ({ page }, use) => {
    await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [API_KEY_STORAGE, API_KEY]);
    await use(page);
  },
});
export { expect };

// ── Test data ─────────────────────────────────────────────────────────────────

let pdfCache: Buffer | undefined;

/** A two-page agreement with a signature line on page 2 (generated, not checked in). */
export async function samplePdf(): Promise<Buffer> {
  if (pdfCache) return pdfCache;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 2; n++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Mutual Non-Disclosure Agreement - page ${n}`, { x: 60, y: 720, size: 18, font });
    page.drawText("The parties agree to keep each other's information confidential.", { x: 60, y: 680, size: 11, font });
    if (n === 2) page.drawText("Signature: ____________________   Date: __________", { x: 60, y: 200, size: 12, font });
  }
  pdfCache = Buffer.from(await doc.save());
  return pdfCache;
}

export interface Seeded {
  envelope: Envelope;
  documentId: string;
  alice: Recipient;
  bob: Recipient;
  carol?: Recipient;
}

/**
 * A sent envelope built through the API, so signer-side specs start at the
 * signing link. Alice has signature + date (page 2) and text + checkbox
 * (page 1); Bob has a signature (page 2); Carol, if requested, is a CC.
 */
export async function seedSentEnvelope(
  api: Api,
  opts: {
    routing?: "sequential" | "parallel";
    bobAccessCode?: string;
    cc?: boolean;
    /** Add the CC with this access code (implies `cc`). */
    ccAccessCode?: string;
    title?: string;
    /** Give Alice only a signature + date (no text/checkbox inputs to fill). */
    signatureOnly?: boolean;
  } = {}
): Promise<Seeded> {
  const routing = opts.routing ?? "sequential";
  let env = await api.create({ title: opts.title ?? `NDA ${Math.random().toString(36).slice(2, 8)}`, routingType: routing });
  env = await api.addPdf(env.id);
  const documentId = env.documents[0].id;
  env = await api.addRecipient(env.id, { name: "Alice Signer", email: "alice@example.com", role: "signer", routingOrder: 1 });
  env = await api.addRecipient(env.id, {
    name: "Bob Counter",
    email: "bob@example.com",
    role: "signer",
    routingOrder: routing === "parallel" ? 1 : 2,
    ...(opts.bobAccessCode ? { authMethod: "access_code", accessCode: opts.bobAccessCode } : {}),
  });
  if (opts.cc || opts.ccAccessCode) {
    env = await api.addRecipient(env.id, {
      name: "Carol Copy",
      email: "carol@example.com",
      role: "cc",
      routingOrder: 3,
      ...(opts.ccAccessCode ? { authMethod: "access_code", accessCode: opts.ccAccessCode } : {}),
    });
  }
  const [alice, bob, carol] = env.recipients;
  const field = (recipientId: string, kind: string, page: number, x: number, y: number, width: number, height: number) =>
    api.addField(env.id, { documentId, recipientId, kind, page, x, y, width, height });
  await field(alice.id, "signature", 2, 0.18, 0.7, 0.24, 0.045);
  await field(alice.id, "date_signed", 2, 0.62, 0.71, 0.16, 0.03);
  if (!opts.signatureOnly) {
    await field(alice.id, "text", 1, 0.1, 0.2, 0.3, 0.03);
    await field(alice.id, "checkbox", 1, 0.1, 0.26, 0.03, 0.022);
  }
  await field(bob.id, "signature", 2, 0.18, 0.8, 0.24, 0.045);
  env = await api.send(env.id);
  return { envelope: env, documentId, alice, bob, carol };
}

/**
 * Sign as a recipient straight through the signer API (typed name, consent, no
 * field values) — for tests about what happens AFTER someone signs. Only for
 * recipients whose fields are all signatures/dates (`signatureOnly`, or Bob).
 */
export async function signViaApi(request: APIRequestContext, link: string, name: string): Promise<string> {
  const token = new URL(link).pathname.split("/").at(-1)!;
  const res = await request.post(`${API_URL}/sign/${token}/apply`, {
    data: { signature: { kind: "typed", name, font: "great_vibes" }, consent: true },
  });
  expect(res.ok(), `apply → ${res.status()}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { status: string }).status;
}

// ── Page helpers ──────────────────────────────────────────────────────────────

/** Wait until the viewer has rendered `count` PDF pages. */
export async function waitForPdfPages(page: Page, count: number): Promise<Locator> {
  const pages = page.getByTestId("pdf-page");
  await expect(pages).toHaveCount(count);
  for (let i = 0; i < count; i++) await expect(pages.nth(i)).toHaveAttribute("data-rendered", "true");
  return pages;
}

/** Click a rendered PDF page at a point given as fractions of its size (top-left origin). */
export async function clickOnPage(page: Page, pageNumber: number, x: number, y: number): Promise<void> {
  const target = page.locator(`[data-testid="pdf-page"][data-page="${pageNumber}"]`);
  const box = await target.boundingBox();
  if (!box) throw new Error(`PDF page ${pageNumber} is not visible`);
  await target.click({ position: { x: box.width * x, y: box.height * y } });
}

/** Draw a stroke across the signature canvas (the Draw tab must be open), from `fromX` to `toX` of its displayed width. */
export async function drawSignature(page: Page, fromX = 0.1, toX = 0.9): Promise<void> {
  const canvas = page.getByTestId("signature-canvas");
  // A trial click waits for the canvas to be visible AND stable — the dialog
  // animates in, and a box measured mid-animation would put the stroke elsewhere.
  await canvas.click({ trial: true });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("signature canvas is not visible");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * fromX, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ((fromX + toX) / 2), y - box.height * 0.2, { steps: 8 });
  await page.mouse.move(box.x + box.width * toX, y, { steps: 8 });
  await page.mouse.up();
}

/** Open the signer's "Adopt your signature" dialog. */
export async function openSignatureDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: /^(Add|Change) signature$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Adopt your signature" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Adopt a typed signature (the dialog's default tab). */
export async function adoptTypedSignature(page: Page, name: string): Promise<void> {
  const dialog = await openSignatureDialog(page);
  await dialog.getByLabel("Full name").fill(name);
  await dialog.getByRole("button", { name: "Adopt signature" }).click();
  await expect(dialog).toBeHidden();
}

/** Open the dialog's Draw tab (the canvas is then ready for `drawSignature`). */
export async function openDrawTab(page: Page): Promise<Locator> {
  const dialog = await openSignatureDialog(page);
  await dialog.getByRole("tab", { name: "Draw" }).click();
  return dialog;
}

/** Adopt a drawn signature. */
export async function adoptDrawnSignature(page: Page): Promise<void> {
  const dialog = await openDrawTab(page);
  await drawSignature(page);
  await dialog.getByRole("button", { name: "Adopt signature" }).click();
  await expect(dialog).toBeHidden();
}

/**
 * How far right the ink on the signature canvas reaches, as a fraction of the
 * canvas's own width. A stroke drawn to 90% of the displayed width should reach
 * about 0.9; if pointer coordinates are not scaled to the canvas, it falls short.
 */
export async function inkRightEdge(page: Page): Promise<number> {
  return page.getByTestId("signature-canvas").evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const { data, width, height } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
    let maxX = -1;
    for (let y = 0; y < height; y++) {
      for (let x = width - 1; x > maxX; x--) {
        if (data[(y * width + x) * 4 + 3] > 0) {
          maxX = x;
          break;
        }
      }
    }
    return maxX / width;
  });
}

/** The ESIGN/UETA consent checkbox on the signer page. */
export const consentBox = (page: Page): Locator =>
  page.getByRole("checkbox", { name: /electronic records and signatures/i });

export const signButton = (page: Page): Locator => page.getByRole("button", { name: "Sign all fields" });

/** Pick an option in a shadcn/Radix select, found by its label. */
export async function chooseOption(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(page.getByRole("listbox")).toBeHidden();
}

/** Fill a reason dialog (void, decline) and confirm it. */
export async function confirmWithReason(page: Page, dialogTitle: string | RegExp, reason: string, confirm: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: dialogTitle });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill(reason);
  await dialog.getByRole("button", { name: confirm, exact: true }).click();
  await expect(dialog).toBeHidden();
}
