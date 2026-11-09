import { CalendarDays, CaseSensitive, Signature, SquareCheck, Type, type LucideIcon } from "lucide-react";

import type { FieldKind } from "@/lib/types";

/** One icon per field kind, shared by the field editor and the signer page. */
export const FIELD_ICONS: Record<FieldKind, LucideIcon> = {
  signature: Signature,
  initials: CaseSensitive,
  date_signed: CalendarDays,
  text: Type,
  checkbox: SquareCheck,
};
