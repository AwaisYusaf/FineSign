import { useEffect, useRef, useState } from "react";
import { loadDocument, renderPage } from "../lib/pdf.js";

const TARGET_WIDTH = 680;

/**
 * Renders every page of a PDF and overlays content on top of each page in
 * DISPLAY SPACE (fractions 0–1, top-left origin) — the same convention the
 * FineSign API uses.
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
  const docRef = useRef(null);
  const canvasRefs = useRef({});

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

  // Pass 2: once the canvases for all pages are mounted, render into them.
  useEffect(() => {
    if (!numPages || !docRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const doc = docRef.current;
        const next = {};
        for (let n = 1; n <= numPages; n++) {
          const canvas = canvasRefs.current[n];
          if (!canvas) continue;
          const page = await doc.getPage(n);
          next[n] = await renderPage(page, canvas, TARGET_WIDTH);
          if (cancelled) return;
        }
        if (!cancelled) {
          setSizes(next);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.message || "failed to render document");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [numPages]);

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
    <div className="pdf-view">
      {loading && <div className="muted">Rendering document…</div>}
      {pageNumbers.map((n) => {
        const size = sizes[n];
        return (
          <div
            key={n}
            className={`pdf-page${onPageClick ? " placing" : ""}`}
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
