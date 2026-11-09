import { useState } from "react";
import { AlertTriangle, FileText, Loader2, Lock, Send } from "lucide-react";

import { RecipientAvatar } from "@/components/recipient-avatar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { pluralize } from "@/lib/format";
import type { Envelope } from "@/lib/types";

import { StepFooter } from "./step-footer";
import { signersWithoutFields } from "./steps";

export function ReviewStep({ env, onBack, onSent }: { env: Envelope; onBack: () => void; onSent: (env: Envelope) => void }) {
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const withoutFields = signersWithoutFields(env);
  const daysInvalid = days.trim() !== "" && !(Number.isInteger(Number(days)) && Number(days) > 0);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      onSent(await api.send(env.id, days.trim() === "" ? undefined : Number(days)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const ordered = [...env.recipients].map((r, i) => ({ r, i })).sort((a, b) => a.r.routingOrder - b.r.routingOrder);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
            <CardDescription>
              {env.routingType === "sequential" ? "Signers are emailed one step at a time." : "Everyone is emailed at once."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <section className="space-y-2">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Documents</h3>
              <ul className="space-y-1.5">
                {env.documents.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 text-sm">
                    <FileText className="size-4 text-muted-foreground" /> {d.name}
                    <span className="text-muted-foreground">· {d.pageCount ? pluralize(d.pageCount, "page") : "PDF"}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="space-y-2">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Recipients</h3>
              <ul className="space-y-2">
                {ordered.map(({ r, i }) => {
                  const count = env.fields.filter((f) => f.recipientId === r.id).length;
                  return (
                    <li key={r.id} className="flex items-center gap-3">
                      <RecipientAvatar name={r.name} index={i} className="size-7" />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        <span className="font-medium">{r.name}</span> <span className="text-muted-foreground">{r.email}</span>
                      </span>
                      {r.authMethod === "access_code" && <Lock className="size-3.5 text-muted-foreground" aria-label="Access code" />}
                      <span className="text-xs text-muted-foreground">
                        {r.role === "cc" ? "gets a copy" : pluralize(count, "field")}
                        {env.routingType === "sequential" && ` · step ${r.routingOrder}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          </CardContent>
        </Card>

        <Card className="self-start">
          <CardHeader>
            <CardTitle>Send</CardTitle>
            <CardDescription>Recipients get an email with their own private signing link.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {withoutFields.length > 0 && (
              <Alert>
                <AlertTriangle className="text-warning" />
                <AlertDescription>
                  {withoutFields.map((p) => p.name).join(", ")} {withoutFields.length === 1 ? "has" : "have"} no fields. Add at least
                  one for every signer before sending.
                </AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="grid gap-2">
              <Label htmlFor="expires">Expires after (days)</Label>
              <Input
                id="expires"
                type="number"
                min={1}
                placeholder="No expiration"
                value={days}
                aria-invalid={daysInvalid}
                onChange={(e) => setDays(e.target.value)}
                className="w-40"
              />
              <p className={daysInvalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                {daysInvalid ? "Use a whole number of days." : "Leave blank for no deadline. After it, unsigned recipients can't sign."}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
      <StepFooter onBack={onBack}>
        <Button onClick={send} disabled={busy || daysInvalid || withoutFields.length > 0}>
          {busy ? <Loader2 className="animate-spin" /> : <Send />}
          Send envelope
        </Button>
      </StepFooter>
    </div>
  );
}
