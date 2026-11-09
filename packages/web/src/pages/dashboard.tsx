import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ChevronLeft, ChevronRight, FileSignature, Plus, Search } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { ENVELOPE_STATUS, signingProgress } from "@/lib/status";
import type { Envelope, EnvelopeStatus } from "@/lib/types";

const PAGE_SIZE = 50;

const FILTERS: { value: string; label: string; statuses: EnvelopeStatus[] | null }[] = [
  { value: "all", label: "All", statuses: null },
  { value: "sent", label: "Out for signature", statuses: ["sent"] },
  { value: "draft", label: "Drafts", statuses: ["draft"] },
  { value: "completed", label: "Completed", statuses: ["completed"] },
  { value: "closed", label: "Closed", statuses: ["declined", "voided", "expired"] },
];

/** "to Alice Signer, Bob Counter +1" */
function recipientsLine(env: Envelope): string {
  const names = env.recipients.map((r) => r.name);
  if (names.length === 0) return "No recipients yet";
  return `to ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""}`;
}

export default function Dashboard() {
  const navigate = useNavigate();
  // Cursors of the pages behind this one: each is the last envelope id of the
  // page before. A cursor, not an offset — newest-first offsets shift with every
  // new envelope, repeating one across pages.
  const [cursors, setCursors] = useState<string[]>([]);
  const before = cursors.at(-1);
  const offset = cursors.length * PAGE_SIZE; // rows before this page (range label, first-page checks)
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const { data, isPending, error } = useQuery({
    queryKey: ["envelopes", before ?? "newest"],
    queryFn: () => api.listEnvelopes({ limit: PAGE_SIZE, before }),
  });

  const envelopes = useMemo(() => data ?? [], [data]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of FILTERS) c[f.value] = envelopes.filter((e) => !f.statuses || f.statuses.includes(e.status)).length;
    return c;
  }, [envelopes]);
  const visible = useMemo(() => {
    const statuses = FILTERS.find((f) => f.value === filter)?.statuses ?? null;
    const q = search.trim().toLowerCase();
    return envelopes.filter(
      (e) =>
        (!statuses || statuses.includes(e.status)) &&
        (!q ||
          e.title.toLowerCase().includes(q) ||
          e.recipients.some((r) => r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q)))
    );
  }, [envelopes, filter, search]);
  // The server caps a page, so a full page means there may be more.
  const hasMore = envelopes.length === PAGE_SIZE;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Envelopes</h1>
          <p className="text-sm text-muted-foreground">Everything you&apos;ve prepared or sent for signature.</p>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {!isPending && !error && envelopes.length === 0 && offset === 0 ? (
        <Card className="py-0">
          <EmptyState
            icon={FileSignature}
            title="No envelopes yet"
            description="Upload a PDF or Word document, add the people who need to sign, and send it in a couple of minutes."
            action={
              <Button asChild>
                <Link to="/new">
                  <Plus /> Create your first envelope
                </Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Tabs value={filter} onValueChange={setFilter} className="min-w-0">
              <TabsList className="max-w-full justify-start overflow-x-auto">
                {FILTERS.map((f) => (
                  <TabsTrigger key={f.value} value={f.value} className="gap-1.5">
                    {f.label}
                    <span className="rounded-full bg-muted-foreground/10 px-1.5 text-[11px] tabular-nums">{counts[f.value] ?? 0}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="relative sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search envelopes"
                placeholder="Search title or recipient"
                className="pl-8"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <Card className="gap-0 py-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Envelope</TableHead>
                  <TableHead className="hidden sm:table-cell">Status</TableHead>
                  <TableHead className="hidden md:table-cell">Progress</TableHead>
                  <TableHead className="hidden sm:table-cell">Created</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending &&
                  Array.from({ length: 4 }, (_, i) => (
                    <TableRow key={i}>
                      <TableCell className="pl-4">
                        <Skeleton className="h-4 w-48" />
                        <Skeleton className="mt-2 h-3 w-32" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Skeleton className="h-5 w-24 rounded-full" />
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Skeleton className="h-2 w-24" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Skeleton className="h-4 w-20" />
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  ))}
                {visible.map((env) => {
                  const status = ENVELOPE_STATUS[env.status];
                  const progress = signingProgress(env);
                  return (
                    <TableRow key={env.id} className="cursor-pointer" onClick={() => navigate(`/envelopes/${env.id}`)}>
                      <TableCell className="max-w-0 pl-4 sm:max-w-none">
                        <Link
                          to={`/envelopes/${env.id}`}
                          className="block truncate font-medium hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {env.title}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">{recipientsLine(env)}</p>
                        <StatusBadge label={status.label} tone={status.tone} className="mt-1.5 sm:hidden" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <StatusBadge label={status.label} tone={status.tone} />
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {env.status === "draft" || progress.total === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <div className="flex w-36 items-center gap-2">
                            <Progress value={(progress.done / progress.total) * 100} className="h-1.5" />
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {progress.done}/{progress.total}
                            </span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground sm:table-cell">{formatRelative(env.createdAt)}</TableCell>
                      <TableCell className="pr-3 text-muted-foreground">
                        <ChevronRight className="size-4" />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {!isPending && visible.length === 0 && (
              <p className="border-t px-4 py-10 text-center text-sm text-muted-foreground">
                {envelopes.length === 0 ? "No more envelopes." : "No envelopes match this view."}
              </p>
            )}
          </Card>

          {(offset > 0 || hasMore) && (
            <div className="flex items-center justify-end gap-2">
              <span className="mr-2 text-xs text-muted-foreground tabular-nums">
                {offset + 1}–{offset + envelopes.length}
              </span>
              <Button variant="outline" size="sm" disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
                <ChevronLeft /> Newer
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasMore}
                onClick={() => {
                  const last = envelopes.at(-1);
                  if (last) setCursors((c) => [...c, last.id]);
                }}
              >
                Older <ChevronRight />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
