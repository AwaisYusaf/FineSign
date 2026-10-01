Verified all code and PKIjs APIs against the installed sources. Here is the blueprint.

---

# PAdES-B-T Implementation Blueprint — `@finesign/pades`

**Verified against installed code** (`packages/pades/src/*`) and `node_modules/pkijs/build/index.d.ts`. All line numbers below are real.

## Ground truth (what already exists — do not rebuild)

- `oids.ts:14` `SIGNATURE_TIMESTAMP_TOKEN = "1.2.840.113549.1.9.16.2.14"` ✅ present
- `oids.ts:30` `TST_INFO = "1.2.840.113549.1.9.16.1.4"` (id-ct-TSTInfo) ✅ present
- `cms.ts:60-62` `unsignedAttributes?: Attribute[]` param; `cms.ts:123-125` wraps as `new SignedAndUnsignedAttributes({ type: 1, attributes })` ✅ plumbing exists
- `cms.ts:108` `const signature = await credential.sign(tbs)` — the raw signature bytes are captured here and **reused** (not re-signed), so ECDSA nondeterminism is a non-issue as long as the imprint is taken from this same variable.
- `cms.ts:28` `derLess` and `cms.ts:37` `signingCertificateV2` are **private** — must be exported/lifted for the in-process TSA.
- `types.ts:24` `PadesLevel = "B-B" | "B-T"`; `types.ts:54` `timestamp: { present, valid, time }` verdict field ✅ declared, `verify.ts:150` hardcodes it to false.
- `verify.ts:119` `attr()` reads **signedAttrs only**; `verify.ts:209-211` computes `withinValidity` from `at`; `verify.ts:294` builds `CertificateChainValidationEngine` with **no checkDate**.
- `engine.ts:8` `ensureEngine()` — called in `verify.ts:326` but **not** on the sign path.
- `sign.ts:55` `signatureLength: options.signatureLength ?? 16384`.

**PKIjs API confirmed** (installed build):
- `MessageImprint`: fields `hashAlgorithm: AlgorithmIdentifier`, `hashedMessage: asn1js.OctetString`; `static create(hashAlgorithm: string, message: BufferSource, crypto?)`.
- `TimeStampReq`: `version:number, messageImprint, reqPolicy?:string, nonce?:asn1js.Integer, certReq?:boolean, extensions?`.
- `TimeStampResp`: `status: PKIStatusInfo, timeStampToken?: ContentInfo`; inherits `fromBER`; has `.verify()`.
- `TSTInfo`: `version, policy:string, messageImprint, serialNumber:asn1js.Integer, genTime:Date, accuracy?:Accuracy, ordering?:boolean, nonce?:asn1js.Integer, tsa?:GeneralName, extensions?`; `verify(params: {data:ArrayBuffer, notBefore?:Date, notAfter?:Date}): Promise<boolean>`.
- `PKIStatus` enum: `granted=0, grantedWithMods=1, rejection=2, waiting=3, revocationWarning=4, revocationNotification=5`.
- `Accuracy`: `seconds?, millis?, micros?`.
- `ExtKeyUsage`: `keyPurposes: string[]`.
- `Extension`: `extnID: string, critical: boolean, extnValue, get parsedValue` (auto-parses known extensions — EKU comes back as an `ExtKeyUsage`).
- `CertificateChainValidationEngine` ctor params include `checkDate: Date` (constructor field, **not** a `verify()` arg).
- Exported OID consts: `id_ExtKeyUsage = "2.5.29.37"`, `id_eContentType_TSTInfo = "1.2.840.113549.1.9.16.1.4"`.

---

## 1. OIDs to add to `oids.ts`

Two of the three already exist. Add only the EKU:

```ts
// Extended Key Usage (X.509)
EXT_KEY_USAGE: "2.5.29.37",
// id-kp-timeStamping — the ONLY EKU a TSA cert may carry, and it MUST be critical (RFC 3161 §2.3)
KP_TIME_STAMPING: "1.3.6.1.5.5.7.3.8",
```

