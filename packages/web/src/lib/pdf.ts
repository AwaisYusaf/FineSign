// pdf.js setup: configure the worker (Vite resolves the ?url import to a served
// asset) and expose small helpers to load and render pages.
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy };

/** Load a PDF from bytes. */
export function loadDocument(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ data: bytes }).promise;
}

/**
 * Render one page at `cssWidth` CSS pixels wide, with a backing store scaled by
 * the device pixel ratio so text stays crisp on HiDPI screens. Returns the CSS
 * size. `onTask` receives the render task so a caller can cancel it.
 */
export async function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  onTask?: (task: RenderTask) => void
): Promise<{ width: number; height: number }> {
  const page: PDFPageProxy = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth / base.width;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const viewport = page.getViewport({ scale: scale * dpr });
  const width = Math.round(base.width * scale);
  const height = Math.round(base.height * scale);
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const task = page.render({ canvasContext: canvas.getContext("2d")!, viewport });
  onTask?.(task);
  await task.promise;
  return { width, height };
}
