import { useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, PenLine, Type } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fontCanDraw } from "@/lib/charset";
import { SIGNATURE_FONTS } from "@/lib/config";
import { signatureInitials } from "@/lib/format";
import type { Signature, SignatureFont } from "@/lib/types";
import { cn } from "@/lib/utils";

import { DrawPad } from "./draw-pad";

/**
 * Adopt a signature once; it is applied to every signature and initials field.
 * Typed signatures preview in the exact fonts finesign-core stamps with.
 *
 * Remount it (a new `key`) each time it opens: it starts from the signature
 * already adopted, so "Change signature" never silently resets the choice.
 */
export function SignatureDialog({
  open,
  onOpenChange,
  current,
  defaultName,
  onAdopt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: Signature | null;
  defaultName: string;
  onAdopt: (signature: Signature) => void;
}) {
  const [mode, setMode] = useState<"type" | "draw">(current?.kind === "image" ? "draw" : "type");
  const [name, setName] = useState(current?.kind === "typed" ? current.name : defaultName);
  const [font, setFont] = useState<SignatureFont>(current?.kind === "typed" ? current.font : SIGNATURE_FONTS[0]!.value);
  const [drawn, setDrawn] = useState<string | null>(current?.kind === "image" ? current.dataUrl : null);

  // A style that can't draw the name (Cyrillic in a Latin-only font, say) would
  // stamp empty boxes; the server refuses it, so steer to one that can.
  const trimmed = name.trim();
  const drawable = SIGNATURE_FONTS.filter((f) => fontCanDraw(f, trimmed));
  const chosen = drawable.some((f) => f.value === font) ? font : drawable[0]?.value;
  const typed: Signature | null = trimmed && chosen ? { kind: "typed", name: trimmed, font: chosen } : null;
  const signature: Signature | null = mode === "type" ? typed : drawn ? { kind: "image", dataUrl: drawn } : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Adopt your signature</DialogTitle>
          <DialogDescription>It goes on every signature and initials field assigned to you.</DialogDescription>
        </DialogHeader>
        <Tabs value={mode} onValueChange={(v) => setMode(v as "type" | "draw")}>
          <TabsList className="w-full">
            <TabsTrigger value="type">
              <Type /> Type
            </TabsTrigger>
            <TabsTrigger value="draw">
              <PenLine /> Draw
            </TabsTrigger>
          </TabsList>
          <TabsContent value="type" className="space-y-4 pt-2">
            <div className="grid gap-2">
              <Label htmlFor="sig-name">Full name</Label>
              <Input id="sig-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </div>
            {drawable.length === 0 ? (
              <Alert>
                <AlertTriangle className="text-warning" />
                <AlertDescription>
                  <span>
                    These signature styles can&apos;t write some of the letters in your name.{" "}
                    <Button variant="link" className="h-auto p-0" onClick={() => setMode("draw")}>
                      Draw your signature
                    </Button>{" "}
                    instead.
                  </span>
                </AlertDescription>
              </Alert>
            ) : (
              <div role="radiogroup" aria-label="Signature style" className="grid gap-2 sm:grid-cols-2">
                {SIGNATURE_FONTS.map((f) => {
                  const canDraw = drawable.includes(f);
                  return (
                    <button
                      key={f.value}
                      type="button"
                      role="radio"
                      aria-checked={chosen === f.value}
                      aria-label={canDraw ? f.label : `${f.label} (can't write your name)`}
                      title={canDraw ? undefined : `${f.label} can't write some of these letters`}
                      disabled={!canDraw}
                      onClick={() => setFont(f.value)}
                      className={cn(
                        "flex h-20 items-center justify-center overflow-hidden rounded-lg border bg-white px-3 text-3xl text-slate-900 transition-colors hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-40",
                        chosen === f.value && "border-primary ring-2 ring-primary/30"
                      )}
                    >
                      <span className={cn("truncate", f.className)}>{trimmed || "Your name"}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </TabsContent>
          {/* Kept mounted while hidden: Radix unmounts an inactive tab, which wiped
              the drawing while its image stayed adoptable from the Type tab. */}
          <TabsContent value="draw" forceMount className="pt-2 data-[state=inactive]:hidden">
            <DrawPad initial={current?.kind === "image" ? current.dataUrl : null} onChange={setDrawn} />
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!signature}
            onClick={() => {
              if (!signature) return;
              onAdopt(signature);
              onOpenChange(false);
            }}
          >
            Adopt signature
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * How an adopted signature looks on the page (a preview; the server stamps the
 * real one). Given the field's box, a typed name is sized like the stamp: by the
 * box height, then shrunk until its MEASURED width fits — not cut off with an
 * ellipsis, which showed initials as "J…".
 */
export function SignaturePreview({
  signature,
  initialsOnly = false,
  box,
  className,
}: {
  signature: Signature;
  initialsOnly?: boolean;
  box?: { width: number; height: number };
  className?: string;
}) {
  if (signature.kind === "image") {
    return <img src={signature.dataUrl} alt="Your signature" className={cn("h-full w-full object-contain", className)} />;
  }
  const font = SIGNATURE_FONTS.find((f) => f.value === signature.font)?.className;
  const text = initialsOnly ? signatureInitials(signature.name) : signature.name;
  if (!box) return <span className={cn("truncate leading-none text-slate-900", font, className)}>{text}</span>;
  return <FittedText text={text} className={cn("leading-none text-slate-900", font, className)} maxSize={box.height * 0.7} maxWidth={box.width} />;
}

/** One line of text at `maxSize`, or smaller if that is wider than `maxWidth`. */
function FittedText({ text, className, maxSize, maxWidth }: { text: string; className: string; maxSize: number; maxWidth: number }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [size, setSize] = useState(maxSize);
  useLayoutEffect(() => {
    let live = true;
    const fit = () => {
      const el = ref.current;
      if (!live || !el) return;
      el.style.fontSize = `${maxSize}px`; // measure at full size (padding included)
      const natural = el.getBoundingClientRect().width;
      const fitted = natural > maxWidth ? Math.max(6, (maxSize * maxWidth) / natural) : maxSize;
      // Written directly as well: if `fitted` equals the current state React
      // skips the render, and the measuring size above would stay on screen.
      el.style.fontSize = `${fitted}px`;
      setSize(fitted);
    };
    fit();
    // The script fonts load on first use; measure again once they have.
    void document.fonts.ready.then(fit);
    return () => {
      live = false;
    };
  }, [text, className, maxSize, maxWidth]);
  return (
    <span ref={ref} className={cn("inline-block whitespace-nowrap", className)} style={{ fontSize: size }}>
      {text}
    </span>
  );
}
