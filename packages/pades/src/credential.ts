/**
 * Signing credentials — the private-key side of PAdES (P1).
 *
 * `LocalSigningCredential` holds a software key (from a PKCS#12/PFX file, from
 * PEM/DER parts, or freshly generated self-signed for dev/test) and signs with
 * Node's `crypto` — so raw key material never leaves this object and the CMS
 * builder only ever sees `sign(tbs)`. An HSM/KMS credential would implement the
 * same `SigningCredential` interface with a remote `sign`.
 */
import crypto, { KeyObject, webcrypto } from "crypto";
import forge from "node-forge";
import { Certificate } from "pkijs";
import { ValidationError } from "@finesign/shared";
import type { SigningCredential } from "./types";
import { type DigestAlgorithm, nodeDigestName } from "./oids";

function forgeToDer(cert: forge.pki.Certificate): Uint8Array {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return new Uint8Array(Buffer.from(der, "binary"));
}

/** Extract the subject Common Name from a DER certificate (via PKIjs). */
export function commonNameFromCertDer(der: Uint8Array): string {
  const cert = Certificate.fromBER(der);
  for (const tv of cert.subject.typesAndValues) {
    if (tv.type === "2.5.4.3") return String(tv.value.valueBlock.value);
  }
  return "";
}

export interface CredentialParts {
  privateKeyPem: string;
  certificateDer: Uint8Array;
  chainDer?: Uint8Array[];
  digest?: DigestAlgorithm;
}

export class LocalSigningCredential implements SigningCredential {
  private constructor(
    private readonly privateKey: KeyObject,
    private readonly certDer: Uint8Array,
    private readonly chainDer: Uint8Array[],
    private readonly digest: DigestAlgorithm,
    private readonly scheme: "RSASSA-PKCS1-v1_5" | "ECDSA",
    private readonly cn: string
  ) {}

  certificate(): Uint8Array {
    return this.certDer;
  }
  chain(): Uint8Array[] {
    return this.chainDer;
  }
  digestAlgorithm(): DigestAlgorithm {
    return this.digest;
  }
  signatureScheme(): "RSASSA-PKCS1-v1_5" | "ECDSA" {
    return this.scheme;
  }
  subjectCommonName(): string {
    return this.cn;
  }

  async sign(tbs: Uint8Array): Promise<Uint8Array> {
    // RSA → RSASSA-PKCS1-v1.5(digest); EC → ECDSA(digest) in DER — both are what
    // `crypto.sign(<digest>, data, key)` produces for the respective key type.
    const sig = crypto.sign(nodeDigestName(this.digest), Buffer.from(tbs), this.privateKey);
    return new Uint8Array(sig);
  }

  /** Build from PEM key + DER cert(s). */
  static fromParts(parts: CredentialParts): LocalSigningCredential {
    const key = crypto.createPrivateKey(parts.privateKeyPem);
    // Only RSA (PKCS#1 v1.5, per the rsaEncryption OID we emit) and EC (ECDSA)
    // are supported. Reject anything else rather than silently mislabelling it as
    // RSASSA-PKCS1-v1.5 (e.g. RSA-PSS or Ed25519 would produce a signature whose
    // algorithm mismatches the declared CMS OID, or crash at sign time).
    const kt = key.asymmetricKeyType;
    if (kt !== "rsa" && kt !== "ec") {
      throw new ValidationError(`unsupported signing key type "${kt}" (only RSA and EC are supported for PAdES)`);
    }
    const scheme = kt === "ec" ? "ECDSA" : "RSASSA-PKCS1-v1_5";
    return new LocalSigningCredential(
      key,
      parts.certificateDer,
      parts.chainDer ?? [],
      parts.digest ?? "SHA-256",
      scheme,
      commonNameFromCertDer(parts.certificateDer)
    );
  }