- `id-ct-TSTInfo` = `OID.TST_INFO` (already `1.2.840.113549.1.9.16.1.4`, line 30).
- `id-aa-signatureTimeStampToken` = `OID.SIGNATURE_TIMESTAMP_TOKEN` (already `1.2.840.113549.1.9.16.2.14`, line 14).

No new digest/signature OIDs needed.

---

## 2. `TimestampAuthority` port + in-process TSA

### 2.1 Ports (new file `tsa.ts`)

```ts
export interface Clock { now(): Date; }
export const systemClock: Clock = { now: () => new Date() };

export interface TimestampAuthority {
  /** imprintDigest = ALREADY-hashed datum; hashAlgo = the digest that produced it.
   *  Returns a DER RFC 3161 TimeStampToken (a ContentInfo wrapping SignedData/id-ct-TSTInfo). */
  stamp(imprintDigest: Uint8Array, hashAlgo: DigestAlgorithm): Promise<Uint8Array>;
}
```

The port takes the **already-computed digest** (not raw bytes), so the caller in `cms.ts` decides the imprint hash and both TSA implementations (in-process, HTTP) are symmetric.

### 2.2 Prep: lift shared CMS helpers

Export `derLess` and `signingCertificateV2` from `cms.ts` (or move both into a new `cms-util.ts` imported by `cms.ts` and `tsa.ts`) — do **not** duplicate them, or SET-OF ordering / ESS binding can silently diverge.

### 2.3 In-process TSA (`createInProcessTsa`)

Mirrors `buildCmsSignedData` with three deliberate differences: **eContent is ATTACHED**, `message-digest` is over the TSTInfo DER, and **SignedData.version = 3** (eContentType ≠ id-data).

