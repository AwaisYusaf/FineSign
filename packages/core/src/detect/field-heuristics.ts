/**
 * Name-based heuristics that classify a form field as a SIGNER's signature line,
 * a signer's "date signed" field, or someone else's (witness / representative /
 * POA / examiner). Pure string logic over a field name or tooltip.
 *
 * These are heuristics, not a controlled vocabulary — they will occasionally
 * miss (e.g. "i_certify") or over-match. Treat their output as a strong default
 * a human can correct, not gospel. The "signer" is the party completing the
 * form for themselves; tune the deny list for your own domain.
 */

/** Parties who are NOT the primary signer — their signature fields are excluded. */
const NON_SIGNER_TOKENS = [
  "witness",
  "representative",
  "examiner",
  "attorney",
  "power_of_attorney",
  "poa",
  "notary",
  "official",
] as const;

/** Prefixes that mark a non-signer party at the START of a field name. */
const NON_SIGNER_PREFIXES = [
  "witness_",
  "representative_",
  "examiner_",
  "physician_",
  "doctor_",
  "official_",
  "notary_",
] as const;

function normalize(key: string): string {
  return key.toLowerCase().trim().replace(/[\s\-.]+/g, "_");
}

export function isNonSignerParty(key: string): boolean {
  const k = normalize(key);
  if (NON_SIGNER_PREFIXES.some((p) => k.startsWith(p))) return true;
  if (NON_SIGNER_TOKENS.some((t) => k.includes(t))) return true;
  return false;
}

/**
 * Matches `sign` / `signed` / `signature` as a WHOLE token (underscore- or
 * boundary-delimited) — deliberately NOT the "sign" inside as·sign·ment,
 * de·sign·ation, con·sign·ee, co·sign·er, so an unrelated field can't be
 * mistaken for a signing field.
 */
const SIGN_TOKEN = /(^|_)sign(ed|ature)?(_|$)/;
export function hasSignToken(key: string): boolean {
  return SIGN_TOKEN.test(normalize(key));
}

/**
 * The signing party's SIGNATURE line — has a sign token, is not a date field,
 * and is not a non-signer party.
 *
 * DATE PRECEDENCE: a key containing "date" is never a signature — this prevents
 * "signature_date" / "date_of_signature" from emitting BOTH a signature and a
 * date classification for the same box.
 */
export function isSignerSignatureField(key: string): boolean {
  const k = normalize(key);
  if (isNonSignerParty(k)) return false;
  if (k.includes("date")) return false;
  return hasSignToken(k);
}

/**
 * The "date signed" field beside the signature — a date field tied to signing,
 * not belonging to a non-signer party.
 */
export function isSignerDateField(key: string): boolean {
  const k = normalize(key);
  if (isNonSignerParty(k)) return false;
  return k.includes("date") && hasSignToken(k);
}
