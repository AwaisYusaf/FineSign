I have verified all the load-bearing APIs against the installed code. Here is the implementation blueprint.

---

# PAdES-B-LT / B-LTA Implementation Blueprint (`@finesign/pades` + `@finesign/server`)

Grounded in the actual installed code:
- `packages/pades/src/{sign,verify,cms,tsa,credential,oids,engine,types,index}.ts` (read in full)
- `packages/server/src/{sealer,certificate}.ts`
- pdf-lib 1.17.1 (`node_modules/pdf-lib/cjs`), `@signpdf/*`, pkijs 3.x

Confirmed facts that shape everything below:
- `sealPdf` (sign.ts:64–75) does `PDFDocument.load` → `pdflibAddPlaceholder` → `pdfDoc.save({useObjectStreams:false})` → `signpdf.sign`. The `save()` is a **full rewrite** — usable for the *first* seal, fatal for any second revision. **pdf-lib has no incremental mode.**
- `SigningCredential` (types.ts:10) exposes only `sign(tbs)` over a private Node `KeyObject` (credential.ts:64). pkijs `CertificateRevocationList.sign` / `BasicOCSPResponse.sign` / `Certificate.sign` all require a **WebCrypto `CryptoKey`** — the port cannot drive them.
- `TimestampAuthority.stamp(imprintDigest, hashAlgo)` (tsa.ts:55) takes a pre-computed imprint and returns a **ContentInfo DER** (an RFC 3161 token). Directly reusable for the DocTimeStamp.
- `verifyTimestampToken` (verify.ts:200–304) already does token-sig + imprint + critical-single-EKU + as-of-genTime TSA trust. The only difference for a DocTimeStamp is the imprint data (`raw.signedContent` vs `signerInfo.signature`).
- `extractSignatures` (verify.ts:78–113) is **ByteRange-only / SubFilter-blind**, and `coversWholeDocument` (verify.ts:109) requires trailing bytes after `c+d` to be whitespace — so **any** incremental append flips it false. This is the single highest-risk regression.
- `octetStringValue` (cms.ts:42), `derLess` (cms.ts:30), `signingCertificateV2` (cms.ts:62), `ensureEngine` (engine.ts:8), `reEncode`/`findSignerCert`/`hasTimeStampingEku` (verify.ts) are all reusable.

---

## 1. Scope + honest testability

### What ships fully implemented AND tested OFFLINE (no live CA/TSA)
- **Hand-rolled PDF incremental-update writer** (new `incremental.ts`) — append-only, byte-preserving. Tested by asserting `output.subarray(0, original.length).equals(original)`.
- **Test PKI**: `generateTestCa` → `issueLeaf` (CA→leaf), CA holds a raw `CryptoKey`; CRL + BasicOCSPResponse issuance (empty / revoking) signed with the CA key.
- **DSS/VRI construction** for B-LT over a B-T seal, keyed by UPPERCASE-hex SHA-1 of `/Contents`.
- **B-LTA DocTimeStamp** via `createInProcessTsa` with an injected `Clock` — byte-reproducible.
- **Verifier**: DSS parse, offline chain+revocation at trusted time `T`, DocTimeStamp verification + DSS-coverage, augmented verdict (level / documentTimestamp / revocation).
- **Cross-tool sanity** with offline OpenSSL/qpdf/pdfsig (§9).

### What is SCAFFOLDED behind a port, pending live infra
- `createHttpValidationDataProvider` — real CRL-from-CDP / OCSP-from-AIA fetch. Interface + parsing shipped and unit-tested against **injected canned DER** (mirrors `createHttpTsa` + `TsaFetch`, tsa.ts:205–212). Live network deferred.
- `createHttpTsa` against a real public/CA TSA (already exists, unchanged).
- **External-conformance acceptance** (Adobe Acrobat / EU DSS validator reporting "LTV enabled / LTA"). Cannot be asserted by unit tests; staged as an integration follow-on.

### CA-hierarchy decision: **real CA→leaf (Option B) as default; self-signed (Option A) kept only as a structural compat shim**
Rationale: a CRL/OCSP is signed *by the issuer* attesting the *subject*. The current `generateSelfSignedCredential` (credential.ts:212) has `cA:false` and `chainDer:[]`, so issuer==subject — it can only "revoke itself," which Adobe/EU-DSS treat as non-conformant LTV. Option B also activates the already-present but currently-dead **chain-trust path** (verify.ts:493–517, `CertificateChainValidationEngine` with the `leafIsSigner` guard at verify.ts:509). Option A stays supported so the existing direct-trust `PadesDocumentSealer` (sealer.ts:43, `trustStore=[credential.certificate()]`) still emits a structurally-valid DSS, but it is flagged non-assuring (structural test only, never an assurance claim).

**Ship order: CRL-based B-LT first** (one signed object per issuer, no responder-identity/EKU/freshness machinery), **OCSP as a follow-on** — the research explicitly agrees, and both DER blobs slot into the same DSS buckets.

---

## 2. Phases (P6a → P6e) — ordered so the gate stays green at each step

Each phase is independently landable; the test suite (`verifyPdf` gate + OpenSSL cross-checks) must pass after every phase.

