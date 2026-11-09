/** Small, dependency-free formatting helpers for dates, names and colours. */

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export const formatDateTime = (iso: string | null | undefined): string => (iso ? dateTime.format(new Date(iso)) : "—");
export const formatDate = (iso: string | null | undefined): string => (iso ? dateOnly.format(new Date(iso)) : "—");

/** "3 minutes ago", "in 6 days" — falls back to a date beyond a month. */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 30 * 86_400) return relative.format(Math.round(seconds / 86_400), "day");
  return dateOnly.format(new Date(iso));
}

/** "Jane Q. Public" → "JP". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/**
 * What a typed signature puts in an initials field: the first letter of every
 * word ("Jane Q. Public" → "JQP"). Must match the server's `initialsOf`
 * (packages/server/src/stamping.ts) so the preview shows what gets stamped.
 * Not `initials` above, which is an avatar's two letters.
 */
export function signatureInitials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/u)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toUpperCase();
  return letters || name;
}

/**
 * A stable colour per recipient position, used for their avatar AND their
 * fields on the page, so the sender can tell at a glance whose field is whose.
 */
const RECIPIENT_HUES = [262, 152, 24, 322, 200, 88];
export function recipientColor(index: number): { solid: string; soft: string; text: string } {
  const hue = RECIPIENT_HUES[((index % RECIPIENT_HUES.length) + RECIPIENT_HUES.length) % RECIPIENT_HUES.length];
  return {
    solid: `oklch(0.58 0.17 ${hue})`,
    soft: `oklch(0.58 0.17 ${hue} / 0.14)`,
    text: `oklch(0.42 0.14 ${hue})`,
  };
}

export const pluralize = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
