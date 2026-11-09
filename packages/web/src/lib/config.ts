import type { FieldKind, SignatureFont } from "@/lib/types";

/**
 * API base — empty means same-origin (the Vite proxy in dev, nginx in Docker).
 * Set VITE_API_BASE only if the API lives on another origin (and enable CORS).
 */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";

const API_KEY_STORAGE = "finesign_api_key";

/** The sender API key, kept in localStorage (empty when unavailable). */
export function readApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function writeApiKey(key: string): void {
  try {
    if (key) localStorage.setItem(API_KEY_STORAGE, key);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // Storage blocked (private mode): the key simply won't persist.
  }
}

/** The fonts finesign-core stamps typed signatures with; `family` matches index.css. */
export type SignatureScript = "Latin" | "Cyrillic";

export interface SignatureFontOption {
  value: SignatureFont;
  label: string;
  className: string;
  /** Writing systems the font finesign-core stamps with can draw (Latin includes
   *  accents and Vietnamese). The server checks every glyph and has the last
   *  word; this lets the dialog steer the signer before they submit. */
  scripts: SignatureScript[];
}

export const SIGNATURE_FONTS: SignatureFontOption[] = [
  { value: "great_vibes", label: "Great Vibes", className: "font-great-vibes", scripts: ["Latin", "Cyrillic"] },
  { value: "dancing_script", label: "Dancing Script", className: "font-dancing-script", scripts: ["Latin"] },
  { value: "pacifico", label: "Pacifico", className: "font-pacifico", scripts: ["Latin", "Cyrillic"] },
  { value: "pinyon_script", label: "Pinyon Script", className: "font-pinyon-script", scripts: ["Latin"] },
];

export const FIELD_KINDS: { value: FieldKind; label: string }[] = [
  { value: "signature", label: "Signature" },
  { value: "initials", label: "Initials" },
  { value: "date_signed", label: "Date signed" },
  { value: "text", label: "Text" },
  { value: "checkbox", label: "Checkbox" },
];

export const fieldKindLabel = (kind: FieldKind): string => FIELD_KINDS.find((k) => k.value === kind)?.label ?? kind;

/** Default size of a newly placed field, as fractions of the page. */
export const DEFAULT_FIELD_SIZE: Record<FieldKind, { w: number; h: number }> = {
  signature: { w: 0.24, h: 0.045 },
  initials: { w: 0.12, h: 0.045 },
  date_signed: { w: 0.16, h: 0.03 },
  text: { w: 0.24, h: 0.03 },
  checkbox: { w: 0.03, h: 0.022 },
};

/** Webhook event types a subscription can filter on (none selected = all). */
export const WEBHOOK_EVENT_TYPES = [
  "envelope_sent",
  "recipient_viewed",
  "recipient_signed",
  "recipient_declined",
  "envelope_completed",
  "envelope_voided",
  "envelope_expired",
] as const;
