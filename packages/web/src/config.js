// API base — empty string means same-origin (the Vite dev proxy forwards
// /api and /sign to the FineSign server). Override with VITE_API_BASE if the
// API is on another origin (and enable CORS on the server).
export const API_BASE = import.meta.env.VITE_API_BASE ?? "";

const API_KEY_STORAGE = "finesign_api_key";

export function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) ?? "";
}

export function setApiKey(key) {
  if (key) localStorage.setItem(API_KEY_STORAGE, key);
  else localStorage.removeItem(API_KEY_STORAGE);
}

export const SIGNATURE_FONTS = [
  { value: "great_vibes", label: "Great Vibes" },
  { value: "dancing_script", label: "Dancing Script" },
  { value: "pacifico", label: "Pacifico" },
  { value: "pinyon_script", label: "Pinyon Script" },
];

export const FIELD_KINDS = [
  { value: "signature", label: "Signature" },
  { value: "date_signed", label: "Date signed" },
  { value: "initials", label: "Initials" },
];
