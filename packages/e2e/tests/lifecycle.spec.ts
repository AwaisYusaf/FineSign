/**
 * Everything that is not the happy path: declining, voiding, dead links,
 * reminders and resends (which rotate the link), and the webhooks admin page.
 * Expiry is not driven here — it needs a controllable clock, so it is covered
 * by the server's integration tests with a FixedClock.
 */
import { confirmWithReason, expect, seedSentEnvelope, test, waitForPdfPages } from "./support";

const UNAVAILABLE = { name: "Signing link unavailable" };

test("a signer who declines ends the envelope for everyone", async ({ page, senderPage, api }) => {
  const { envelope, alice } = await seedSentEnvelope(api);
  const link = (await api.linkFor(envelope.id, alice.id))!;
  await page.goto(link);
  await waitForPdfPages(page, 2);

  await page.getByRole("button", { name: "Decline to sign" }).click();
  await confirmWithReason(page, "Decline to sign?", "The payment terms are wrong.", "Decline");
  await expect(page.getByRole("heading", { name: "Declined" })).toBeVisible();

  const env = await api.get(envelope.id);
  expect(env.status).toBe("declined");
  await senderPage.goto(`/envelopes/${envelope.id}`);
  await expect(senderPage.getByText("Declined", { exact: true }).first()).toBeVisible();
  await expect(senderPage.getByText("“The payment terms are wrong.”")).toBeVisible();
  await expect(senderPage.getByRole("button", { name: "Void envelope" })).toHaveCount(0);

  await page.goto(link); // the link is dead now, and says why
  await expect(page.getByRole("heading", UNAVAILABLE)).toBeVisible();
  await expect(page.getByText(/declined to sign, so this agreement is closed/)).toBeVisible();
});

test("cancelling the decline dialog keeps the signing session open", async ({ page, api }) => {
  const { envelope, alice } = await seedSentEnvelope(api);
  await page.goto((await api.linkFor(envelope.id, alice.id))!);
  await waitForPdfPages(page, 2);

  await page.getByRole("button", { name: "Decline to sign" }).click();
  const dialog = page.getByRole("dialog", { name: "Decline to sign?" });
  // An empty reason can't be submitted.
  await expect(dialog.getByRole("button", { name: "Decline", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Sign all fields" })).toBeVisible();
  expect((await api.get(envelope.id)).status).toBe("sent");
});

test("a sender can void a sent envelope, which kills the signing links", async ({ page, senderPage, api }) => {
  const { envelope, alice } = await seedSentEnvelope(api);
  const link = (await api.linkFor(envelope.id, alice.id))!;

  await senderPage.goto(`/envelopes/${envelope.id}`);
  await senderPage.getByRole("button", { name: "Void envelope" }).click();
  await confirmWithReason(senderPage, "Void this envelope?", "Sent to the wrong counterparty.", "Void envelope");
  await expect(senderPage.getByText("Voided", { exact: true })).toBeVisible();
  await expect(senderPage.getByRole("button", { name: "Void envelope" })).toHaveCount(0);

  const env = await api.get(envelope.id);
  expect(env.status).toBe("voided");
  expect(env.audit.map((a) => a.type)).toContain("envelope_voided");

  await page.goto(link);
  await expect(page.getByRole("heading", UNAVAILABLE)).toBeVisible();
  await expect(page.getByText(/sender withdrew this agreement/)).toBeVisible();
});

test("an unknown signing link is refused without revealing anything", async ({ page }) => {
  await page.goto("/s/not-a-real-signing-token");
  await expect(page.getByRole("heading", UNAVAILABLE)).toBeVisible();
  await expect(page.getByTestId("pdf-page")).toHaveCount(0);
});

test("remind and resend issue a fresh link and retire the old one", async ({ page, senderPage, api }) => {
  const { envelope, alice } = await seedSentEnvelope(api);
  const first = (await api.linkFor(envelope.id, alice.id))!;
  await senderPage.goto(`/envelopes/${envelope.id}`);
  const aliceRow = senderPage.getByRole("listitem", { name: /alice@example.com/ });

  await aliceRow.getByRole("button", { name: "Remind" }).click();
  await expect(senderPage.getByText("Reminder sent.")).toBeVisible();
  await expect.poll(() => api.linkFor(envelope.id, alice.id)).not.toBe(first);
  const second = (await api.linkFor(envelope.id, alice.id))!;

  await aliceRow.getByRole("button", { name: "Resend link" }).click();
  await expect(senderPage.getByText("Signing link re-sent.")).toBeVisible();
  await expect.poll(() => api.linkFor(envelope.id, alice.id)).not.toBe(second);
  const third = (await api.linkFor(envelope.id, alice.id))!;

  for (const retired of [first, second]) {
    await page.goto(retired);
    await expect(page.getByRole("heading", UNAVAILABLE)).toBeVisible();
  }
  await page.goto(third);
  await waitForPdfPages(page, 2);

  const audit = (await api.get(envelope.id)).audit.map((a) => a.type);
  expect(audit).toEqual(expect.arrayContaining(["recipient_reminded", "recipient_resent"]));
});

test("a double-clicked Remind sends one reminder, not two", async ({ senderPage, api }) => {
  // Each reminder re-mints the link, so a duplicate kills the link in the first
  // email moments after it was sent.
  const { envelope, alice } = await seedSentEnvelope(api);
  await senderPage.goto(`/envelopes/${envelope.id}`);
  const aliceRow = senderPage.getByRole("listitem", { name: /alice@example.com/ });

  await aliceRow.getByRole("button", { name: "Remind" }).dblclick();
  await expect(senderPage.getByText("Reminder sent.").first()).toBeVisible();

  await expect
    .poll(async () => (await api.get(envelope.id)).audit.filter((a) => a.type === "recipient_reminded").length)
    .toBe(1);
  // …and it stays at one (a second request would land within this window).
  await senderPage.waitForTimeout(500);
  expect((await api.get(envelope.id)).audit.filter((a) => a.type === "recipient_reminded")).toHaveLength(1);
  expect(await api.linkFor(envelope.id, alice.id)).toBeTruthy();
});

test("the webhooks page registers an endpoint, shows its secret once, and deletes it", async ({ senderPage: page }) => {
  // `.invalid` never resolves, and the suite's server never drains the outbox,
  // so registering this endpoint can't cause an outbound request.
  const url = `https://hooks.example.invalid/finesign/${Date.now()}`;
  await page.goto("/webhooks");

  await page.getByLabel("Endpoint URL (https)").fill(url);
  await page.getByRole("checkbox", { name: "envelope_completed" }).check();
  await page.getByRole("button", { name: "Add webhook" }).click();

  const secret = page.getByRole("dialog", { name: "Signing secret (shown once)" });
  await expect(secret).toBeVisible();
  await expect(secret.locator("code")).toHaveText(/\S{16,}/);
  await secret.getByRole("button", { name: "Done" }).click();
  const row = page.getByRole("row").filter({ hasText: url });
  await expect(row).toContainText("envelope_completed");

  await page.reload(); // the secret is never shown again
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete endpoint" }).click();
  await expect(row).toHaveCount(0);
});
