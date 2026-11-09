import { useEffect, useRef, type PointerEvent } from "react";
import { Eraser } from "lucide-react";

import { Button } from "@/components/ui/button";

/** The drawing surface in logical units; CSS may shrink it, the backing store scales with DPR. */
const W = 520;
const H = 160;

/**
 * Draw a signature with mouse, finger or stylus (pointer events). Calls
 * `onChange` with a PNG data URL after each stroke, or `null` when cleared.
 *
 * Pointer positions are mapped from the canvas's CSS content box to its logical
 * 520x160 surface, so a stroke lands under the pointer however far CSS shrinks
 * the canvas (BACKLOG U.4), and the backing store is scaled by devicePixelRatio
 * so the result is crisp on HiDPI screens.
 *
 * Test hook: `data-testid="signature-canvas"` (packages/e2e).
 */
export function DrawPad({ initial = null, onChange }: { initial?: string | null; onChange: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const dirty = useRef(initial !== null);
  const initialRef = useRef(initial);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0b1d4a"; // ink, on white paper in either theme
    // Reopening the dialog shows the signature already adopted, ready to keep or redo.
    if (initialRef.current) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, W, H);
      img.src = initialRef.current;
    }
  }, []);

  function point(e: PointerEvent<HTMLCanvasElement>) {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left - canvas.clientLeft) * W) / canvas.clientWidth,
      y: ((e.clientY - rect.top - canvas.clientTop) * H) / canvas.clientHeight,
    };
  }

  function down(e: PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const { x, y } = point(e);
    const ctx = e.currentTarget.getContext("2d")!;
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function move(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const { x, y } = point(e);
    const ctx = e.currentTarget.getContext("2d")!;
    ctx.lineTo(x, y);
    ctx.stroke();
    dirty.current = true;
  }

  function up(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    if (dirty.current) onChange(e.currentTarget.toDataURL("image/png"));
  }

  function clear() {
    const canvas = canvasRef.current!;
    canvas.getContext("2d")!.clearRect(0, 0, W, H);
    dirty.current = false;
    onChange(null);
  }

  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-lg border bg-white">
        <canvas
          ref={canvasRef}
          data-testid="signature-canvas"
          aria-label="Signature drawing area"
          className="block h-auto w-full touch-none select-none"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-6 bottom-8 border-b border-dashed border-slate-300" />
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Draw with your mouse, finger or a stylus.</p>
        <Button type="button" variant="ghost" size="sm" onClick={clear}>
          <Eraser /> Clear
        </Button>
      </div>
    </div>
  );
}