```ts
import crypto from "crypto";
import * as asn1js from "asn1js";
import {
  TSTInfo, MessageImprint, Accuracy, GeneralName,
  ContentInfo, SignedData, SignerInfo, Attribute, SignedAndUnsignedAttributes,
  IssuerAndSerialNumber, AlgorithmIdentifier, EncapsulatedContentInfo, Certificate,
} from "pkijs";
import { OID, digestOid, ecdsaOid, nodeDigestName, type DigestAlgorithm } from "./oids";
import { derLess, signingCertificateV2 } from "./cms";     // lifted
import { ensureEngine } from "./engine";

export interface InProcessTsaOptions {
  credential: SigningCredential;      // TSA key+cert (critical id-kp-timeStamping EKU)
  clock: Clock;
  policyOid?: string;
  serial?: () => Uint8Array;          // inject for deterministic tests
  accuracySeconds?: number;
}

export function createInProcessTsa(o: InProcessTsaOptions): TimestampAuthority {
  const policy = o.policyOid ?? "1.3.6.1.4.1.99999.1"; // private test policy OID
  let counter = 0n;
  const nextSerial = o.serial ?? (() => { counter += 1n; return new Uint8Array([0x00, Number(counter & 0xffn)]); });

  return { async stamp(imprintDigest, hashAlgo) {
    ensureEngine();                                       // MessageImprint/SignedData not used async here, but keep parity
    const tsaDig = o.credential.digestAlgorithm();
    const certDer = o.credential.certificate();
    const cert = Certificate.fromBER(certDer);
    const chain = o.credential.chain().map((d) => Certificate.fromBER(d));

    // messageImprint: build MANUALLY (do NOT use MessageImprint.create — we already hold the digest).
    // SHA-2 hashAlgorithm params ABSENT (RFC 5754), so pass only algorithmId.
    const messageImprint = new MessageImprint({
      hashAlgorithm: new AlgorithmIdentifier({ algorithmId: digestOid(hashAlgo) }),
      hashedMessage: new asn1js.OctetString({ valueHex: imprintDigest }),
    });

    const tstInfo = new TSTInfo({
      version: 1,
      policy,
      messageImprint,
      serialNumber: new asn1js.Integer({ valueHex: nextSerial() }),
      genTime: o.clock.now(),                              // injected clock — never new Date()
      accuracy: new Accuracy({ seconds: o.accuracySeconds ?? 1 }),
      ordering: false,
      tsa: new GeneralName({ type: 4, value: cert.subject }), // directoryName [4]
    });
    const eContent = new Uint8Array(tstInfo.toSchema().toBER(false));

    // signed attrs OVER the eContent VALUE octets (the TSTInfo DER)
    const md = crypto.createHash(nodeDigestName(tsaDig)).update(Buffer.from(eContent)).digest();
    const attrs: Attribute[] = [
      new Attribute({ type: OID.CONTENT_TYPE, values: [new asn1js.ObjectIdentifier({ value: OID.TST_INFO })] }),
      new Attribute({ type: OID.MESSAGE_DIGEST, values: [new asn1js.OctetString({ valueHex: md })] }),
      new Attribute({ type: OID.SIGNING_CERTIFICATE_V2, values: [signingCertificateV2(certDer, cert)] }),
    ];
    const sorted = attrs.map((a) => ({ a, enc: new Uint8Array(a.toSchema().toBER(false)) }))
                        .sort((x, y) => derLess(x.enc, y.enc)).map((x) => x.a);
    const signedAttrs = new SignedAndUnsignedAttributes({ type: 0, attributes: sorted });
    const tbs = new Uint8Array(signedAttrs.toSchema().toBER(false));
    tbs[0] = 0x31;                                         // [0] IMPLICIT (0xA0) → SET OF (0x31)
    const signature = await o.credential.sign(tbs);

    const isEc = o.credential.signatureScheme() === "ECDSA";
    const si = new SignerInfo({
      version: 1,
      sid: new IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
      digestAlgorithm: new AlgorithmIdentifier({ algorithmId: digestOid(tsaDig) }),
      signedAttrs,
      signatureAlgorithm: new AlgorithmIdentifier({
        algorithmId: isEc ? ecdsaOid(tsaDig) : OID.RSA_ENCRYPTION,
        ...(isEc ? {} : { algorithmParams: new asn1js.Null() }),
      }),
      signature: new asn1js.OctetString({ valueHex: signature }),
    });

    const sd = new SignedData({
      version: 3,                                          // 3 because eContentType ≠ id-data
      digestAlgorithms: [new AlgorithmIdentifier({ algorithmId: digestOid(tsaDig) })],
      encapContentInfo: new EncapsulatedContentInfo({
        eContentType: OID.TST_INFO,
        eContent: new asn1js.OctetString({ valueHex: eContent }), // ATTACHED
      }),
      certificates: [cert, ...chain],                      // certReq semantics: TSA cert IS in the token
      signerInfos: [si],
    });

    const token = new ContentInfo({ contentType: OID.SIGNED_DATA, content: sd.toSchema(true) });
    return new Uint8Array(token.toSchema().toBER(false));
  }};
}
```

### 2.4 TSA credential — critical `id-kp-timeStamping` EKU

Add `generateSelfSignedTsaCredential` in `credential.ts` alongside `generateSelfSignedCredential` (line 158). Only the extension set and clock-driven validity change:

```ts
cert.validity.notBefore = clock.now();
cert.validity.notAfter  = new Date(clock.now().getTime() + days * 864e5);
cert.setExtensions([
  { name: "basicConstraints", cA: false, critical: true },
  { name: "keyUsage", digitalSignature: true, nonRepudiation: true, critical: true },
  { name: "extKeyUsage", timeStamping: true, critical: true }, // node-forge → 1.3.6.1.5.5.7.3.8, EXACTLY one EKU
]);
```

node-forge maps `timeStamping: true` to `1.3.6.1.5.5.7.3.8` and honors `critical: true`. Do not add any other EKU flag.

### 2.5 Injected-clock rule

`genTime` **must** come from `Clock.now()`; the in-process TSA and the TSA-cert validity window both take the injected clock. `new Date()`/`Date.now()` only appear at the non-deterministic top edge (`systemClock`). Tests inject a fixed clock + fixed `serial` for byte-reproducible fixtures.

---

## 3. HTTP RFC 3161 client (injectable fetch)

