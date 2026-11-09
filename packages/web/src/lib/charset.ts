import type { SignatureFontOption, SignatureScript } from "./config";

/**
 * What the signed PDF can actually print. Mirrors the server (`pdf-text.ts`,
 * `stamping.ts`), which refuses such input with a 400; checking here lets the
 * signer fix it before submitting instead of after.
 */

/** Beyond Latin-1, the few characters WinAnsi (the PDF's Helvetica) still encodes. */
const WIN_ANSI_EXTRA = new Set(Array.from("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"));

/** Distinct characters of a text-field value the document font can't print. */
export function unprintableChars(text: string): string[] {
  const bad = new Set<string>();
  // Normalized as the server stamps it (`stampableText` in pdf-text.ts).
  const stampable = text
    .normalize("NFC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/\s+/gu, " ");
  for (const ch of stampable) {
    const cp = ch.codePointAt(0)!;
    const printable = (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(ch);
    if (!printable) bad.add(ch);
  }
  return [...bad];
}

const SCRIPT_TESTS: Record<SignatureScript, RegExp> = {
  Latin: /\p{Script=Latin}/u,
  Cyrillic: /\p{Script=Cyrillic}/u,
};

/** Can this signature font draw every letter of `text`? (Digits and common
 *  punctuation are in every bundled font.) */
export function fontCanDraw(font: SignatureFontOption, text: string): boolean {
  for (const ch of text.normalize("NFC")) {
    if (!/\p{L}/u.test(ch)) continue;
    if (!font.scripts.some((script) => SCRIPT_TESTS[script].test(ch))) return false;
  }
  return true;
}

/** The offending characters for a message, capped so a pasted paragraph stays readable. */
export const quoteChars = (chars: string[]): string =>
  chars
    .slice(0, 8)
    .map((c) => `“${c}”`)
    .join(" ") + (chars.length > 8 ? ` and ${chars.length - 8} more` : "");
