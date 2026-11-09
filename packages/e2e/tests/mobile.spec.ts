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

  await pdf.getByPlaceholder("text").fill("Acme Corp");
  await pdf.getByRole("checkbox").check();
  await drawSignature(page, 0.1, 0.9);
  const reach = await inkRightEdge(page);
  expect(reach, "the stroke ends where the finger did").toBeGreaterThan(0.85);
  expect(reach).toBeLessThan(0.95);
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
