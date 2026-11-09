import { useState, type FormEvent } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

import { LogoMark } from "@/components/logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isKeyRejection } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/** The sender console's door: the server's FINESIGN_SENDER_API_KEY, checked before it's kept. */
export default function SignIn() {
  const { signIn, notice } = useAuth();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(key.trim());
    } catch (err) {
      setError(
        isKeyRejection(err)
          ? "The server rejected that key. Check FINESIGN_SENDER_API_KEY on your server."
          : err instanceof Error
            ? err.message
            : String(err)
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <LogoMark className="size-10" />
          <p className="text-sm text-muted-foreground">FineSign — self-hosted e-signatures</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>
              <h1 className="text-xl">Sender access</h1>
            </CardTitle>
            <CardDescription>
              The sender console is protected by your server&apos;s API key (<code className="text-xs">FINESIGN_SENDER_API_KEY</code>).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="grid gap-4">
              {(error ?? notice) && (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertDescription>{error ?? notice}</AlertDescription>
                </Alert>
              )}
              <div className="grid gap-2">
                <Label htmlFor="api-key">API key</Label>
                <Input
                  id="api-key"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Sender API key"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  autoFocus
                />
              </div>
              <Button type="submit" disabled={busy || key.trim() === ""}>
                {busy && <Loader2 className="animate-spin" />}
                Continue
              </Button>
            </form>
          </CardContent>
        </Card>
        <p className="text-center text-xs text-muted-foreground">Signing a document? Open the link in your email instead.</p>
      </div>
    </div>
  );
}
