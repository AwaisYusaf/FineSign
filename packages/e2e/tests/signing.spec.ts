/**
 * The signer's side: tokenized links, the access-code gate, field capture,
 * typed and drawn signatures, routing order, completion, the PAdES seal, and
 * the finished copy every recipient (CC included) can download.
 */
import { PDFDocument } from "pdf-lib";
import {
  adoptDrawnSignature,
  adoptTypedSignature,
  consentBox,
  drawSignature,
  expect,
  inkRightEdge,
  openDrawTab,
  openSignatureDialog,
  seedSentEnvelope,
  signButton,
  signViaApi,
  test,
  waitForPdfPages,
} from "./support";

test("sequential signing with an access code completes, seals, and reaches every recipient", async ({
  page,
  senderPage,
  api,
}) => {
  const { envelope, documentId, alice, bob, carol } = await seedSentEnvelope(api, { bobAccessCode: "4242", cc: true });

  await test.step("only the first signer has a link until they sign", async () => {
    expect(await api.linkFor(envelope.id, alice.id)).toBeTruthy();
    expect(await api.linkFor(envelope.id, bob.id)).toBeUndefined();
  });

  await test.step("Alice fills her fields, types a signature, consents and signs", async () => {
    await page.goto((await api.linkFor(envelope.id, alice.id))!);
    await expect(page.getByRole("heading", { name: envelope.title })).toBeVisible();
    await expect(page.getByText("Hi Alice Signer")).toBeVisible();
    const pdf = await waitForPdfPages(page, 2);
    await pdf.getByLabel(/Text field/).fill("Acme Corp");
    await pdf.getByRole("checkbox").check();
    await adoptTypedSignature(page, "Alice Signer");
    await consentBox(page).check();
    await signButton(page).click();
    await expect(page.getByRole("heading", { name: /Signature recorded/ })).toBeVisible();
  });

  await test.step("Bob must pass the access-code gate before seeing anything", async () => {
    await page.goto((await api.linkFor(envelope.id, bob.id))!);
    await expect(page.getByRole("heading", { name: "Enter your access code" })).toBeVisible();
    await expect(page.getByTestId("pdf-page")).toHaveCount(0); // documents stay hidden
    await page.getByPlaceholder("Access code").fill("0000");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("That access code is incorrect.")).toBeVisible();
    await page.getByPlaceholder("Access code").fill("4242");
    await page.getByRole("button", { name: "Continue" }).click();
    await waitForPdfPages(page, 2);
  });

  await test.step("Bob draws a signature and completes the envelope", async () => {
    await adoptDrawnSignature(page);
    await consentBox(page).check();
    await signButton(page).click();
    await expect(page.getByRole("heading", { name: /All done/ })).toBeVisible();
  });

  await test.step("the API shows a completed, sealed envelope with a full audit trail", async () => {
    const env = await api.get(envelope.id);
    expect(env.status).toBe("completed");
    expect(env.recipients.filter((r) => r.role === "signer").map((r) => r.status)).toEqual(["signed", "signed"]);
    expect(env.audit.map((a) => a.type)).toEqual(
      expect.arrayContaining(["recipient_consented", "recipient_authenticated", "recipient_signed", "envelope_completed"])
    );
    const verdict = await api.verify(envelope.id, documentId);
    expect(verdict).toMatchObject({ valid: true, level: "B-T", signatureCount: 1 });
    // The certificate of completion is appended to the signed PDF.
    const signed = await PDFDocument.load(await api.download(envelope.id, documentId));
    expect(signed.getPageCount()).toBeGreaterThan(2);
  });

  await test.step("the sender sees it completed and can verify the seal in the UI", async () => {
    await senderPage.goto(`/envelopes/${envelope.id}`);
    await expect(senderPage.locator('[data-slot="badge"]').filter({ hasText: /^Completed$/ })).toBeVisible();
    await expect(senderPage.getByText("2 of 2 done")).toBeVisible();
    await expect(senderPage.getByRole("listitem", { name: /carol@example.com/ })).toContainText("Copy sent");
    await senderPage.getByRole("button", { name: "Verify seal" }).click();
    await expect(senderPage.getByText(/Seal valid/)).toContainText("PAdES B-T");
    await expect(senderPage.getByRole("button", { name: /Certificate of completion/ })).toBeVisible();
  });

  await test.step("the CC recipient's link opens the finished package", async () => {
    await page.goto((await api.linkFor(envelope.id, carol!.id))!);
    await expect(page.getByText("This agreement is complete.")).toBeVisible();
    const doc = page.getByRole("link", { name: "nda.pdf" });
    const res = await page.request.get(new URL((await doc.getAttribute("href"))!, page.url()).toString());
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    expect((await res.body()).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

test("parallel routing lets every signer sign at once", async ({ browser, api }) => {
  const { envelope, alice, bob } = await seedSentEnvelope(api, { routing: "parallel" });
  const aliceLink = await api.linkFor(envelope.id, alice.id);
  const bobLink = await api.linkFor(envelope.id, bob.id);
  expect(aliceLink && bobLink, "both signers are notified at send").toBeTruthy();

  // Two independent browser sessions, as two people on two machines.
  const sign = async (link: string, name: string, fillAliceFields: boolean) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(link);
    const pdf = await waitForPdfPages(page, 2);
    if (fillAliceFields) {
      await pdf.getByLabel(/Text field/).fill("Globex LLC");
      await pdf.getByRole("checkbox").check(); // a required checkbox must be ticked
    }
    await adoptTypedSignature(page, name);
    await consentBox(page).check();
    await signButton(page).click();
    await expect(page.getByRole("heading", { name: /Signature recorded|All done/ })).toBeVisible();
    await ctx.close();
  };
  await Promise.all([sign(bobLink!, "Bob Counter", false), sign(aliceLink!, "Alice Signer", true)]);

  expect((await api.get(envelope.id)).status).toBe("completed");
});

test("a drawn signature lands where the pointer moves (desktop)", async ({ page, api }) => {
  // Also the control for mobile.spec.ts: it proves the ink measurement works.
  const { envelope, alice } = await seedSentEnvelope(api);
  await page.goto((await api.linkFor(envelope.id, alice.id))!);
  await waitForPdfPages(page, 2);

  await openDrawTab(page);
  await drawSignature(page, 0.1, 0.9);
  const reach = await inkRightEdge(page);
  expect(reach).toBeGreaterThan(0.85);
  expect(reach).toBeLessThan(0.95);
});

test("the sign button explains, step by step, what is still missing", async ({ page, api }) => {
  const { envelope, alice } = await seedSentEnvelope(api);
  await page.goto((await api.linkFor(envelope.id, alice.id))!);
  const pdf = await waitForPdfPages(page, 2);
  const hint = page.getByText(/left to complete|to finish\.|Everything's ready/);

  await expect(signButton(page)).toBeDisabled();
  await expect(hint).toHaveText("3 required fields left to complete."); // text, checkbox, signature
  await pdf.getByLabel(/Text field/).fill("Acme Corp");
  await pdf.getByRole("checkbox").check();
  await expect(hint).toHaveText("1 required field left to complete.");
  await adoptTypedSignature(page, "Alice Signer");
  await expect(hint).toHaveText("Agree to sign electronically (above) to finish.");
  await expect(signButton(page)).toBeDisabled();
  await consentBox(page).check();
  await expect(hint).toHaveText("Everything's ready.");
  await expect(signButton(page)).toBeEnabled();
});

test("Next field takes the signer to a required field they skipped", async ({ page, api }) => {
  const { envelope, alice } = await seedSentEnvelope(api);
  await page.goto((await api.linkFor(envelope.id, alice.id))!);
  const pdf = await waitForPdfPages(page, 2);

  await pdf.getByRole("checkbox").check();
  await adoptTypedSignature(page, "Alice Signer");
  await consentBox(page).check();
  await expect(signButton(page)).toBeDisabled(); // the required text field is still empty

  await page.getByRole("button", { name: "Next field" }).first().click();
  await expect(pdf.getByLabel(/Text field/)).toBeFocused();
  await page.keyboard.type("Acme Corp");
  await expect(signButton(page)).toBeEnabled();
});

test("a CC's access code guards the finished package", async ({ page, api }) => {
  const { envelope, documentId, alice, bob, carol } = await seedSentEnvelope(api, {
    routing: "parallel",
    signatureOnly: true,
    ccAccessCode: "8080",
  });
  await signViaApi(page.request, (await api.linkFor(envelope.id, alice.id))!, "Alice Signer");
  expect(await signViaApi(page.request, (await api.linkFor(envelope.id, bob.id))!, "Bob Counter")).toBe("completed");

  // The completed link used to say "complete" and then 403 on every download.
  await page.goto((await api.linkFor(envelope.id, carol!.id))!);
  await expect(page.getByRole("heading", { name: "Enter your access code" })).toBeVisible();
  await expect(page.getByRole("link", { name: "nda.pdf" })).toHaveCount(0);
  await page.getByPlaceholder("Access code").fill("8080");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("This agreement is complete.")).toBeVisible();
  const href = await page.getByRole("link", { name: "nda.pdf" }).getAttribute("href");
  const res = await page.request.get(new URL(href!, page.url()).toString());
  expect(res.status()).toBe(200);
  void documentId;
});

test("a signer who reopens their link after signing is told they're done", async ({ page, api }) => {
  const { envelope, alice } = await seedSentEnvelope(api, { signatureOnly: true });
  const link = (await api.linkFor(envelope.id, alice.id))!;
  expect(await signViaApi(page.request, link, "Alice Signer")).toBe("sent"); // Bob is next
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Signature recorded" })).toBeVisible();
  await expect(signButton(page)).toHaveCount(0);
});

test("the signature dialog steers names its fonts can't write to a style that can, or to drawing", async ({ page, api }) => {
  const { envelope, alice } = await seedSentEnvelope(api, { signatureOnly: true });
  await page.goto((await api.linkFor(envelope.id, alice.id))!);
  await waitForPdfPages(page, 2);
  const dialog = await openSignatureDialog(page);
  const styles = dialog.getByRole("radiogroup", { name: "Signature style" });

  // Cyrillic: only Great Vibes and Pacifico carry it.
  await dialog.getByLabel("Full name").fill("Иван Петров");
  await expect(styles.getByRole("radio", { name: /Dancing Script/ })).toBeDisabled();
  await expect(styles.getByRole("radio", { name: /Pinyon Script/ })).toBeDisabled();
  await expect(styles.getByRole("radio", { name: "Great Vibes" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("button", { name: "Adopt signature" })).toBeEnabled();

  // A script no bundled font has: no typed signature, a way to draw instead.
  await dialog.getByLabel("Full name").fill("李小龍");
  await expect(styles).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Adopt signature" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Draw your signature" }).click();
  await expect(dialog.getByRole("tab", { name: "Draw" })).toHaveAttribute("aria-selected", "true");
  await drawSignature(page);
  await expect(dialog.getByRole("button", { name: "Adopt signature" })).toBeEnabled();
});

test("text the document can't print is flagged before the signer submits", async ({ page, api }) => {
  const { envelope, alice } = await seedSentEnvelope(api);
  await page.goto((await api.linkFor(envelope.id, alice.id))!);
  const pdf = await waitForPdfPages(page, 2);
  const hint = page.getByText(/can't print|left to complete|to finish\.|Everything's ready/);

  await pdf.getByLabel(/Text field/).fill("Москва");
  await pdf.getByRole("checkbox").check();
  await adoptTypedSignature(page, "Alice Signer");
  await consentBox(page).check();
  await expect(pdf.getByLabel(/Text field/)).toHaveAttribute("aria-invalid", "true");
  await expect(hint).toContainText("The document can't print");
  await expect(signButton(page)).toBeDisabled();

  await pdf.getByLabel(/Text field/).fill("Café Zoë");
  await expect(hint).toHaveText("Everything's ready.");
  await expect(signButton(page)).toBeEnabled();
});

test("reopening the signature dialog keeps the adopted signature, typed or drawn", async ({ page, api }) => {
  const { envelope, alice } = await seedSentEnvelope(api, { signatureOnly: true });
  await page.goto((await api.linkFor(envelope.id, alice.id))!);
  await waitForPdfPages(page, 2);

  let dialog = await openSignatureDialog(page);
  await dialog.getByLabel("Full name").fill("Alice Q. Signer");
  await dialog.getByRole("radio", { name: "Pacifico" }).click();
  await dialog.getByRole("button", { name: "Adopt signature" }).click();
  await expect(dialog).toBeHidden();

  // It used to reopen on Great Vibes with the recipient's name.
  dialog = await openSignatureDialog(page);
  await expect(dialog.getByLabel("Full name")).toHaveValue("Alice Q. Signer");
  await expect(dialog.getByRole("radio", { name: "Pacifico" })).toHaveAttribute("aria-checked", "true");

  // A drawing survives a trip to the Type tab (Radix used to unmount it, so an
  // invisible drawing stayed adoptable).
  await dialog.getByRole("tab", { name: "Draw" }).click();
  await drawSignature(page, 0.1, 0.9);
  await dialog.getByRole("tab", { name: "Type" }).click();
  await dialog.getByRole("tab", { name: "Draw" }).click();
  expect(await inkRightEdge(page)).toBeGreaterThan(0.85);
  await dialog.getByRole("button", { name: "Adopt signature" }).click();
  await expect(dialog).toBeHidden();

  dialog = await openSignatureDialog(page);
  await expect(dialog.getByRole("tab", { name: "Draw" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("button", { name: "Adopt signature" })).toBeEnabled();
  await expect.poll(() => inkRightEdge(page)).toBeGreaterThan(0.85);
});
