/**
 * The sender console: the API-key gate and the five-step envelope wizard, driven
 * entirely through the UI, then cross-checked against what the API stored.
 */
import { API_KEY } from "./env";
import {
  adoptTypedSignature,
  chooseOption,
  clickOnPage,
  consentBox,
  expect,
  samplePdf,
  test,
  waitForPdfPages,
} from "./support";

test("the console stays locked until a valid sender API key is entered", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sender access" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Envelopes" })).toHaveCount(0);

  // The key is checked with the server before it's kept.
  await page.getByPlaceholder("Sender API key").fill("not-the-right-key-000000");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("The server rejected that key")).toBeVisible();

  await page.getByPlaceholder("Sender API key").fill(API_KEY);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Envelopes" })).toBeVisible();

  // "Change API key" (account menu) locks the console again.
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Change API key" }).click();
  await expect(page.getByRole("heading", { name: "Sender access" })).toBeVisible();
});

test("a sender builds, fields and sends an envelope through the wizard", async ({ senderPage: page, api }) => {
  const title = `Wizard NDA ${Date.now()}`;
  await page.goto("/new");

  await test.step("1. details", async () => {
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Your name").fill("Jane Q. Public");
    await page.getByLabel("Your email").fill("jane@example.com");
    await expect(page.getByRole("radio", { name: /Sequential/ })).toBeChecked(); // the default
    await page.getByRole("button", { name: "Create draft" }).click();
    // The draft now has its own URL, so the wizard survives a refresh.
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/edit\?step=documents$/);
  });

  await test.step("2. upload a PDF", async () => {
    await page.getByLabel("Upload documents").setInputFiles({ name: "nda.pdf", mimeType: "application/pdf", buffer: await samplePdf() });
    await expect(page.getByRole("list", { name: "Documents" }).getByRole("listitem")).toContainText(["nda.pdf"]);
    await expect(page.getByRole("list", { name: "Documents" })).toContainText("2 pages");
    await page.getByRole("button", { name: "Continue to recipients" }).click();
  });

  await test.step("3. add two signers (one with an access code) and a CC", async () => {
    const add = async (r: { name: string; email: string; role: string; step: number; code?: string }) => {
      await page.getByLabel("Name", { exact: true }).fill(r.name);
      await page.getByLabel("Email", { exact: true }).fill(r.email);
      await chooseOption(page, "Role", r.role);
      await page.getByRole("spinbutton", { name: "Step", exact: true }).fill(String(r.step));
      if (r.code) await page.getByLabel("Access code (optional)").fill(r.code);
      await page.getByRole("button", { name: "Add recipient" }).click();
      await expect(page.getByRole("list", { name: "Recipients" })).toContainText(r.email);
    };
    await add({ name: "Alice Signer", email: "alice@example.com", role: "Signer", step: 1 });
    await add({ name: "Bob Counter", email: "bob@example.com", role: "Signer", step: 2, code: "4242" });
    await add({ name: "Carol Copy", email: "carol@example.com", role: "CC", step: 3 });
    const bob = page.getByRole("list", { name: "Recipients" }).getByRole("listitem").filter({ hasText: "bob@example.com" });
    await expect(bob.getByLabel("Access code")).toBeVisible();
    await page.getByRole("button", { name: "Continue to fields" }).click();
  });

  await test.step("4. place fields by clicking the pages, and remove a misplaced one", async () => {
    const pages = await waitForPdfPages(page, 2);
    // Placed fields are named "<Kind> for <Recipient>" (each page also has a
    // keyboard "Place … on page N" button, which this must not count).
    const placed = pages.getByRole("button", { name: / for (Alice Signer|Bob Counter)$/ });
    const place = async (assignee: string, kind: string, pageNumber: number, x: number, y: number) => {
      const before = await placed.count();
      await page.getByRole("radiogroup", { name: "Assign to" }).getByRole("radio", { name: new RegExp(assignee) }).click();
      await page.getByRole("radiogroup", { name: "Field type" }).getByRole("radio", { name: kind, exact: true }).click();
      await clickOnPage(page, pageNumber, x, y);
      await expect(placed).toHaveCount(before + 1);
    };
    await place("Alice Signer", "Signature", 2, 0.2, 0.7);
    await place("Alice Signer", "Date signed", 2, 0.62, 0.7);
    await place("Alice Signer", "Text", 1, 0.1, 0.2);
    await place("Alice Signer", "Checkbox", 1, 0.1, 0.3);
    await place("Bob Counter", "Signature", 2, 0.2, 0.82);
    // CC recipients receive the finished copy; they are not offered as assignees.
    await expect(page.getByRole("radiogroup", { name: "Assign to" }).getByRole("radio")).toHaveCount(2);

    await place("Alice Signer", "Initials", 1, 0.6, 0.5);
    await page.getByRole("button", { name: "Initials for Alice Signer" }).click(); // select it…
    await page.getByRole("button", { name: "Remove field" }).click(); // …and remove it
    await expect(placed).toHaveCount(5);
    await page.getByRole("button", { name: "Review & send", exact: true }).click(); // not the stepper's
  });

  await test.step("5. send with a 7-day expiry", async () => {
    await expect(page.getByText("4 fields · step 1")).toBeVisible(); // Alice's count in the summary
    await page.getByLabel("Expires after (days)").fill("7");
    await page.getByRole("button", { name: "Send envelope" }).click();
  });

  await test.step("the detail page reflects what was sent", async () => {
    await expect(page).toHaveURL(/\/envelopes\/[^/]+$/);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByText("Out for signature", { exact: true })).toBeVisible();
    await expect(page.getByText(/Expires /)).toBeVisible();
    const row = (email: string) => page.getByRole("listitem", { name: new RegExp(email) });
    await expect(row("alice@example.com")).toContainText("Sent");
    await expect(row("bob@example.com")).toContainText("Waiting");
    await expect(row("carol@example.com")).toContainText("Gets a copy");
    // Sequential routing: only the first signer has a link so far.
    const devLinks = page.locator("[data-slot=card]").filter({ hasText: "Signer links (dev mode)" });
    await expect(devLinks.getByRole("link")).toHaveCount(1);
    await expect(devLinks).toContainText("Alice Signer");
  });

  await test.step("the API stored exactly what was placed", async () => {
    const id = page.url().split("/").at(-1)!;
    const env = await api.get(id);
    expect(env.status).toBe("sent");
    const byName = Object.fromEntries(env.recipients.map((r) => [r.name, r]));
    const fields = env.fields.map((f) => ({ kind: f.kind, who: env.recipients.find((r) => r.id === f.recipientId)!.name }));
    expect(fields).toEqual(
      expect.arrayContaining([
        { kind: "signature", who: "Alice Signer" },
        { kind: "date_signed", who: "Alice Signer" },
        { kind: "text", who: "Alice Signer" },
        { kind: "checkbox", who: "Alice Signer" },
        { kind: "signature", who: "Bob Counter" },
      ])
    );
    expect(env.fields).toHaveLength(5);
    const aliceSig = env.fields.find((f) => f.kind === "signature" && f.recipientId === byName["Alice Signer"].id)!;
    expect(aliceSig.page).toBe(2);
    expect(aliceSig.x).toBeCloseTo(0.2, 2); // where the click landed, in display-space fractions
    expect(aliceSig.y).toBeCloseTo(0.7, 2);
    const days = (Date.parse(env.expiresAt!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });
});

