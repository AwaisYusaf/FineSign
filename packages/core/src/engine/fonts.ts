/**
 * Script-font registry for typed-name signatures.
 *
 * Signet bundles four handwriting fonts (in `assets/fonts/`, all OFL-licensed).
 * The registry lazy-loads their bytes from disk and caches them. You can point
 * at a different fonts directory, or register raw font bytes for a custom font
 * key, via `FontRegistry` — handy if you bundle Signet somewhere the relative
 * asset path doesn't resolve, or want your own signature typefaces.
 */

import fs from "fs";
import path from "path";
import type { SignatureFont } from "../types";

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

  constructor(options?: { fontsDir?: string }) {
    this.fontsDir = options?.fontsDir ?? DEFAULT_FONTS_DIR;
  }

  /** Register raw TTF/OTF bytes under a font key (built-in or custom). */
  register(fontKey: string, bytes: Uint8Array): void {
    this.overrides.set(fontKey, bytes);
    this.cache.delete(fontKey);
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
      throw new Error(
        `Unknown signature font "${fontKey}". Register it with FontRegistry.register() or use one of: ${Object.keys(
          DEFAULT_FONT_FILES
        ).join(", ")}`
      );
    }
    const bytes = fs.readFileSync(path.join(this.fontsDir, file));
    this.cache.set(fontKey, bytes);
    return bytes;
  }
}

/** A process-wide default registry using the bundled fonts. */
export const defaultFontRegistry = new FontRegistry();
