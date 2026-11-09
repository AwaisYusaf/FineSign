import { useEffect, useRef, useState } from "react";
import { loadDocument, renderPage } from "../lib/pdf.js";

/** Pages render at most this wide (CSS px), and narrower when their container is. */
const MAX_WIDTH = 680;
/** Wider than any classic scrollbar (15–21px): growth below this is ignored. */
const GROW_MARGIN = 24;

/**
 * Renders every page of a PDF and overlays content on top of each page in
 * DISPLAY SPACE (fractions 0–1, top-left origin) — the same convention the
 * FineSign API uses, so overlays stay put at any rendered size.
 *
 * Props:
 *   loadBytes()      → Promise<ArrayBuffer> — fetches the PDF (authed or public).
 *   renderOverlay(pageNumber, size) → JSX absolutely positioned over that page.
 *   onPageClick(pageNumber, {x, y}) — fractional click position, if provided.
 */
export default function PdfView({ loadBytes, renderOverlay, onPageClick }) {
  const [numPages, setNumPages] = useState(0);
  const [sizes, setSizes] = useState({}); // pageNumber -> { width, height }
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(0); // the container's width, once measured
  const docRef = useRef(null);
  const canvasRefs = useRef({});
  const containerRef = useRef(null);
  const renderChain = useRef(Promise.resolve());

  // Fit pages to the container. They used to render at a fixed 680px, which on a
  // phone made the layout wider than the screen and centred each page at a
  // negative x that cannot be scrolled to — fields near the left margin could not
  // be tapped at all (BACKLOG U.12).
  //
  // Shrink at once (pages must fit), but grow only by a clear margin. Narrower
  // pages are shorter, so a classic scrollbar can disappear when they re-render,
  // widening the container and bringing the scrollbar back: without the margin
  // the viewer re-rendered ~30 times a second, forever, at certain heights.
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

  // Pass 1: load the document to discover the page count (mounts the canvases).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNumPages(0);
    setSizes({});
    (async () => {
      try {
        const bytes = await loadBytes();
        const doc = await loadDocument(new Uint8Array(bytes));
        if (cancelled) return;
        docRef.current = doc;
        setNumPages(doc.numPages);
      } catch (e) {
        if (!cancelled) {
          setError(e.message || "failed to load document");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pass 2: once the canvases are mounted and the width is known, render into
  // them — again whenever the width changes. pdf.js refuses two renders on one
  // canvas, so a pass first cancels the previous one and waits for it to settle.
  useEffect(() => {
    if (!numPages || !docRef.current || !renderWidth) return undefined;
    let cancelled = false;
    const tasks = [];
    const previous = renderChain.current;
    const pass = (async () => {
      await previous;
      if (cancelled) return;
      try {
        const doc = docRef.current;
        const next = {};
        for (let n = 1; n <= numPages; n++) {
          const canvas = canvasRefs.current[n];
          if (!canvas) continue;
          const page = await doc.getPage(n);
          if (cancelled) return;
          next[n] = await renderPage(page, canvas, renderWidth, (task) => tasks.push(task));
          if (cancelled) return;
        }
        setSizes(next);
        setLoading(false);
      } catch (e) {
        if (cancelled || e?.name === "RenderingCancelledException") return;
        setError(e.message || "failed to render document");
        setLoading(false);
      }
    })();
    renderChain.current = pass; // never rejects: errors are handled inside
    return () => {
      cancelled = true;
      for (const task of tasks) task.cancel();
    };
  }, [numPages, renderWidth]);

  function handleClick(pageNumber, e) {
    if (!onPageClick) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    onPageClick(pageNumber, { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) });
  }

  if (error) return <div className="pdf-error">Could not load document: {error}</div>;

  const pageNumbers = Array.from({ length: numPages }, (_, i) => i + 1);

  return (
    <div className="pdf-view" ref={containerRef}>
      {loading && <div className="muted">Rendering document…</div>}
      {pageNumbers.map((n) => {
        const size = sizes[n];
        return (
          <div
            key={n}
            className={`pdf-page${onPageClick ? " placing" : ""}`}
            // Stable hooks for the end-to-end suite (packages/e2e): which page this
            // is, and whether it has finished rendering. Keep them in a redesign.
            data-testid="pdf-page"
            data-page={n}
            data-rendered={size ? "true" : "false"}
            style={size ? { width: size.width, height: size.height } : undefined}
            onClick={onPageClick ? (e) => handleClick(n, e) : undefined}
          >
            <canvas ref={(el) => (canvasRefs.current[n] = el)} />
            {size && renderOverlay ? <div className="pdf-overlay">{renderOverlay(n, size)}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
