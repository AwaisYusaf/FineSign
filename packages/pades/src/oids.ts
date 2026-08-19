/** Object identifiers used across CMS / PAdES construction (RFC 5652, RFC 5035,
 *  RFC 3161). Centralised so magic OID strings never scatter through the code. */
export const OID = {
  // PKCS#7 / CMS content types
  DATA: "1.2.840.113549.1.7.1",
  SIGNED_DATA: "1.2.840.113549.1.7.2",
  // CMS signed attributes
  CONTENT_TYPE: "1.2.840.113549.1.9.3",
  MESSAGE_DIGEST: "1.2.840.113549.1.9.4",
  SIGNING_TIME: "1.2.840.113549.1.9.5",
  // ESS signing certificate v2 (RFC 5035)
  SIGNING_CERTIFICATE_V2: "1.2.840.113549.1.9.16.2.47",
  // CAdES / RFC 3161 timestamp token as an unsigned attribute
  SIGNATURE_TIMESTAMP_TOKEN: "1.2.840.113549.1.9.16.2.14",
  // Digest algorithms
  SHA256: "2.16.840.1.101.3.4.2.1",
  SHA384: "2.16.840.1.101.3.4.2.2",
  SHA512: "2.16.840.1.101.3.4.2.3",
  // Signature algorithms
  RSA_ENCRYPTION: "1.2.840.113549.1.1.1",
  ECDSA_WITH_SHA256: "1.2.840.10045.4.3.2",
  ECDSA_WITH_SHA384: "1.2.840.10045.4.3.3",
  ECDSA_WITH_SHA512: "1.2.840.10045.4.3.4",
  EC_PUBLIC_KEY: "1.2.840.10045.2.1",
  // Weak/deprecated signature algorithms (rejected on verify)
  MD5_WITH_RSA: "1.2.840.113549.1.1.4",
  SHA1_WITH_RSA: "1.2.840.113549.1.1.5",
  ECDSA_WITH_SHA1: "1.2.840.10045.4.1",
  // RFC 3161 — id-ct-TSTInfo (the eContentType of a timestamp token).
  TST_INFO: "1.2.840.113549.1.9.16.1.4",
  // X.509 Extended Key Usage extension, and the id-kp-timeStamping purpose a TSA
  // certificate must carry (as its ONLY EKU, marked critical — RFC 3161 §2.3).
  EXT_KEY_USAGE: "2.5.29.37",
  KP_TIME_STAMPING: "1.3.6.1.5.5.7.3.8",
} as const;

export type DigestAlgorithm = "SHA-256" | "SHA-384" | "SHA-512";

export function digestOid(algo: DigestAlgorithm): string {
  return algo === "SHA-384" ? OID.SHA384 : algo === "SHA-512" ? OID.SHA512 : OID.SHA256;
}

/** Node crypto digest name for a `DigestAlgorithm`. */
export function nodeDigestName(algo: DigestAlgorithm): "sha256" | "sha384" | "sha512" {
  return algo === "SHA-384" ? "sha384" : algo === "SHA-512" ? "sha512" : "sha256";
}

/** The ECDSA signature-algorithm OID matching a digest (M2). */
export function ecdsaOid(algo: DigestAlgorithm): string {
  return algo === "SHA-384" ? OID.ECDSA_WITH_SHA384 : algo === "SHA-512" ? OID.ECDSA_WITH_SHA512 : OID.ECDSA_WITH_SHA256;
}

/** Map a digest-algorithm OID to a Node digest name, or null if weak/unknown. */
export function digestNameFromOid(oid: string): "sha256" | "sha384" | "sha512" | null {
  if (oid === OID.SHA256) return "sha256";
  if (oid === OID.SHA384) return "sha384";
  if (oid === OID.SHA512) return "sha512";
  return null;
}
