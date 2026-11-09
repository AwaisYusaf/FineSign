/**
 * The signer page on small screens (run by the "mobile" project: Pixel 7).
 *
 * Regression guards for two bugs this suite found (BACKLOG U.12, U.4):
 *  - PDF pages rendered at a fixed 680px and were centred, so on a phone each
 *    page's left edge sat at a negative x that cannot be scrolled to, and fields
 *    near the left margin could not be tapped.
 *  - The signature canvas is shrunk by CSS on narrow screens, but pointer
 *    coordinates were not rescaled, so strokes landed left of the finger.
 */
import {
  consentBox,
  drawSignature,
  expect,
  inkRightEdge,
  openDrawTab,
  seedSentEnvelope,
  signButton,
  test,
  waitForPdfPages,
} from "./support";

test("a signer can fill left-margin fields, draw a signature and sign on a phone", async ({ page, api }) => {
  // Alice's text field and checkbox sit at x = 0.1 — the strip that used to be
  // off-screen and unreachable.
  const { envelope, alice } = await seedSentEnvelope(api);
  await page.goto((await api.linkFor(envelope.id, alice.id))!);
  const pdf = await waitForPdfPages(page, 2);

  await pdf.getByLabel(/Text field/).fill("Acme Corp");
  await pdf.getByRole("checkbox").check();
  const dialog = await openDrawTab(page);
  await drawSignature(page, 0.1, 0.9);
  const reach = await inkRightEdge(page);
  expect(reach, "the stroke ends where the finger did").toBeGreaterThan(0.85);
  expect(reach).toBeLessThan(0.95);
  await dialog.getByRole("button", { name: "Adopt signature" }).click();
  await consentBox(page).check();
  await signButton(page).click();
  await expect(page.getByRole("heading", { name: /Signature recorded/ })).toBeVisible();
});

test("every part of a PDF page is on-screen on a phone", async ({ page, api }) => {
  const { envelope, alice } = await seedSentEnvelope(api);
  await page.goto((await api.linkFor(envelope.id, alice.id))!);
  const pdf = await waitForPdfPages(page, 2);

  const viewportWidth = await page.evaluate(() => window.innerWidth);
  for (const box of [await pdf.nth(0).boundingBox(), await pdf.nth(1).boundingBox()]) {
    expect(box!.x, "left edge on-screen").toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, "right edge on-screen").toBeLessThanOrEqual(viewportWidth);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "no sideways scrolling").toBeLessThanOrEqual(0);
});

test.describe("in a narrow desktop window", () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 360, height: 800 } });

  test("a drawn signature lands where the pointer moves", async ({ page, api }) => {
    const { envelope, alice } = await seedSentEnvelope(api, { signatureOnly: true });
    await page.goto((await api.linkFor(envelope.id, alice.id))!);
    await waitForPdfPages(page, 2);
    await openDrawTab(page);

    // Content box (clientWidth/Height exclude the 1px border), compared with the
    // canvas's own 520x160 drawing surface.
    const canvas = await page
      .getByTestId("signature-canvas")
      .evaluate((el) => ({ width: el.clientWidth, height: el.clientHeight }));
    expect(canvas.width, "precondition: CSS really has shrunk the canvas").toBeLessThan(520);
    expect(canvas.height / canvas.width, "…without distorting its shape").toBeCloseTo(160 / 520, 2);
    await drawSignature(page, 0.1, 0.9);
    const reach = await inkRightEdge(page);
    expect(reach).toBeGreaterThan(0.85);
    expect(reach).toBeLessThan(0.95);
  });
});

test("a tap on one of two adjacent checkboxes ticks that one, not its neighbour", async ({ page, api }) => {
  // The invisible input overhung its ~10px box by 12px on every side, so the
  // later checkbox covered the earlier one and took its taps.
  let env = await api.create({ title: `Boxes ${Date.now()}`, routingType: "sequential" });
  env = await api.addPdf(env.id);
  env = await api.addRecipient(env.id, { name: "Alice Signer", email: "alice@example.com", role: "signer", routingOrder: 1 });
  const alice = env.recipients[0];
  const field = (kind: string, page: number, x: number, y: number, width: number, height: number) =>
    api.addField(env.id, { documentId: env.documents[0].id, recipientId: alice.id, kind, page, x, y, width, height });
  await field("signature", 2, 0.18, 0.7, 0.24, 0.045);
  await field("checkbox", 1, 0.1, 0.26, 0.03, 0.022);
  await field("checkbox", 1, 0.14, 0.26, 0.03, 0.022); // ~3px to the right of the first
  await api.send(env.id);

  await page.goto((await api.linkFor(env.id, alice.id))!);
  const pdf = await waitForPdfPages(page, 2);
  const [first, second] = [pdf.getByRole("checkbox").nth(0), pdf.getByRole("checkbox").nth(1)];
  const tapCentre = async (box: { x: number; y: number; width: number; height: number } | null) => {
    if (!box) throw new Error("checkbox is not visible");
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  };
  // Tap the centre of each DRAWN box (the input's parent), as a finger would.
  await first.scrollIntoViewIfNeeded();
  await tapCentre(await first.locator("..").boundingBox());
  await expect(first).toBeChecked();
  await expect(second).not.toBeChecked();
  await tapCentre(await second.locator("..").boundingBox());
  await expect(second).toBeChecked();
  await expect(first).toBeChecked();
});
