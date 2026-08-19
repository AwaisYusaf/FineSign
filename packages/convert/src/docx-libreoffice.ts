/**
 * DOCX → PDF via LibreOffice (`soffice --headless --convert-to pdf`) — the
 * pragmatic, high-fidelity choice for self-hosters (no cloud dependency).
 *
 * The actual subprocess call is behind an injected `runner`, so this class is
 * unit-testable without LibreOffice installed and the binary path/flags are
 * swappable. The default runner shells out to `soffice`.
 *
 * If LibreOffice is not installed, `toPdf` throws a clear, actionable error
 * (FACTORY §1.5 — never silently pretend a `.docx` became a PDF).
 */
import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { DocumentConverter } from "@finesign/domain";
import { isPdfBuffer } from "finesign-core";
import { FineSignError } from "@finesign/shared";

export class DocxConversionError extends FineSignError {
  constructor(message: string) {
    super("DOCX_CONVERSION_FAILED", message, 502);
  }
}

export class ConverterUnavailableError extends FineSignError {
  constructor(message: string) {
    super("CONVERTER_UNAVAILABLE", message, 503);
  }
}

/** Converts DOCX bytes to PDF bytes. Injectable so tests avoid the real binary. */
export type DocxRunner = (docx: Uint8Array) => Promise<Uint8Array>;

export interface LibreOfficeOptions {
  /** Binary name/path. Default tries `soffice`. */
  binary?: string;
  /** Override the conversion runner (tests inject a fake). */
  runner?: DocxRunner;
}

/**
 * Reference DOCX runner: writes the docx to a temp dir, invokes LibreOffice
 * headless to emit a PDF beside it, reads it back, and cleans up.
 */
/** Wall-clock cap on a single conversion — a hostile document must not hang the
 *  process (S4). */
const CONVERSION_TIMEOUT_MS = 60_000;
/** Cap on the produced PDF — a converted DOCX decompression bomb must not OOM
 *  the reader (E4). */
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

/** Run soffice in its OWN process group, and on timeout kill the WHOLE group with
 *  SIGKILL — so the real `soffice.bin` child dies too, not just the wrapper (E5).
 *  Rejects with an ENOENT-coded error if the binary is missing. */
function runSoffice(binary: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { detached: true, stdio: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL"); // negative pid = process group
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e); // e.g. ENOENT when the binary is missing
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new DocxConversionError("LibreOffice conversion timed out"));
      if (code === 0) return resolve();
      reject(new DocxConversionError(`LibreOffice exited with code ${code ?? "signal"}`));
    });
  });
}

export function makeLibreOfficeRunner(binary = "soffice"): DocxRunner {
  return async (docx: Uint8Array): Promise<Uint8Array> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "finesign-docx-"));
    try {
      const inPath = path.join(dir, "in.docx");
      await fs.writeFile(inPath, docx);
      // Hardening (S4): throwaway per-conversion user profile (no shared state /
      // macros), no restore/logo. NOTE: full isolation (seccomp / container /
      // no-network) is the operator's responsibility — see backlog X.7.
      try {
        await runSoffice(
          binary,
          [
            "--headless",
            "--norestore",
            "--nologo",
            "--nofirststartwizard",
            `-env:UserInstallation=file://${path.join(dir, "profile")}`,
            "--convert-to",
            "pdf",
            "--outdir",
            dir,
            inPath,
          ],
          CONVERSION_TIMEOUT_MS
        );
      } catch (err) {
        // Binary-missing (spawn ENOENT) → unavailable (503); anything else the
        // subprocess raised is a conversion failure (502).
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ConverterUnavailableError(
            `LibreOffice binary "${binary}" not found. Install LibreOffice or configure a different DocumentConverter to sign .docx files.`
          );
        }
        throw err instanceof FineSignError ? err : new DocxConversionError(`LibreOffice conversion failed: ${(err as Error).message}`);
      }

      // Read the output — a MISSING output means the conversion produced nothing
      // (a conversion failure), NOT a missing binary (E3). Cap the size (E4).
      const outPath = path.join(dir, "in.pdf");
      let stat;
      try {
        stat = await fs.stat(outPath);
      } catch {
        throw new DocxConversionError("LibreOffice produced no output PDF");
      }
      if (stat.size > MAX_OUTPUT_BYTES) {
        throw new DocxConversionError(`converted PDF is too large (${stat.size} bytes, max ${MAX_OUTPUT_BYTES})`);
      }
      return new Uint8Array(await fs.readFile(outPath));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

export class LibreOfficeDocxConverter implements DocumentConverter {
  private readonly runner: DocxRunner;
  constructor(options: LibreOfficeOptions = {}) {
    this.runner = options.runner ?? makeLibreOfficeRunner(options.binary);
  }
  supports(format: "pdf" | "docx"): boolean {
    return format === "docx";
  }
  async toPdf(bytes: Uint8Array, format: "pdf" | "docx"): Promise<Uint8Array> {
    if (format !== "docx") {
      throw new DocxConversionError(`LibreOfficeDocxConverter cannot handle "${format}"`);
    }
    const pdf = await this.runner(bytes);
    if (!isPdfBuffer(pdf)) {
      throw new DocxConversionError("converter did not produce a valid PDF");
    }
    return pdf;
  }
}