### P6a — Verifier hardening: DocTimeStamp classification + append-aware coverage (NO new writers yet)
**Goal:** teach the verifier that (a) a `/DocTimeStamp` ByteRange is not a broken document signature, and (b) well-formed incremental revisions after a signature's ByteRange are legitimate, not tampering. This must land FIRST so that when P6b/P6d start emitting revisions, the gate does not go red.

**Files:** `verify.ts`, `types.ts`.

**API surface:**
- `RawSig` gains `kind: 'signature' | 'document-timestamp'` and `contentsSha1Upper: string`.
- New coverage semantics: replace the absolute-EOF check with **"covers up to a later legitimate revision."** A signature is `coversWholeDocument` if `a===0` and every byte after `c+d` belongs to a subsequent well-formed incremental update (a revision that only adds DSS and/or DocTimeStamp objects). Implement by walking `startxref`/`%%EOF` markers: bytes after `c+d` up to the next `%%EOF` must parse as an xref+trailer with `/Prev`, and the added objects must be limited to DSS / DocTimeStamp shapes.

**Test that locks it:** take an *externally-fixed* golden B-LT/B-LTA byte fixture (or, once P6b lands, a produced one) and assert the underlying B-T signature reports `integrity && digestMatches && signingCertMatches && coversWholeDocument === true`. Until P6b exists, unit-test classification + coverage on a hand-built fixture buffer.

> Note: P6a and P6b are mutually bootstrapping. Land the *classification + coverage relaxation* logic in P6a using a synthetic fixture, then re-point its assertions at real P6b output.

### P6b — Incremental-update writer + DSS/VRI + B-LT (CRL only)
**Goal:** produce a valid B-LT file from a B-T seal by appending a DSS revision, byte-preserving the original.

**Files:** new `incremental.ts` (hand-rolled writer), new `dss.ts` (DSS/VRI builder), new `validation-data.ts` (port + in-process CRL provider), `credential.ts` (add `generateTestCa`/`issueLeaf`), `sign.ts` (add `augmentToBLt`), `oids.ts` (add CRL/AKI/CRLNumber OIDs), `index.ts` (exports).

**API surface:**
```ts
// incremental.ts
export interface IncrementalObject { ref: PDFRef; obj: PDFObject; }
export function appendIncrementalUpdate(
  original: Uint8Array,
  ctx: PDFContext,
  changed: IncrementalObject[],   // includes the re-emitted catalog under its SAME ref
  opts: { rootRef: PDFRef; idPair: [Uint8Array, Uint8Array]; prevStartxref: number }
): Uint8Array;

// validation-data.ts
export interface ValidationData { certs: Uint8Array[]; crls: Uint8Array[]; ocsps: Uint8Array[]; }
export interface ValidationDataProvider {
  collect(signerCertDer: Uint8Array, chainDer: Uint8Array[]): Promise<ValidationData>;
}

// sign.ts
export async function augmentToBLt(
  signedPdf: Uint8Array,
  provider: ValidationDataProvider
): Promise<Uint8Array>;
```

**Test that locks it:**
1. Byte-preservation: `bLt.subarray(0, bT.length).equals(bT)` (accounting for a possible single injected `0x0A`).
2. Re-parse: `PDFDocument.load(bLt)` succeeds; `catalog.lookup('DSS')` resolves; `/Certs`,`/CRLs`,`/VRI/<key>` resolve to injected DER.
3. `qpdf --check bLt.pdf` reports no errors.
4. `verifyPdf(bLt, {trustStore:[caDer]})` — B-T signature stays `integrity && coversWholeDocument === true`; `level === 'B-LT'`; `revocation.status === 'good'`.

### P6c — B-LT revocation semantics + OCSP provider (follow-on validation source)
**Goal:** enforce offline chain+revocation at `T`; add OCSP as a second material source.

**Files:** `verify.ts` (chain engine with `crls`/`ocsps`, freshness, fail-closed `noRevocation`), `validation-data.ts` (OCSP issuance), `oids.ts` (`KP_OCSP_SIGNING`, `AD_OCSP`, `PKIX_OCSP_BASIC`).

**API surface:** verifier internals only; `ValidationData.ocsps` now populated. No public API change beyond richer `SignatureVerdict.revocation`.

**Test that locks it:** good-CRL → chain `resultCode===0` (not `11 noRevocation`); revoking-CRL / `[1]` OCSP → `revocation.status==='revoked'`, `valid===false`; expired CRL (`nextUpdate < T`) → rejected by manual freshness; missing-material with `passedWhenNotRevValues:false` → surfaced as "missing revocation material".

### P6d — B-LTA DocTimeStamp writer
**Goal:** append a second `/DocTimeStamp` revision over the DSS-augmented file, reusing `TimestampAuthority`.

**Files:** new `doctimestamp.ts` (placeholder revision + signer), `sign.ts` (`augmentToBLta`), `index.ts`.

**API surface:**
```ts
export async function augmentToBLta(
  bLtPdf: Uint8Array,
  tsa: TimestampAuthority,
  opts?: { signatureLength?: number; hashAlgo?: DigestAlgorithm }
): Promise<Uint8Array>;
```

