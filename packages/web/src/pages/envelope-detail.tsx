import { useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowLeft,
  BadgeCheck,
  Ban,
  Bell,
  ExternalLink,
  FileText,
  Loader2,
  Lock,
  PencilLine,
  RotateCw,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";

import { CopyButton } from "@/components/copy-button";
import { ReasonDialog } from "@/components/reason-dialog";
import { RecipientAvatar } from "@/components/recipient-avatar";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { api, certificateUrl, managementDocUrl, openAuthedPdf } from "@/lib/api";
import { formatDateTime, formatRelative, pluralize } from "@/lib/format";
import { describeEvent, ENVELOPE_STATUS, isSetupEvent, recipientStatus, ROLE_LABEL, signingProgress } from "@/lib/status";
import type { DevLink, Envelope, Recipient, Verification } from "@/lib/types";
import { cn } from "@/lib/utils";

type Verdict = { pending: true } | { error: string } | Verification;

export default function EnvelopeDetail() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const { data: env, error, isPending } = useQuery({
    queryKey: ["envelope", id],
    queryFn: () => api.getEnvelope(id),
    // While it's out, watch it progress (a cheap poll; no websocket needed).
    refetchInterval: (q) => (q.state.data?.status === "sent" ? 5000 : false),
  });
  const linksQuery = useQuery({
    queryKey: ["dev-links", id, env?.status, env?.audit.length],
    queryFn: () => api.devLinks(id),
    enabled: env?.status === "sent" || env?.status === "completed",
  });
  const [voidOpen, setVoidOpen] = useState(false);
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [nudging, setNudging] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const nudgingRef = useRef(false); // same, readable synchronously by a second click

  if (isPending) return <DetailSkeleton />;
  if (error || !env) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertDescription>{error?.message ?? "Envelope not found."}</AlertDescription>
      </Alert>
    );
  }

  const status = ENVELOPE_STATUS[env.status];
  const progress = signingProgress(env);
  const setEnvelope = (next: Envelope) => queryClient.setQueryData(["envelope", id], next);

  // One request at a time: each re-mints the signer's link, so a double-click
  // would send two emails and kill the link in the first one.
  async function nudge(r: Recipient, kind: "remind" | "resend") {
    if (nudgingRef.current) return;
    nudgingRef.current = true;
    setNudging(true);
    try {
      setEnvelope(kind === "remind" ? await api.remind(id, r.id) : await api.resend(id, r.id));
      toast.success(kind === "remind" ? "Reminder sent." : "Signing link re-sent.", {
        description: kind === "resend" ? `The previous link to ${r.name} no longer works.` : undefined,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      nudgingRef.current = false;
      setNudging(false);
    }
  }

  async function verify(documentId: string) {
    setVerdicts((v) => ({ ...v, [documentId]: { pending: true } }));
    try {
      const result = await api.verify(id, documentId);
      setVerdicts((v) => ({ ...v, [documentId]: result }));
    } catch (e) {
      setVerdicts((v) => ({ ...v, [documentId]: { error: e instanceof Error ? e.message : String(e) } }));
    }
  }

  async function open(url: string) {
    try {
      await openAuthedPdf(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  const canNudge = (r: Recipient) => env.status === "sent" && (r.status === "notified" || r.status === "viewed");
  const links = latestLinks(linksQuery.data?.links ?? []);

  return (
    <div className="space-y-6">
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Envelopes
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{env.title}</h1>
            <StatusBadge label={status.label} tone={status.tone} />
          </div>
          <p className="text-sm text-muted-foreground">
            From {env.senderName} · {env.routingType === "sequential" ? "Signers sign in order" : "Everyone signs at once"}
            {env.expiresAt && (
              <>
                {" · "}
                <span>
                  {env.status === "expired" ? "Expired" : "Expires"} {formatDateTime(env.expiresAt)}
                </span>
              </>
            )}
          </p>
          {env.voidedReason && <p className="text-sm text-muted-foreground">Voided: “{env.voidedReason}”</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {env.status === "draft" && (
            <Button asChild>
              <Link to={`/envelopes/${env.id}/edit`}>
                <PencilLine /> Continue editing
              </Link>
            </Button>
          )}
          {env.status === "completed" && (
            <Button variant="outline" onClick={() => open(certificateUrl(id))}>
              <ScrollText /> Certificate of completion
            </Button>
          )}
          {(env.status === "draft" || env.status === "sent") && (
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setVoidOpen(true)}>
              <Ban /> Void envelope
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Recipients</CardTitle>
              {progress.total > 0 && env.status !== "draft" && (
                <div className="flex items-center gap-3 pt-1">
                  <Progress value={(progress.done / progress.total) * 100} className="h-1.5 max-w-xs" />
                  <span className="text-xs text-muted-foreground">
                    {progress.done} of {progress.total} {env.status === "completed" ? "done" : "signed"}
                  </span>
                </div>
              )}
            </CardHeader>
            <CardContent className="px-0">
              <ul className="divide-y">
                {env.recipients.map((r, i) => {
                  const rs = recipientStatus(r, env);
                  return (
                    <li key={r.id} className="flex flex-wrap items-center gap-3 px-6 py-3" aria-label={`${r.name} <${r.email}>`}>
                      <RecipientAvatar name={r.name} index={i} />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                          {r.name}
                          {r.authMethod === "access_code" && (
                            <Lock className="size-3 text-muted-foreground" aria-label="Access code required" />
                          )}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {r.email} · {ROLE_LABEL[r.role]}
                          {env.routingType === "sequential" && ` · step ${r.routingOrder}`}
                        </p>
                        {r.declineReason && <p className="mt-1 text-xs text-destructive">Declined: “{r.declineReason}”</p>}
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <StatusBadge label={rs.label} tone={rs.tone} />
                        {(r.signedAt ?? r.viewedAt) && (
                          <span className="text-[11px] text-muted-foreground">{formatRelative(r.signedAt ?? r.viewedAt)}</span>
                        )}
                      </div>
                      {canNudge(r) && (
                        <div className="flex w-full justify-end gap-2 sm:w-auto">
                          <Button variant="outline" size="sm" disabled={nudging} onClick={() => nudge(r, "remind")}>
                            <Bell /> Remind
                          </Button>
                          <Button variant="outline" size="sm" disabled={nudging} onClick={() => nudge(r, "resend")}>
                            <RotateCw /> Resend link
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Documents</CardTitle>
              {env.status === "completed" && (
                <CardDescription>Each signed PDF carries the certificate of completion and a PAdES seal.</CardDescription>
              )}
            </CardHeader>
            <CardContent className="px-0">
              <ul className="divide-y">
                {env.documents.map((d) => (
                  <li key={d.id} className="space-y-2 px-6 py-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <FileText className="size-5 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{d.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {d.pageCount ? pluralize(d.pageCount, "page") : "PDF"}
                          {d.signedBlobKey && " · signed"}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => open(managementDocUrl(id, d.id))}>
                        <ExternalLink /> Open
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => verify(d.id)}>
                        <ShieldCheck /> Verify seal
                      </Button>
                    </div>
                    {verdicts[d.id] && <VerdictLine verdict={verdicts[d.id]!} />}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {links.length > 0 && (
            <Card className="border-dashed">
              <CardHeader>
                <CardTitle>Signer links (dev mode)</CardTitle>
                <CardDescription>
                  Shown because the server runs with <code className="text-xs">FINESIGN_DEV_EXPOSE_TOKENS=true</code>. In production,
                  recipients get these by email.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {links.map((l) => (
                  <div key={l.recipientId} className="flex flex-wrap items-center gap-2">
                    <span className="w-full text-sm font-medium sm:w-40 sm:truncate">{l.name}</span>
                    <a href={l.link} className="min-w-0 flex-1 truncate font-mono text-xs text-primary hover:underline">
                      {l.link}
                    </a>
                    <CopyButton value={l.link} />
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Sender</dt>
                <dd className="truncate">{env.senderEmail}</dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd>{formatDateTime(env.createdAt)}</dd>
                {env.sentAt && (
                  <>
                    <dt className="text-muted-foreground">Sent</dt>
                    <dd>{formatDateTime(env.sentAt)}</dd>
                  </>
                )}
                {env.completedAt && (
                  <>
                    <dt className="text-muted-foreground">Completed</dt>
                    <dd>{formatDateTime(env.completedAt)}</dd>
                  </>
                )}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
              <CardDescription>Tamper-evident: every event is hash-chained to the one before.</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="relative space-y-4 border-l pl-5">
                {[...env.audit]
                  .reverse()
                  .filter((e) => showSetup || !isSetupEvent(e) || env.status === "draft")
                  .map((e) => (
                  <li key={e.id} className="relative">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute top-1.5 -left-[25px] size-2 rounded-full ring-4 ring-card",
                        e.type === "envelope_completed" || e.type === "recipient_signed"
                          ? "bg-success"
                          : e.type === "recipient_declined" || e.type === "envelope_voided"
                            ? "bg-destructive"
                            : "bg-muted-foreground/40"
                      )}
                    />
                    <p className="text-sm">{describeEvent(e, env)}</p>
                    <p className="text-xs text-muted-foreground" title={formatDateTime(e.at)}>
                      {formatRelative(e.at)}
                    </p>
                  </li>
                ))}
              </ol>
              {env.status !== "draft" && env.audit.some(isSetupEvent) && (
                <Button variant="link" size="xs" className="mt-3 h-auto p-0" onClick={() => setShowSetup((v) => !v)}>
                  {showSetup ? "Hide draft setup" : `Show draft setup (${env.audit.filter(isSetupEvent).length} events)`}
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <ReasonDialog
        open={voidOpen}
        onOpenChange={setVoidOpen}
        title="Void this envelope?"
        description="Signing links stop working immediately and nobody can sign it any more. This can't be undone."
        reasonLabel="Reason (recorded in the audit trail)"
        confirmLabel="Void envelope"
        onConfirm={async (reason) => {
          setEnvelope(await api.void(id, reason));
          toast.success("Envelope voided.");
        }}
      />
    </div>
  );
}

/** One link per recipient: the newest (remind, resend and completion re-mint them). */
function latestLinks(links: DevLink[]): DevLink[] {
  const byRecipient = new Map<string, DevLink>();
  for (const l of links) byRecipient.set(l.recipientId, l);
  return [...byRecipient.values()];
}

function VerdictLine({ verdict }: { verdict: Verdict }) {
  if ("pending" in verdict) {
    return (
      <p className="flex items-center gap-1.5 pl-8 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Verifying…
      </p>
    );
  }
  if ("error" in verdict) {
    return <p className="pl-8 text-xs text-destructive">Could not verify: {verdict.error}</p>;
  }
  if (verdict.signatureCount === 0) {
    return (
      <p className="flex items-center gap-1.5 pl-8 text-xs text-muted-foreground">
        <ShieldQuestion className="size-3.5" /> Not sealed yet — no cryptographic signature.
      </p>
    );
  }
  return (
    <p className={cn("flex items-center gap-1.5 pl-8 text-xs", verdict.valid ? "text-success" : "text-destructive")}>
      {verdict.valid ? <BadgeCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
      {verdict.valid ? "Seal valid" : "Seal INVALID"} · PAdES {verdict.level} · {pluralize(verdict.signatureCount, "signature")}
      {verdict.documentTimestamp?.present && (
        <Badge variant="outline" className="ml-1">
          archive timestamp
        </Badge>
      )}
    </p>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-80" />
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </div>
  );
}
