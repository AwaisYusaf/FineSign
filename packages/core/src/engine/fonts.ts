/**
 * Script-font registry for typed-name signatures.
 *
 * finesign-core bundles four handwriting fonts (in `assets/fonts/`, all OFL-licensed).
 * The registry lazy-loads their bytes from disk and caches them. You can point
 * at a different fonts directory, or register raw font bytes for a custom font
 * key, via `FontRegistry` — handy if you bundle the engine somewhere the relative
 * asset path doesn't resolve, or want your own signature typefaces.
 */

import fs from "fs";
import path from "path";
import fontkit, { type Font } from "@pdf-lib/fontkit";
import { SIGNATURE_FONTS, type SignatureFont } from "../types";

/**
 * A typed-name signature asked for a font that is neither built in nor
 * registered. Typed (not a bare `Error`) so a caller can map it to a 4xx —
 * the font key comes from the caller, not from us.
 */
export class UnknownSignatureFontError extends Error {
  constructor(
    readonly fontKey: string,
    readonly known: readonly string[]
  ) {
    super(
      `Unknown signature font "${fontKey}". Register it with FontRegistry.register() or use one of: ${known.join(", ")}`
    );
    this.name = "UnknownSignatureFontError";
  }
}

/** Default bundled fonts live at `<package>/assets/fonts`. From the compiled
 *  `dist/engine/` this resolves up to the package root either way. */
const DEFAULT_FONTS_DIR = path.resolve(__dirname, "..", "..", "assets", "fonts");

const DEFAULT_FONT_FILES: Record<SignatureFont, string> = {
  dancing_script: "DancingScript-Regular.ttf",
  great_vibes: "GreatVibes-Regular.ttf",
  pacifico: "Pacifico-Regular.ttf",
  pinyon_script: "PinyonScript-Regular.ttf",
};

export class FontRegistry {
  private readonly fontsDir: string;
  private readonly overrides = new Map<string, Uint8Array>();
  private readonly cache = new Map<string, Uint8Array>();
  private readonly parsed = new Map<string, Font>();

  constructor(options?: { fontsDir?: string }) {
    this.fontsDir = options?.fontsDir ?? DEFAULT_FONTS_DIR;
  }

  /** Register raw TTF/OTF bytes under a font key (built-in or custom). */
  register(fontKey: string, bytes: Uint8Array): void {
    this.overrides.set(fontKey, bytes);
    this.cache.delete(fontKey);
    this.parsed.delete(fontKey);
  }

  /**
   * The distinct characters of `text` this font has no glyph for, in order of
   * first appearance. Empty means the name stamps exactly as typed.
   *
   * Why it exists: pdf-lib embeds a custom font without complaint and draws a
   * missing character as the font's blank "notdef" box, so a name in a script
   * the handwriting font lacks would be stamped as empty boxes on a signed
   * document. Callers check first and reject (the bundled fonts cover Latin and
   * Vietnamese; only some cover Cyrillic; none cover Greek, CJK, Arabic, …).
   * Every character counts, whitespace included: the name is drawn as one
   * string, so an ideographic space (U+3000, which no bundled font has) is a
   * box too. Normalize exotic whitespace to U+0020 before calling.
   */
  missingGlyphs(fontKey: string, text: string): string[] {
    let font = this.parsed.get(fontKey);
    if (!font) {
      font = fontkit.create(this.getBytes(fontKey));
      this.parsed.set(fontKey, font);
    }
    const missing = new Set<string>();
    for (const ch of text) {
      if (!font.hasGlyphForCodePoint(ch.codePointAt(0)!)) missing.add(ch);
    }
    return [...missing];
  }

  /** Resolve a font key to its bytes: explicit override → bundled file. Throws
   *  a clear error if the key is unknown and no file backs it. */
  getBytes(fontKey: string): Uint8Array {
    const cached = this.cache.get(fontKey);
    if (cached) return cached;

    const override = this.overrides.get(fontKey);
    if (override) {
      this.cache.set(fontKey, override);
      return override;
    }

    const file = DEFAULT_FONT_FILES[fontKey as SignatureFont];
    if (!file) {
      throw new UnknownSignatureFontError(fontKey, [...SIGNATURE_FONTS, ...this.overrides.keys()]);
    }
    const bytes = fs.readFileSync(path.join(this.fontsDir, file));
    this.cache.set(fontKey, bytes);
    return bytes;
  }
}

/** A process-wide default registry using the bundled fonts. */
export const defaultFontRegistry = new FontRegistry();