**Test that locks it:** second dict has `/Type /DocTimeStamp` + `/SubFilter /ETSI.RFC3161`; its `/Contents` is a `ContentInfo(SignedData/id-ct-TSTInfo)` whose `TSTInfo.verify({data: byteRangeBytes})` is true; ByteRange `[0,x,y,z]` with `z` reaching EOF; **regression:** the B-T signature still reports `integrity && coversWholeDocument true`; `level === 'B-LTA'`; `documentTimestamp.coversDss === true`.

### P6e — SealOptions + server wiring
**Goal:** expose `level: 'B-LT' | 'B-LTA'` on `sealPdf`; wire the provider + env into `PadesDocumentSealer`.

**Files:** `types.ts` (`PadesLevel`, `SealOptions`), `sign.ts` (`sealPdf` orchestration), `sealer.ts`, server composition root / container.

**Test that locks it:** `sealPdf(pdf, leaf, {level:'B-LTA', timestampAuthority, validationDataProvider})` end-to-end produces a file whose `verifyPdf(...).level==='B-LTA' && .valid===true`; `PadesDocumentSealer` with a configured provider+TSA yields the same.

---

## 3. Test-PKI additions to `credential.ts`

Extend the existing `buildSelfSigned` (credential.ts:169) pattern. The **CA must retain the raw key** and expose a WebCrypto `CryptoKey` (because pkijs `.sign()` needs it — the `SigningCredential` port cannot supply one).

```ts
import { webcrypto } from "crypto";

/** Bridge a Node RSA private key (PEM) to a WebCrypto CryptoKey for pkijs .sign(). */
async function toCryptoKey(privateKeyPem: string): Promise<CryptoKey> {
  const pkcs8 = crypto.createPrivateKey(privateKeyPem).export({ type: "pkcs8", format: "der" });
  return webcrypto.subtle.importKey(
    "pkcs8", pkcs8 as Buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, // EC: { name:"ECDSA", namedCurve:"P-256" }
    false, ["sign"],
  ) as Promise<CryptoKey>;
}

export interface TestCa {
  certificateDer(): Uint8Array;
  cryptoKey(): Promise<CryptoKey>;                 // for pkijs CRL/OCSP .sign()
  pkijsCert(): Certificate;                        // parsed once, reused as issuer
  issueLeaf(opts: SelfSignedOptions): {
    credential: LocalSigningCredential; pkcs12: Uint8Array; passphrase: string;
    certDer: Uint8Array;
  };
}

export function generateTestCa(opts: SelfSignedOptions): TestCa {
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  const serial = crypto.randomBytes(16); serial[0] = (serial[0] & 0x7f) || 0x01; // minimal positive (credential.ts:179)
  caCert.serialNumber = serial.toString("hex");
  const notBefore = opts.notBefore ?? new Date();
  caCert.validity.notBefore = notBefore;
  caCert.validity.notAfter = new Date(notBefore.getTime() + (opts.days ?? 3650) * 864e5);
  const caAttrs = [{ name: "commonName", value: opts.commonName }, { name: "organizationName", value: opts.organization ?? "FineSign" }];
  caCert.setSubject(caAttrs); caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());
  const caDer = forgeToDer(caCert);
  const caPem = forge.pki.privateKeyToPem(caKeys.privateKey);
  let ck: Promise<CryptoKey> | null = null;
  let parsed: Certificate | null = null;

  return {
    certificateDer: () => caDer,
    cryptoKey: () => (ck ??= toCryptoKey(caPem)),
    pkijsCert: () => (parsed ??= Certificate.fromBER(caDer)),
    issueLeaf(leafOpts) {
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const leaf = forge.pki.createCertificate();
      leaf.publicKey = keys.publicKey;
      const ls = crypto.randomBytes(16); ls[0] = (ls[0] & 0x7f) || 0x01;
      leaf.serialNumber = ls.toString("hex");
      const lb = leafOpts.notBefore ?? notBefore;
      leaf.validity.notBefore = lb;
      leaf.validity.notAfter = new Date(lb.getTime() + (leafOpts.days ?? 3650) * 864e5);
      leaf.setSubject([{ name: "commonName", value: leafOpts.commonName }, { name: "organizationName", value: leafOpts.organization ?? "FineSign" }]);
      leaf.setIssuer(caCert.subject.attributes);   // issuer == CA → real chain
      leaf.setExtensions([
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
        { name: "authorityKeyIdentifier", keyIdentifier: true },
        // prod-shaped hints (offline tests ignore): cRLDistributionPoints / AIA (raw ext, node-forge lacks named AIA)
      ]);
      leaf.sign(caKeys.privateKey, forge.md.sha256.create());   // signed BY THE CA
      const leafDer = forgeToDer(leaf);
      const credential = LocalSigningCredential.fromParts({
        privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
        certificateDer: leafDer, chainDer: [caDer], digest: leafOpts.digest,
      });
      const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [leaf, caCert], leafOpts.passphrase ?? "finesign", { algorithm: "3des" });
      const pkcs12 = new Uint8Array(Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), "binary"));
      return { credential, pkcs12, passphrase: leafOpts.passphrase ?? "finesign", certDer: leafDer };
    },
  };
}
```