test("a draft left half-way can be resumed from its detail page", async ({ senderPage: page, api }) => {
  // A draft with a document but no recipients yet.
  let env = await api.create({ title: `Resume me ${Date.now()}`, routingType: "parallel" });
  env = await api.addPdf(env.id);

  await page.goto(`/envelopes/${env.id}`);
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Continue editing" }).click();
  // It opens at the first step with work left: recipients.
  await expect(page).toHaveURL(new RegExp(`/envelopes/${env.id}/edit`));
  await expect(page.getByRole("button", { name: "Recipients" })).toHaveAttribute("aria-current", "step");
  await expect(page.getByText("Add a recipient")).toBeVisible();
  // Parallel routing: no signing-order step to set.
  await expect(page.getByRole("spinbutton", { name: "Step", exact: true })).toHaveCount(0);
});

test("a field can be placed with the keyboard alone", async ({ senderPage: page, api }) => {
  let env = await api.create({ title: `Keyboard ${Date.now()}`, routingType: "sequential" });
  env = await api.addPdf(env.id);
  env = await api.addRecipient(env.id, { name: "Alice Signer", email: "alice@example.com", role: "signer", routingOrder: 1 });
  await page.goto(`/envelopes/${env.id}/edit?step=fields`);
  await waitForPdfPages(page, 2);

  const place = page.getByRole("button", { name: "Place signature field for Alice Signer on page 2" });
  await place.focus();
  await page.keyboard.press("Enter");
  const placed = page.getByRole("button", { name: "Signature for Alice Signer" });
  await expect(placed).toHaveAttribute("aria-pressed", "true"); // selected, so Delete undoes it
  const fields = (await api.get(env.id)).fields;
  expect(fields).toHaveLength(1);
  expect(fields[0]).toMatchObject({ page: 2, kind: "signature" });

  await page.keyboard.press("Delete");
  await expect(placed).toHaveCount(0);
  await expect.poll(async () => (await api.get(env.id)).fields.length).toBe(0);
});

