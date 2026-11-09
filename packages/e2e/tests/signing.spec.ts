/**
 * The signer's side: tokenized links, the access-code gate, field capture,
 * typed and drawn signatures, routing order, completion, the PAdES seal, and
 * the finished copy every recipient (CC included) can download.
 */
import { PDFDocument } from "pdf-lib";
import {
  consentBox,
  drawSignature,
  inkRightEdge,
  expect,
  seedSentEnvelope,
  signButton,
  test,
  typeSignature,
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
    await pdf.getByPlaceholder("text").fill("Acme Corp");
    await pdf.getByRole("checkbox").check();
    await typeSignature(page, "Alice Signer");
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
    await drawSignature(page);
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
    await expect(senderPage.getByText("completed", { exact: true })).toBeVisible();
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
      await pdf.getByPlaceholder("text").fill("Globex LLC");
      await pdf.getByRole("checkbox").check(); // a required checkbox must be ticked
    }
    await typeSignature(page, name);
    await consentBox(page).check();
    await signButton(page).click();
    await expect(page.getByRole("heading", { name: /Signature recorded|All done/ })).toBeVisible();
    await ctx.close();
  };
  await Promise.all([sign(bobLink!, "Bob Counter", false), sign(aliceLink!, "Alice Signer", true)]);

  expect((await api.get(envelope.id)).status).toBe("completed");
});

test("a drawn signature lands where the pointer moves (desktop)", async ({ page, api }) => {
  // Also the control for mobile.spec.ts's U.4 test: it proves the ink
  // measurement itself works, so that test fails for the right reason.
  const { envelope, alice } = await seedSentEnvelope(api);
  await page.goto((await api.linkFor(envelope.id, alice.id))!);
  await waitForPdfPages(page, 2);

  await drawSignature(page, 0.1, 0.9);
  const reach = await inkRightEdge(page);
  expect(reach).toBeGreaterThan(0.85);
  expect(reach).toBeLessThan(0.95);
});

test("signing stays disabled until there is a signature and consent", async ({ page, api }) => {
  const { envelope, alice } = await seedSentEnvelope(api);
  await page.goto((await api.linkFor(envelope.id, alice.id))!);
  await waitForPdfPages(page, 2);

  await expect(signButton(page)).toBeDisabled();
  await expect(page.getByText("Draw or type your signature to enable signing.")).toBeVisible();
  await typeSignature(page, "Alice Signer");
  await expect(signButton(page)).toBeDisabled();
  await expect(page.getByText("Check the consent box above to enable signing.")).toBeVisible();
  await consentBox(page).check();
  await expect(signButton(page)).toBeEnabled();
});

test("a required text field left empty is rejected and nothing is signed", async ({ page, api }) => {
  const { envelope, alice } = await seedSentEnvelope(api);
  await page.goto((await api.linkFor(envelope.id, alice.id))!);
  const pdf = await waitForPdfPages(page, 2);

  await pdf.getByRole("checkbox").check(); // everything else is complete…
  await typeSignature(page, "Alice Signer");
  await consentBox(page).check();
  await signButton(page).click(); // …but the required text field is empty

  await expect(page.getByText(/required fields are incomplete/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: /Signature recorded/ })).toHaveCount(0);
  const env = await api.get(envelope.id);
  expect(env.recipients.find((r) => r.id === alice.id)!.status).not.toBe("signed");
});
