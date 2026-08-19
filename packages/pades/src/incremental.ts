/**
 * Hand-rolled PDF INCREMENTAL UPDATE writer (append-only, byte-preserving).
 *
 * pdf-lib has no incremental-save mode — `PDFDocument.save()` fully rewrites the
 * file, which would destroy an existing PAdES signature's ByteRange. PAdES-B-LT
 * (DSS) and B-LTA (document timestamp) BOTH require appending a new revision to an
 * already-signed PDF while leaving every prior byte untouched. This writer does
 * exactly that: it emits `original` verbatim, then appends the changed/new objects,
 * a classic cross-reference section, and a trailer with `/Prev` chaining to the
 * previous xref — so the signed bytes (and their ByteRange digest) never change.
 *
 * We use pdf-lib only to build/serialize the object model (`PDFObject.copyBytesInto`);
 * we never call `save()` on a signed document.
 */
import crypto from "crypto";
import type { PDFContext, PDFRef, PDFObject } from "pdf-lib";

export interface IncrementalObject {
  ref: PDFRef;
  obj: PDFObject;
}

/** The last `startxref N` offset in the file — the /Prev of our new revision. */
function lastStartxref(text: string): number {
  const matches = [...text.matchAll(/startxref\s+(\d+)/g)];
  if (matches.length === 0) throw new Error("incremental update: no startxref in the source PDF");
  return Number(matches[matches.length - 1][1]);
}

/** The largest /Size across the file's trailers (so the new /Size never shrinks). */
function lastSize(text: string): number {
  const matches = [...text.matchAll(/\/Size\s+(\d+)/g)];
  return matches.length ? Number(matches[matches.length - 1][1]) : 0;
}

/** The file's /ID pair (hex). /ID[0] MUST be preserved across revisions; if the
 *  source has none we derive a stable pair from its bytes (Date/Math.random are
 *  banned here for determinism). */
function readIdPair(text: string, original: Uint8Array): [string, string] {
  const m = /\/ID\s*\[\s*<([0-9a-fA-F]*)>\s*<([0-9a-fA-F]*)>\s*\]/.exec(text);
  if (m) return [m[1], m[2]];
  const h = crypto.createHash("md5").update(Buffer.from(original)).digest("hex");
  return [h, h];
}

/** Group ascending object numbers into consecutive-run xref subsections. */
function groupRuns(nums: number[]): { first: number; count: number }[] {
  const sorted = [...nums].sort((a, b) => a - b);
  const runs: { first: number; count: number }[] = [];
  let i = 0;
  while (i < sorted.length) {
    const first = sorted[i];
    let count = 1;
    while (i + count < sorted.length && sorted[i + count] === first + count) count++;
    runs.push({ first, count });
    i += count;
  }
  return runs;
}

/** A classic-xref entry is EXACTLY 20 bytes: `NNNNNNNNNN GGGGG n\r\n`. */
function xrefEntry(offset: number, gen: number, type: "n" | "f"): string {
  return `${String(offset).padStart(10, "0")} ${String(gen).padStart(5, "0")} ${type}\r\n`;
}

/**
 * Append an incremental update to `original`, writing `changed` (new objects plus
 * any re-emitted existing object under its SAME ref, e.g. the catalog) and a new
 * xref/trailer/startxref/%%EOF. The result is `original` byte-for-byte followed by
 * the appended revision.
 */
export function appendIncrementalUpdate(original: Uint8Array, ctx: PDFContext, changed: IncrementalObject[]): Uint8Array {
  if (changed.length === 0) throw new Error("incremental update: nothing to write");
  const text = Buffer.from(original).toString("latin1");
  const prevStartxref = lastStartxref(text);
  const [id0, id1] = readIdPair(text, original);
  const rootRef = ctx.trailerInfo.Root as PDFRef;
  if (!rootRef || typeof rootRef.objectNumber !== "number") {
    throw new Error("incremental update: source PDF has no /Root reference");
  }

  const parts: Buffer[] = [Buffer.from(original)];
  let cursor = original.length;
  // A new indirect object must start on its own line, not glued to `%%EOF`.
  if (original.length > 0 && original[original.length - 1] !== 0x0a) {
    parts.push(Buffer.from("\n", "latin1"));
    cursor += 1;
  }

  const sorted = [...changed].sort((a, b) => a.ref.objectNumber - b.ref.objectNumber);
  const offsets = new Map<number, number>();
  let maxObjNum = 0;
  for (const { ref, obj } of sorted) {
    const header = Buffer.from(`${ref.objectNumber} ${ref.generationNumber} obj\n`, "latin1");
    const body = Buffer.alloc(obj.sizeInBytes());
    obj.copyBytesInto(body, 0);
    const footer = Buffer.from("\nendobj\n", "latin1");
    offsets.set(ref.objectNumber, cursor);
    parts.push(header, body, footer);
    cursor += header.length + body.length + footer.length;
    maxObjNum = Math.max(maxObjNum, ref.objectNumber);
  }

  const xrefOffset = cursor;
  let xref = "xref\r\n";
  for (const run of groupRuns(sorted.map((s) => s.ref.objectNumber))) {
    xref += `${run.first} ${run.count}\r\n`;
    for (let n = run.first; n < run.first + run.count; n++) {
      const ref = sorted.find((s) => s.ref.objectNumber === n)!.ref;
      xref += xrefEntry(offsets.get(n)!, ref.generationNumber, "n");
    }
  }

  const size = Math.max(lastSize(text), maxObjNum + 1);
  const trailer =
    `trailer\r\n<< /Size ${size} /Root ${rootRef.objectNumber} ${rootRef.generationNumber} R ` +
    `/Prev ${prevStartxref} /ID [<${id0}> <${id1}>] >>\r\n` +
    `startxref\r\n${xrefOffset}\r\n%%EOF\r\n`;

  parts.push(Buffer.from(xref + trailer, "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}
