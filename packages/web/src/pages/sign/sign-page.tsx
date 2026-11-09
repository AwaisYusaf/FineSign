import { useState } from "react";
import { useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";

import { SignerFrame } from "./signer-frame";
import { SigningRoom } from "./signing-room";
import { AccessCodeCard, CompletedCard, DeclinedCard, SignedCard, UnavailableCard } from "./status-cards";

type Outcome = { kind: "signed"; completed: boolean } | { kind: "declined" };

/** `/s/:token` — the public, token-authenticated signing page. */
export default function SignPage() {
  const { token = "" } = useParams();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const { data: session, error, isPending } = useQuery({
    queryKey: ["session", token],
    queryFn: () => api.getSession(token),
    retry: false,
    staleTime: Infinity, // one load per visit; signing state lives in the page
  });

  if (isPending) {
    return (
      <SignerFrame wide>
        <div className="space-y-4">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-96 max-w-full" />
          <Skeleton className="mx-auto aspect-[612/792] w-full max-w-[680px]" />
        </div>
      </SignerFrame>
    );
  }
  if (error || !session) {
    return (
      <SignerFrame>
        <UnavailableCard error={error} />
      </SignerFrame>
    );
  }
  const { recipient } = session;
  if (outcome) {
    return (
      <SignerFrame>
        {outcome.kind === "declined" ? (
          <DeclinedCard />
        ) : (
          <SignedCard name={recipient.name} role={recipient.role} completed={outcome.completed} />
        )}
      </SignerFrame>
    );
  }
  // The access code guards the finished package too, so it comes first.
  if (session.authRequired && !session.authenticated) {
    return (
      <SignerFrame>
        <AccessCodeCard token={token} onUnlocked={() => void queryClient.invalidateQueries({ queryKey: ["session", token] })} />
      </SignerFrame>
    );
  }
  if (session.status === "completed") {
    return (
      <SignerFrame>
        <CompletedCard session={session} token={token} />
      </SignerFrame>
    );
  }
  // Reopened after signing, while others still sign: nothing left to do here.
  if (recipient.status === "signed") {
    return (
      <SignerFrame>
        <SignedCard name={recipient.name} role={recipient.role} completed={false} />
      </SignerFrame>
    );
  }
  return (
    <SignerFrame wide>
      <SigningRoom
        session={session}
        token={token}
        onSigned={(status) => setOutcome({ kind: "signed", completed: status === "completed" })}
        onDeclined={() => setOutcome({ kind: "declined" })}
      />
    </SignerFrame>
  );
}