**CRL issuance** (pkijs `CertificateRevocationList`; `version:1` == v2 so `revokedCertificates`/`crlExtensions` are legal):
```ts
async function issueCrl(caCert: Certificate, caKey: CryptoKey, revoked: Certificate[], now: Date, next: Date) {
  ensureEngine();
  const crl = new CertificateRevocationList({
    version: 1,
    issuer: caCert.subject,                              // reuse verbatim → issuer.isEqual holds
    thisUpdate: new Time({ type: 0, value: now }),       // type 0 = UTCTime
    nextUpdate: new Time({ type: 0, value: next }),
    revokedCertificates: revoked.map((c) => new RevokedCertificate({
      userCertificate: c.serialNumber,                   // reuse the parsed serial → DER matches
      revocationDate: new Time({ type: 0, value: now }),
    })),
  });
  // AKI (2.5.29.35) + CRLNumber (2.5.29.20), BOTH non-critical (RFC 5280 §5.2)
  await crl.sign(caKey, "SHA-256", getCrypto(true));     // NEVER the SHA-1 default; RSA ignores arg but pass anyway
  return new Uint8Array(crl.toSchema().toBER(false));    // default encodeFlag=false → re-parses signed tbsView
}
```

**Load-bearing gotchas locked in:**
- **`CryptoKey` requirement** for `crl.sign` / `basic.sign` / `cert.sign` — the whole reason the CA holds the raw key.
- For **RSASSA-PKCS1-v1_5 the hash is baked in at `importKey`**; `getSignatureParameters` ignores the `hashAlgorithm` arg. Import with `hash:'SHA-256'`.
- `crl.sign` **default is SHA-1** — always pass `"SHA-256"`.
- Serialize the signed CRL with **`crl.toSchema()` (default `encodeFlag=false`)**, not `toSchema(true)` (which re-encodes TBS and can diverge from signed bytes).
- `ensureEngine()` before any pkijs crypto (`getCrypto(true)` throws otherwise), exactly as tsa.ts:136.

---

## 4. `ValidationDataProvider` port + in-process impl + HTTP sketch

```ts
// validation-data.ts
export interface ValidationData { certs: Uint8Array[]; crls: Uint8Array[]; ocsps: Uint8Array[]; }
export interface ValidationDataProvider {
  collect(signerCertDer: Uint8Array, chainDer: Uint8Array[]): Promise<ValidationData>;
}

export interface InProcessValidationOptions {
  ca: TestCa;
  clock: Clock;                    // reuse @finesign/shared Clock, like InProcessTsaOptions (tsa.ts:109)
  validityDays?: number;           // nextUpdate window; default 7
  revoke?: (leafSerialHex: string) => boolean;   // test hook for the revoked case
}

export function createInProcessValidationDataProvider(o: InProcessValidationOptions): ValidationDataProvider {
  return {
    async collect(signerDer, chainDer) {
      ensureEngine();
      const leaf = Certificate.fromBER(signerDer);
      const caCert = o.ca.pkijsCert();
      const caKey = await o.ca.cryptoKey();
      const now = o.clock.now();
      const next = new Date(now.getTime() + (o.validityDays ?? 7) * 864e5);
      const isRevoked = o.revoke?.(Buffer.from(leaf.serialNumber.valueBlock.valueHexView).toString("hex")) ?? false;
      const crl = await issueCrl(caCert, caKey, isRevoked ? [leaf] : [], now, next);
      const ocsp = await issueOcsp(leaf, caCert, caKey, now, next, isRevoked);   // BasicOCSPResponse DER
      return { certs: [signerDer, ...chainDer], crls: [crl], ocsps: [ocsp] };
    },
  };
}
```

**OCSP issuance** (P6c) — `CertID.createForCertificate` guarantees the hashing the verifier re-derives; `good` is a **primitive [0]**, `revoked` a **constructed [1]**; embed the **BasicOCSPResponse** DER (iText/EU-DSS convention), not the OCSPResponse wrapper:
```ts
async function issueOcsp(leaf, caCert, caKey, now, next, revoked) {
  const basic = new BasicOCSPResponse();
  basic.tbsResponseData.responderID = caCert.subject;      // byName
  basic.tbsResponseData.producedAt  = now;                 // plain Date (SingleResponse.thisUpdate is Date too)
  const certID = new CertID();
  await certID.createForCertificate(leaf, { hashAlgorithm: "SHA-256", issuerCertificate: caCert });
  const sr = new SingleResponse({ certID });
  sr.certStatus = revoked
    ? new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 1 }, value: [ new asn1js.GeneralizedTime({ valueDate: now }) ] })
    : new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 }, lenBlockLength: 1 });
  sr.thisUpdate = now; sr.nextUpdate = next;
  basic.tbsResponseData.responses.push(sr);
  basic.certs = [caCert];                                   // needed for offline verify()
  await basic.sign(caKey, "SHA-256");                       // NEVER SHA-1 default
  return new Uint8Array(basic.toSchema().toBER(false));
}
```

