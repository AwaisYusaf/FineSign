import { useMemo, useRef, useState } from "react";
import { ArrowDown, Check, Circle, Loader2, PenLine, X } from "lucide-react";

import { PdfView, type PageSize } from "@/components/pdf-view";
import { ReasonDialog } from "@/components/reason-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { api, fetchPublicPdf, signerDocUrl } from "@/lib/api";
import { quoteChars, unprintableChars } from "@/lib/charset";
import { fieldKindLabel } from "@/lib/config";
import { FIELD_ICONS } from "@/lib/field-icons";
import type { Session, SessionField, Signature } from "@/lib/types";
import { cn } from "@/lib/utils";

import { SignatureDialog, SignaturePreview } from "./signature-dialog";

type PlacedField = SessionField & { documentId: string; documentName: string; documentIndex: number };

const isSignatureKind = (f: SessionField) => f.kind === "signature" || f.kind === "initials";

/** The furthest a checkbox's invisible tap area reaches past its drawn box (CSS px). */
const MAX_TAP_SLOP = 12;

/**
 * The signing experience: the documents with this recipient's fields, a
 * checklist that says what is left (and jumps to it), one adopted signature for
 * every signature/initials field, explicit ESIGN/UETA consent, then sign.
 */
export function SigningRoom({
  session,
  token,
  onSigned,
  onDeclined,
}: {
  session: Session;
  token: string;
  onSigned: (status: string) => void;
  onDeclined: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [signature, setSignature] = useState<Signature | null>(null);
  const [consented, setConsented] = useState(false);
  const [dialog, setDialog] = useState({ open: false, key: 0 });
  const [declineOpen, setDeclineOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Exactly what finesign-core stamps: MM/DD/YYYY, in UTC.
  const today = new Intl.DateTimeFormat("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "UTC" }).format(new Date());

  // Every field in reading order: document, page, then top-to-bottom, left-to-right.
  const fields: PlacedField[] = useMemo(
    () =>
      session.documents
        .flatMap((d, documentIndex) => d.fields.map((f) => ({ ...f, documentId: d.id, documentName: d.name, documentIndex })))
        .sort((a, b) => a.documentIndex - b.documentIndex || a.page - b.page || a.y - b.y || a.x - b.x),
    [session.documents]
  );

  // Characters the PDF's font can't print; the server refuses them (400).
  const unprintable = (f: SessionField): string[] => (f.kind === "text" ? unprintableChars(values[f.id] ?? "") : []);

  const isComplete = (f: SessionField): boolean => {
    switch (f.kind) {
      case "text":
        return unprintable(f).length === 0 && (!f.required || (values[f.id] ?? "").trim() !== "");
      case "checkbox":
        return !f.required || values[f.id] === "true";
      case "signature":
      case "initials":
        return signature !== null;
      case "date_signed":
        return true;
    }
  };
  // Dates fill themselves in; everything else is something the signer does.
  const checklist = fields.filter((f) => f.kind !== "date_signed");
  const required = checklist.filter((f) => f.required || isSignatureKind(f));
  const remaining = required.filter((f) => !isComplete(f));
  const invalid = checklist.filter((f) => unprintable(f).length > 0);
  const done = required.length - remaining.length;
  const ready = remaining.length === 0 && invalid.length === 0 && signature !== null && consented;
  const isApprover = session.recipient.role === "approver";

  const openSignatureDialog = () => setDialog((d) => ({ open: true, key: d.key + 1 }));

  function goTo(f: SessionField) {
    const el = document.getElementById(`field-${f.id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (isSignatureKind(f)) {
      if (!signature) openSignatureDialog();
    } else {
      el?.focus({ preventScroll: true });
    }
  }

  function next() {
    const f = invalid[0] ?? remaining[0];
    if (f) goTo(f);
    else if (!signature) openSignatureDialog();
    else panelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const hint =
    invalid.length > 0
      ? `The document can't print ${quoteChars([...new Set(invalid.flatMap(unprintable))])} — text fields support Western European (Latin-1) letters only.`
      : remaining.length > 0
        ? `${remaining.length} required ${remaining.length === 1 ? "field" : "fields"} left to complete.`
        : !signature
          ? "Add your signature to finish."
          : !consented
            ? "Agree to sign electronically (above) to finish."
            : "Everything's ready.";

  async function sign() {
    if (!ready || !signature) return;
    setBusy(true);
    setError(null);
    try {
      const fieldValues = fields
        .filter((f) => (f.kind === "text" ? (values[f.id] ?? "").trim() !== "" : f.kind === "checkbox"))
        .map((f) => ({
          fieldId: f.id,
          value: f.kind === "checkbox" ? (values[f.id] === "true" ? "true" : "false") : (values[f.id] ?? "").trim(),
        }));
      const res = await api.apply(token, signature, consented, fieldValues);
      onSigned(res.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  /**
   * How far a checkbox's invisible input may reach past its drawn box: enough
   * to tap on a phone, where the box itself can be ~10px, but never more than
   * half the gap to the nearest field on the page. A fixed overhang made a tap
   * on one of two adjacent checkboxes tick the other.
   */
  function tapSlop(f: PlacedField, onPage: PlacedField[], size: PageSize): number {
    const box = (g: PlacedField) => ({
      left: g.x * size.width,
      top: g.y * size.height,
      right: (g.x + g.width) * size.width,
      bottom: (g.y + g.height) * size.height,
    });
    const a = box(f);
    let slop = MAX_TAP_SLOP;
    for (const g of onPage) {
      if (g.id === f.id) continue;
      const b = box(g);
      // Positive when apart along that axis; both negative when the boxes overlap.
      const gap = Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom);
      slop = Math.min(slop, Math.max(0, gap / 2));
    }
    return slop;
  }

  function overlay(documentId: string, page: number, size: PageSize) {
    const onPage = fields.filter((f) => f.documentId === documentId && f.page === page);
    return onPage
      .map((f) => {
        const heightPx = f.height * size.height;
        const box = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.width * 100}%`, height: `${f.height * 100}%` };
        const pending = !isComplete(f);
        const bad = unprintable(f);
        const frame = cn(
          "pointer-events-auto absolute rounded-[3px] border transition-colors",
          bad.length > 0
            ? "border-destructive bg-destructive/10"
            : pending
              ? "border-dashed border-primary bg-primary/10"
              : "border-success/50 bg-success/5"
        );
        const label = `${fieldKindLabel(f.kind)} field${f.required ? " (required)" : ""}`;
        switch (f.kind) {
          case "text":
            return (
              <input
                key={f.id}
                id={`field-${f.id}`}
                aria-label={label}
                aria-invalid={bad.length > 0 || undefined}
                title={bad.length > 0 ? `Can't be printed in the document: ${bad.join(" ")}` : undefined}
                placeholder="Type here"
                maxLength={5000}
                value={values[f.id] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                className={cn(frame, "px-1 text-slate-900 outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-primary/40")}
                style={{ ...box, fontSize: Math.max(9, Math.min(14, heightPx * 0.6)) }}
              />
            );
          case "checkbox": {
            // The real (invisible) input overhangs the drawn box (see tapSlop).
            const slop = tapSlop(f, onPage, size);
            return (
              <span
                key={f.id}
                className={cn(frame, "flex items-center justify-center has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/50")}
                style={box}
              >
                {values[f.id] === "true" && <Check className="size-[85%] text-slate-900" strokeWidth={3} aria-hidden="true" />}
                <input
                  id={`field-${f.id}`}
                  type="checkbox"
                  aria-label={label}
                  checked={values[f.id] === "true"}
                  onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.checked ? "true" : "false" }))}
                  className="absolute cursor-pointer opacity-0"
                  style={{ inset: -slop }}
                />
              </span>
            );
          }
          case "signature":
          case "initials":
            return (
              <button
                key={f.id}
                id={`field-${f.id}`}
                type="button"
                aria-label={signature ? `${label}: change your signature` : `${label}: add your signature`}
                onClick={openSignatureDialog}
                className={cn(
                  "pointer-events-auto absolute flex items-center justify-center overflow-hidden rounded-[3px] border transition-colors",
                  signature ? "border-transparent hover:border-primary/40" : "border-dashed border-primary bg-primary/10 text-primary hover:bg-primary/15"
                )}
                style={{ ...box, fontSize: Math.max(10, heightPx * 0.7) }}
              >
                {signature ? (
                  <SignaturePreview
                    signature={signature}
                    initialsOnly={f.kind === "initials"}
                    box={{ width: f.width * size.width, height: heightPx }}
                    className="px-1"
                  />
                ) : (
                  <span className="flex items-center gap-1 text-[10px] font-semibold">
                    <PenLine className="size-3" /> {f.kind === "initials" ? "Initial" : "Sign here"}
                  </span>
                )}
              </button>
            );
          case "date_signed":
            return (
              <span
                key={f.id}
                title="Filled in automatically when you sign"
                className="absolute flex items-center rounded-[3px] border border-dashed border-slate-300 px-1 text-slate-600"
                style={{ ...box, fontSize: Math.max(9, Math.min(13, heightPx * 0.6)) }}
              >
                {today}
              </span>
            );
        }
      });
  }

  return (
    <div className="pb-24 lg:pb-0">
      <div className="mb-6 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{session.title}</h1>
        <p className="text-sm text-muted-foreground">
          Hi {session.recipient.name} —{" "}
          {isApprover ? "please review the documents below, then approve." : "please review and sign the highlighted fields below."}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          {session.documents.map((d) => (
            <section key={d.id} aria-label={d.name} className="space-y-3">
              {session.documents.length > 1 && <h2 className="text-sm font-medium text-muted-foreground">{d.name}</h2>}
              <div className="rounded-xl bg-muted/60 p-3 sm:p-6">
                <PdfView
                  loadBytes={() => fetchPublicPdf(signerDocUrl(token, d.id))}
                  renderOverlay={(page, size) => overlay(d.id, page, size)}
                />
              </div>
            </section>
          ))}
        </div>

        <div ref={panelRef} id="sign-panel" className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          {checklist.length > 0 && (
            <Card className="gap-4 py-5">
              <CardHeader className="px-5">
                <CardTitle className="flex items-center justify-between text-sm">
                  Your progress
                  <span className="font-normal text-muted-foreground tabular-nums">
                    {done} of {required.length}
                  </span>
                </CardTitle>
                <Progress value={required.length ? (done / required.length) * 100 : 100} className="h-1.5" />
              </CardHeader>
              <CardContent className="px-3">
                <ul className="max-h-60 space-y-0.5 overflow-y-auto">
                  {checklist.map((f) => {
                    const Icon = FIELD_ICONS[f.kind];
                    const complete = isComplete(f);
                    return (
                      <li key={f.id}>
                        <button
                          type="button"
                          onClick={() => goTo(f)}
                          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                        >
                          <Icon className="size-4 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">
                            {fieldKindLabel(f.kind)}
                            <span className="text-muted-foreground">
                              {" "}
                              · page {f.page}
                              {session.documents.length > 1 && ` · ${f.documentName}`}
                              {!f.required && !isSignatureKind(f) && " · optional"}
                            </span>
                          </span>
                          {complete ? <Check className="size-4 text-success" /> : <Circle className="size-4 text-muted-foreground/50" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card className="gap-4 py-5">
            <CardHeader className="px-5">
              <CardTitle className="text-sm">Your signature</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 px-5">
              <div className="flex h-20 items-center justify-center overflow-hidden rounded-lg border bg-white px-3 text-3xl">
                {signature ? (
                  <SignaturePreview signature={signature} />
                ) : (
                  <span className="text-sm text-slate-400">Not added yet</span>
                )}
              </div>
              <Button variant="outline" className="w-full" onClick={openSignatureDialog}>
                <PenLine /> {signature ? "Change signature" : "Add signature"}
              </Button>
            </CardContent>
          </Card>

          <Card className="gap-4 py-5">
            <CardContent className="space-y-4 px-5">
              <div className="flex items-start gap-3">
                <Checkbox id="consent" checked={consented} onCheckedChange={(v) => setConsented(v === true)} className="mt-0.5" />
                <Label htmlFor="consent" className="block text-xs leading-relaxed font-normal text-muted-foreground">
                  {session.consent.disclosure}
                </Label>
              </div>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button size="lg" className="w-full" disabled={!ready || busy} onClick={sign}>
                {busy && <Loader2 className="animate-spin" />}
                {isApprover ? "Approve" : "Sign all fields"}
              </Button>
              <p aria-live="polite" className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{hint}</span>
                {!ready && (
                  <Button variant="link" size="xs" className="h-auto p-0" onClick={next}>
                    Next field <ArrowDown />
                  </Button>
                )}
              </p>
              <Button variant="ghost" className="w-full text-muted-foreground" onClick={() => setDeclineOpen(true)}>
                <X /> Decline to sign
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Phones: progress and the next step stay in reach while scrolling the document. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 px-4 py-3 backdrop-blur lg:hidden">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <div className="min-w-0 flex-1">
            {checklist.length > 0 ? (
              <>
                <p className="text-sm font-medium tabular-nums">
                  {done} of {required.length} done
                </p>
                <Progress value={required.length ? (done / required.length) * 100 : 100} className="mt-1 h-1" />
              </>
            ) : (
              <p className="text-sm font-medium">{isApprover ? "Review, then approve" : "Review, then sign"}</p>
            )}
          </div>
          <Button size="sm" onClick={next}>
            {remaining.length > 0 || !signature ? "Next field" : "Finish"} <ArrowDown />
          </Button>
        </div>
      </div>

      <SignatureDialog
        key={dialog.key}
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        current={signature}
        defaultName={session.recipient.name}
        onAdopt={setSignature}
      />
      <ReasonDialog
        open={declineOpen}
        onOpenChange={setDeclineOpen}
        title="Decline to sign?"
        description="The sender is told you declined, and the agreement closes for everyone. This can't be undone."
        reasonLabel="Reason (shared with the sender)"
        confirmLabel="Decline"
        onConfirm={async (reason) => {
          await api.decline(token, reason);
          onDeclined();
        }}
      />
    </div>
  );
}
