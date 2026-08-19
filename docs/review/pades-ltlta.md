# PAdES-B-LT / B-LTA — adversarial review + fixes

A 5-lens, 16-agent adversarial review of the long-term-validation code (the
hand-rolled incremental writer, DSS, coverage relaxation, revocation, and document
timestamp), with each finding independently verified. Lenses: coverage/append-attack,
incremental writer, revocation freshness, document-timestamp coverage, test-CA /
integration.

**9 findings confirmed; 8 fixed (each with a regression test), 1 deferred with a
documented follow-on.** Gate green (116 tests / 8 packages); OpenSSL independently
verifies every level (`cms -verify`, `crl -verify`, `ts -verify`).

## Fixed

### CRITICAL — a trusted document-timestamp made an untrusted signer's PDF `valid`
The `valid` aggregation required "some entity that is trusted covers the whole
document," evaluated over ALL entries — including the B-LTA **document timestamp**.
A document timestamp gets `trusted=true` when its TSA is anchored (chains to
`tsaTrustStore`). Since a public RFC 3161 TSA stamps any imprint for anyone, an
attacker could self-sign their own PDF (untrusted CAdES), append a DSS, timestamp
the whole file via the same public TSA, and the trusted timestamp alone satisfied
the clause → `valid=true`, `level=B-LTA` for a document the seal cert never signed.

**Fix** (`verify.ts verifyPdf`): the whole-document trust anchor must be a trusted
CAdES **signature** — `cmsSigs.some(s => s.trusted && s.coversWholeDocument)`. A
timestamp attests *time*, not *signer identity*; it only raises the *level* of an
already-trusted signature. Regression: `pades-ltlta.test.ts` (untrusted signer +
anchored document timestamp → `valid=false`).

### HIGH — overlay injection via a pre-planted dangling reference
`appendsAreBenign` allowed any newly-added object. An attacker could sign a document
whose render path carries a **dangling** indirect reference (e.g. a page
`/Annots [999 0 R]` with object 999 absent — renders blank), then append a benign-
looking revision that merely **defines** object 999 as an overlay annotation/XObject.
The object-diff saw it as a new object and coverage stayed `true`, yet a viewer
renders the overlay.

**Fix** (`verify.ts appendsAreBenign` + `renderReachable`): no object that becomes
**newly defined AND render-reachable** from the catalog graph (minus the `/DSS`
subtree) is allowed — the render-reachable object set must not gain a
newly-defined member. A still-dangling reference is harmless and does not trip it.
Regression: define object 9999 behind a pre-planted `/Annots [9999 0 R]` → coverage
breaks, `valid=false`.

### MEDIUM — un-anchored / partial-coverage document timestamp conferred B-LTA
`btaCovered` used the timestamp's crypto-validity, so a self-signed-TSA document
timestamp (valid on crypto merits, `trusted=false`) — or one whose ByteRange didn't
cover the whole file — could raise a signature to B-LTA. **Fix**: B-LTA now requires
the document timestamp to be **anchored-trusted** AND cover the whole document AND
cover the DSS (`v.trusted && v.coversWholeDocument && coversDss`).

### MEDIUM — revocation fail-open: CRL issuer taken from the attacker-supplied pool
The CRL issuer certificate was resolved from `dss.certs + CMS certs` by subject-DN
match, so an attacker could inject a fake CA with the same DN and make the genuine
revoking CRL fail to verify (→ `unknown`, stays trusted). **Fix** (`crlRevocationStatus`):
the CRL issuer is resolved ONLY from the TRUSTED anchors (`options.trustStore`), and
its signature is verified against that trusted cert.

### MEDIUM — revocation fail-open when the DSS/CRL is stripped
Because the DSS lives after the signature's ByteRange, stripping/swapping the CRL
keeps coverage true and yields `unknown` (still trusted). **Fix**: a new fail-closed
`requireRevocation` verify option treats any non-`good` status as untrusted. Default
off (a signature stays trusted on its chain when revocation is indeterminate); the
binding of B-LTA revocation material to the DocTimeStamp-protected DSS is a noted
follow-on.

### LOW — CRL with no `nextUpdate` treated as eternally fresh; first-match wins
A CRL lacking `nextUpdate` passed freshness forever, and the loop returned on the
first matching CRL — so a stale pre-revocation CRL placed first could report `good`.
**Fix**: a CRL without `nextUpdate` is skipped; across all usable CRLs a `revoked`
hit wins over a `good`.

### LOW — `FINESIGN_PADES_LEVEL` cast unvalidated / silent downgrade
**Fix** (`container.ts`): the env value is validated against the known set (throws on
a typo), and requesting B-LT/LTA on the PKCS#12 path (whose HTTP validation provider
is deferred) throws rather than silently downgrading to B-T.

## Deferred (documented follow-on)

### MEDIUM — the B-LTA document timestamp is written as an orphan object
`augmentToBLta` adds the `/DocTimeStamp` dict reachable only via the cross-reference
table, not linked into `/AcroForm /Fields`. FineSign's verifier finds it by scanning
`/ByteRange`, so verification is unaffected, and OpenSSL validates the token — but a
normalizing/garbage-collecting tool (or Adobe "Save As") could drop it. Linking it as
an AcroForm signature field requires relaxing the catalog-change check to also permit
an `/AcroForm` addition; tracked with the Adobe/EU-DSS external-conformance work.
