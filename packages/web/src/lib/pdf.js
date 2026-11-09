// pdf.js setup — configure the worker (Vite resolves the ?url import to a served
// asset) and expose small helpers for loading + rendering pages.
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/** Load a PDF from bytes into a pdf.js document. */
export async function loadDocument(bytes) {
  return pdfjsLib.getDocument({ data: bytes }).promise;
}

/**
 * Render one page into a canvas at a target CSS width; returns the CSS size.
 * `onTask` receives the pdf.js render task so a caller can cancel it (e.g. when
 * the available width changes mid-render).
 */
export async function renderPage(page, canvas, targetWidth, onTask) {
  const base = page.getViewport({ scale: 1 });
  const scale = targetWidth / base.width;
  const viewport = page.getViewport({ scale });
  const ctx = canvas.getContext("2d");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const task = page.render({ canvasContext: ctx, viewport });
  onTask?.(task);
  await task.promise;
  return { width: viewport.width, height: viewport.height };
}