  /** Load from a PKCS#12 / PFX file (the standard way an org holds a signing key). */
  static fromPkcs12(
    p12: Uint8Array,
    passphrase: string,
    opts: { digest?: DigestAlgorithm } = {}
  ): LocalSigningCredential {
    let bag: forge.pkcs12.Pkcs12Pfx;
    try {
      const asn1 = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(p12).toString("binary")));
      bag = forge.pkcs12.pkcs12FromAsn1(asn1, passphrase);
    } catch (e) {
      throw new ValidationError(`could not open PKCS#12 (wrong passphrase, unsupported encryption, or corrupt file): ${(e as Error).message}`);
    }
    // NOTE: node-forge parses only RSA private keys from PKCS#12. An EC-key P12
    // therefore yields no key bag here and fails below with a clear message; full
    // EC-P12 support (via a PKI.js/OpenSSL loader) is tracked in the backlog.
    const keyBag =
      bag.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0] ??
      bag.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];
    if (!keyBag?.key) {
      throw new ValidationError(
        "PKCS#12 contains no readable private key (note: this loader supports RSA keys only; an EC-key PKCS#12 is not yet supported)"
      );
    }

    const certBags = bag.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
    const certs = certBags
      .map((b: forge.pkcs12.Bag) => b.cert)
      .filter((c): c is forge.pki.Certificate => Boolean(c));
    if (certs.length === 0) throw new ValidationError("PKCS#12 contains no certificate");

    // The leaf is the cert whose PUBLIC KEY corresponds to the private key —
    // matched by comparing the SPKI DER derived from the private key against each
    // cert's SPKI (works for RSA and EC certs); never blindly fall back to the
    // first cert (that can pick the CA in a CA-first bundle).
    const privateKeyPem = forge.pki.privateKeyToPem(keyBag.key);
    const keyObj = crypto.createPrivateKey(privateKeyPem);
    const keySpki = crypto.createPublicKey(keyObj).export({ type: "spki", format: "der" }) as Buffer;
    const leaf = certs.find((c: forge.pki.Certificate) => {
      try {
        const certSpki = crypto
          .createPublicKey(forge.pki.publicKeyToPem(c.publicKey))
          .export({ type: "spki", format: "der" }) as Buffer;
        return certSpki.equals(keySpki);
      } catch {
        return false;
      }
    });
    if (!leaf) throw new ValidationError("PKCS#12 has no certificate matching the private key");
    const chain = certs.filter((c: forge.pki.Certificate) => c !== leaf);

    return LocalSigningCredential.fromParts({
      privateKeyPem,
      certificateDer: forgeToDer(leaf),
      chainDer: chain.map(forgeToDer),
      digest: opts.digest,
    });
  }
}

interface SelfSignedOptions {
  commonName: string;
  organization?: string;
  days?: number;
  passphrase?: string;
  digest?: DigestAlgorithm;
  /** Certificate `notBefore` (injected for deterministic validity-window tests). */
  notBefore?: Date;
}

/** A node-forge X.509 extension descriptor (`{ name, critical?, ...flags }`);
 *  `setExtensions` is typed `any[]`, so we give the callers a checked shape. */
type ForgeExtension = { name: string; critical?: boolean } & Record<string, unknown>;

/** Shared self-signed cert + PKCS#12 builder. `extensions` distinguishes an
 *  ordinary signing cert from a TSA cert (id-kp-timeStamping EKU). */
function buildSelfSigned(
  opts: SelfSignedOptions,
  extensions: ForgeExtension[]
): { credential: LocalSigningCredential; pkcs12: Uint8Array; passphrase: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // A MINIMAL positive DER INTEGER serial: clear the top bit of the first byte so
  // it is positive without a leading 0x00 (a `00 xx` serial with xx's high bit
  // clear is non-minimal DER and is rejected by OpenSSL/Adobe). Keep it non-zero.
  const serialBytes = crypto.randomBytes(16);
  serialBytes[0] = (serialBytes[0] & 0x7f) || 0x01;
  cert.serialNumber = serialBytes.toString("hex");
  const notBefore = opts.notBefore ?? new Date();
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = new Date(notBefore.getTime() + (opts.days ?? 3650) * 24 * 3600 * 1000);
  const attrs = [
    { name: "commonName", value: opts.commonName },
    { name: "organizationName", value: opts.organization ?? "FineSign" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions(extensions);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const passphrase = opts.passphrase ?? "finesign";
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, { algorithm: "3des" });
  const pkcs12 = new Uint8Array(Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), "binary"));

  const credential = LocalSigningCredential.fromParts({
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificateDer: forgeToDer(cert),
    chainDer: [],
    digest: opts.digest,
  });
  return { credential, pkcs12, passphrase };
}

/**
 * Generate a self-signed RSA credential — for DEV/DEMO and tests only (a real
 * deployment loads an organizational/CA-issued cert). Returns the credential AND
 * a PKCS#12 export (so tests can exercise `fromPkcs12`).
 */
export function generateSelfSignedCredential(
  opts: SelfSignedOptions
): { credential: LocalSigningCredential; pkcs12: Uint8Array; passphrase: string } {
  return buildSelfSigned(opts, [
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
  ]);
}

/**
 * Generate a self-signed RSA credential for a Timestamp Authority — DEV/TEST
 * only (a real TSA cert is CA-issued). The cert carries EXACTLY ONE Extended Key
 * Usage, `id-kp-timeStamping`, marked CRITICAL, as RFC 3161 §2.3 requires; a
 * verifier that finds any other EKU (or a non-critical one) must reject the
 * timestamp. `basicConstraints`/`keyUsage` are also critical, matching real TSAs.
 */
export function generateSelfSignedTsaCredential(
  opts: SelfSignedOptions
): { credential: LocalSigningCredential; pkcs12: Uint8Array; passphrase: string } {
  return buildSelfSigned(opts, [
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true, critical: true },
    // node-forge maps `timeStamping` → 1.3.6.1.5.5.7.3.8 and honours `critical`.
    { name: "extKeyUsage", timeStamping: true, critical: true },
  ]);
}

/** Parse a DER certificate into a PKIjs `Certificate`. */
export function certFromDer(der: Uint8Array): Certificate {
  return Certificate.fromBER(der);
}

