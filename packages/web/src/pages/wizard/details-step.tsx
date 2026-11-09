import { useState, type FormEvent } from "react";
import { ArrowRight, ListOrdered, Loader2, Users } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import type { Envelope, RoutingType } from "@/lib/types";
import { cn } from "@/lib/utils";

import { StepFooter } from "./step-footer";

const SENDER_STORAGE = "finesign_sender";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Senders usually send many envelopes: remember who they are (this browser only). */
function rememberedSender(): { name: string; email: string } {
  try {
    const raw = localStorage.getItem(SENDER_STORAGE);
    const parsed = raw ? (JSON.parse(raw) as { name?: unknown; email?: unknown }) : {};
    return { name: typeof parsed.name === "string" ? parsed.name : "", email: typeof parsed.email === "string" ? parsed.email : "" };
  } catch {
    return { name: "", email: "" };
  }
}

const ROUTING: { value: RoutingType; title: string; body: string; icon: typeof Users }[] = [
  { value: "sequential", title: "Sequential", body: "Signers sign one after another, in the order you set.", icon: ListOrdered },
  { value: "parallel", title: "Parallel", body: "Everyone gets the document at once and signs in any order.", icon: Users },
];

export function DetailsStep({
  env,
  onCreated,
  onNext,
}: {
  env: Envelope | undefined;
  onCreated: (env: Envelope) => void;
  onNext: () => void;
}) {
  const [title, setTitle] = useState("");
  const [sender, setSender] = useState(rememberedSender);
  const [routingType, setRoutingType] = useState<RoutingType>("sequential");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A created draft's details are fixed (the API has no edit for them).
  if (env) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent>
            <dl className="grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Title</dt>
                <dd className="font-medium">{env.title}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Sender</dt>
                <dd className="font-medium">
                  {env.senderName} <span className="text-muted-foreground">({env.senderEmail})</span>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Signing order</dt>
                <dd className="font-medium capitalize">{env.routingType}</dd>
              </div>
            </dl>
            <p className="mt-4 text-xs text-muted-foreground">These are fixed once the draft exists.</p>
          </CardContent>
        </Card>
        <StepFooter>
          <Button onClick={onNext}>
            Continue <ArrowRight />
          </Button>
        </StepFooter>
      </div>
    );
  }

  const emailInvalid = sender.email.trim() !== "" && !EMAIL.test(sender.email.trim());
  const ready = title.trim() !== "" && sender.name.trim() !== "" && EMAIL.test(sender.email.trim());

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createEnvelope({
        title: title.trim(),
        senderName: sender.name.trim(),
        senderEmail: sender.email.trim(),
        routingType,
      });
      try {
        localStorage.setItem(SENDER_STORAGE, JSON.stringify({ name: sender.name.trim(), email: sender.email.trim() }));
      } catch {
        // Not remembered; harmless.
      }
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <Card>
        <CardContent className="grid gap-6">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              placeholder="e.g. Master Services Agreement"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">Recipients see this in their email and on the signing page.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="sender-name">Your name</Label>
              <Input id="sender-name" value={sender.name} onChange={(e) => setSender({ ...sender, name: e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sender-email">Your email</Label>
              <Input
                id="sender-email"
                type="email"
                value={sender.email}
                aria-invalid={emailInvalid}
                onChange={(e) => setSender({ ...sender, email: e.target.value })}
              />
              {emailInvalid && <p className="text-xs text-destructive">Enter a valid email address.</p>}
            </div>
          </div>
          <fieldset className="grid gap-3">
            <legend className="mb-3 text-sm font-medium">Signing order</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {ROUTING.map((o) => (
                <label
                  key={o.value}
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors hover:bg-accent/50 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
                    routingType === o.value && "border-primary bg-primary/5"
                  )}
                >
                  <input
                    type="radio"
                    name="routing"
                    value={o.value}
                    checked={routingType === o.value}
                    onChange={() => setRoutingType(o.value)}
                    className="sr-only"
                  />
                  <o.icon className={cn("mt-0.5 size-5 shrink-0", routingType === o.value ? "text-primary" : "text-muted-foreground")} />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium">{o.title}</span>
                    <span className="block text-xs text-muted-foreground">{o.body}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </CardContent>
      </Card>
      <StepFooter>
        <Button type="submit" disabled={busy || !ready}>
          {busy && <Loader2 className="animate-spin" />}
          Create draft <ArrowRight />
        </Button>
      </StepFooter>
    </form>
  );
}
