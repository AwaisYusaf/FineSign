/**
 * Example: inspect what Signet detects on a form BEFORE signing — useful for
 * building a review UI where a human confirms/corrects the "sign here" spots.
 *
 *   npm run example:detect
 */
import { detectFields, detectAnchorsFromAcroForm } from "../src/index";
import { makeDemoForm } from "./_sample";

async function main() {
  const pdf = await makeDemoForm();

  const fields = await detectFields(pdf);
  console.log("Raw detected fields (point-space):");
  console.table(
    fields.map((f) => ({
      name: f.name,
      page: f.page,
      fieldType: f.fieldType,
      kind: f.kind,
      box: `x${Math.round(f.position.x)} y${Math.round(f.position.y)} ${Math.round(
        f.position.w
      )}×${Math.round(f.position.h)}`,
    }))
  );

  const anchors = await detectAnchorsFromAcroForm(pdf);
  console.log("\nDisplay-space anchors (ready to stamp):");
  console.table(
    anchors.map((a) => ({
      kind: a.kind,
      label: a.label,
      page: a.page,
      x: a.x.toFixed(3),
      y: a.y.toFixed(3),
      w: a.width.toFixed(3),
      h: a.height.toFixed(3),
    }))
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
