/**
 * Example: place a scripted-font typed name onto a page at a chosen point — the
 * "type your name and pick a font" signing style.
 *
 *   npm run example:typed   →  writes examples/out/signed-typed.pdf
 */
import fs from "fs";
import path from "path";
import { SignEngine } from "../src/index";
import { makeDemoForm } from "./_sample";

async function main() {
  const pdf = await makeDemoForm();
  const engine = new SignEngine();

  const signed = await engine.signWithTypedNames(pdf, [
    {
      signatureName: "Jane Q. Veteran",
      signatureFont: "great_vibes", // dancing_script | great_vibes | pacifico | pinyon_script
      pageNumber: 1,
      // Display-space fractions (top-left origin) — same coords a browser overlay uses.
      xPercent: 0.12,
      yPercent: 0.83,
      scale: 1.3,
    },
  ]);

  const outDir = path.join(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "signed-typed.pdf");
  fs.writeFileSync(outPath, signed);
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
