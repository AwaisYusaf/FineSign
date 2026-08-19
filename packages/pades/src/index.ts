/**
 * `@finesign/pades` — cryptographic PDF signatures to ETSI PAdES standards.
 * Seal a PDF with a detached CMS signature (PAdES-B-B), and independently verify
 * integrity, whole-document coverage, signed attributes, and trust.
 *
 * @packageDocumentation
 */
export type {
  SigningCredential,
  PadesLevel,
  SealOptions,
  SignatureVerdict,
  VerificationResult,
} from "./types";
export {
  LocalSigningCredential,
  generateSelfSignedCredential,
  generateSelfSignedTsaCredential,
  generateTestCa,
  certFromDer,
  commonNameFromCertDer,
  type CredentialParts,
  type TestCa,
} from "./credential";
export { sealPdf, augmentToBLt, lastContentsBytes } from "./sign";
export { augmentToBLta, type DocTimeStampOptions } from "./doctimestamp";
export {
  createInProcessValidationDataProvider,
  createHttpValidationDataProvider,
  revocationSourcesForCert,
  issueCrl,
  issueOcsp,
  type ValidationData,
  type ValidationDataProvider,
  type InProcessValidationOptions,
  type HttpValidationOptions,
  type ValidationFetch,
  type RevocationSource,
} from "./validation-data";
export { verifyPdf, type VerifyOptions } from "./verify";
export { buildCmsSignedData, type BuildCmsParams } from "./cms";
export {
  createInProcessTsa,
  createHttpTsa,
  signatureTimestampAttributes,
  type TimestampAuthority,
  type InProcessTsaOptions,
  type HttpTsaOptions,
  type TsaFetch,
  type TsaFetchResponse,
} from "./tsa";
export { OID, digestOid, nodeDigestName, type DigestAlgorithm } from "./oids";
