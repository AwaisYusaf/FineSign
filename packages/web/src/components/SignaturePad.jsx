import { useRef, useState, useEffect } from "react";
import { SIGNATURE_FONTS } from "../config.js";

/**
 * Capture a signature as either a DRAWN image (canvas → PNG data URL) or a TYPED
 * name + font. Calls `onChange(signature | null)` — signature is the exact shape
 * the API expects: `{ kind: "image", dataUrl }` or `{ kind: "typed", name, font }`.
 */
export default function SignaturePad({ onChange }) {
  const [mode, setMode] = useState("draw");
  const [name, setName] = useState("");
  const [font, setFont] = useState(SIGNATURE_FONTS[0].value);
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  // Reset drawing surface when switching into draw mode.
  useEffect(() => {
    if (mode !== "draw") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#0a1f44";
    dirty.current = false;
  }, [mode]);

  // Pointer position in CANVAS pixels. The canvas is 520x160 internally but CSS
  // can shrink it (phones, narrow windows); without this scaling a stroke landed
  // left of where the finger moved, proportionally to the shrink (BACKLOG U.4).
  // Measured against the content box (client*), not the border box, so the 1px
  // border does not skew the mapping either.
  function pos(e) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return {
      x: ((p.clientX - rect.left - canvas.clientLeft) * canvas.width) / canvas.clientWidth,
      y: ((p.clientY - rect.top - canvas.clientTop) * canvas.height) / canvas.clientHeight,
    };
  }
  function start(e) {
    drawing.current = true;
    const { x, y } = pos(e);
    const ctx = canvasRef.current.getContext("2d");
    ctx.beginPath();
    ctx.moveTo(x, y);
  }
  function move(e) {
    if (!drawing.current) return;
    e.preventDefault();
    const { x, y } = pos(e);
    const ctx = canvasRef.current.getContext("2d");
    ctx.lineTo(x, y);
    ctx.stroke();
    dirty.current = true;
  }
  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    if (dirty.current) onChange({ kind: "image", dataUrl: canvasRef.current.toDataURL("image/png") });
  }
  function clear() {
    const canvas = canvasRef.current;
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    dirty.current = false;
    onChange(null);
  }

  function switchMode(m) {
    setMode(m);
    onChange(null);
  }
  function onTypedName(v) {
    setName(v);
    onChange(v.trim() ? { kind: "typed", name: v.trim(), font } : null);
  }
  function onTypedFont(v) {
    setFont(v);
    if (name.trim()) onChange({ kind: "typed", name: name.trim(), font: v });
  }

  return (
    <div className="sig-pad">
      <div className="tabs">
        <button className={mode === "draw" ? "tab active" : "tab"} onClick={() => switchMode("draw")} type="button">Draw</button>
        <button className={mode === "type" ? "tab active" : "tab"} onClick={() => switchMode("type")} type="button">Type</button>
      </div>

      {mode === "draw" ? (
        <div>
          <canvas
            ref={canvasRef}
            width={520}
            height={160}
            className="sig-canvas"
            data-testid="signature-canvas"
            aria-label="Signature drawing area"
            onMouseDown={start}
            onMouseMove={move}
            onMouseUp={end}
            onMouseLeave={end}
            onTouchStart={start}
            onTouchMove={move}
            onTouchEnd={end}
          />
          <div className="row">
            <button type="button" className="btn ghost" onClick={clear}>Clear</button>
            <span className="muted">Draw your signature above.</span>
          </div>
        </div>
      ) : (
        <div>
          <input className="input" placeholder="Type your full name" value={name} onChange={(e) => onTypedName(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <select className="input" value={font} onChange={(e) => onTypedFont(e.target.value)}>
              {SIGNATURE_FONTS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
          {name.trim() ? <div className={`typed-preview font-${font}`}>{name}</div> : null}
        </div>
      )}
    </div>
  );
}
