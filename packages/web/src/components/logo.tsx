import { cn } from "@/lib/utils";

/** The FineSign mark: a pen stroke over a signature line. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-7", className)}>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path
        d="M9 22.5c2.6-.2 4.3-1.7 5.6-4.6l3.9-8.4 3.4 1.6-3.9 8.4c-1.3 2.9-3.2 4.4-5.9 4.9"
        fill="none"
        className="stroke-primary-foreground"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8 25h16" className="stroke-primary-foreground" strokeWidth="2" strokeLinecap="round" opacity=".55" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <LogoMark />
      <span className="text-base">FineSign</span>
    </span>
  );
}
