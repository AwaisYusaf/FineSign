import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDateValues } from "../src/engine/dates";
import type { SignatureAnchor } from "../src/types";

function dateAnchor(id: string, x: number, extra: Partial<SignatureAnchor> = {}): SignatureAnchor {
  return { anchorId: id, page: 1, x, y: 0.8, width: 0.1, height: 0.03, kind: "date", label: "date_signed", source: "manual", ...extra };
}

const NOW = new Date("2026-07-11T00:00:00Z");

test('three "full" date anchors on one page each get the WHOLE date (K1 regression)', () => {
  const anchors = [dateAnchor("a", 0.1, { dateFormat: "full" }), dateAnchor("b", 0.4, { dateFormat: "full" }), dateAnchor("c", 0.7, { dateFormat: "full" })];
  const values = buildDateValues(anchors, NOW);
  assert.equal(values.get("a"), "07/11/2026");
  assert.equal(values.get("b"), "07/11/2026");
  assert.equal(values.get("c"), "07/11/2026");
});

test('three "auto" date anchors on one page still split MM / DD / YYYY (form behavior preserved)', () => {
  const anchors = [dateAnchor("a", 0.1), dateAnchor("b", 0.4), dateAnchor("c", 0.7)];
  const values = buildDateValues(anchors, NOW);
  assert.equal(values.get("a"), "07");
  assert.equal(values.get("b"), "11");
  assert.equal(values.get("c"), "2026");
});

test("a single date anchor gets the full date", () => {
  const values = buildDateValues([dateAnchor("only", 0.5)], NOW);
  assert.equal(values.get("only"), "07/11/2026");
});

test("a full-date cell mixed with 3 split cells assigns each correctly (B3)", () => {
  const anchors = [
    dateAnchor("full", 0.05, { dateFormat: "full" }),
    dateAnchor("m", 0.3),
    dateAnchor("d", 0.5),
    dateAnchor("y", 0.7),
  ];
  const values = buildDateValues(anchors, NOW);
  assert.equal(values.get("full"), "07/11/2026");
  assert.equal(values.get("m"), "07"); // split index taken within the auto subset
  assert.equal(values.get("d"), "11");
  assert.equal(values.get("y"), "2026");
});

test("labeled month/day/year components still resolve", () => {
  const anchors = [
    dateAnchor("m", 0.1, { label: "signature_date_month" }),
    dateAnchor("d", 0.4, { label: "signature_date_day" }),
    dateAnchor("y", 0.7, { label: "signature_date_year" }),
  ];
  const values = buildDateValues(anchors, NOW);
  assert.equal(values.get("m"), "07");
  assert.equal(values.get("d"), "11");
  assert.equal(values.get("y"), "2026");
});
