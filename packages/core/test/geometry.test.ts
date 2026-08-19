import { test } from "node:test";
import assert from "node:assert/strict";
import {
  schemaFieldToDisplayBox,
  displayBoxToPointBox,
  displayBoxToPageRect,
  drawnBoxError,
  normalizeRotation,
} from "../src/geometry/coordinates";
import type { PointBox } from "../src/types";

test("normalizeRotation reduces to {0,90,180,270}", () => {
  assert.equal(normalizeRotation(0), 0);
  assert.equal(normalizeRotation(90), 90);
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(450), 90);
  assert.equal(normalizeRotation(360), 0);
});

test("schemaFieldToDisplayBox ↔ displayBoxToPointBox round-trip at every rotation", () => {
  const W = 612;
  const H = 792;
  const field: PointBox = { x: 100, y: 200, w: 180, h: 40 };
  for (const rot of [0, 90, 180, 270]) {
    const disp = schemaFieldToDisplayBox(field, W, H, rot);
    const back = displayBoxToPointBox(disp, W, H, rot);
    assert.ok(Math.abs(back.x - field.x) < 1e-6, `x @${rot}`);
    assert.ok(Math.abs(back.y - field.y) < 1e-6, `y @${rot}`);
    assert.ok(Math.abs(back.w - field.w) < 1e-6, `w @${rot}`);
    assert.ok(Math.abs(back.h - field.h) < 1e-6, `h @${rot}`);
  }
});

test("displayBoxToPageRect fills the raw field box (bbox of rotated rect == field)", () => {
  const W = 612;
  const H = 792;
  const field: PointBox = { x: 100, y: 200, w: 180, h: 40 };
  for (const rot of [0, 90, 180, 270]) {
    const disp = schemaFieldToDisplayBox(field, W, H, rot);
    const rect = displayBoxToPageRect(disp, W, H, rot);
    // Rotate the rect's 4 corners CCW about (x,y) by rotateDeg, take the bbox,
    // and confirm it equals the raw field box in pdf-lib (bottom-left) space.
    const rad = (rect.rotateDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const corners = [
      [0, 0],
      [rect.width, 0],
      [rect.width, rect.height],
      [0, rect.height],
    ].map(([dx, dy]) => [rect.x + dx * cos - dy * sin, rect.y + dx * sin + dy * cos]);
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const rawXmin = field.x;
    const rawXmax = field.x + field.w;
    const rawYmin = H - (field.y + field.h);
    const rawYmax = H - field.y;
    assert.ok(Math.abs(Math.min(...xs) - rawXmin) < 1e-6, `xmin @${rot}`);
    assert.ok(Math.abs(Math.max(...xs) - rawXmax) < 1e-6, `xmax @${rot}`);
    assert.ok(Math.abs(Math.min(...ys) - rawYmin) < 1e-6, `ymin @${rot}`);
    assert.ok(Math.abs(Math.max(...ys) - rawYmax) < 1e-6, `ymax @${rot}`);
  }
});

test("drawnBoxError catches off-page and zero-area boxes", () => {
  assert.equal(drawnBoxError({ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }), null);
  assert.match(drawnBoxError({ x: 0.9, y: 0.1, width: 0.5, height: 0.05 })!, /right edge/);
  assert.match(drawnBoxError({ x: 0.1, y: 0.9, width: 0.2, height: 0.5 })!, /bottom edge/);
  assert.match(drawnBoxError({ x: 0.1, y: 0.1, width: 0, height: 0.05 })!, /area/);
});