```ts
export interface HttpTsaOptions {
  url: string;
  fetchImpl?: typeof fetch;   // inject for tests
  reqPolicy?: string;
  nonce?: () => Uint8Array;   // inject for determinism
}
const posInt = (b: Uint8Array) => (b[0] & 0x80) ? new Uint8Array([0, ...b]) : b; // unsigned INTEGER
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export function createHttpTsa(o: HttpTsaOptions): TimestampAuthority {
  const doFetch = o.fetchImpl ?? fetch;
  const mkNonce = o.nonce ?? (() => new Uint8Array(crypto.randomBytes(16)));
  return { async stamp(imprintDigest, hashAlgo) {
    ensureEngine();
    const nonce = posInt(mkNonce());
    const req = new TimeStampReq({
      version: 1,
      messageImprint: new MessageImprint({
        hashAlgorithm: new AlgorithmIdentifier({ algorithmId: digestOid(hashAlgo) }),
        hashedMessage: new asn1js.OctetString({ valueHex: imprintDigest }),
      }),
      ...(o.reqPolicy ? { reqPolicy: o.reqPolicy } : {}),
      certReq: true,                                       // REQUIRED: TSA embeds its cert in the token
      nonce: new asn1js.Integer({ valueHex: nonce }),
    });
    const res = await doFetch(o.url, {
      method: "POST",
      headers: { "Content-Type": "application/timestamp-query" },
      body: new Uint8Array(req.toSchema().toBER(false)),
    });
    if (!res.ok) throw new ValidationError(`TSA HTTP ${res.status}`);
    if (!(res.headers.get("content-type") ?? "").includes("application/timestamp-reply"))
      throw new ValidationError("TSA returned wrong content-type");

    const resp = TimeStampResp.fromBER(new Uint8Array(await res.arrayBuffer()));
    if (resp.status.status !== PKIStatus.granted && resp.status.status !== PKIStatus.grantedWithMods)
      throw new ValidationError(`TSA rejected (status ${resp.status.status})`);
    if (!resp.timeStampToken) throw new ValidationError("TSA response missing timeStampToken");

    // Validate echoed imprint + nonce BEFORE returning
    const sd  = new SignedData({ schema: resp.timeStampToken.content });
    const tst = new TSTInfo({ schema: asn1js.fromBER(sd.encapContentInfo.eContent!.valueBlock.valueHexView).result });
    if (!eq(new Uint8Array(tst.messageImprint.hashedMessage.valueBlock.valueHexView), imprintDigest))
      throw new ValidationError("TSA imprint mismatch");
    if (tst.nonce && !eq(new Uint8Array(tst.nonce.valueBlock.valueHexView), nonce))
      throw new ValidationError("TSA nonce mismatch");

    return new Uint8Array(resp.timeStampToken.toSchema().toBER(false)); // the ContentInfo/TimeStampToken DER
  }};
}
```

The injected `fetchImpl` must expose `.ok`, `.status`, `.headers.get`, `.arrayBuffer()`.

---

## 4. Imprint computation + attaching the unsigned attribute in `cms.ts`

### 4.1 The imprint (load-bearing)

The signature-timestamp imprint is `hash(SignerInfo.signature VALUE octets)` — i.e. the raw `signature` `Uint8Array` at `cms.ts:108`, **not** the OCTET STRING TLV, **not** the signed attrs, **not** the ByteRange:

```ts
const tsHash: DigestAlgorithm = "SHA-256";
const imprint = crypto.createHash(nodeDigestName(tsHash)).update(Buffer.from(signature)).digest();
// NOT: new asn1js.OctetString({ valueHex: signature }).toBER()  ← wrong (prepends 04 LL)
```

### 4.2 The seam in `buildCmsSignedData`

The existing `unsignedAttributes: Attribute[]` param is supplied by the caller **before** the signature exists, so it cannot carry a signature-timestamp. Add a hook that runs **between line 108 and the SignerInfo build**:

