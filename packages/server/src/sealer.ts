/**
 * Document sealing — the server-side wrapper that applies and verifies the
 * platform's cryptographic PAdES seal (P5). The `EnvelopeApp` depends on the
 * `DocumentSealer` interface; the composition root injects the PAdES-backed
 * implementation with the configured signing credential.
 *
 * When a `TimestampAuthority` is supplied the seal is PAdES-B-T (an RFC 3161
 * signature timestamp is embedded), and verification checks it — optionally
 * against a pinned TSA trust store.
 */
import {
  sealPdf,
  verifyPdf,
  type SigningCredential,
  type TimestampAuthority,
  type ValidationDataProvider,
  type PadesLevel,
  type VerificationResult,
} from "@finesign/pades";

export interface DocumentSealer {
  /** Apply a cryptographic seal over the whole PDF; returns the sealed bytes. */
  seal(pdfBytes: Uint8Array, opts?: { reason?: string }): Promise<Uint8Array>;
  /** Verify a (sealed) PDF against the platform trust store. */
  verify(pdfBytes: Uint8Array): Promise<VerificationResult>;
  /** The seal certificate subject common name (for display). */
  signerName(): string;
}

export interface PadesSealerOptions {
  /** RFC 3161 TSA. Required for B-T and above. */
  timestampAuthority?: TimestampAuthority;
  /** DER trust anchors for the TSA. When set, a timestamp is only reported
   *  valid if its TSA cert chains to one of these (else it is accepted on its
   *  own cryptographic merits). */
  tsaTrustStore?: Uint8Array[];
  /** Validation-data source — required for B-LT and B-LTA. */
  validationDataProvider?: ValidationDataProvider;
  /** Target PAdES level. Defaults to the strongest the wiring supports:
   *  B-LTA (TSA + provider) → B-LT → B-T (TSA only) → B-B. */
  level?: PadesLevel;
  /** Trust anchors for verification. Defaults to the seal certificate itself
   *  (direct trust). For a CA-issued leaf, pass the CA certificate(s). */
  trustStore?: Uint8Array[];
}

export class PadesDocumentSealer implements DocumentSealer {
  private readonly trustStore: Uint8Array[];
  private readonly tsa?: TimestampAuthority;
  private readonly tsaTrustStore?: Uint8Array[];
  private readonly provider?: ValidationDataProvider;
  private readonly level: PadesLevel;
  constructor(private readonly credential: SigningCredential, options: PadesSealerOptions = {}) {
    this.trustStore = options.trustStore ?? [credential.certificate()];
    this.tsa = options.timestampAuthority;
    this.tsaTrustStore = options.tsaTrustStore;
    this.provider = options.validationDataProvider;
    // Choose the strongest level the wiring supports unless one is pinned.
    this.level =
      options.level ??
      (this.tsa && this.provider ? "B-LTA" : this.tsa ? "B-T" : "B-B");
  }
  async seal(pdfBytes: Uint8Array, opts: { reason?: string } = {}): Promise<Uint8Array> {
    return sealPdf(pdfBytes, this.credential, {
      reason: opts.reason ?? "Agreement completed — sealed by FineSign",
      level: this.level,
      ...(this.tsa ? { timestampAuthority: this.tsa } : {}),
      ...(this.provider ? { validationDataProvider: this.provider } : {}),
    });
  }
  async verify(pdfBytes: Uint8Array): Promise<VerificationResult> {
    return verifyPdf(pdfBytes, {
      trustStore: this.trustStore,
      ...(this.tsaTrustStore ? { tsaTrustStore: this.tsaTrustStore } : {}),
    });
  }
  signerName(): string {
    return this.credential.subjectCommonName();
  }
}
