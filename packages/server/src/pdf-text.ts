/**
 * Text that reaches a PDF through pdf-lib's standard fonts (Helvetica).
 *
 * Standard fonts use WinAnsi encoding: Latin-1 plus a few typographic marks.
 * pdf-lib THROWS on any other character (and on control characters such as a
 * newline), so every string drawn with them must be checked or made safe first.
 */
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";

/** Distinct characters of `text` that `font` cannot encode, in order of first appearance. */
export function unencodableChars(text: string, font: PDFFont): string[] {
  const bad = new Set<string>();
  const ok = new Set<string>();
  for (const ch of text) {
    if (bad.has(ch) || ok.has(ch)) continue;
    try {
      font.widthOfTextAtSize(ch, 1);
      ok.add(ch);
    } catch {
      bad.add(ch);
    }
  }
  return [...bad];
}

/**
 * `text` with only the characters `font` cannot encode replaced by "?".
 *
 * A last-resort guard for renders that must never throw (the certificate of
 * completion, a value stored before input was validated). Replacing per
 * character keeps "Zoë" intact where the old ASCII-only fallback printed "Zo?".
 */
export function encodableText(text: string, font: PDFFont): string {
  const bad = new Set(unencodableChars(text, font));
  if (bad.size === 0) return text;
  return Array.from(text, (ch) => (bad.has(ch) ? "?" : ch)).join("");
}

/**
 * Signer text as it is checked and stamped — one line of composed characters:
 *  - NFC, so an accent typed or pasted as a separate combining mark ("e" +
 *    U+0301) becomes the "é" the fonts actually carry;
 *  - invisible format characters (zero-width space, joiners, soft hyphen, …)
 *    dropped: no font draws them, and a refusal naming one is unreadable;
 *  - any whitespace run (a newline, a tab, the ideographic space an IME types)
 *    as one plain space: fonts lack the exotic ones and draw an empty box, and
 *    pdf-lib turns a newline into a second line below the field.
 */
export function stampableText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/\s+/gu, " ");
}

/** A text-field value as checked and stamped (see `stampableText`). */
export const fieldText = stampableText;

/** A typed signature name as checked and stamped (see `stampableText`), trimmed. */
export function typedName(name: string): string {
  return stampableText(name).trim();
}

let helvetica: Promise<PDFFont> | undefined;

/** A standalone Helvetica, for checking signer input before any document is touched. */
export function standardHelvetica(): Promise<PDFFont> {
  helvetica ??= PDFDocument.create().then((doc) => doc.embedFont(StandardFonts.Helvetica));
  return helvetica;
}