test("an approver needs no fields: the envelope sends and they can review and approve", async ({ senderPage: page, browser, api }) => {
  let env = await api.create({ title: `Approval ${Date.now()}`, routingType: "parallel" });
  env = await api.addPdf(env.id);
  env = await api.addRecipient(env.id, { name: "Alice Signer", email: "alice@example.com", role: "signer", routingOrder: 1 });
  env = await api.addRecipient(env.id, { name: "Ann Approver", email: "ann@example.com", role: "approver", routingOrder: 1 });
  const [alice, ann] = env.recipients;
  await api.addField(env.id, { documentId: env.documents[0].id, recipientId: alice.id, kind: "signature", page: 2, x: 0.18, y: 0.7, width: 0.24, height: 0.045 });

  // The wizard used to refuse this, though the server accepts it.
  await page.goto(`/envelopes/${env.id}/edit?step=review`);
  await expect(page.getByText(/no fields/)).toHaveCount(0);
  await page.getByRole("button", { name: "Send envelope" }).click();
  await expect(page).toHaveURL(new RegExp(`/envelopes/${env.id}$`));

  // The approver's session used to have no documents at all.
  const signer = await (await browser.newContext()).newPage();
  await signer.goto((await api.linkFor(env.id, ann.id))!);
  await expect(signer.getByText(/please review the documents below, then approve/)).toBeVisible();
  await waitForPdfPages(signer, 2);
  await adoptTypedSignature(signer, "Ann Approver");
  await consentBox(signer).check();
  await signer.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(signer.getByRole("heading", { name: "Approval recorded" })).toBeVisible();
  await signer.context().close();
});

test("the dashboard lists the newest envelope first", async ({ senderPage: page, api }) => {
  const stamp = `Order ${Date.now()}`;
  await api.create({ title: `${stamp} older`, routingType: "sequential" });
  await api.create({ title: `${stamp} newer`, routingType: "sequential" });
  await page.goto("/");
  await page.getByPlaceholder("Search title or recipient").fill(stamp);
  const rows = page.getByRole("row").filter({ hasText: stamp });
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("newer");
});

test("paging back through the dashboard asks for what comes before the last envelope shown", async ({ senderPage: page }) => {
  // The list API is stubbed: the server's keyset paging has its own contract and
  // HTTP tests, and 50+ real envelopes in the shared database would push other
  // tests' envelopes off the first page. This pins the UI's half: it pages with
  // `before=<last id shown>`, never a shifting offset.
  const envelope = (n: number) => ({
    id: `env-${n}`,
    title: `Stub envelope ${n}`,
    status: "draft",
    routingType: "sequential",
    senderName: "Jane Q. Public",
    senderEmail: "jane@example.com",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    sentAt: null,
    completedAt: null,
    voidedReason: null,
    expiresAt: null,
    documents: [],
    recipients: [],
    fields: [],
    audit: [],
  });
  const newestFirst = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => envelope(from - i));
  const asked: (string | null)[] = [];
  await page.route(/\/api\/envelopes\?/, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("offset"), "pages by cursor, not offset").toBeNull();
    const before = url.searchParams.get("before");
    if (url.searchParams.get("limit") !== "1") asked.push(before); // not the key check
    await route.fulfill({ json: before === null ? newestFirst(60, 11) : before === "env-11" ? newestFirst(10, 1) : [] });
  });

  await page.goto("/");
  await expect(page.getByRole("row").filter({ hasText: "Stub envelope 60" })).toBeVisible();
  await page.getByRole("button", { name: /Older/ }).click();
  await expect(page.getByRole("row").filter({ hasText: "Stub envelope 10" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Stub envelope 11" })).toHaveCount(0);
  await expect(page.getByText("51–60")).toBeVisible();
  await page.getByRole("button", { name: /Newer/ }).click();
  await expect(page.getByRole("row").filter({ hasText: "Stub envelope 60" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Newer/ })).toBeDisabled();
  // Page 1, then "before env-11"; returning shows page 1 from the cache (and may
  // refresh it), but never asks by offset or with any other cursor.
  expect(asked.slice(0, 2)).toEqual([null, "env-11"]);
  expect(asked.every((b) => b === null || b === "env-11")).toBe(true);
});
