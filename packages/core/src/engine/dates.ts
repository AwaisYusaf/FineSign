/**
 * Assign each DATE anchor the correct signing-date component.
 *
 * Real forms split the "date signed" field several ways:
 *   - one box for the whole MM/DD/YYYY;
 *   - three separate boxes labelled with `_month` / `_day` / `_year` tokens;
 *   - three unlabelled boxes that must be filled left-to-right as MM, DD, YYYY.
 *
 * Preference order per anchor: an explicit month/day/year token in the label →
 * else, within a same-page group of exactly 3, left-to-right x-order → else the
 * full MM/DD/YYYY. Returns `Map<anchorId, value>`.
 */

import type { SignatureAnchor } from "../types";

const pad2 = (n: number) => String(n).padStart(2, "0");

export function buildDateValues(
  dateAnchors: SignatureAnchor[],
  now: Date
): Map<string, string> {
  // Use UTC so the stamped date matches the UTC signing-time recorded in the
  // audit trail / CMS signing-time (a signature near local midnight otherwise
  // stamps a different calendar day than the audit records).
  const MM = pad2(now.getUTCMonth() + 1);
  const DD = pad2(now.getUTCDate());
  const YYYY = String(now.getUTCFullYear());
  const full = `${MM}/${DD}/${YYYY}`;
  const out = new Map<string, string>();

  const byPage = new Map<number, SignatureAnchor[]>();
  for (const a of dateAnchors) {
    const list = byPage.get(a.page) ?? [];
    list.push(a);
    byPage.set(a.page, list);
  }

  const isLabeledComponent = (l: string) => /(^|_)(month|day|year)(_|$)/.test(l);

  for (const group of byPage.values()) {
    group.sort((a, b) => a.x - b.x);
    // The split-of-3 heuristic applies only to UNLABELED "auto" cells; an
    // explicit "full" anchor and a month/day/year-labeled anchor are resolved
    // directly, and the split index is taken WITHIN the auto subset (not the
    // whole group), so a mix of full + split cells is never mis-assigned.
    const autoAnchors = group.filter(
      (a) => a.dateFormat !== "full" && !isLabeledComponent((a.label || "").toLowerCase())
    );
    const autoIndex = new Map(autoAnchors.map((a, idx) => [a.anchorId, idx] as const));
    for (const a of group) {
      const l = (a.label || "").toLowerCase();
      let v: string;
      if (a.dateFormat === "full") v = full;
      else if (/(^|_)month(_|$)/.test(l)) v = MM;
      else if (/(^|_)day(_|$)/.test(l)) v = DD;
      else if (/(^|_)year(_|$)/.test(l)) v = YYYY;
      else if (autoAnchors.length === 3) v = [MM, DD, YYYY][autoIndex.get(a.anchorId)!];
      else v = full;
      out.set(a.anchorId, v);
    }
  }
  return out;
}
