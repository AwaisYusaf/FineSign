import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, Loader2, MousePointerClick, Trash2 } from "lucide-react";

import { PdfView } from "@/components/pdf-view";
import { RecipientAvatar } from "@/components/recipient-avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, fetchAuthedPdf, managementDocUrl } from "@/lib/api";
import { DEFAULT_FIELD_SIZE, FIELD_KINDS, fieldKindLabel } from "@/lib/config";
import { FIELD_ICONS } from "@/lib/field-icons";
import { pluralize, recipientColor } from "@/lib/format";
import type { Envelope, Field, FieldKind } from "@/lib/types";
import { cn } from "@/lib/utils";

import { StepFooter } from "./step-footer";
import { actors, signersWithoutFields } from "./steps";

/**
 * Place fields by clicking the page. The left panel picks WHO the next field is
 * for and WHAT it is; each recipient's fields wear their colour. Click a placed
 * field to select it, then remove it (or press Delete).
 */
export function FieldsStep({
  env,
  onChange,
  onBack,
  onNext,
}: {
  env: Envelope;
  onChange: (env: Envelope) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const people = actors(env);
  const colorIndex = (recipientId: string) => env.recipients.findIndex((r) => r.id === recipientId);
  const [assignee, setAssignee] = useState(people[0]?.id ?? "");
  const [kind, setKind] = useState<FieldKind>("signature");
  const [documentId, setDocumentId] = useState(env.documents[0]?.id ?? "");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = env.fields.find((f) => f.id === selectedId) ?? null;
  const nameOf = (recipientId: string) => env.recipients.find((r) => r.id === recipientId)?.name ?? "someone";
  const withoutFields = signersWithoutFields(env);

  /** Add a field with its top-left corner at `point`; returns the new field's id. */
  async function addField(page: number, point: { x: number; y: number }): Promise<string | null> {
    if (busy || !assignee) return null;
    const size = DEFAULT_FIELD_SIZE[kind];
    setBusy(true);
    try {
      const next = await api.addField(env.id, {
        documentId,
        recipientId: assignee,
        page,
        x: point.x,
        y: point.y,
        width: Math.min(size.w, 1 - point.x),
        height: Math.min(size.h, 1 - point.y),
        kind,
      });
      onChange(next);
      return next.fields.find((f) => !env.fields.some((old) => old.id === f.id))?.id ?? null;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  function place(page: number, point: { x: number; y: number }) {
    if (selectedId) {
      setSelectedId(null); // a click on the page first just deselects
      return;
    }
    void addField(page, point);
  }

  /** Keyboard placement: centred on the page, then selected so Delete undoes it. */
  async function placeCentered(page: number) {
    const size = DEFAULT_FIELD_SIZE[kind];
    const id = await addField(page, { x: Math.max(0, 0.5 - size.w / 2), y: Math.max(0, 0.5 - size.h / 2) });
    if (id) {
      setSelectedId(id);
      toast.success(`Placed a ${fieldKindLabel(kind).toLowerCase()} field for ${nameOf(assignee)} on page ${page}.`);
    }
  }

  const remove = useCallback(
    async (field: Field) => {
      if (busy) return; // one removal at a time (a held Delete key repeats)
      setBusy(true);
      try {
        onChange(await api.removeField(env.id, field.id));
        setSelectedId(null);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, env.id, onChange]
  );

  // Delete / Backspace removes the selected field; Escape deselects.
  useEffect(() => {
    if (!selected) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (!e.repeat) void remove(selected);
      } else if (e.key === "Escape") {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, remove]);

  function overlay(page: number) {
    return env.fields
      .filter((f) => f.documentId === documentId && f.page === page)
      .map((f) => {
        const color = recipientColor(colorIndex(f.recipientId));
        const Icon = FIELD_ICONS[f.kind];
        const label = `${fieldKindLabel(f.kind)} for ${nameOf(f.recipientId)}`;
        const isSelected = f.id === selectedId;
        return (
          <button
            key={f.id}
            type="button"
            aria-label={label}
            aria-pressed={isSelected}
            title={label}
            onClick={(e) => {
              e.stopPropagation(); // the page is the drop target
              setSelectedId(isSelected ? null : f.id);
            }}
            className={cn(
              "pointer-events-auto absolute flex items-center justify-center gap-1 overflow-hidden rounded-[3px] border-2 px-1 text-[10px] font-semibold transition-shadow",
              isSelected && "ring-2 ring-offset-1 ring-offset-white"
            )}
            style={{
              left: `${f.x * 100}%`,
              top: `${f.y * 100}%`,
              width: `${f.width * 100}%`,
              height: `${f.height * 100}%`,
              borderColor: color.solid,
              backgroundColor: color.soft,
              color: color.text,
              ...(isSelected ? { ["--tw-ring-color" as string]: color.solid } : {}),
            }}
          >
            <Icon className="size-3 shrink-0" />
            {f.kind !== "checkbox" && <span className="truncate">{fieldKindLabel(f.kind)}</span>}
          </button>
        );
      });
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Card className="gap-4 py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-sm">Who fills it in</CardTitle>
            </CardHeader>
            <CardContent className="px-2">
              <div role="radiogroup" aria-label="Assign to" className="space-y-1">
                {people.map((p) => {
                  const count = env.fields.filter((f) => f.recipientId === p.id).length;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={assignee === p.id}
                      onClick={() => setAssignee(p.id)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent",
                        assignee === p.id && "bg-accent ring-1 ring-border"
                      )}
                    >
                      <RecipientAvatar name={p.name} index={colorIndex(p.id)} className="size-7" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{p.name}</span>
                        <span className="block text-xs text-muted-foreground">{pluralize(count, "field")}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card className="gap-4 py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-sm">Field type</CardTitle>
            </CardHeader>
            <CardContent className="px-4">
              <div role="radiogroup" aria-label="Field type" className="grid grid-cols-2 gap-2">
                {FIELD_KINDS.map((k) => {
                  const Icon = FIELD_ICONS[k.value];
                  return (
                    <button
                      key={k.value}
                      type="button"
                      role="radio"
                      aria-checked={kind === k.value}
                      onClick={() => setKind(k.value)}
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs font-medium transition-colors hover:bg-accent",
                        kind === k.value && "border-primary bg-primary/5 text-primary"
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      {k.label}
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {selected ? (
            <Card className="gap-3 border-primary/40 py-4">
              <CardContent className="space-y-3 px-4">
                <p className="text-sm">
                  <span className="font-medium">{fieldKindLabel(selected.kind)}</span> for {nameOf(selected.recipientId)}
                  <span className="text-muted-foreground"> · page {selected.page}</span>
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={busy}
                    onClick={() => void remove(selected)}
                  >
                    <Trash2 /> Remove field
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
                    Done
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <p className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
              <MousePointerClick className="mt-0.5 size-4 shrink-0" />
              Click the document to place a {fieldKindLabel(kind).toLowerCase()} field for {nameOf(assignee)} (or Tab to a
              page&apos;s &ldquo;Place&rdquo; button). Click a placed field to select it.
            </p>
          )}

          {withoutFields.length > 0 && env.fields.length > 0 && (
            <p className="flex items-start gap-2 rounded-md bg-warning/15 px-3 py-2 text-xs">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              {withoutFields.map((p) => p.name).join(", ")} {withoutFields.length === 1 ? "has" : "have"} no fields yet — every
              signer needs at least one.
            </p>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          {env.documents.length > 1 && (
            <Tabs value={documentId} onValueChange={(v) => (setDocumentId(v), setSelectedId(null))}>
              <TabsList className="max-w-full overflow-x-auto">
                {env.documents.map((d) => (
                  <TabsTrigger key={d.id} value={d.id} className="max-w-48">
                    <span className="truncate">{d.name}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          <div className="relative rounded-xl bg-muted/50 p-4 sm:p-6">
            {busy && (
              <span className="absolute top-3 right-3 z-10 flex items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-xs shadow">
                <Loader2 className="size-3 animate-spin" /> Saving
              </span>
            )}
            {documentId && (
              <PdfView
                key={documentId}
                loadBytes={() => fetchAuthedPdf(managementDocUrl(env.id, documentId))}
                onPageClick={place}
                keyboardPlacement={{
                  label: (page) => `Place ${fieldKindLabel(kind).toLowerCase()} field for ${nameOf(assignee)} on page ${page}`,
                  onPlace: (page) => void placeCentered(page),
                }}
                renderOverlay={overlay}
              />
            )}
          </div>
        </div>
      </div>
      <StepFooter onBack={onBack}>
        <Button onClick={onNext} disabled={env.fields.length === 0}>
          Review &amp; send <ArrowRight />
        </Button>
      </StepFooter>
    </div>
  );
}
