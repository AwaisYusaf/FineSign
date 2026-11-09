/**
 * The sender console: the API-key gate and the five-step envelope wizard, driven
 * entirely through the UI, then cross-checked against what the API stored.
 */
import { API_KEY } from "./env";
import { clickOnPage, expect, samplePdf, test, waitForPdfPages } from "./support";

test("the console stays locked until a sender API key is entered", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sender access" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Envelopes" })).toHaveCount(0);

  await page.getByPlaceholder("Sender API key").fill(API_KEY);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Envelopes" })).toBeVisible();

  // "Change key" locks the console again.
  await page.getByRole("button", { name: "Change key" }).click();
  await expect(page.getByRole("heading", { name: "Sender access" })).toBeVisible();
});

test("a sender builds, fields and sends an envelope through the wizard", async ({ senderPage: page, api }) => {
  const title = `Wizard NDA ${Date.now()}`;
  await page.goto("/new");

  await test.step("1. details", async () => {
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Your name").fill("Jane Q. Public");
    await page.getByLabel("Your email").fill("jane@example.com");
    await page.getByRole("combobox", { name: "Signing order" }).selectOption("sequential");
    await page.getByRole("button", { name: "Create draft" }).click();
  });

  await test.step("2. upload a PDF", async () => {
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: "nda.pdf", mimeType: "application/pdf", buffer: await samplePdf() });
    await expect(page.getByRole("listitem").filter({ hasText: "nda.pdf" })).toContainText("2 page(s)");
    await page.getByRole("button", { name: "Next" }).click();
  });

  await test.step("3. add two signers (one with an access code) and a CC", async () => {
    const add = async (r: { name: string; email: string; role: string; order: number; code?: string }) => {
      await page.getByLabel("Name", { exact: true }).fill(r.name);
      await page.getByLabel("Email", { exact: true }).fill(r.email);
      await page.getByRole("combobox", { name: "Role" }).selectOption(r.role);
      await page.getByLabel("Order").fill(String(r.order));
      if (r.code) await page.getByLabel("Access code (optional)").fill(r.code);
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("cell", { name: r.email })).toBeVisible();
    };
    await add({ name: "Alice Signer", email: "alice@example.com", role: "signer", order: 1 });
    await add({ name: "Bob Counter", email: "bob@example.com", role: "signer", order: 2, code: "4242" });
    await add({ name: "Carol Copy", email: "carol@example.com", role: "cc", order: 3 });
    await expect(page.getByRole("row").filter({ hasText: "bob@example.com" })).toContainText("code");
    await page.getByRole("button", { name: "Next" }).click();
  });

  await test.step("4. place fields by clicking the pages, and remove a misplaced one", async () => {
    await waitForPdfPages(page, 2);
    const placed = page.getByTitle(/click to remove/);
    const place = async (assignee: string, kind: string, pageNumber: number, x: number, y: number) => {
      const before = await placed.count();
      await page.getByRole("combobox", { name: "Assign to" }).selectOption({ label: assignee });
      await page.getByRole("combobox", { name: "Field", exact: true }).selectOption({ label: kind });
      await clickOnPage(page, pageNumber, x, y);
      await expect(placed).toHaveCount(before + 1);
    };
    await place("Alice Signer", "Signature", 2, 0.2, 0.7);
    await place("Alice Signer", "Date signed", 2, 0.62, 0.7);
    await place("Alice Signer", "Text", 1, 0.1, 0.2);
    await place("Alice Signer", "Checkbox", 1, 0.1, 0.3);
    await place("Bob Counter", "Signature", 2, 0.2, 0.82);
    // CC recipients receive the finished copy; they are not offered as assignees.
    await expect(page.getByRole("combobox", { name: "Assign to" }).locator("option")).toHaveText(["Alice Signer", "Bob Counter"]);

    await place("Alice Signer", "Initials", 1, 0.6, 0.5);
    await page.getByTitle(/^initials — Alice Signer/).click();
    await expect(placed).toHaveCount(5);
    await page.getByRole("button", { name: "Review & send" }).click();
  });

  await test.step("5. send with a 7-day expiry", async () => {
    await expect(page.getByText(/Ready to send/)).toContainText("3 recipient(s) with 5 field(s)");
    await page.getByLabel("Expires after (days)").fill("7");
    await page.getByRole("button", { name: "Send envelope" }).click();
    await expect(page.getByText("Sent!")).toBeVisible();
    // Sequential routing: only the first signer has a link so far.
    const links = page.getByRole("listitem").filter({ has: page.getByRole("link") });
    await expect(links).toHaveCount(1);
    await expect(links).toContainText("Alice Signer");
  });

  await test.step("the detail page reflects what was sent", async () => {
    await page.getByRole("link", { name: "View envelope" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByText(/^Expires /)).toBeVisible();
    const status = (email: string) => page.getByRole("row").filter({ hasText: email });
    await expect(status("alice@example.com")).toContainText("notified");
    await expect(status("bob@example.com")).toContainText("pending");
    await expect(status("carol@example.com")).toContainText("pending");
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