**HTTP production sketch** (deferred behind the port, mirrors `createHttpTsa` tsa.ts:231 + `TsaFetch`):
```ts
export function createHttpValidationDataProvider(opts: { fetchImpl?: TsaFetch; maxBytes?: number }): ValidationDataProvider {
  return { async collect(signerDer, chainDer) {
    const leaf = Certificate.fromBER(signerDer);
    const issuer = Certificate.fromBER(chainDer[0]);
    // 1) CRL: read id-ce-cRLDistributionPoints (2.5.29.31) URL → GET → CertificateRevocationList.fromBER
    // 2) OCSP: read id-ad-ocsp AIA (1.3.6.1.5.5.7.48.1) URL → OCSPRequest(CertID.createForCertificate(leaf,{issuerCertificate:issuer}))
    //          → POST application/ocsp-request → OCSPResponse.fromBER → unwrap responseBytes.response (id-pkix-ocsp-basic)
    //          → BasicOCSPResponse → keep its DER
    // 3) certs: [signerDer, ...chainDer] + any AIA caIssuers intermediates
    // bound + content-type check exactly like tsa.ts:257-268
    return { certs: [signerDer, ...chainDer], crls: [/*…*/], ocsps: [/*…*/] };
  } };
}
```
Unit-test it by injecting a `fetchImpl` returning canned DER (same pattern the TSA client tests use).

---

## 5. DSS / VRI construction (incremental update that preserves the seal)

**pdf-lib is used READ-ONLY for the object model; the top-level writer is NOT used.** Never call `doc.save()` on an already-signed PDF.

### 5.1 Build the objects (reusing pdf-lib serialization)
```ts
// dss.ts
import { PDFDocument, PDFRef, PDFName, PDFDict, PDFArray, PDFRawStream } from "pdf-lib";

const doc = await PDFDocument.load(signedPdf, { ignoreEncryption: true });
const ctx = doc.context;
const catalogRef = ctx.trailerInfo.Root as PDFRef;         // existing, unchanged number+gen
const catalog = ctx.lookup(catalogRef, PDFDict);

const mkStream = (der: Uint8Array) => { const s = PDFRawStream.of(ctx.obj({}), der); return { s, ref: ctx.register(s) }; };
const certObjs = vd.certs.map(mkStream);
const crlObjs  = vd.crls.map(mkStream);
const ocspObjs = vd.ocsps.map(mkStream);                    // raw DER, uncompressed (matches DSS/PDFBox, OpenSSL-checkable)

// VRI key = UPPERCASE hex SHA-1 over the FULL hex-decoded /Contents (INCLUDING zero padding = raw.cmsDer)
const vriKey = crypto.createHash("sha1").update(contentsBytesIncludingPadding).digest("hex").toUpperCase();

const vriEntry = ctx.obj({ Type: "VRI",
  Cert: certObjs.map(o => o.ref), CRL: crlObjs.map(o => o.ref), OCSP: ocspObjs.map(o => o.ref) });
const vriEntryRef = ctx.register(vriEntry);
const vriMap = PDFDict.withContext(ctx);
vriMap.set(PDFName.of(vriKey), vriEntryRef);                // dynamic hex key set directly
const vriMapRef = ctx.register(vriMap);

const dss = ctx.obj({ Type: "DSS",
  Certs: certObjs.map(o => o.ref), CRLs: crlObjs.map(o => o.ref), OCSPs: ocspObjs.map(o => o.ref), VRI: vriMapRef });
const dssRef = ctx.register(dss);
catalog.set(PDFName.of("DSS"), dssRef);                     // mutate the EXISTING catalog in place
```

### 5.2 Hand-write the incremental section (`incremental.ts`)
Classic-xref append (the seal was written by `PDFWriter` with `useObjectStreams:false`, so it ends with `xref`/`trailer`/`startxref`/`%%EOF`):

1. If `original` does not end in `\n`, append one `0x0A` first (else `N G obj` merges into the `%%EOF` line).
2. Collect the changed set — **the re-emitted catalog under its SAME ref** plus every new stream/dict — and **sort ascending by `ref.objectNumber`** (`PDFCrossRefSection.addEntry` requires ascending order).
3. For each: record absolute start offset (`= originalLength(+1) + offsetWithinAppend`), write `"{num} {gen} obj\n"` + `obj.copyBytesInto(buf, off)` + `"\nendobj\n"`.
4. Write the xref at the current cursor. Build it with `PDFCrossRefSection.createEmpty()` + `addEntry(ref, absOffset)` (auto-splits the low catalog number and the high new-object block into correct subsections). Prepend the `0 1` free-head subsection.
5. Write `trailer\n<< /Size {ctx.largestObjectNumber+1} /Root {catRef} /Prev {prevStartxref} /ID [<id0> <id1>] >>\n`.
6. Write `startxref\n{xrefOffset}\n%%EOF\n`.

- `prevStartxref` = the integer from the **last** `startxref\s+(\d+)` in `original`.
- `/ID` = `ctx.trailerInfo.ID` **unchanged** (first element must stay identical across revisions).
- Do **not** call `ctx.enumerateIndirectObjects()` (that re-emits the whole document); serialize only your explicit `changed[]` list.

The final buffer = `original` (verbatim) ++ appended bytes.

---

## 6. B-LTA document timestamp (`doctimestamp.ts`)

Differences from B-T: imprint is over the **document ByteRange** (not a SignerInfo signature value); dict is `/Type /DocTimeStamp` + `/SubFilter /ETSI.RFC3161`; `/Contents` is the **bare** RFC 3161 ContentInfo (no extra CMS wrapping, no signed attrs).

