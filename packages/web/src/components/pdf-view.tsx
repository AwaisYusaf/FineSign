import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { RenderTask } from "pdfjs-dist";
import { FileWarning } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { loadDocument, renderPage, type PDFDocumentProxy } from "@/lib/pdf";
import { cn } from "@/lib/utils";

/** Pages render at most this wide (CSS px), and narrower when their container is. */
const MAX_WIDTH = 680;
/** Wider than any classic scrollbar (15–21px): growth below this is ignored. */
const GROW_MARGIN = 24;

export interface PageSize {
  width: number;
  height: number;
}

/**
 * Renders every page of a PDF and lays content over each page in DISPLAY SPACE
 * (fractions 0–1, top-left origin) — the API's coordinate convention, so overlays
 * stay put at any rendered size.
 *
 * Test hooks (packages/e2e): every page is `data-testid="pdf-page"` with
 * `data-page` and `data-rendered`. Keep them through any redesign.
 */
export function PdfView({
  loadBytes,
  renderOverlay,
  onPageClick,
  keyboardPlacement,
  className,
}: {
  loadBytes: () => Promise<ArrayBuffer>;
  renderOverlay?: (pageNumber: number, size: PageSize) => ReactNode;
  onPageClick?: (pageNumber: number, point: { x: number; y: number }) => void;
  /** The keyboard's way to do what a click on a page does: a button on each
   *  page, shown when focused. A click target alone shut keyboard users out. */
  keyboardPlacement?: { label: (pageNumber: number) => string; onPlace: (pageNumber: number) => void };
  className?: string;
}) {
  const [numPages, setNumPages] = useState(0);
  const [sizes, setSizes] = useState<Record<number, PageSize>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(0);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const canvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});
  const containerRef = useRef<HTMLDivElement | null>(null);
  const renderChain = useRef<Promise<void>>(Promise.resolve());
  const loadRef = useRef(loadBytes);

  // Fit pages to the container (a fixed width pushed a phone's page edges
  // off-screen). Shrink at once; grow only by a clear margin, or a classic
  // scrollbar appearing and vanishing makes the viewer re-render forever.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const measure = () => {
      const width = Math.floor(el.clientWidth);
      setAvailable((current) => (width < current || width - current > GROW_MARGIN ? width : current));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const renderWidth = available > 0 ? Math.min(MAX_WIDTH, available) : 0;

  // Load once (the document id is fixed for this component's lifetime).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const doc = await loadDocument(new Uint8Array(await loadRef.current()));
        if (cancelled) {
          void doc.destroy();
          return;
        }
        docRef.current = doc;
        setNumPages(doc.numPages);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "failed to load document");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      // Release the parsed document and its worker-side memory with the view.
      void docRef.current?.destroy();
      docRef.current = null;
    };
  }, []);

  // Render (again whenever the width changes). pdf.js refuses two renders on one
  // canvas, so a pass cancels the previous one and waits for it to settle.
  useEffect(() => {
    const doc = docRef.current;
    if (!numPages || !doc || !renderWidth) return undefined;
    let cancelled = false;
    const tasks: RenderTask[] = [];
    const previous = renderChain.current;
    const pass = (async () => {
      await previous;
      if (cancelled) return;
      try {
        const next: Record<number, PageSize> = {};
        for (let n = 1; n <= numPages; n++) {
          const canvas = canvasRefs.current[n];
          if (!canvas) continue;
          next[n] = await renderPage(doc, n, canvas, renderWidth, (task) => tasks.push(task));
          if (cancelled) return;
        }
        setSizes(next);
        setLoading(false);
      } catch (e) {
        if (cancelled || (e instanceof Error && e.name === "RenderingCancelledException")) return;
        setError(e instanceof Error ? e.message : "failed to render document");
        setLoading(false);
      }
    })();
    renderChain.current = pass; // never rejects: errors are handled inside
    return () => {
      cancelled = true;
      for (const task of tasks) task.cancel();
    };
  }, [numPages, renderWidth]);

  function handleClick(pageNumber: number, e: MouseEvent<HTMLDivElement>) {
    if (!onPageClick) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    onPageClick(pageNumber, { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) });
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <FileWarning className="size-4" /> Could not load the document: {error}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={cn("flex flex-col items-center gap-6", className)}>
      {loading && numPages === 0 && <Skeleton className="aspect-[612/792] w-full max-w-[680px]" />}
      {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => {
        const size = sizes[n];
        return (
          <div
            key={n}
            data-testid="pdf-page"
            data-page={n}
            data-rendered={size ? "true" : "false"}
            className={cn(
              "relative overflow-hidden rounded-sm bg-white shadow-[0_1px_3px_rgb(0_0_0/0.12),0_8px_24px_-8px_rgb(0_0_0/0.18)] ring-1 ring-black/5",
              onPageClick && "cursor-crosshair"
            )}
            style={size ? { width: size.width, height: size.height } : { width: renderWidth || undefined }}
            onClick={onPageClick ? (e) => handleClick(n, e) : undefined}
          >
            <canvas ref={(el) => void (canvasRefs.current[n] = el)} className="block" />
            {keyboardPlacement && size && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation(); // not a pointer click on the page
                  keyboardPlacement.onPlace(n);
                }}
                // Invisible until focused, and click-through for the mouse, which
                // places fields by clicking the page itself.
                className="pointer-events-none absolute top-2 left-2 z-10 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground opacity-0 shadow focus-visible:pointer-events-auto focus-visible:opacity-100"
              >
                {keyboardPlacement.label(n)}
              </button>
            )}
            {/* Click-through overlay; interactive children opt back in with pointer-events-auto. */}
            {size && renderOverlay && <div className="pointer-events-none absolute inset-0">{renderOverlay(n, size)}</div>}
          </div>
        );
      })}
    </div>
  );
}