```ts
export interface BuildCmsParams {
  content: Uint8Array;
  credential: SigningCredential;
  signingTime: Date;
  unsignedAttributes?: Attribute[];                                  // keep for other callers
  timestamp?: (signatureValue: Uint8Array) => Promise<Attribute[]>;  // NEW: B-T hook
}
```

Inside `buildCmsSignedData`, after `const signature = await credential.sign(tbs);` (line 108):

```ts
let extraUnsigned: Attribute[] = params.unsignedAttributes ?? [];
if (params.timestamp) {
  extraUnsigned = [...extraUnsigned, ...(await params.timestamp(signature))];
}
```

Then change the SignerInfo assembly (cms.ts:123-125) to use `extraUnsigned`:

```ts
...(extraUnsigned.length > 0
  ? { unsignedAttrs: new SignedAndUnsignedAttributes({ type: 1, attributes: extraUnsigned }) }
  : {}),
```

### 4.3 The B-T hook (builds the attribute)

```ts
async function signatureTimestampAttrs(tsa: TimestampAuthority, sig: Uint8Array): Promise<Attribute[]> {
  const tsHash: DigestAlgorithm = "SHA-256";
  const imprint = crypto.createHash(nodeDigestName(tsHash)).update(Buffer.from(sig)).digest();
  const tokenDer = await tsa.stamp(new Uint8Array(imprint), tsHash);
  return [ new Attribute({
    type: OID.SIGNATURE_TIMESTAMP_TOKEN,                 // 1.2.840.113549.1.9.16.2.14
    values: [ ContentInfo.fromBER(tokenDer).toSchema() ], // token IS a ContentInfo — embed its schema, unwrapped
  }) ];
}
```

Add `ensureEngine()` at the top of `buildCmsSignedData` (the sign path does not call it today; MessageImprint/SignedData async helpers used anywhere in the TSA path need it).

---

## 5. `sealPdf` B-T option surface

Extend `SealOptions` (types.ts:26):

```ts
export interface SealOptions {
  reason?: string; location?: string; name?: string;
  signingTime?: Date;
  signatureLength?: number;
  /** PAdES level. Default "B-B". "B-T" requires `timestampAuthority`. */
  level?: PadesLevel;
  /** RFC 3161 TSA used when level === "B-T". */
  timestampAuthority?: TimestampAuthority;
}
```

In `sign.ts`, thread the TSA into `PadesSigner` and pass the hook to `buildCmsSignedData`:

```ts
class PadesSigner extends Signer {
  constructor(private credential: SigningCredential, private signingTime: Date,
              private tsa?: TimestampAuthority) { super(); }
  async sign(content: Buffer): Promise<Buffer> {
    const cms = await buildCmsSignedData({
      content: new Uint8Array(content),
      credential: this.credential,
      signingTime: this.signingTime,
      ...(this.tsa ? { timestamp: (sig) => signatureTimestampAttrs(this.tsa!, sig) } : {}),
    });
    return Buffer.from(cms);
  }
}
```

In `sealPdf`: if `options.level === "B-T"` require `options.timestampAuthority` (throw `ValidationError` if missing), pass it to `PadesSigner`, and **bump the default reserve** — the token adds ~1.5–8 KB, so default `signatureLength` to `32768` when `level === "B-T"` (still overridable). Export `createInProcessTsa`, `createHttpTsa`, `TimestampAuthority`, `Clock`, `systemClock`, `generateSelfSignedTsaCredential` from `index.ts`.

---

## 6. Verifier algorithm (`verify.ts`)

### 6.1 Options + helper

```ts
export interface VerifyOptions {
  trustStore?: Uint8Array[];
  tsaTrustStore?: Uint8Array[];   // NEW: separate anchor set for TSA roots
  at?: Date;
}

// sibling of attr() but for unsignedAttrs
function unsignedAttr(si: SignerInfo, type: string): unknown[] | null {
  const attrs = si.unsignedAttrs?.attributes ?? [];
  const found = attrs.find((a) => a.type === type);
  return found ? found.values : null;
}
```

### 6.2 Timestamp verification (new block in `verifyOne`, run **before** `withinValidity` at 209-211)