**Do NOT reuse `pdflibAddPlaceholder`** — it hardcodes `Type:'Sig'`, writes `Reason/M/Name/Location`, and creates an AcroForm field `Signature1` that collides with the B-T field; and it forces a full `save()`. Hand-write the placeholder revision.

**Reuse `signpdf.sign`'s splice mechanics** (it's placeholder-agnostic — matches the literal `/**********` and `/Contents ` with trailing space):

1. Build the second incremental revision (via `incremental.ts`) whose one new object is:
   ```
   N 0 obj
   << /Type /DocTimeStamp /Filter /Adobe.PPKLite /SubFilter /ETSI.RFC3161
      /ByteRange [0 /********** /********** /**********]
      /Contents <0000…0000> >>
   endobj
   ```
   `/ByteRange` MUST precede `/Contents`. Reserve the hole (`signatureLength` default 32768, mirroring sealPdf). A DocTimeStamp needs **no** AcroForm/Widget linkage (Adobe recognizes it via `/Type /DocTimeStamp`), so the AcroForm object is not touched. Append xref/trailer(`/Prev`)/startxref/%%EOF so the tail follows `/Contents`.
2. Feed the buffer to `signpdf.sign(withPlaceholder, new DocTimeStampSigner(tsa, hashAlgo))`. signpdf resolves `[0, x, y, z]` (`z` reaches EOF, only gap = the Contents hole), removes the hole, hands the signer the ByteRange bytes, hex-encodes the return, and splices it back.

```ts
import { Signer } from "@signpdf/utils";
class DocTimeStampSigner extends Signer {
  constructor(private tsa: TimestampAuthority, private hashAlgo: DigestAlgorithm = "SHA-256") { super(); }
  async sign(content: Buffer): Promise<Buffer> {           // content === whole-file ByteRange bytes
    const imprint = crypto.createHash(nodeDigestName(this.hashAlgo)).update(content).digest();
    const tokenDer = await this.tsa.stamp(new Uint8Array(imprint), this.hashAlgo);  // ContentInfo DER, tsa.ts:55
    return Buffer.from(tokenDer);                           // verbatim into /Contents
  }
}
```

Reuse `createInProcessTsa` / `createHttpTsa` unchanged. Contrast tsa.ts:308 (`signatureTimestampAttributes` hashes the SignerInfo signature) — here we hash the document.

---

## 7. Verifier (`verify.ts` extensions)

### 7.1 Classify (P6a)
Extend `extractSignatures`: for each ByteRange match, slice the enclosing dict window (`text.lastIndexOf('<<', m.index)` → `m.index+m[0].length`) and set `kind='document-timestamp'` if `/SubFilter/ETSI.RFC3161` or `/Type/DocTimeStamp`. Compute `contentsSha1Upper = SHA1(cmsDer).toUpperCase()`.

### 7.2 DocTimeStamp path
For `kind==='document-timestamp'`, do NOT run the document-signature path. Refactor the inner body of `verifyTimestampToken` (verify.ts:210–299) into a shared helper and call it with the DocTimeStamp imprint data:
```ts
async function verifyRfc3161Token(tstSd: SignedData, imprintData: ArrayBuffer, opts: VerifyOptions, problems: string[])
  : Promise<{ valid: boolean; genTime: Date | null }>;
```
- `ContentInfo.fromBER(raw.cmsDer)` → assert `eContentType===OID.TST_INFO`.
- Retype `eContentType = OID.DATA` before `tstSd.verify({signer:0, extendedMode:true, checkChain:false})` (the same pkijs constructed-OCTET-STRING workaround at verify.ts:224).
- Parse TSTInfo via `octetStringValue` + `asn1js.fromBER` (verify.ts:230–234).
- `tst.verify({ data: new Uint8Array(raw.signedContent).buffer })` — imprint over the **ByteRange**, the one behavioral diff.
- `hasTimeStampingEku(tsaSigner)`; when `tsaTrustStore` set, chain the TSA cert as-of `genTime`.
- SHA-1 as a VRI key / pkijs matcher is exempt from `WEAK_DIGESTS`.

### 7.3 Trusted time `T` and level
```
T = docTsGenTime ?? sigTsGenTime ?? (options.at ?? new Date())
level = docTsValid ? 'B-LTA' : (dssPresent && sigTsValid ? 'B-LT' : (sigTsPresent ? 'B-T' : 'B-B'))
```
This generalizes the existing `effectiveTime` (verify.ts:402) to prefer archive time. Revocation freshness AND chain `checkDate` both use `T`, never `now`.

### 7.4 DSS parse
`PDFDocument.load(pdfBytes)`, `doc.catalog.lookup(PDFName.of('DSS'), PDFDict)`, walk `/Certs`,`/CRLs`,`/OCSPs` arrays → decode each `PDFRawStream` → `Certificate.fromBER` / `CertificateRevocationList.fromBER` / (OCSP: `OCSPResponse.fromBER` then unwrap `responseBytes.response` to `BasicOCSPResponse`, or parse directly as BasicOCSPResponse). Prefer `/VRI/<contentsSha1Upper>` material for this signature; fall back to top-level DSS. Guard every `fromBER` in try/catch and cap counts/sizes.

