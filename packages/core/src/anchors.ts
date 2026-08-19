/**
 * Anchor construction helpers — build `SignatureAnchor`s from the two other
 * sources besides AcroForm detection:
 *   - a raw form-schema field box (PDF points), via page geometry, and
 *   - a box drawn on a rendered page (display fractions), validated on the way in.
 */

import type { DisplayBox, PointBox, SignatureAnchor, SignatureFieldKind } from "./types";
import { schemaFieldToDisplayBox, drawnBoxError } from "./geometry/coordinates";
import { newAnchorId } from "./engine/sign";

/**
 * Build an anchor from a form-schema field box (`PointBox`, top-left origin,
 * unrotated frame) plus the page's raw size and `/Rotate`. This is the
 * "the form declares where to sign" path — the field's own geometry becomes a
 * DocuSign-style target.
 */
export function anchorFromPointBox(params: {
  position: PointBox;
  page: number;
  pageWidth: number;
  pageHeight: number;
  rotation: number;
  kind: SignatureFieldKind;
  label?: string;
  anchorId?: string;
}): SignatureAnchor {
  const box = schemaFieldToDisplayBox(
    params.position,
    params.pageWidth,
    params.pageHeight,
    params.rotation
  );
  return {
    anchorId: params.anchorId ?? newAnchorId(),
    page: params.page,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    kind: params.kind,
    label: params.label ?? `${params.kind}`,
    source: "auto",
  };
}

/**
 * Build an anchor from a box drawn on a rendered page (display-space fractions).
 * Validates the box is on-page with positive area; throws with a human message
 * if not (see `drawnBoxError`).
 */
export function anchorFromDisplayBox(params: {
  box: DisplayBox;
  page: number;
  kind: SignatureFieldKind;
  label?: string;
  anchorId?: string;
}): SignatureAnchor {
  const err = drawnBoxError(params.box);
  if (err) throw new Error(err);
  return {
    anchorId: params.anchorId ?? newAnchorId(),
    page: params.page,
    x: params.box.x,
    y: params.box.y,
    width: params.box.width,
    height: params.box.height,
    kind: params.kind,
    label: params.label ?? `${params.kind}`,
    source: "manual",
  };
}
