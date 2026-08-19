/**
 * Example: detect "sign here" fields on a PDF form, then stamp ONE captured
 * signature image onto every signature field and today's date onto every date
 * field — the DocuSign "sign all" experience.
 *
 *   npm run example:image   →  writes examples/out/signed-image.pdf
 */
import fs from "fs";
import path from "path";
import { SignEngine, detectAnchorsFromAcroForm } from "../src/index";
import { makeDemoForm, makeDemoSignaturePng } from "./_sample";

async function main() {
  const pdf = await makeDemoForm();

  // 1. Find where to sign — no AI, straight from the AcroForm.
  const anchors = await detectAnchorsFromAcroForm(pdf);
  console.log(`detected ${anchors.length} anchors:`);
  for (const a of anchors) {
    console.log(`  • ${a.kind.padEnd(9)} "${a.label}" on page ${a.page}`);
  }

  // 2. Stamp the captured signature + auto-date. Bytes in, bytes out.
  const engine = new SignEngine();
  const { pdf: signed, signatureCount, dateCount, stamped } = await engine.signWithImage(
    pdf,
    anchors,
    makeDemoSignaturePng()
  );

  console.log(`\nstamped ${signatureCount} signature(s), ${dateCount} date(s)`);
  console.table(stamped.map((s) => ({ kind: s.kind, label: s.label, value: s.value })));

  // 3. Persist however you like — here, just to disk.
  const outDir = path.join(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "signed-image.pdf");
  fs.writeFileSync(outPath, signed);
  console.log(`\nwrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
