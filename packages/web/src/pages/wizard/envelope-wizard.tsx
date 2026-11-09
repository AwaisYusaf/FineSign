import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import type { Envelope } from "@/lib/types";
import { cn } from "@/lib/utils";

import { DetailsStep } from "./details-step";
import { DocumentsStep } from "./documents-step";
import { FieldsStep } from "./fields-step";
import { RecipientsStep } from "./recipients-step";
import { ReviewStep } from "./review-step";
import { firstOpenStep, isStepKey, STEPS, stepReachable, type StepKey } from "./steps";

/**
 * Build an envelope in five steps. `/new` creates the draft; every later step
 * lives at `/envelopes/:id/edit?step=…`, so a draft can be left and resumed, and
 * a refresh never loses the sender's place.
 */
export default function EnvelopeWizard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { data: env, error, isPending } = useQuery({
    queryKey: ["envelope", id],
    queryFn: () => api.getEnvelope(id!),
    enabled: !!id,
  });

  const setEnvelope = (next: Envelope) => queryClient.setQueryData(["envelope", next.id], next);
  const requested = params.get("step");

  if (id && isPending) return <WizardSkeleton />;
  if (id && (error || !env)) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertDescription>{error?.message ?? "Envelope not found."}</AlertDescription>
      </Alert>
    );
  }
  // Only drafts can be edited; anything sent has its own page.
  if (env && env.status !== "draft") return <Navigate to={`/envelopes/${env.id}`} replace />;

  let step: StepKey = !env ? "details" : isStepKey(requested) ? requested : firstOpenStep(env);
  if (!stepReachable(step, env)) step = env ? firstOpenStep(env) : "details";

  const goTo = (next: StepKey) => setParams({ step: next });

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{env ? env.title : "New envelope"}</h1>
        <p className="text-sm text-muted-foreground">
          {env ? "Draft — changes are saved as you go." : "Send a document for signature in a few steps."}
        </p>
      </div>

      <Stepper current={step} env={env} onSelect={goTo} />

      {step === "details" && (
        <DetailsStep
          env={env}
          onCreated={(created) => {
            setEnvelope(created);
            navigate(`/envelopes/${created.id}/edit?step=documents`, { replace: true });
          }}
          onNext={() => goTo("documents")}
        />
      )}
      {step === "documents" && env && (
        <DocumentsStep env={env} onChange={setEnvelope} onBack={() => goTo("details")} onNext={() => goTo("recipients")} />
      )}
      {step === "recipients" && env && (
        <RecipientsStep env={env} onChange={setEnvelope} onBack={() => goTo("documents")} onNext={() => goTo("fields")} />
      )}
      {step === "fields" && env && (
        <FieldsStep env={env} onChange={setEnvelope} onBack={() => goTo("recipients")} onNext={() => goTo("review")} />
      )}
      {step === "review" && env && (
        <ReviewStep
          env={env}
          onBack={() => goTo("fields")}
          onSent={(sent) => {
            setEnvelope(sent);
            void queryClient.invalidateQueries({ queryKey: ["envelopes"] });
            navigate(`/envelopes/${sent.id}`);
          }}
        />
      )}
    </div>
  );
}

function Stepper({ current, env, onSelect }: { current: StepKey; env: Envelope | undefined; onSelect: (s: StepKey) => void }) {
  const currentIndex = STEPS.findIndex((s) => s.key === current);
  return (
    <nav aria-label="Steps">
      <ol className="flex items-center gap-2 overflow-x-auto pb-1">
        {STEPS.map((s, i) => {
          const done = i < currentIndex;
          const active = i === currentIndex;
          const reachable = stepReachable(s.key, env) && !(s.key === "details" && env === undefined && !active);
          return (
            <li key={s.key} className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                disabled={!reachable || active}
                onClick={() => onSelect(s.key)}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full py-1 pr-3 pl-1 text-sm font-medium transition-colors",
                  active && "bg-primary/10 text-primary",
                  !active && reachable && "text-foreground hover:bg-accent",
                  !active && !reachable && "text-muted-foreground"
                )}
              >
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border text-xs tabular-nums",
                    active && "border-primary bg-primary text-primary-foreground",
                    done && "border-success bg-success text-success-foreground"
                  )}
                >
                  {done ? <Check className="size-3.5" /> : i + 1}
                </span>
                {s.label}
              </button>
              {i < STEPS.length - 1 && <span aria-hidden="true" className="h-px w-6 bg-border" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function WizardSkeleton() {
  return (
    <div className="space-y-8">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-8 w-full max-w-2xl" />
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}
