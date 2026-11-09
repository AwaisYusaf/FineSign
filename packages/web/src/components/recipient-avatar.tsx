import { initials, recipientColor } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Initials in the recipient's colour — the same colour as their fields. */
export function RecipientAvatar({ name, index, className }: { name: string; index: number; className?: string }) {
  const color = recipientColor(index);
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold", className)}
      style={{ backgroundColor: color.soft, color: color.text }}
    >
      {initials(name)}
    </span>
  );
}
