import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/lib/status";
import { cn } from "@/lib/utils";

const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-primary/12 text-primary",
  success: "bg-success/15 text-success dark:text-success",
  warning: "bg-warning/20 text-warning-foreground dark:text-warning",
  danger: "bg-destructive/12 text-destructive",
};

const DOTS: Record<Tone, string> = {
  neutral: "bg-muted-foreground/60",
  info: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

/** A status pill: a coloured dot plus a plain-language label. */
export function StatusBadge({ label, tone, className }: { label: string; tone: Tone; className?: string }) {
  return (
    <Badge variant="secondary" className={cn("gap-1.5 border-transparent font-medium", TONES[tone], className)}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", DOTS[tone])} />
      {label}
    </Badge>
  );
}
