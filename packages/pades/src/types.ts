import type { DigestAlgorithm } from "./oids";
import type { TimestampAuthority } from "./tsa";
import type { ValidationDataProvider } from "./validation-data";

/**
 * A signing credential — the private-key holder. `sign(tbs)` receives the exact
 * bytes to be signed (the DER-encoded SET OF signed attributes) and returns the
 * raw signature. This seam keeps the CMS assembly away from raw key material, so
 * a software key (P12), an HSM, or a cloud KMS all implement the same interface.
 */
export interface SigningCredential {
  /** The signer's certificate, DER-encoded. */
  certificate(): Uint8Array;
  /** The issuer chain (DER), leaf's issuer first; excludes the leaf itself. */
  chain(): Uint8Array[];
  /** Digest algorithm for the signature (SHA-256 minimum). */
  digestAlgorithm(): DigestAlgorithm;
  /** Signature scheme of the key. */
  signatureScheme(): "RSASSA-PKCS1-v1_5" | "ECDSA";
  /** Sign the to-be-signed bytes; returns the raw signature. */
  sign(tbs: Uint8Array): Promise<Uint8Array>;
  /** The certificate subject common name (for display/audit). */
  subjectCommonName(): string;
}

export type PadesLevel = "B-B" | "B-T" | "B-LT" | "B-LTA";

export interface SealOptions {
  /** Human-readable reason shown in the signature dictionary (e.g. "Completed"). */
  reason?: string;
  /** Location shown in the signature dictionary. */
  location?: string;
  /** Signer name shown in the signature dictionary. */
  name?: string;
  /** Signing time (injected for determinism). Defaults to now. */
  signingTime?: Date;
  /** Reserve this many bytes for the CMS in /Contents. Defaults to 16384 for
   *  B-B and 32768 for B-T (an RFC 3161 token adds a few KB). */
  signatureLength?: number;
  /** PAdES level (each builds on the previous): `"B-T"` embeds a signature
   *  timestamp; `"B-LT"` adds the DSS validation material; `"B-LTA"` adds a
   *  document timestamp. Defaults to `"B-B"`. */
  level?: PadesLevel;
  /** The TSA — REQUIRED for `"B-T"`, `"B-LT"`, and `"B-LTA"`. */
  timestampAuthority?: TimestampAuthority;
  /** The validation-data source — REQUIRED for `"B-LT"` and `"B-LTA"`. */
  validationDataProvider?: ValidationDataProvider;
}

/** A signature's revocation status from the embedded DSS material (B-LT+). */
export interface RevocationVerdict {
  checked: boolean;
  status: "good" | "revoked" | "unknown" | "not-checked";
  source: "crl" | "ocsp" | null;
  asOf: string | null;
}

/** One signature found in a PDF, with its verification verdict. */
export interface SignatureVerdict {
  /** 1-based index of the signature in the document. */
  index: number;
  /** A CAdES signature (`/Type /Sig`) or an RFC 3161 document timestamp
   *  (`/Type /DocTimeStamp`, `/SubFilter /ETSI.RFC3161` — B-LTA). */
  kind: "signature" | "document-timestamp";
  /** The strongest PAdES level this entry attests: B-B < B-T < B-LT < B-LTA. */
  level: PadesLevel;
  /** Cryptographic integrity: the CMS signature verifies over the ByteRange. */
  integrity: boolean;
  /** The signature covers the ENTIRE document — either nothing follows its
   *  ByteRange, or only legitimate DSS/DocTimeStamp incremental revisions do. */
  coversWholeDocument: boolean;
  /** The message-digest signed attribute matches the ByteRange digest. */
  digestMatches: boolean;
  /** The signing-certificate-v2 attribute matches the signer certificate. */
  signingCertMatches: boolean;
  /** The signer certificate chains to the configured trust store. */
  trusted: boolean;
  /** A trusted RFC 3161 timestamp is present and valid (B-T). */
  timestamp: { present: boolean; valid: boolean; time: string | null };
  /** Revocation status from the embedded DSS material (B-LT+). */
  revocation: RevocationVerdict;
  /** Signer certificate subject common name. */
  signerCommonName: string;
  /** Claimed signing time from the signed attribute (ISO), if present. */
  signingTime: string | null;
  /** Human-readable problems (empty when fully valid). */
  problems: string[];
}

export interface VerificationResult {
  /** True only if the document has ≥1 signature and ALL are integrity-valid,
   *  whole-document-covering, digest-matching, and cert-matching. */
  valid: boolean;
  /** The strongest fully-valid PAdES level attested across the document. */
  level: PadesLevel;
  /** The document-timestamp (B-LTA) verdict, if any. */
  documentTimestamp: { present: boolean; valid: boolean; time: string | null; coversDss: boolean };
  /** Number of signatures + document timestamps found. */
  signatureCount: number;
  signatures: SignatureVerdict[];
}