Wrap everything in try/catch — a malformed token yields `valid=false` + a `problems[]` entry, never a throw.

```ts
let tsGenTime: Date | null = null;
const tsVals = unsignedAttr(signerInfo, OID.SIGNATURE_TIMESTAMP_TOKEN);
if (tsVals?.[0]) {
  verdict.timestamp.present = true;
  try {
    // parse ContentInfo → SignedData
    const tsCi = new ContentInfo({ schema: tsVals[0] as object });
    if (tsCi.contentType !== OID.SIGNED_DATA) throw new Error("TST is not SignedData");
    const tstSd = new SignedData({ schema: tsCi.content });
    if (tstSd.encapContentInfo.eContentType !== OID.TST_INFO) throw new Error("TST eContentType is not id-ct-TSTInfo");

    // (a) verify the token's OWN CMS signature — ATTACHED, so DO NOT pass `data`
    const tv = await tstSd.verify({ signer: 0, extendedMode: true, checkChain: false });
    const tstSigOk = typeof tv === "boolean" ? tv : (tv as { signatureVerified?: boolean }).signatureVerified === true;
    if (!tstSigOk) problems.push("timestamp token signature is invalid");

    // (b) parse TSTInfo
    const eContent = tstSd.encapContentInfo.eContent!;
    const tstInfo = new TSTInfo({ schema: asn1js.fromBER(eContent.valueBlock.valueHexView).result });

    // reject weak imprint hash (reuse WEAK_DIGESTS, verify.ts:28)
    const impAlgo = tstInfo.messageImprint.hashAlgorithm.algorithmId;
    if (!digestNameFromOid(impAlgo) || WEAK_DIGESTS.has(impAlgo)) throw new Error(`weak timestamp imprint hash ${impAlgo}`);

    // (c) imprint MUST bind to the OUTER signature value octets. Exact-length copy.
    const sigBytes = new Uint8Array(signerInfo.signature.valueBlock.valueHexView);
    const imprintOk = await tstInfo.verify({ data: sigBytes.slice().buffer }); // hashes with the imprint's OWN algo
    if (!imprintOk) problems.push("timestamp messageImprint does not match the signature");

    // (d) TSA cert: exactly one EKU = id-kp-timeStamping, and CRITICAL (RFC 3161 §2.3)
    const tsaCerts = (tstSd.certificates ?? []).filter((c): c is Certificate => c instanceof Certificate);
    const tsaSigner = findSignerCert(tstSd, tstSd.signerInfos[0]); // reuse existing helper
    const ekuExt = tsaSigner?.extensions?.find((e) => e.extnID === OID.EXT_KEY_USAGE);
    const eku = ekuExt?.parsedValue as ExtKeyUsage | undefined; // pkijs auto-parses EKU
    const ekuOk = !!ekuExt && ekuExt.critical &&
                  eku?.keyPurposes.length === 1 && eku.keyPurposes[0] === OID.KP_TIME_STAMPING;
    if (!ekuOk) problems.push("TSA cert lacks a single critical id-kp-timeStamping EKU");

    // (e) optional: chain the TSA cert to tsaTrustStore, validated AS-OF genTime
    let tsaChainOk = true;
    if (options.tsaTrustStore?.length) {
      const trustedCerts = options.tsaTrustStore.map((d) => Certificate.fromBER(d));
      const engine = new CertificateChainValidationEngine({ trustedCerts, certs: tsaCerts, checkDate: tstInfo.genTime });
      const chain = await engine.verify();
      const path = (chain.certificatePath ?? []) as Certificate[];
      const leafIsTsaSigner = tsaSigner && path.length > 0 && reEncode(path[0]).equals(reEncode(tsaSigner));
      tsaChainOk = chain.result === true && !!leafIsTsaSigner;
      if (!tsaChainOk) problems.push("TSA certificate not trusted");
    }

    verdict.timestamp.valid = tstSigOk && imprintOk && ekuOk && tsaChainOk;
    verdict.timestamp.time  = tstInfo.genTime.toISOString();
    if (verdict.timestamp.valid) tsGenTime = tstInfo.genTime;
  } catch (e) {
    problems.push(`timestamp verification failed: ${(e as Error).message}`);
  }
}
```