### 7.5 Offline chain + revocation
```ts
const engine = new CertificateChainValidationEngine({
  trustedCerts,                          // ONLY options.trustStore (DSS /Certs are NEVER anchors)
  certs: dedupeByDer([...cmsCerts, ...dssCerts]),
  crls: dssCrls, ocsps: dssOcsps,        // MUST be non-empty or revocation is silently skipped
  checkDate: T,
});
let chain;
try { chain = await engine.verify({ passedWhenNotRevValues: false }); }  // fail-closed
catch (e) { if ((e as any).code === 11) problems.push("missing revocation material for a certificate in the path"); }
```
Preserve the `leafIsSigner` guard (verify.ts:509): `path[0]` must `reEncode`-equal the signer cert. **pkijs does not check CRL/OCSP freshness** — assert manually: `crl.thisUpdate.value <= T && (!crl.nextUpdate || T <= crl.nextUpdate.value)`; same for OCSP `SingleResponse`. Report per-signature `{status, source, asOf}` using `crl.isCertificateRevoked(cert)` (after `crl.verify({issuerCertificate})`) / `basic.getCertificateStatus(cert, issuer)`.

### 7.6 B-LTA DSS coverage
After the DocTimeStamp token verifies and its imprint matches its own ByteRange `[a,b,c,d]`, require the DSS dict + its streams' byte span to lie within `[0, a+b)` (the pre-Contents region the DocTimeStamp signs). If the DSS was appended after the newest DocTimeStamp, `coversDss=false` → downgrade to B-LT. Chain multiple DocTimeStamps by `genTime`; the outermost supplies `T`.

### 7.7 Augmented verdict shape (`types.ts`)
```ts
interface SignatureVerdict {
  /* …existing… */
  kind: 'signature' | 'document-timestamp';
  level: 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';
  trustedTime: string | null;
  trustedTimeSource: 'archive' | 'signature-timestamp' | 'local';
  revocation: { checked: boolean; status: 'good'|'revoked'|'unknown'|'not-checked'; source: 'crl'|'ocsp'|null; asOf: string | null };
}
interface VerificationResult {
  valid: boolean; signatureCount: number;
  level: SignatureVerdict['level'];                                  // strongest fully-valid level
  documentTimestamp: { present: boolean; valid: boolean; time: string | null; coversDss: boolean };
  signatures: SignatureVerdict[];
}
```
**`verifyPdf.valid` (verify.ts:546) must branch on `kind`:** a document-timestamp contributes `{tokenValid && coversWholeDocument && coversDss}`; a signature contributes the existing `integrity && digestMatches && signingCertMatches` predicate. Keep the rule: ≥1 trusted whole-document-covering entity.

---

## 8. `sealPdf` / `SealOptions` API surface + server wiring

```ts
// types.ts
export type PadesLevel = "B-B" | "B-T" | "B-LT" | "B-LTA";
export interface SealOptions {
  /* …existing… */
  level?: PadesLevel;                             // B-LT/B-LTA build on B-T
  timestampAuthority?: TimestampAuthority;        // required for B-T, B-LT, B-LTA
  validationDataProvider?: ValidationDataProvider;// required for B-LT, B-LTA
}
```

`sealPdf` orchestration (sign.ts):
```ts
export async function sealPdf(pdfBytes, credential, options = {}) {
  const level = options.level ?? "B-B";
  if ((level === "B-LT" || level === "B-LTA") && !options.validationDataProvider)
    throw new ValidationError(`PAdES level "${level}" requires a validationDataProvider`);
  if (level !== "B-B" && !options.timestampAuthority)
    throw new ValidationError(`PAdES level "${level}" requires a timestampAuthority`);

  // 1) B-T seal (existing path)
  let out = await sealBt(pdfBytes, credential, options);          // current sealPdf body
  if (level === "B-B" || level === "B-T") return out;

  // 2) B-LT: DSS revision
  out = await augmentToBLt(out, options.validationDataProvider!); // certs = [leaf, ...credential.chain()]
  if (level === "B-LT") return out;

  // 3) B-LTA: DocTimeStamp revision
  return augmentToBLta(out, options.timestampAuthority!, { hashAlgo: credential.digestAlgorithm() });
}
```
`augmentToBLt` computes `contentsBytesIncludingPadding` by reusing `extractSignatures`' Contents extraction on `out` to key the VRI, and calls `provider.collect(credential.certificate(), credential.chain())`.

**Server wiring** (`sealer.ts` + container):
```ts
export interface PadesSealerOptions {
  timestampAuthority?: TimestampAuthority;
  tsaTrustStore?: Uint8Array[];
  validationDataProvider?: ValidationDataProvider;   // NEW
  level?: PadesLevel;                                // NEW, default derived
}
```
`seal()` chooses the level: `validationDataProvider && tsa` → `B-LTA` (or configurable `B-LT`); `tsa` only → `B-T`; else `B-B`. For Option B, set `this.trustStore = [ca.certificateDer()]` so the chain-trust path validates the CA-issued leaf; keep `[credential.certificate()]` for the Option A shim.

