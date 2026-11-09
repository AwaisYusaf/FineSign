/**
 * PDF page layout under classic, space-taking scrollbars (Windows/Linux, or
 * macOS set to always show them). Playwright hides scrollbars by default, which
 * is exactly how this regression slipped past the rest of the suite.
 *
 * Regression: pages fit their container, so a scrollbar appearing makes them
 * narrower, hence shorter — which can make the scrollbar disappear, the pages
 * wider and taller, and the scrollbar reappear. At the right viewport height the
 * viewer re-rendered about 30 times a second, forever.
 */
import { expect, seedSentEnvelope, test, waitForPdfPages } from "./support";

const CLASSIC_SCROLLBARS = "::-webkit-scrollbar { width: 17px; height: 17px } ::-webkit-scrollbar-thumb { background: #999 }";

// Show real scrollbars (file-level: launch options need their own browser).
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test.describe("with classic scrollbars", () => {
  test("pages settle instead of re-rendering forever as a scrollbar comes and goes", async ({ page, api }) => {
    const { envelope, alice } = await seedSentEnvelope(api, { signatureOnly: true });
    const width = 700; // narrower than the 680px page cap plus margins, so pages track the container
    await page.setViewportSize({ width, height: 4000 });
    await page.goto((await api.linkFor(envelope.id, alice.id))!);
    await page.addStyleTag({ content: CLASSIC_SCROLLBARS });
    await waitForPdfPages(page, 2);
    const fullHeight = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));

    // Sweep viewport heights through the band where the scrollbar toggles.
    for (let height = fullHeight - 64; height <= fullHeight; height += 8) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(400); // one legitimate re-render may follow a resize
      const rerenders = await page.evaluate(async () => {
        let writes = 0;
        const observer = new MutationObserver((records) => {
          writes += records.filter((r) => r.attributeName === "width").length;
        });
        for (const canvas of document.querySelectorAll('[data-testid="pdf-page"] canvas')) {
          observer.observe(canvas, { attributes: true });
        }
        await new Promise((resolve) => setTimeout(resolve, 800));
        observer.disconnect();
        return writes;
      });
      expect(rerenders, `re-renders while idle at ${width}x${height}`).toBe(0);
    }
  });
});