### 6.3 Feed genTime into cert-validity (the point of B-T)

Replace the fixed `at` at `verify.ts:209-211` with an effective time that shifts to the **trusted** genTime only when the timestamp is valid, and reuse it as the chain `checkDate` at line 294:

```ts
const effectiveTime = tsGenTime ?? at;                 // never move the clock on an unverified timestamp
const withinValidity = effectiveTime >= notBefore && effectiveTime <= notAfter;
if (!withinValidity) problems.push("certificate was not valid at the (timestamped) signing time");
// ...
const engine = new CertificateChainValidationEngine({ trustedCerts, certs: chainCerts, checkDate: effectiveTime });
```

Imports to add in `verify.ts`: `TSTInfo, ExtKeyUsage` from `pkijs`, `* as asn1js from "asn1js"`, and `WEAK_DIGESTS` already exists (line 28).

---

## 7. Test plan

**In-process TSA round-trip**
- `createInProcessTsa` with fixed `clock` + fixed `serial`; `sealPdf(level:"B-T")`; `verifyPdf` with matching `trustStore` (signer) + `tsaTrustStore` (TSA root). Assert `timestamp.present === true`, `timestamp.valid === true`, `timestamp.time` equals the injected clock ISO.
- Determinism: two seals with identical injected clock/serial/signingTime produce byte-identical PDFs (RSA) — assert equality.
- Both RSA and EC signer credentials (EC signer path exercises the "reuse captured signature" property).

**Tamper cases (each must set `timestamp.valid=false` with a `problems[]` entry, no throw)**
- Flip one byte of the outer `SignerInfo.signature` after timestamping → imprint mismatch.
- Corrupt a byte inside the token's TSTInfo eContent → token CMS signature invalid.
- Re-imprint over the OCTET STRING TLV instead of the value octets (negative construction test) → mismatch, proving §4.1.
- TSA cert generated **without** the EKU, or with EKU **non-critical**, or with an extra EKU → EKU check fails.
- `tsaTrustStore` set to an unrelated root → chain untrusted.
- HTTP client: injected fetch returns `status: rejection(2)` with no token → throws `ValidationError`; returns mismatched nonce → throws; wrong content-type → throws.

**genTime-based validity**
- Signer cert with a short validity window; verify at an `at` **after** `notAfter` but with a valid timestamp whose `genTime` is **inside** the window → `withinValidity` true (B-T resurrects an otherwise-expired-at-verification signature).
- Same setup but with the timestamp **tampered** (invalid) → falls back to `at`, `withinValidity` false. Guards against forged-genTime clock-shift.

**OpenSSL / asn1 sanity check**
Extract `/Contents` hex from the sealed PDF, and dump the CMS:
```
openssl asn1parse -inform DER -in cms.der -i
```
Confirm the unsigned-attribute OID `1.2.840.113549.1.9.16.2.14`, a nested `SignedData` whose `eContentType` is `1.2.840.113549.1.9.16.1.4`, and (attached) an `OCTET STRING` carrying the TSTInfo. Verify the token independently:
```
openssl ts -reply -in token.der -text          # prints genTime, policy, messageImprint, TSA
openssl ts -verify -in token.der -queryfile req.tsq -CAfile tsa-root.pem
```

---

## 8. Ranked GOTCHAS