**Env** (composition root):
- `FINESIGN_PADES_LEVEL` = `B-B|B-T|B-LT|B-LTA`.
- `FINESIGN_VALIDATION_PROVIDER` = `inprocess|http`; when `http`, `FINESIGN_VALIDATION_HTTP_TIMEOUT_MS`, and CDP/AIA come from the certs themselves.
- Reuse existing TSA env for `timestampAuthority`.

---

## 9. OpenSSL / PDF validation commands (offline independent checks)

DSS CRL:
```
openssl crl  -inform DER -in dss-crl.der -noout -text
openssl crl  -inform DER -in dss-crl.der -CAfile ca.pem -noout -verify
```
DSS OCSP (BasicOCSPResponse — may need the wrapper for `openssl ocsp`; verify structure with asn1parse):
```
openssl asn1parse -inform DER -in dss-ocsp.der
openssl ocsp -respin dss-ocsp.der -CAfile ca.pem -issuer ca.pem -verify_other ca.pem -no_nonce
```
DSS certs:
```
openssl x509 -inform DER -in dss-cert.der -noout -text
```
Structural / xref-chain integrity of the incremental updates:
```
qpdf --check out.pdf
qpdf --show-xref out.pdf
```
DocTimeStamp token (extract the `/Contents` hex, hex-decode to `dts.der`):
```
openssl asn1parse -inform DER -in dts.der            # expect ContentInfo → SignedData → id-ct-TSTInfo
openssl ts -reply -in dts.der -token_in -text
openssl ts -verify -in dts.der -token_in -data byterange.bin -CAfile tsa-ca.pem
pdfsig out.pdf                                        # poppler: lists sig + DocTimeStamp, reports coverage
```
CMS of the underlying B-T seal (existing discipline):
```
openssl cms -verify -no_check_time -inform DER -in cms.der -content byterange.bin -CAfile ca.pem
```

---

## 10. Ranked GOTCHAS

1. **Byte-preservation is the whole ballgame.** Never `doc.save()` a signed PDF (full rewrite invalidates the B-T seal + any DSS). Both the DSS and the DocTimeStamp are hand-rolled append-only revisions over the untouched original buffer. Assert `out.subarray(0, prev.length).equals(prev)` in every phase.
2. **`coversWholeDocument` regression (verify.ts:109).** Any incremental append makes trailing bytes non-whitespace → the B-T signature reads as tampered and `verifyPdf.valid` flips false. P6a MUST relax coverage to "covers up to a later legitimate DSS/DocTimeStamp revision" before P6b/P6d emit anything.
3. **`CryptoKey` requirement.** pkijs `.sign()` cannot consume the `SigningCredential` port. The CA holds the raw key and `webcrypto.subtle.importKey('pkcs8', …)`. RSA hash is baked in at import (arg ignored); CRL/OCSP `.sign` default to **SHA-1** — always pass `"SHA-256"`.
4. **VRI key hashing.** UPPERCASE-hex SHA-1 over the **full hex-decoded `/Contents` including zero padding** (= `raw.cmsDer` as extracted at verify.ts:107). Do NOT strip padding — must match EU DSS / PDFBox, or reference validators silently ignore the VRI.
5. **`/Prev`, `/Size`, `/ID`.** `/Prev` = previous `startxref` offset; `/Size` = `largestObjectNumber+1` counting new objects; `/ID[0]` **unchanged** across revisions. Omitting/mis-setting any triggers Adobe/qpdf "repair" — which rewrites bytes and breaks the seal.
6. **CRL/OCSP validity windows.** pkijs checks neither freshness nor (for `isCertificateRevoked`) the signature. Verifier must independently assert `thisUpdate <= T <= nextUpdate` and run `crl.verify({issuerCertificate})`. `checkDate`/`T` = timestamp/archive time, never `now`.
7. **Revocation only runs if `crls.length||ocsps.length>0`** in `CertificateChainValidationEngine` (else silently skipped → looks "valid"). And `passedWhenNotRevValues:false` **throws** `noRevocation` (code 11) rather than returning false — special-case it as "missing revocation material."
8. **DocTimeStamp coverage + imprint.** Imprint is over the ByteRange bytes (`raw.signedContent`), not a SignerInfo signature value — reusing the token helper without swapping the imprint data validates the wrong thing. And B-LTA requires the DocTimeStamp to actually cover the DSS byte span (`dssEnd <= a+b`); a DSS appended after the newest DocTimeStamp downgrades to B-LT.
9. **ETSI ordering B-T → B-LT → B-LTA.** B-LT is built on a *completed* B-T seal (needs the B-T token present to key the VRI); B-LTA is built on a *completed* B-LT (the DocTimeStamp must cover the DSS). `sealPdf` must enforce this pipeline and reject `B-LT`/`B-LTA` without a TSA.
10. **Adobe conformance traps.** DocTimeStamp is `/Type /DocTimeStamp` (NOT `/Sig`), `/SubFilter /ETSI.RFC3161` (hardcode the literal — no `SUBFILTER_ETSI_RFC3161` constant in `@signpdf/utils`), bare RFC 3161 token in `/Contents` (no extra CMS wrapping, no AcroForm field). `/ByteRange` before `/Contents `; DSS streams stored as **uncompressed raw DER** (matches PDFBox/DSS and stays OpenSSL-checkable); DSS `/Certs` are path material only — **never** trust anchors (preserve the `leafIsSigner` guard).