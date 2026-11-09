import { useState, type FormEvent, type ReactNode } from "react";
import { CircleCheck, Download, FileText, KeyRound, Link2Off, Loader2, XCircle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api, signerDocUrl } from "@/lib/api";
import { pluralize } from "@/lib/format";
import type { RecipientRole, Session } from "@/lib/types";

function CenterCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Card className="mx-auto max-w-md">
      <CardHeader className="items-center text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-muted">{icon}</div>
        <CardTitle>
          <h1 className="text-xl">{title}</h1>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-center text-sm text-muted-foreground">{children}</CardContent>
    </Card>
  );
}

/** Turn a session error into something a signer can act on. */
function explain(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "This link isn't valid, or a newer one replaced it (after a reminder or a resend). Use the most recent email.";
    if (error.code === "ENVELOPE_EXPIRED") return "This agreement expired before it was signed. Ask the sender for a new one.";
    if (error.code === "TOKEN_EXPIRED") return "This signing link has expired. Ask the sender to resend it.";
    if (error.code === "ENVELOPE_NOT_SENT") {
      if (error.message.includes("voided")) return "The sender withdrew this agreement, so it can no longer be signed.";
      if (error.message.includes("declined")) return "Someone declined to sign, so this agreement is closed.";
    }
    if (error.status === 429) return "Too many requests. Wait a minute and try again.";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function UnavailableCard({ error }: { error: unknown }) {
  return (
    <CenterCard icon={<Link2Off className="size-5 text-muted-foreground" />} title="Signing link unavailable">
      <p>{explain(error)}</p>
    </CenterCard>
  );
}

export function SignedCard({ name, role, completed }: { name: string; role: RecipientRole; completed: boolean }) {
  const what = role === "approver" ? "approval" : "signature";
  return (
    <CenterCard
      icon={<CircleCheck className="size-6 text-success" />}
      title={completed ? "All done" : role === "approver" ? "Approval recorded" : "Signature recorded"}
    >
      <p>
        {completed
          ? `Thanks, ${name}. Everyone has signed and the agreement is complete. We've emailed you a link to your signed copy.`
          : `Thanks, ${name}. Your ${what} is recorded; we're waiting on the others and will email you the final copy.`}
      </p>
      <p className="text-xs">You can close this page.</p>
    </CenterCard>
  );
}

export function DeclinedCard() {
  return (
    <CenterCard icon={<XCircle className="size-6 text-destructive" />} title="Declined">
      <p>You declined to sign. The sender has been notified, with your reason.</p>
    </CenterCard>
  );
}

/** A completed envelope keeps the link alive as a download page for the finished package. */
export function CompletedCard({ session, token }: { session: Session; token: string }) {
  return (
    <CenterCard icon={<CircleCheck className="size-6 text-success" />} title={session.title}>
      <p>This agreement is complete. Your signed copy is below — each file includes the certificate of completion.</p>
      {session.documents.length === 0 ? (
        <p>No documents are available for you on this agreement.</p>
      ) : (
        <ul className="space-y-2 pt-2 text-left">
          {session.documents.map((d) => (
            <li key={d.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
              <FileText className="size-4 text-muted-foreground" />
              <a href={signerDocUrl(token, d.id)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-medium text-foreground hover:underline">
                {d.name}
              </a>
              <span className="text-xs">{d.pageCount ? pluralize(d.pageCount, "page") : ""}</span>
              <Download className="size-4" aria-hidden="true" />
            </li>
          ))}
        </ul>
      )}
    </CenterCard>
  );
}

/** The documents stay hidden until the access code is accepted. */
export function AccessCodeCard({ token, onUnlocked }: { token: string; onUnlocked: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.authenticate(token, code.trim());
      onUnlocked();
    } catch (err) {
      const locked = err instanceof Error && /too many/i.test(err.message);
      setError(err instanceof ApiError && err.status === 403 && !locked ? "That access code is incorrect." : explainCode(err));
      setBusy(false);
    }
  }

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10">
          <KeyRound className="size-5 text-primary" />
        </div>
        <CardTitle>
          <h1 className="text-xl">Enter your access code</h1>
        </CardTitle>
        <CardDescription>The sender protected these documents with a code they shared with you separately.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="access-code" className="sr-only">
              Access code
            </Label>
            <Input
              id="access-code"
              autoComplete="one-time-code"
              placeholder="Access code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
            />
          </div>
          <Button type="submit" disabled={busy || code.trim() === ""}>
            {busy && <Loader2 className="animate-spin" />}
            Continue
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

const explainCode = (err: unknown) => (err instanceof Error ? err.message : String(err));