1. **Imprint input.** Hash the raw `signature` value octets (`cms.ts:108` `signature`; on verify `signerInfo.signature.valueBlock.valueHexView`), never the OCTET STRING TLV, never the signed attrs, never the ByteRange. Hashing `new OctetString({valueHex:signature}).toBER()` (prepends `04 LL`) is the classic wrong imprint and breaks Adobe/DSS/OpenSSL interop.
2. **Attached vs detached on verify.** The token SignedData is **attached** — call `tstSd.verify({ signer: 0, extendedMode: true })` **without** `data`. Passing `data` (as the outer detached CMS at `verify.ts:217` does) makes PKIjs treat it as detached and verification fails. This is the single most common B-T bug.
3. **The seam.** The existing `unsignedAttributes: Attribute[]` param is filled by the caller before `signature` exists — it cannot carry the timestamp. Add the `timestamp?: (sig) => Promise<Attribute[]>` hook that runs after `cms.ts:108`. Missing this makes the feature architecturally impossible.
4. **SignedData.version = 3** for the token (eContentType ≠ id-data). The B-B CMS correctly uses version 1; emitting 1 here is non-conformant.
5. **`certReq: true`** on `TimeStampReq`, else the TSA omits its cert and the token cannot be verified offline. On verify, recover the TSA cert from `tstSd.certificates`, not the document signer certs.
6. **Recompute imprint with the token's OWN `messageImprint.hashAlgorithm`**, not the signer's `digestAlgorithm` — the TSA may use SHA-512. Easiest: `tstInfo.verify({data})` reads it internally.
7. **`TSTInfo.verify()` is imprint-only.** It does NOT check the token's CMS signature. You must ALSO call `tstSd.verify({signer:0})`. Treating `TSTInfo.verify()===true` as full validity is a real hole.
8. **TSA cert EKU** must be **exactly** `{1.3.6.1.5.5.7.3.8}` AND **critical** (RFC 3161 §2.3). Checking "includes timeStamping" is too lax; reject extra EKUs or non-critical.
9. **`checkDate` is a constructor param** of `CertificateChainValidationEngine`, not a `verify()` argument (confirmed in the installed d.ts). Passing it to `verify()` silently does nothing. Use it (= effectiveTime/genTime) for both the TSA chain and the signer chain.
10. **Never move the clock on an unverified timestamp.** `effectiveTime = tsGenTime ?? at`, and set `tsGenTime` only when `timestamp.valid`. Otherwise a forged genTime revives an expired/revoked cert.
11. **Embed `resp.timeStampToken.toSchema()` unwrapped.** It is already a `ContentInfo`; do not double-wrap in another OctetString/SignedData, and do not embed the bare `TSTInfo` or the whole `TimeStampResp`.
12. **`ensureEngine()` on the sign path.** It's only called in `verify.ts` today; add it to `buildCmsSignedData` / TSA before any PKIjs async crypto or you get `Unable to create WebCrypto object`.
13. **Accept only `PKIStatus.granted(0)`/`grantedWithMods(1)`.** On other statuses `timeStampToken` is undefined and dereferencing throws.
14. **Unsigned SET OF ordering.** B-T adds exactly one unsigned attribute so ordering is moot now, but LT/LTA will add more — those must be DER-sorted (`derLess`) like the signed attrs at `cms.ts:95-98`.
15. **Positive INTEGERs.** Both the request `nonce` and the token `serialNumber` must be non-negative — prepend `0x00` when the high bit is set (`posInt` / the `"00"+hex` trick at `credential.ts:168`).
16. **SHA-2 imprint AlgorithmIdentifier params ABSENT** (RFC 5754) — build `MessageImprint` manually with only `algorithmId`. (RSA `signatureAlgorithm` still needs NULL params, as `cms.ts:120` already does.)
17. **`/Contents` reserve.** The token adds ~1.5–8 KB; bump `signatureLength` for B-T (default 32768) or `@signpdf` overflows the placeholder.
18. **Exact-length ArrayBuffer.** `valueHexView` may be an offset/oversized view — always `bytes.slice().buffer` before `verify({data})` or `asn1js.fromBER` (mirrors `verify.ts:216`), or trailing bytes poison the hash.
19. **Lift `derLess` + `signingCertificateV2`.** They're private in `cms.ts` (lines 28, 37); export/share them rather than duplicating, or the TSA's SET-OF ordering and ESS binding can diverge from the document builder.
20. **Determinism inputs.** Beyond `Clock`, inject `serial` (in-process TSA) and `nonce`/`fetchImpl` (HTTP client); any stray `crypto.randomBytes` defeats byte-reproducible fixtures.