/** A WebCrypto private key, as produced by `webcrypto.subtle.importKey` — the
 *  type pkijs's CRL/OCSP `.sign()` require (avoids depending on lib.dom). */
export type WebCryptoKey = Awaited<ReturnType<typeof webcrypto.subtle.importKey>>;

/** Bridge a Node RSA private key (PEM) to a WebCrypto `CryptoKey`. pkijs's CRL /
 *  OCSP `.sign()` require a `CryptoKey` (the `SigningCredential.sign(tbs)` port
 *  cannot supply one), so a test CA that issues revocation material keeps its raw
 *  key and imports it here. */
async function toCryptoKey(privateKeyPem: string): Promise<WebCryptoKey> {
  const pkcs8 = crypto.createPrivateKey(privateKeyPem).export({ type: "pkcs8", format: "der" }) as Buffer;
  return webcrypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  ) as Promise<WebCryptoKey>;
}

/**
 * A test Certificate Authority — for DEV/TEST ONLY. It issues real CA→leaf
 * certificates (so revocation via CRL/OCSP is meaningful, unlike a self-signed
 * end-entity), and retains its raw key so it can sign CRLs/OCSP responses via
 * pkijs (`cryptoKey()`). A production deployment uses a real CA + `fromPkcs12`.
 */
export interface TestCa {
  /** The CA certificate, DER-encoded (a trust anchor for CA-issued leaves). */
  certificateDer(): Uint8Array;
  /** The CA private key as a WebCrypto `CryptoKey` (for pkijs CRL/OCSP `.sign()`). */
  cryptoKey(): Promise<WebCryptoKey>;
  /** The CA certificate parsed once (reused as the CRL/OCSP issuer). */
  pkijsCert(): Certificate;
  /** Issue a leaf credential signed BY THIS CA (chain = [leaf-issuer = CA]). */
  issueLeaf(opts: SelfSignedOptions): {
    credential: LocalSigningCredential;
    pkcs12: Uint8Array;
    passphrase: string;
    certificateDer: Uint8Array;
  };
}

/** Minimal-positive DER serial hex (see `buildSelfSigned`). */
function randomSerialHex(): string {
  const bytes = crypto.randomBytes(16);
  bytes[0] = (bytes[0] & 0x7f) || 0x01;
  return bytes.toString("hex");
}

export function generateTestCa(opts: SelfSignedOptions): TestCa {
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = randomSerialHex();
  const notBefore = opts.notBefore ?? new Date();
  caCert.validity.notBefore = notBefore;
  caCert.validity.notAfter = new Date(notBefore.getTime() + (opts.days ?? 3650) * 864e5);
  const caAttrs = [
    { name: "commonName", value: opts.commonName },
    { name: "organizationName", value: opts.organization ?? "FineSign" },
  ];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const caDer = forgeToDer(caCert);
  const caPem = forge.pki.privateKeyToPem(caKeys.privateKey);
  let ck: Promise<WebCryptoKey> | null = null;
  let parsed: Certificate | null = null;

  return {
    certificateDer: () => caDer,
    cryptoKey: () => (ck ??= toCryptoKey(caPem)),
    pkijsCert: () => (parsed ??= Certificate.fromBER(caDer)),
    issueLeaf(leafOpts: SelfSignedOptions) {
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const leaf = forge.pki.createCertificate();
      leaf.publicKey = keys.publicKey;
      leaf.serialNumber = randomSerialHex();
      const lb = leafOpts.notBefore ?? notBefore;
      leaf.validity.notBefore = lb;
      leaf.validity.notAfter = new Date(lb.getTime() + (leafOpts.days ?? 3650) * 864e5);
      leaf.setSubject([
        { name: "commonName", value: leafOpts.commonName },
        { name: "organizationName", value: leafOpts.organization ?? "FineSign" },
      ]);
      leaf.setIssuer(caCert.subject.attributes); // issuer == CA → a real chain
      // NOTE: no authorityKeyIdentifier — node-forge mis-derives its keyIdentifier
      // (it lacks the issuer-key context and hashes the LEAF's key, not the CA's),
      // which would break PKIjs's AKI→SKI issuer matching. Omitting the AKI lets
      // PKIjs fall back to name-based issuer matching (issuer DN == CA subject DN),
      // which is exact here. A real CA-issued cert carries a correct AKI.
      leaf.setExtensions([
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
      ]);
      leaf.sign(caKeys.privateKey, forge.md.sha256.create()); // signed BY the CA
      const leafDer = forgeToDer(leaf);
      const credential = LocalSigningCredential.fromParts({
        privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
        certificateDer: leafDer,
        chainDer: [caDer],
        digest: leafOpts.digest,
      });
      const passphrase = leafOpts.passphrase ?? "finesign";
      const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [leaf, caCert], passphrase, { algorithm: "3des" });
      const pkcs12 = new Uint8Array(Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), "binary"));
      return { credential, pkcs12, passphrase, certificateDer: leafDer };
    },
  };
}
