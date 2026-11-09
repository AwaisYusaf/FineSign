import { useState, type FormEvent } from "react";
import { ArrowRight, Info, Loader2, Lock, UserPlus } from "lucide-react";

import { RecipientAvatar } from "@/components/recipient-avatar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import type { Envelope, RecipientRole } from "@/lib/types";

import { StepFooter } from "./step-footer";
import { actors } from "./steps";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROLES: { value: RecipientRole; label: string; hint: string }[] = [
  { value: "signer", label: "Signer", hint: "Signs and fills in fields" },
  { value: "approver", label: "Approver", hint: "Approves; can have fields too" },
  { value: "cc", label: "CC", hint: "Gets the signed copy" },
];

export function RecipientsStep({
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
  const sequential = env.routingType === "sequential";
  const nextOrder = Math.max(0, ...env.recipients.map((r) => r.routingOrder)) + 1;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RecipientRole>("signer");
  const [order, setOrder] = useState(String(nextOrder));
  const [accessCode, setAccessCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailInvalid = email.trim() !== "" && !EMAIL.test(email.trim());
  const codeTooShort = accessCode.trim() !== "" && accessCode.trim().length < 4;
  const ready = name.trim() !== "" && EMAIL.test(email.trim()) && !codeTooShort && Number(order) >= 1;

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const code = accessCode.trim();
      const next = await api.addRecipient(env.id, {
        name: name.trim(),
        email: email.trim(),
        role,
        routingOrder: sequential ? Number(order) : 1,
        ...(code ? { authMethod: "access_code" as const, accessCode: code } : {}),
      });
      onChange(next);
      setName("");
      setEmail("");
      setAccessCode("");
      setOrder(String(Math.max(0, ...next.recipients.map((r) => r.routingOrder)) + 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Card className="self-start">
          <CardHeader>
            <CardTitle>Add a recipient</CardTitle>
            <CardDescription>
              {sequential ? "Lower steps sign first; people on the same step sign together." : "Everyone is notified as soon as you send."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={add} className="grid gap-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="r-name">Name</Label>
                  <Input id="r-name" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="r-email">Email</Label>
                  <Input id="r-email" type="email" value={email} aria-invalid={emailInvalid} onChange={(e) => setEmail(e.target.value)} />
                  {emailInvalid && <p className="text-xs text-destructive">Enter a valid email address.</p>}
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
                <div className="grid gap-2">
                  <Label htmlFor="r-role">Role</Label>
                  <Select value={role} onValueChange={(v) => setRole(v as RecipientRole)}>
                    <SelectTrigger id="r-role" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r.value} value={r.value}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{ROLES.find((r) => r.value === role)?.hint}.</p>
                </div>
                {sequential && (
                  <div className="grid gap-2">
                    <Label htmlFor="r-order">Step</Label>
                    <Input id="r-order" type="number" min={1} className="w-20" value={order} onChange={(e) => setOrder(e.target.value)} />
                  </div>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="r-code">Access code (optional)</Label>
                <Input
                  id="r-code"
                  value={accessCode}
                  aria-invalid={codeTooShort}
                  placeholder="Share it with them separately"
                  onChange={(e) => setAccessCode(e.target.value)}
                />
                <p className={codeTooShort ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                  {codeTooShort ? "Use at least 4 characters." : "They must enter it before they can see the documents."}
                </p>
              </div>
              <Button type="submit" variant="secondary" disabled={busy || !ready} className="justify-self-start">
                {busy ? <Loader2 className="animate-spin" /> : <UserPlus />}
                Add recipient
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="self-start">
          <CardHeader>
            <CardTitle>Recipients</CardTitle>
            <CardDescription>Each person&apos;s colour marks their fields on the document.</CardDescription>
          </CardHeader>
          <CardContent>
            {env.recipients.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Info className="size-4" /> Nobody yet — add at least one signer.
              </p>
            ) : (
              <ul className="space-y-2" aria-label="Recipients">
                {[...env.recipients]
                  .map((r, i) => ({ r, i }))
                  .sort((a, b) => a.r.routingOrder - b.r.routingOrder)
                  .map(({ r, i }) => (
                    <li key={r.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                      <RecipientAvatar name={r.name} index={i} />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                          {r.name}
                          {r.authMethod === "access_code" && <Lock className="size-3 text-muted-foreground" aria-label="Access code" />}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{r.email}</p>
                      </div>
                      <Badge variant="outline" className="capitalize">
                        {r.role === "cc" ? "CC" : r.role}
                      </Badge>
                      {sequential && <span className="w-12 text-right text-xs text-muted-foreground">step {r.routingOrder}</span>}
                    </li>
                  ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
      <StepFooter onBack={onBack}>
        <Button onClick={onNext} disabled={actors(env).length === 0}>
          Continue to fields <ArrowRight />
        </Button>
      </StepFooter>
    </div>
  );
}
