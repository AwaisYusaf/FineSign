import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertCircle, KeyRound, Loader2, Send, Trash2, Webhook } from "lucide-react";

import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { WEBHOOK_EVENT_TYPES } from "@/lib/config";
import { formatRelative } from "@/lib/format";

export default function Webhooks() {
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery({ queryKey: ["webhooks"], queryFn: api.listWebhooks });
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [delivering, setDelivering] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["webhooks"] });

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const created = await api.createWebhook({
        url: url.trim(),
        secret: secret.trim() === "" ? undefined : secret.trim(),
        eventTypes: types.length === 0 ? null : types,
      });
      setCreatedSecret(created.secret); // shown exactly once
      setUrl("");
      setSecret("");
      setTypes([]);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deliverNow() {
    setDelivering(true);
    try {
      const s = await api.deliverWebhooks();
      toast.success(`Outbox drained: ${s.delivered} delivered, ${s.retried} retried, ${s.dead} dead-lettered.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDelivering(false);
    }
  }

  const subscriptions = data?.subscriptions ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Webhooks</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Endpoints receive an HTTP POST for each matching envelope event, signed with{" "}
            <code className="text-xs">X-FineSign-Signature: sha256=HMAC(secret, "&lt;timestamp&gt;.&lt;body&gt;")</code>.
          </p>
        </div>
        <Button variant="outline" onClick={deliverNow} disabled={delivering}>
          {delivering ? <Loader2 className="animate-spin" /> : <Send />} Deliver now
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <Card className="self-start">
          <CardHeader>
            <CardTitle>Add endpoint</CardTitle>
            <CardDescription>Events are queued durably and retried with backoff.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={create} className="grid gap-4">
              {formError && (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              )}
              <div className="grid gap-2">
                <Label htmlFor="wh-url">Endpoint URL (https)</Label>
                <Input
                  id="wh-url"
                  type="url"
                  required
                  placeholder="https://example.com/finesign/webhook"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="wh-secret">Signing secret (optional)</Label>
                <Input
                  id="wh-secret"
                  placeholder="Generated if left blank (min 16 characters)"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </div>
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">Events</legend>
                <p className="-mt-1 mb-1 text-xs text-muted-foreground">None selected means every event.</p>
                {WEBHOOK_EVENT_TYPES.map((t) => (
                  <div key={t} className="flex items-center gap-2">
                    <Checkbox
                      id={`ev-${t}`}
                      checked={types.includes(t)}
                      onCheckedChange={(on) => setTypes((cur) => (on ? [...cur, t] : cur.filter((x) => x !== t)))}
                    />
                    <Label htmlFor={`ev-${t}`} className="font-mono text-xs font-normal">
                      {t}
                    </Label>
                  </div>
                ))}
              </fieldset>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="animate-spin" />}
                Add webhook
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="gap-0 self-start pb-0">
          <CardHeader className="pb-4">
            <CardTitle>Endpoints</CardTitle>
          </CardHeader>
          {error && (
            <div className="px-6 pb-6">
              <Alert variant="destructive">
                <AlertCircle />
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
            </div>
          )}
          {isPending && (
            <div className="space-y-2 px-6 pb-6">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          )}
          {!isPending && !error && subscriptions.length === 0 && (
            <EmptyState icon={Webhook} title="No webhook endpoints" description="Add one to get notified as envelopes move." />
          )}
          {subscriptions.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-6">URL</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead className="hidden sm:table-cell">Added</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {subscriptions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="max-w-56 pl-6">
                      <p className="truncate font-mono text-xs" title={s.url}>
                        {s.url}
                      </p>
                      {!s.active && <StatusBadge label="Paused" tone="neutral" className="mt-1" />}
                    </TableCell>
                    <TableCell className="max-w-48 text-xs whitespace-normal text-muted-foreground">
                      {s.eventTypes === null ? "all events" : s.eventTypes.join(", ")}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">{formatRelative(s.createdAt)}</TableCell>
                    <TableCell className="pr-4">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label="Delete">
                            <Trash2 />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete this endpoint?</AlertDialogTitle>
                            <AlertDialogDescription>
                              {s.url} stops receiving events. Deliveries already queued for it are dropped.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              onClick={async () => {
                                try {
                                  await api.deleteWebhook(s.id);
                                  toast.success("Endpoint deleted.");
                                  await refresh();
                                } catch (err) {
                                  toast.error(err instanceof Error ? err.message : String(err));
                                }
                              }}
                            >
                              Delete endpoint
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>

      <Dialog open={createdSecret !== null} onOpenChange={(open) => !open && setCreatedSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-4" /> Signing secret (shown once)
            </DialogTitle>
            <DialogDescription>Copy it now — it will not be shown again. Use it to verify incoming requests.</DialogDescription>
          </DialogHeader>
          <code className="block rounded-md bg-muted p-3 font-mono text-xs break-all">{createdSecret}</code>
          <DialogFooter>
            <CopyButton value={createdSecret ?? ""} label="Copy secret" />
            <Button onClick={() => setCreatedSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
