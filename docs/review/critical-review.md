# FineSign Critical Review & DocuSign Parity Report

*Lead reviewer synthesis. Scope: robustness of the shipped engine + server, and gap analysis against DocuSign/Adobe Sign parity. Severities are the reviewer-corrected values. Findings are grouped CONFIRMED vs UNCERTAIN (unverified). All citations are repo-relative.*

---

## 1. Executive Summary

**State of robustness.** The cryptographic core is unusually strong in ambition and mostly correct: FineSign ships a genuinely standards-conformant **PAdES-B-B** signer (detached CMS, all four signed attributes, correct DER ordering) and a **rigorous independent verifier** (whole-document coverage, message-digest + signing-certificate-v2 binding, weak-algorithm rejection). The domain model is clean (draft→sent→completed state machine, hash-chained audit log, effect-based notifications). However, the product is **not yet production-robust**: there are concurrency defects that silently drop signatures, a verifier that produces false negatives on its own valid output, a trust-decoupling bug that can report forged documents as authentic, memory-exhaustion DoS vectors in both the image and DOCX paths, and multiple "completed" states that deliver unsigned/unsealed content.

**Top robustness risks (fix first):**
1. **Trust decoupled from signer** (`pades/src/verify.ts:285-292`) — chain-trust binds to the *last* cert in the CMS, not the actual signer. A forged, self-signed document can be reported `valid:true`. This defeats the platform's central promise.
2. **Two independent lost-update / double-sign races** (`server/src/app.ts:388`, `app.ts:298`) — no optimistic concurrency. Concurrent signatures either drop a recorded signature (envelope never completes/seals) or double-fire finalize (two certificates, two divergent sealed PDFs, duplicate emails).
3. **Verifier false negatives on genuine seals** — trailing-`0x00` stripping (`verify.ts:86`, ~1/256 of RSA seals), and `signatures.every(...)` failing on any stray `/ByteRange` literal (`verify.ts:322-325`). The core verification guarantee is non-deterministically broken.
4. **Unsealed content in "completed"/seal-required envelopes** (`server/src/app.ts:491`) — no-field documents are delivered raw even when `FINESIGN_SEAL_REQUIRED=true`, a fail-closed bypass.
5. **DoS via uploads** — PNG decompression bomb bypasses the guard at embed time (`core/src/engine/sign.ts:156`); DOCX conversion reads output unbounded (`convert/src/docx-libreoffice.ts:79`), orphans `soffice.bin` on timeout (`:76`), and parses untrusted DOCX with no network/macro isolation (`:62`); PDF parse path has no timeout/cap (`app.ts:175`).

**Biggest DocuSign parity gaps:**
- **No trusted timestamp (PAdES-B-T), no B-LT/B-LTA.** Signatures cannot be reliably dated; every sealed agreement's verification silently breaks when the seal cert expires (`verify.ts:203-206`). This is the single most impactful assurance gap.
- **Non-signature fields (text, checkbox, initials-as-value, radio, dropdown) are modeled but never captured or stamped.** Required text fields are silently skipped yet the envelope completes (`stamping.ts:102`, `envelope-service.ts:286`) — silent data loss on legal documents.
- **No ESIGN/UETA e-consent disclosure or consent capture**, and **no IP / user-agent / signer-identity capture** — the two artifacts that make DocuSign's Certificate of Completion legally load-bearing are absent.
- **No templates, no reminders, no envelope expiration, no resend, no correct/reassign, no webhooks.** These are table-stakes workflow/integration features.
- **No encryption at rest, no retention/erasure, no HSM/KMS signing adapter (software key only), no backup/DR story.**

---

## 2. Confirmed Findings by Module (ranked by corrected severity)

### 2.1 PAdES (`@finesign/pades`)

#### CONFIRMED

**[HIGH] Chain-trust decision decoupled from the actual signer** — `packages/pades/src/verify.ts:285-292`
In chain-trust mode the verifier builds/validates the chain from the *last* certificate in `SignedData.certificates`, not the cert that signed the SignerInfo. An attacker signs content with a self-signed key, then appends any legitimately-issued leaf (e.g. an unrelated TLS cert) that chains to the pinned root, ordered last. `directlyTrusted` is false, the chain branch picks the appended leaf, validates it to root, and returns `trusted=true` — a forged, self-signed document is reported authentic with attacker-chosen CN.
*Fix:* Pin the chain to `signerCert` (assert returned `path[0]` re-encodes equal to `signerCert`), or delegate to pkijs `sd.verify({ signer:0, checkChain:true, trustedCerts })` and drop the decoupled engine call.

**[HIGH] EC PKCS#12 credentials cannot be loaded despite "works for RSA and EC" claim** — `packages/pades/src/credential.ts:86-135`
node-forge is RSA-only; it silently drops EC key/cert material, so `LocalSigningCredential.fromPkcs12` throws `PKCS#12 contains no private key` for a valid EC P-256 seal cert. With `FINESIGN_SEAL_REQUIRED=true` this is a hard boot failure with a misleading message. Mixed RSA-leaf/EC-intermediate bundles lose the EC cert from the chain.
*Fix:* Parse PKCS#12 with an EC-capable library (PKI.js) or shell to Node crypto; or document RSA-only, remove the false "M3" comment, and reject EC P12 with a clear message. Add an EC round-trip test.

**[MEDIUM] Verifier strips trailing `0x00`, truncating ~1/256 of legitimate CMS** — `packages/pades/src/verify.ts:86`
A greedy zero-strip removes the genuine final `0x00` of an RSA signature along with @signpdf padding, shortening the ContentInfo below its declared length. `ContentInfo.fromBER` throws → `integrity=false` → `valid=false` for a self-produced, cryptographically valid seal. Empirically confirmed. ~0.4% non-deterministic false negative on the core guarantee.
*Fix:* Do not strip; pass the full hex-decoded buffer to `ContentInfo.fromBER` (asn1js reads the definite length and ignores padding), or slice exactly the outer TLV length. Add a regression test with a CMS ending in `0x00`.

**[MEDIUM] `valid` requires EVERY regex-discovered `/ByteRange` to be sound** — `packages/pades/src/verify.ts:322-325`
`extractSignatures` uses a global text regex, so a literal `/ByteRange [0 0 0 0]` in an uncompressed content stream, XMP, or Info string (e.g. FineSign's own PAdES docs) produces a second "signature" with `integrity=false`; `signatures.every(...)` then fails and an authentic seal verifies as invalid.
*Fix:* Parse real signature dictionaries via the AcroForm `/V` structure (`/Type /Sig`, real `/Contents`), or ignore matches whose gap is not a well-formed hex `/Contents`.

**[MEDIUM] Certificate validity evaluated at `now`, no timestamp/LTV — verification breaks at seal-cert expiry** — `packages/pades/src/verify.ts:203-206`
`at = new Date()` (`:149`); once `notAfter` passes, `withinValidity=false` propagates through both trust paths to `valid:false` for an authentic, unmodified document. Signing-time is display-only (`:262-266`) and the timestamp verdict is hard-coded absent (`:144`), so there is no fallback. Every previously sealed agreement silently fails at rollover.
*Fix:* Complete B-T (verify an RFC 3161 token) and evaluate cert/chain validity at the trusted timestamp. Until then, document the lifetime limitation and consider validating the leaf at signingTime absent a timestamp.

**[MEDIUM] Only PAdES-B-B produced; no RFC 3161 signature timestamp (B-T), no LTV** — `packages/pades/src/sign.ts:59`
No `unsignedAttrs`, no signature-timestamp token; the only time evidence is self-asserted signing-time + PDF `/M`. Strict validators cannot establish long-term validity; B-LT/B-LTA are impossible (no DSS dictionary, no archive timestamp).
*Fix:* Wire task #25 (id-aa-signatureTimeStampToken via the existing `unsignedAttributes` path), then plan B-LT (DSS OCSP/CRL/certs) and B-LTA (document timestamp).

**[MEDIUM] Non-EC keys unconditionally labeled RSASSA-PKCS1-v1_5 → OID/signature mismatch or crash** — `packages/pades/src/credential.ts:74`
An `rsa-pss` key yields a CMS declaring `rsaEncryption` but carrying PSS bytes (strict validators reject). An Ed25519 key passes load and crashes at `crypto.sign('sha256', …)`.
*Fix:* Derive scheme from the actual key type; reject anything other than `rsa`/`ec` at construction (fail fast at load).

**[LOW] All PKCS#12 parse failures reported as "wrong passphrase or corrupt file"** — `packages/pades/src/credential.ts:95-96` (corrected down from medium)
Algorithm-support failures (EC key, unsupported PBE) are misattributed to a passphrase/corruption problem; the real cause is only in the trailing appended message.
*Fix:* Distinguish MAC/passphrase verification failures from structural/algorithm failures; surface the specific cause for the latter.

#### UNCERTAIN (unverified)

- **[LOW] content-type signed attribute never checked equals id-data** — `verify.ts:218` (RFC 5652 §11.1).
- **[LOW] Trailing `0x00` treated as whitespace in whole-document coverage** — `verify.ts:57` (appended NUL bytes tolerated). *(Two findings describe the same defect.)*
- **[LOW] Entire ECDSA signing path untested** — `test/pades.test.ts:6`.
- **[LOW] Fixed 16384-byte `/Contents` placeholder** can be exceeded by long chains / 4096-bit keys / future timestamps — `sign.ts:55`.
- **[LOW] Chain validity not evaluated at requested `at`** — `verify.ts:288`.
- **[LOW] signing-certificate-v2 weak (SHA-1/MD5) hash not screened** — silent fallback to sha256 → spurious mismatch — `verify.ts:243-248`.
- **[LOW] `findSignerCert` returns `certs[0]` for SKI SignerInfo without matching the SKI** — `verify.ts:110`.
- **[LOW] RSA padding relies on Node default instead of pinning PKCS#1 v1.5** — `credential.ts:67`.
- **[LOW] Self-signed export uses hardcoded default passphrase + 3DES** — `credential.ts:168-169`.
- **[LOW] Server silently attempts empty passphrase when env var unset** — `server/src/container.ts:59`.

### 2.2 finesign-core

#### CONFIRMED

**[HIGH] PNG decompression-bomb guard bypassed at embed time** — `packages/core/src/engine/sign.ts:156`
A 20000×20000 PNG whose IDAT compresses under the 2MB cap passes decode; `trimSignatureImage` sees dims > 16M px and returns bytes *untrimmed*; `embedPng` inflates to ~1.6GB and OOM-kills the process. Cheap, repeatable remote DoS.
*Fix:* Enforce a hard pixel-dimension cap *before* embedding (in `decodeSignatureImage` / top of `signWithImage`); reject rather than skip; treat an unreadable IHDR as rejection.

**[HIGH] Non-zero MediaBox/CropBox origin ignored — stamps land offset/off-page** — `packages/core/src/engine/stamp.ts:42`
For a page with MediaBox `[100 100 700 900]`, UI-placed (manual) boxes are drawn 100 units left/below the visible page and clipped. Auto-detect masks it via equal-and-opposite offset; manual/UI placement is broken.
*Fix:* Read `getMediaBox()`/`getCropBox()` origin; add origin when stamping, subtract when detecting; pick CropBox vs MediaBox consistently on both sides.

**[MEDIUM] Split-date heuristic indexes by full-group position → wrong/blank dates** — `packages/core/src/engine/dates.ts:48`
When a `full` date anchor sorts among three auto date boxes, the `[MM,DD,YYYY]` array is indexed by global position, producing `DD, YYYY, blank` (MM dropped). Order-dependent wrong signing date.
*Fix:* Build the auto-only ordered list first and index `[MM,DD,YYYY]` by `autos.indexOf(a)`.

**[MEDIUM] Stamped date uses server local time; audit timestamp uses UTC** — `packages/core/src/engine/dates.ts:22`
Near midnight the visible date and the audit `signedAt` (`toISOString()`) disagree by a day — a contradictory signing date on the signed document.
*Fix:* Use one convention for both (e.g. UTC getters to match `toISOString()`), or make timezone an explicit option.

#### UNCERTAIN (unverified)

- **[LOW] Signature image may extend above its anchor and off the top of the page** (1.6× growth, bottom-aligned) — `stamp.ts:91`.
- **[LOW] Typed-name stamping uses unsnapped `/Rotate` for draw angle while coords snap to 90s** — `stamp.ts:43`.
- **[LOW] `isPdfBuffer` accepts any file containing `%PDF-` in first 1KB** → downstream 500 instead of clean 4xx — `pdf-guards.ts:9`.

### 2.3 Domain (`@finesign/domain`)

#### CONFIRMED

**[HIGH] No optimistic concurrency: concurrent requests on one token double-sign / lost-update** — `server/src/app.ts:298`
Double-click or replay: both requests pass all guards, write two signed blobs, both hit finalize → two certificates, two divergent sealed PDFs, duplicate completion emails; `repo.save` is last-write-wins. In sequential routing, next-recipient tokens are issued twice, leaving one emailed link dead.
*Fix:* Version the aggregate + conditional `UPDATE … WHERE version=$expected` (or `SELECT … FOR UPDATE`); 409 on conflict.

**[MEDIUM] `applySignature` completes a recipient without verifying required fields are filled** — `packages/domain/src/envelope-service.ts:286`
A signer with a required signature field *and* a required text field can submit only the signature; the envelope transitions to `completed` with a permanently-blank required value.
*Fix:* Accept per-field values in the sign input; assert every required field owned by the recipient is non-empty before transitioning; stamp collected values.

**[MEDIUM] Sender never notified of completion and never receives the signed copy** — `packages/domain/src/envelope-service.ts:326`
No effect has `toSender=true`; the sender must poll to learn the agreement completed and gets no link to the sealed document.
*Fix:* Push a sender-targeted `completed_copy` notify and deliver a download link.

**[MEDIUM] Envelope can complete with documents that were never signed or sealed, while the certificate claims them** — `packages/domain/src/validation.ts:50`
A zero-field supplemental PDF keeps `signedBlobKey=null`, is skipped by the seal loop, yet is listed with a sha256 on the certificate — even when `sealRequired=true`. (Server-side manifestation below.)
*Fix:* Reject zero-field documents at send, or seal/stamp supplemental docs and mark them "supplemental / unsigned" on the certificate.

**[MEDIUM] Decline notifies uninvolved downstream recipients, leaking envelope existence + free-text reason** — `packages/domain/src/envelope-service.ts:362`
In a sequential envelope, declining fans out to recipients (e.g. an internal exec at order 2) who never received a link and may not know the envelope exists — leaking title and the decliner's reason.
*Fix:* Restrict decline notifications to the sender plus already-engaged recipients (`status !== 'pending'`); sanitize the note.

**[MEDIUM] Notification delivery not retryable — a mail failure after persist strands the envelope** — `server/src/app.ts:222`
`send()` saves `sent` and mints a token, then SMTP failure 500s; retry throws `ENVELOPE_NOT_DRAFT`; no resend/re-notify path exists. Agreement permanently un-completable via API. *(Duplicate cross-cutting entry: `app.ts:390`.)*
*Fix:* Add a resend/re-notify operation and/or a durable retried outbox.

**[MEDIUM] Audit hash-chain is unkeyed SHA-256 — a write-capable attacker can forge a valid replacement chain** — `packages/domain/src/audit.ts:33` (corrected down from high)
For a declined/never-sealed envelope there is no external anchor, so a store-write attacker can delete events and recompute a passing chain.
*Fix:* HMAC the chain with a server-held key or sign periodic checkpoints with the PAdES credential; seal the final audit log into the certificate PDF. Document that unkeyed hashing only defends against non-recomputing edits.

**[LOW] Document normalization & signed-copy assignment mutate state with no audit event** — `packages/domain/src/envelope-service.ts:150` (corrected down from medium)
The chain never records normalized `pdfBlobKey`/`pageCount` or final `signedBlobKey`. Practical evidentiary loss is minimal (recoverable from persisted state), but the chain is incomplete.
*Fix:* Emit `document_normalized`/`document_signed` events with blob keys (ideally content fingerprints).

**[LOW] No envelope expiration state — expired-token envelopes are stuck in `sent`** — `packages/domain/src/state-machine.ts:20` (corrected down from medium)
After all tokens expire, no domain call can re-mint; envelope lives forever in "pending/active" listings; only manual void exits.
*Fix:* Add an `expired` terminal status + scheduler-driven expiry + re-notify/re-issue path.

#### UNCERTAIN (unverified)

- **[LOW] Decline reason broadcast verbatim to every other recipient** — `envelope-service.ts:363`.
- **[LOW] Sequential routing never notifies cc at their routing order** (only end-of-flow) — `routing.ts:28`.
- **[LOW] `markViewed` assigns status directly, bypassing the transition table** — `envelope-service.ts:276`.
- **[LOW] `decline()` lacks the turn/role/expiry guards `applySignature` enforces** — `envelope-service.ts:341`.

### 2.4 Server (`@finesign/server`)

#### CONFIRMED

**[HIGH] Lost-update race: `repo.save` has no optimistic concurrency; parallel signatures drop a signature and the envelope never completes/seals** — `packages/server/src/app.ts:388`
Two parallel signers on stale snapshots overwrite each other's row; a recorded signature, its stamped pointer, and its audit event are lost; finalize never runs; envelope stuck `sent`, never sealed.
*Fix:* Version + conditional `UPDATE`/`ConflictError` → HTTP 409 retry, or per-envelope serialization; apply in both in-memory and Postgres repos so the contract suite covers it.

**[HIGH] No-field documents delivered UNSEALED even when `sealRequired=true` (fail-closed bypass)** — `packages/server/src/app.ts:491`
The finalize loop does `if (!d.signedBlobKey) continue`, so a fieldless exhibit is never sealed; `GET …/documents/:docB` returns raw normalized bytes; operator believes fail-closed held.
*Fix:* Seal every document with a `pdfBlobKey` (`signedBlobKey ?? pdfBlobKey`); when `sealRequired`, assert post-condition that every document ended sealed, else throw `SEAL_UNAVAILABLE`.

**[MEDIUM] Rate limiting keyed by socket IP with no `trustProxy` collapses to one global bucket behind a proxy** — `packages/server/src/http.ts:56`
Behind nginx/ALB/Cloudflare every client shares one 30/min `/sign/*` bucket; one abuser (or a few concurrent legitimate signers) 429s all signers. The 300/min global bucket is likewise shared.
*Fix:* Set `trustProxy`; add a `keyGenerator` on the authenticated principal; add a per-recipient/per-envelope cap independent of IP. Document required proxy config.

**[MEDIUM] `bodyLimit` (12MB) < base64-inflated max upload → configured `maxUploadBytes` unreachable and un-tunable** — `packages/server/src/http.ts:56`
A 9.5MB PDF (< 10MB limit) is rejected 413; raising `maxUploadBytes` doesn't help (hard-coded literal). *(Duplicate: `http.ts:56` "all".)*
*Fix:* Derive `bodyLimit` from `config.maxUploadBytes * 4/3 + slack`, or accept raw binary multipart.

**[MEDIUM] `GET /api/envelopes` limit/offset unvalidated: NaN/negative → 500, unbounded limit → full-table dump** — `packages/server/src/http.ts:144`
`?limit=99999999` loads and serializes every row (DoS); `?offset=-1` on Postgres → unhandled 500.
*Fix:* Reject non-finite/negative with 400; `Math.trunc`; clamp limit to a max page size; default when absent.

**[MEDIUM] Uploaded PDFs parsed with only a 1KB magic check and no timeout/resource cap — crafted-PDF CPU/memory DoS** — `packages/server/src/app.ts:175`
A ~200KB PDF with a FlateDecode ObjStm declaring millions of objects pins the event loop and heap; the DOCX path is timeout/maxBuffer-bounded, the PDF path is not.
*Fix:* Wall-clock timeout, page-count cap, worker-thread/subprocess isolation, stricter upload rate limit; validate full `%PDF-` header at offset 0 + xref/EOF.

**[LOW] Certificate document hash computed over an ephemeral, undelivered intermediate blob** — `packages/server/src/app.ts:476` (corrected down from medium)
The printed sha256 covers the pre-certificate stamped blob, which no route serves; not reproducible from the delivered artifact. Impact limited (PAdES seal + audit chain are the real integrity mechanism).
*Fix:* Hash a stable, retrievable artifact, or label the hash with the exact stage it covers.

**[LOW] Single shared sender API key grants full cross-envelope access (IDOR)** — `packages/server/src/http.ts:88` (corrected down from medium)
No per-sender filter on list/download/void/verify. Caveat: multi-sender is an explicit non-goal (PRD.md:97, BACKLOG X.8), so within the single-tenant design there is no violation. *(Duplicate: `http.ts:88` "all".)*
*Fix:* Per-sender principal + ownership checks for multi-tenant; at minimum document single-tenant and enforce a high-entropy key.

#### UNCERTAIN (unverified)

- **[LOW] Signer document fetch does not check envelope/recipient status** → leaks bytes after void/decline/completion — `app.ts:282`.
- **[LOW] Signing tokens long-lived, not one-time-use, not revoked after signing** — `app.ts:122`.
- **[LOW] Error handler echoes `FineSignError.message/details` verbatim for 5xx** — `http.ts:103`.
- **[LOW] Swagger UI / OpenAPI served publicly unauthenticated** — `http.ts:82`.
- **[LOW] Auth-by-path-prefix is fragile (not default-deny); list limit/offset unbounded/NaN** — `http.ts:94`.
- **[LOW] Recipient/sender email accepted on bare `@`, no CRLF check** (header injection) — `domain/src/envelope-service.ts:167`.
- **[LOW] Typed-signature font cast from untrusted input without validation** → 500 instead of 400 — `http.ts:50`.

### 2.5 Storage (`@finesign/storage`)

#### CONFIRMED

**[MEDIUM] `LocalFsBlobStore.exists()` masks EACCES/EIO/EPERM as "blob absent"** — `packages/storage/src/blob-store.ts:62-69`
A real permission/IO fault on a present certificate blob is reported as a benign "not ready yet" 404, masking infrastructure faults (whereas `get()` surfaces them).
*Fix:* Mirror `get()`: treat only ENOENT (and arguably ENOTDIR) as false; re-throw every other errno.

**[MEDIUM] `LocalFsBlobStore.put()` writes non-atomically — crash/concurrent put leaves a truncated blob** — `packages/storage/src/blob-store.ts:41-46`
`fs.writeFile` truncates then partially writes; a later `get()` returns partial bytes with no integrity signal → structurally invalid signed PDF.
*Fix:* Write to a temp file in the same dir then `fs.rename` (atomic); optionally fsync before rename.

**[LOW] SQLite `nextSeq()` uses `MAX(seq)+1` RMW; `seq` nullable/non-unique → concurrent creates collide, destabilizing `list()` order** — `packages/storage/src/sqlite-repository.ts:36-39` (corrected down from medium)
Two processes on the same WAL file can both write `seq=5`; `ORDER BY seq` becomes non-deterministic. Not reproducible single-process (better-sqlite3 is synchronous).
*Fix:* DB-assigned AUTOINCREMENT/rowid-backed monotonic column with UNIQUE/NOT NULL; secondary order by `(seq, id)`.

#### UNCERTAIN (unverified)

- **[LOW] Denormalized `status`/`created_at` columns drift between adapters and are never read** — `postgres-repository.ts:114-118` vs `sqlite-repository.ts:44`.
- **[LOW] `PostgresEnvelopeRepository.init()` runs unguarded `CREATE TABLE IF NOT EXISTS`; concurrent bootstrap can throw spuriously** — `postgres-repository.ts:40-57`.
- **[LOW] Blob path check is lexical (`path.resolve`), not realpath — no symlink containment** — `blob-store.ts:31-39`.

### 2.6 Convert (`@finesign/convert`)

#### CONFIRMED

**[MEDIUM] `readFile` ENOENT after a failed conversion misreported as "LibreOffice not found" (wrong error + wrong 503)** — `packages/convert/src/docx-libreoffice.ts:83` (corrected down from high)
A corrupt-but-PK DOCX makes soffice exit 0 without writing `in.pdf`; the ENOENT catch throws `ConverterUnavailableError` (503) claiming LibreOffice is uninstalled, when it is running fine. Correct response is 502 `DOCX_CONVERSION_FAILED`.
*Fix:* Only map execFile spawn ENOENT to `ConverterUnavailableError`; wrap `readFile(outPath)` separately and throw `DocxConversionError` on ENOENT there.

**[MEDIUM] Converted PDF read into memory with no size cap — DOCX bomb → OOM DoS** — `packages/convert/src/docx-libreoffice.ts:79` (corrected down from high)
A valid sub-12MB DOCX can render a many-hundred-MB PDF; `fs.readFile` buffers it whole; a few parallel uploads exhaust heap.
*Fix:* `stat` the output and reject over a configured max before reading; bound temp-dir disk usage; stream/size-check.

**[MEDIUM] Conversion timeout SIGTERMs the wrapper only — real `soffice.bin` survives (orphan accumulation)** — `packages/convert/src/docx-libreoffice.ts:76`
Each timed-out conversion leaves a live CPU-pinning `soffice.bin`; repeated submissions exhaust the host despite the timeout "firing".
*Fix:* Spawn `detached:true` and kill the whole process group with SIGKILL on timeout; run each conversion in a disposable container/cgroup (X.7).

**[MEDIUM] Untrusted DOCX parsed by LibreOffice with no network/macro/OLE isolation (SSRF / RCE / exfiltration)** — `packages/convert/src/docx-libreoffice.ts:62`
An authenticated attacker's DOCX referencing `http://169.254.169.254/…` triggers SSRF to instance metadata; an OLE/import-filter CVE yields RCE as the server uid.
*Fix:* Sandbox by default (no network namespace, read-only fs, non-root, cgroup limits); refuse to run without an isolation wrapper; disable macros/external links. Land BACKLOG X.7 before exposing this path.

#### UNCERTAIN (unverified)

- **[LOW] Converter output validated only by `%PDF-` substring — truncated PDF passes** → opaque 500 downstream — `docx-libreoffice.ts:108`.
- **[LOW] Format magic checks accept any ZIP as DOCX / any `%PDF-`-containing preamble as PDF (polyglot/type-confusion)** — `server/src/app.ts:518`.

### 2.7 Cross-cutting ("all") — consolidated

These duplicate module findings above; noting them once:
- **cms-trailing-zero-strip** = PAdES trailing-`0x00` strip (`verify.ts:86`). **CONFIRMED MEDIUM.**
- **required-nonsig-fields-skipped** (`server/src/stamping.ts:102`) — required text/checkbox fields land in `summary.skipped`, logged as a warning only, yet the envelope completes and seals. **CONFIRMED MEDIUM.** Same defect as domain `sign-without-required-fields`; the *server* side must fail-closed (`ValidationError`) rather than warn.
- **bodylimit-below-max-upload** = `maxupload-unreachable-bodylimit`. **UNCERTAIN LOW / (confirmed medium via server entry).**
- **single-shared-api-key-no-authz** = server IDOR. **UNCERTAIN LOW.**
- **email-failure-after-commit** = domain `send-not-retryable-stuck`. **UNCERTAIN LOW / (confirmed medium via domain entry).**
- **typed-font-unvalidated** (`http.ts:50`). **UNCERTAIN LOW.**

---

## 3. Completeness-Critic Additions

These are gaps/omissions rather than located code bugs (though several have precise anchors). Ranked by severity.

**[HIGH] No signer identity capture (IP / user-agent) — required audit evidence never recorded** — `server/src/app.ts:298`
PRD FR-A1 promises actor/timestamp/IP/user-agent; no path threads `req.ip`/UA into the domain — audit `data` carries only `{recipientId}` (`domain/src/types.ts:93`). This is the single most-cited evidentiary element of an e-signature audit trail; its absence materially weakens legal defensibility and puts the product out of conformance with its own PRD.
*Fix:* Thread `req.ip` + UA from Fastify routes into `applySignature`/`markViewed`/`decline`; persist on the recipient and in hashed audit data; render in the certificate's per-signer events.

**[HIGH] Text/checkbox/initials fields accepted, never collected, silently dropped at completion** — `domain/src/validation.ts:12`
`validateForSend` does not reject unsupported kinds; the signer payload carries only a `SignatureInput`; `Field.value` is never populated; the envelope completes anyway. Silent data loss on a legal document and a core parity gap.
*Fix:* Reject unsupported kinds at `validateForSend`, or extend the submit payload + stamping to collect/render them and enforce required completion.

**[HIGH] No ESIGN/UETA electronic-records consent disclosure or consent capture** — `server/src/app.ts:247`
`getSession` returns documents and lets the signer sign immediately; no disclosure, no consent checkbox, no `consent_given` audit type (`domain/src/types.ts:78`). A foundational legal-validity feature both DocuSign and Adobe Sign gate signing on; not in non-goals/backlog.
*Fix:* Add a consent gate (disclosure + explicit agreement) before first signature; record a hash-chained `consent_given` event with IP/timestamp/disclosure version; surface on the certificate; make disclosure configurable.

**[HIGH] No automatic reminders, envelope expiration, or scheduler** — `domain/src/types.ts:106`
No `expiresAt`, no reminder policy, no cron/worker to re-notify or auto-void. Stalled envelopes never resolve; links quietly die with no nudge or sender visibility.
*Fix:* Add expiration (→ auto-void with audit) and a reminder cadence behind an injected scheduler port; emit audit events + sender notifications.

**[HIGH] Recipients cannot retrieve the completed copy** — `server/src/app.ts:322`
The `completed_copy` email says a copy is available, but carries no token and the original token no longer works (`getSession` throws `ENVELOPE_NOT_SENT`). Only the sender (API-key holder) can download.
*Fix:* Attach the completed PDF/certificate to the email, or issue a post-completion read-only download token / keep the signer token valid read-only.

**[HIGH] `buildCertificate` uses WinAnsi StandardFonts on unsanitized user text — international names/titles permanently wedge completion** — `server/src/certificate.ts:32`
pdf-lib throws `WinAnsi cannot encode …` for any non-CP1252 code point (CJK/Cyrillic/Arabic/emoji and common Latin `ā`/`ș`). This runs inside `finalize()` *before* `repo.save()`, so the last signer's `applySignature` aborts: signature not persisted, 500 to signer, envelope stuck at `sent` forever, retry re-throws. Routine for an e-signature product with international recipients.
*Fix:* Sanitize/transliterate to WinAnsi, or embed a Unicode TTF via fontkit for the certificate; at minimum wrap the certificate build so an encoding failure degrades gracefully; validate title/name/email at authoring.

**[MEDIUM] No webhooks / event callbacks (DocuSign Connect parity)** — `server/src/http.ts:55`
Integrators can only poll. The deferred M5.4 (in-UI websockets) is a different concern; server-to-server webhooks are captured nowhere.
*Fix:* Webhook subscription model (per-envelope/global endpoint + HMAC), fired on each audit event, with retries + dead-letter.

**[MEDIUM] Notification delivery has no retry/queue — a failed send after state advance strands the envelope** — `server/src/app.ts:389`
`persistThenDeliver` saves then fires a single awaited `mailer.send` with no retry/DLQ/bounce handling.
*Fix:* Durable outbox/queue with retries + dead-letter, decoupled from the request; surface delivery/bounce failures to the sender.

**[MEDIUM] No data-retention, purge, or GDPR/CCPA erasure/export** — `server/src/app.ts:106`
Agreements + PII stored indefinitely; no delete/scrub API; no legal-hold; erasure would break the audit hash chain.
*Fix:* Configurable retention/purge, erasure/export workflow, legal-hold flag; define tombstoning/crypto-shredding so erasure preserves chain integrity.

**[MEDIUM] Documents and PII stored unencrypted at rest** — `server/src/app.ts:173`
Originals, normalized/signed PDFs, certificates, and DB PII are plaintext; the self-host default (SQLite + local FS) leaves sensitive data unprotected.
*Fix:* At-rest encryption seam (envelope encryption via injected key provider/KMS, or SSE-KMS for S3); treat the key as a required secret.

**[MEDIUM] No backup/DR story for the blob store or DB (system of record)** — `docs/ARCHITECTURE.md:83`
Certificates record only document hashes; losing blob bytes is an unrecoverable loss of the executed agreement.
*Fix:* Backup/restore guidance + adapter support (S3 versioning, DB snapshots) + an integrity-check tool re-verifying the chain and hashes against restored blobs.

**[MEDIUM] Shallow `/health`, no readiness/dependency checks, no metrics/tracing** — `server/src/http.ts:126`
Static `{status:'ok'}` routes traffic to an instance whose DB/storage is down; no throughput/latency/notify-failure metrics.
*Fix:* Readiness pinging repo/blob/mailer; split liveness/readiness; Prometheus metrics + structured error counters.

**[LOW] PAdES verifier enforces an RSA key-size floor but no EC curve strength floor** — `pades/src/verify.ts:191`
`MIN_RSA_BITS=2048` gate only runs for RSA; a P-192 EC signature is accepted with equal authority.
*Fix:* Enforce an EC curve allow-list (P-256/384/521) or minimum field size.

**[LOW] Production container defaults to `ConsoleMailer` — signing links never delivered** — `server/src/container.ts:109`
Default production boot issues valid tokens that reach no recipient; the only workaround is the dev-only token-exposure flag the code warns against.
*Fix:* When no mailer is configured, refuse to boot (fail-closed) or emit a prominent startup warning.

**[LOW] Uploaded (and redistributed) documents are not malware-scanned** — `server/src/app.ts:518`
Magic-bytes + size only; the platform re-serves uploaded PDFs/DOCX to other parties. X.7 covers only the conversion process, not stored-file scanning.
*Fix:* Optional anti-malware scanning port (ClamAV/ICAP) on upload before a document is signable/downloadable.

---

## 4. DocuSign Parity Matrix

Legend — Status: ✅ have · ◑ partial · ❌ missing. Importance: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low.

### 4.1 Envelopes & Recipient Workflow

| Capability | Status | Imp. | Recommendation |
|---|---|---|---|
| Draft creation & authoring | ✅ | 🔴 | Add remove/reorder/edit (currently additive-only); edit title/routing post-create |
| Send envelope | ✅ | 🔴 | Add send-time settings (subject/body, reminder/expiration) |
| Void sent/draft | ✅ | 🟠 | Emit notify to active recipients on void (today void is silent, unlike decline) |
| Recipient decline w/ reason | ✅ | 🟠 | Consider sender-configurable decline handling; restrict/sanitize reason (see §2.3) |
| Sequential routing | ✅ | 🔴 | Expose routingOrder editing + visual builder |
| Parallel routing | ✅ | 🟠 | Support hybrid parallel-within-sequential; document same-order = parallel |
| Signer role | ✅ | 🔴 | — |
| Approver role | ◑ | 🟡 | Add an `approve` action that advances routing without a StampEffect |
| CC recipient | ✅ | 🟠 | Ensure cc get only the final copy, no per-turn links |
| Signing-link TTL | ◑ | 🟠 | Add envelope-level expiration + auto-void/expired terminal status |
| Reminders | ❌ | 🟠 | Reminder policy + scheduler re-issuing notifies |
| Resend / re-notify | ❌ | 🟠 | Add resend endpoint that re-mints token + audits |
| Correct a sent envelope | ❌ | 🟠 | Add correct flow preserving the audit chain; at minimum fix bad emails |
| Delegation / reassign | ❌ | 🟡 | Add reassign action (replace identity, re-mint, move fields, audit) |
| Templates | ❌ | 🟠 | Template aggregate + instantiate flow (table stakes; drives most volume) |
| Bulk send | ❌ | 🟡 | After templates: CSV fan-out + batch status |
| In-person / hosted signing | ❌ | ⚪ | Later; host session issuing an in-person token |
| Tamper-evident audit trail / CoC | ✅ | 🟠 | Render full recipient timeline + IP (see §3) |

### 4.2 Field Types & Signing Experience

| Capability | Status | Imp. | Recommendation |
|---|---|---|---|
| Signature field | ✅ | 🔴 | Strongest, most complete field |
| Initials field | ✅ | 🟠 | Allow a distinct initials mark (today reuses signature blob) |
| Date-signed (auto) | ✅ | 🟠 | Add user-editable/calendar date variant |
| **Text (free-form) field** | ◑ | 🔴 | **Highest-priority field gap** — implement entry in Sign.jsx, persist value, stamp |
| Checkbox | ◑ | 🟠 | Add to placement + signer UI, store checked, stamp glyph |
| Radio group | ❌ | 🟡 | New kind with shared group id + exclusive selection |
| Dropdown / list | ❌ | 🟡 | New kind with options + selected value |
| **Required vs optional enforcement** | ◑ | 🔴 | **Enforce server-side in `applySignature` + client-side** (today cosmetic) |
| Drawn signature capture | ✅ | 🔴 | Optional stroke smoothing / higher DPI |
| Typed signature (fonts) | ✅ | 🟠 | Add exact live preview |
| Uploaded signature image | ❌ | ⚪ | Add upload tab reusing the `{kind:'image'}` path |
| Adopt / reusable saved signature | ❌ | 🟡 | Persist per user/email |
| Auto field placement (detect) | ◑ | 🟠 | Wire existing `detectAnchorsFromAcroForm` into Create; add OCR for flat PDFs |
| Anchor/text-tag placement | ◑ | 🟡 | Add page-text keyword anchor scanning |
| Conditional / dependent fields | ❌ | 🟡 | Add show-if rules once checkbox/radio/dropdown exist |
| Field format validation (masks/regex) | ❌ | 🟠 | Add validation metadata + client/server enforcement (SSN/date/ZIP) |
| Mobile / touch signing | ◑ | 🟠 | Make PdfView responsive (fluid/zoom/fit-to-width) |
| Drag-to-place fields | ◑ | 🟠 | Add drag-to-draw sizing |
| Edit/move/resize/delete placed fields | ❌ | 🟠 | Add select/move/resize/delete + update/deleteField API |
| Per-field recipient assignment + color | ✅ | 🟡 | Extend once more kinds are interactive |

### 4.3 Recipient Authentication & Identity

| Capability | Status | Imp. | Recommendation |
|---|---|---|---|
| Email-link (tokenized) auth | ✅ | 🔴 | Rotate/expire token on completion/decline; document it as low-assurance |
| Access code / shared secret | ❌ | 🟠 | Optional per-recipient accessCode (hashed), gate session, lockout, audit |
| SMS/phone OTP | ❌ | 🟠 | Phone field + OtpChallenge port + SMS provider |
| KBA | ❌ | 🟡 | Defer; integrate third-party behind a port if regulated flows needed |
| ID-doc / biometric IDV | ❌ | 🟡 | Integrate IDV vendor behind a port; store reference + assurance level only |
| **Signer IP capture** | ❌ | 🔴 | **Capture `req.ip` (trustProxy) at session/apply/decline → audit + certificate** |
| Device / user-agent capture | ❌ | 🟠 | Record UA alongside IP |
| Geolocation | ❌ | ⚪ | Optionally derive coarse geo from IP at render |
| **ESIGN/UETA e-consent** | ❌ | 🔴 | **First-run consent gate + audit event + certificate line** |
| Per-recipient step-up auth config | ❌ | 🟠 | `authRequirements` on Recipient, enforced in resolveToken/getSession |
| Identity metadata on certificate | ◑ | 🟠 | Add per-recipient Authentication section once IP/UA/consent/factor capture exists |

### 4.4 Compliance, Audit & Signature Assurance

| Capability | Status | Imp. | Recommendation |
|---|---|---|---|
| Certificate of Completion | ✅ | 🔴 | Add auth method, IP, consent, UA; machine-readable sidecar + verify QR/URL |
| Tamper-evident audit trail | ✅ | 🔴 | Anchor chain externally (RFC 3161 on tail hash); enforce append-only at DB tier |
| PAdES-B-B | ✅ | 🔴 | Add Adobe/DSS interop tests to CI; add RSASSA-PSS |
| **PAdES-B-T (trusted timestamp)** | ❌ | 🔴 | **Highest-priority assurance gap** — TSA port + RFC 3161 client + verify |
| PAdES-B-LT (DSS OCSP/CRL) | ❌ | 🟠 | Implement after B-T; enables years-later offline validation |
| PAdES-B-LTA (archive timestamp) | ❌ | 🟠 | Sequence after B-LT; refresh job |
| Crypto vs visual signatures | ✅ | 🔴 | Document trust model (platform attestation, not per-signer PKI) |
| Independent verification | ✅ | 🔴 | Add revocation checking + timestamp verdict; publish a public verify page |
| HSM/KMS-backed signing key | ◑ | 🟠 | Ship a real KMS adapter (AWS KMS asymmetric sign) before positioning as prod |
| Trusted/qualified CA cert (vs self-signed) | ◑ | 🟠 | Obtain AATL/eIDAS-qualified org cert; document onboarding |
| ESIGN/UETA consent + intent + disclosure | ◑ | 🟠 | Add explicit audit types + certificate rows |
| eIDAS positioning (AdES/QES) | ◑ | 🟡 | Decide/document target tier; don't overclaim |
| Trusted timestamping (TSA) | ❌ | 🔴 | Same as B-T; also anchor the audit chain |
| Encryption at rest | ❌ | 🔴 | Envelope encryption / KMS; encrypt document blobs + PII |
| Retention / deletion / legal-hold | ❌ | 🟠 | Configurable retention + erasure (crypto-shredding) + legal hold |
| Fail-closed sealing | ✅ | 🟡 | Make `sealRequired` the prod default; validate credential loads at boot; **also fix per-document coverage (§2.4 unsealed no-field docs)** |

### 4.5 Notifications, Delivery & Integration

| Capability | Status | Imp. | Recommendation |
|---|---|---|---|
| Transactional email (SMTP) | ✅ | 🔴 | Add delivery-failure retry + bounce feedback |
| Branded HTML email | ❌ | 🟠 | Add `html` + template layer (plain text reads as phishing) |
| Automatic reminders | ❌ | 🔴 | Scheduler + `reminder` notify reason |
| Manual resend | ❌ | 🟠 | POST resend endpoint re-issuing token |
| SMS delivery / OTP | ❌ | 🟡 | Notifier/Channel abstraction + SMS adapter |
| Webhooks (Connect-style) | ❌ | 🔴 | HMAC-signed event delivery + retry + log |
| REST API completeness | ◑ | 🟠 | Add templates, bulk send, resend, richer list filtering; per-account keys/OAuth |
| OpenAPI + docs | ✅ | 🟠 | Add per-route request/response schemas |
| Embedded signing / iframe SDK | ◑ | 🟠 | `create recipient view` endpoint + JS SDK (postMessage, returnUrl) |
| Downloadable completed docs + CoC | ✅ | 🔴 | Add combined all-docs+certificate download; link in completion email |
| Branding / white-label | ❌ | 🟠 | Per-account logo/colors/from/copy |
| Multi-language / i18n | ❌ | 🟡 | Externalize strings + per-recipient language |

### Prioritized Parity Gap List (most impactful first)
1. **PAdES-B-T trusted timestamp** (🔴, and unblocks cert-validity-at-`now` bug §2.1). Then B-LT/B-LTA.
2. **Text field capture + required-field enforcement** (🔴, ties to §2.3/§3 silent data loss).
3. **Signer IP + user-agent capture** on the certificate (🔴).
4. **ESIGN/UETA e-consent gate** (🔴).
5. **Webhooks** (🔴 for integrators).
6. **Encryption at rest** (🔴).
7. **Templates** (🟠, drives volume) + **reminders** + **envelope expiration** + **resend** (🟠).
8. **Recipient access to completed copy** (🟠).
9. **HSM/KMS signing adapter** + **AATL/qualified cert** (🟠).
10. **Field-editing UX** (move/resize/delete, drag-to-place, checkbox/radio/dropdown) (🟠).

---

## 5. Recommended Remediation Plan

### FIX NOW (correctness / security / data-loss / DoS — before any production traffic)

*These break the platform's core promises or lose signatures/documents.*

1. **Bind trust to the signer** — `pades/src/verify.ts:285-292` (forged-doc-reported-authentic). *[HIGH]*
2. **Add optimistic concurrency** to `repo.save` across both repos and both sign paths — `server/src/app.ts:388` and `:298` (dropped signatures / double-finalize). *[HIGH×2]*
3. **Stop the verifier false negatives** — remove trailing-`0x00` strip (`verify.ts:86`); parse real signature dictionaries instead of a global regex / relax `every()` (`verify.ts:322-325`). *[MEDIUM×2, but core guarantee]*
4. **Seal every delivered document** and assert per-document coverage under `sealRequired` — `server/src/app.ts:491` (+ domain `validation.ts:50`). *[HIGH]*
5. **Enforce required-field completion server-side** and fail-closed instead of warning — `domain/src/envelope-service.ts:286`, `server/src/stamping.ts:102`. *[MEDIUM, legal correctness]*
6. **Sanitize/embed-TTF the certificate text** so international names don't wedge completion — `server/src/certificate.ts:32`. *[MEDIUM, but bricks envelopes]*
7. **Close the upload DoS vectors:** PNG pixel cap before embed (`core/src/engine/sign.ts:156`); DOCX output size cap + process-group kill + sandbox (`convert/src/docx-libreoffice.ts:79/76/62`); PDF parse timeout/cap (`server/src/app.ts:175`). *[HIGH/MEDIUM]*
8. **Fix the seal credential loader:** reject non-RSA/EC at construction and correct scheme labeling (`credential.ts:74`); either support EC PKCS#12 or document RSA-only + clear error (`credential.ts:86-135`, `:95-96`). *[HIGH/MEDIUM]*
9. **Make send/notify recoverable:** resend/re-notify endpoint + retried outbox — `server/src/app.ts:222/389`. *[MEDIUM, else envelopes permanently stuck]*
10. **Restrict decline notifications** to sender + engaged recipients; sanitize reason — `domain/src/envelope-service.ts:362`. *[MEDIUM, info leak]*
11. **Atomic blob writes** (temp+rename) and **`exists()` errno handling** — `storage/src/blob-store.ts:41-46`, `:62-69`. *[MEDIUM]*
12. **MediaBox/CropBox origin + date correctness** (UTC/local, split-date index) — `core/src/engine/stamp.ts:42`, `dates.ts:22`, `dates.ts:48`. *[HIGH/MEDIUM, mislocated stamps / wrong signing dates]*
13. **Rate-limit + input hardening:** set `trustProxy` + per-recipient cap (`http.ts:56`); validate/clamp list limit/offset (`http.ts:144`); fix `bodyLimit` derivation (`http.ts:56`). *[MEDIUM]*
14. **Fix DOCX ENOENT misclassification** (503→502) — `convert/src/docx-libreoffice.ts:83`. *[MEDIUM]*

### NEXT (assurance, legal defensibility, robustness completeness)

1. **PAdES-B-T trusted timestamp** (`sign.ts:59` + verify) — unblocks the cert-validity-at-`now` failure (`verify.ts:203-206`) and dating. Then anchor the audit chain via RFC 3161.
2. **Signer IP + user-agent + consent capture** threaded into audit + certificate (`app.ts:298/247`, `certificate.ts`).
3. **ESIGN/UETA consent gate** with `consent_given` audit type.
4. **Text/checkbox field capture end-to-end** (Sign.jsx entry, `Field.value`, stamping) — the top parity gap.
5. **Sender completion notification + recipient completed-copy retrieval** (`envelope-service.ts:326`, `app.ts:322`).
6. **Encryption at rest** seam + **HSM/KMS signing adapter**; obtain an AATL/qualified seal cert.
7. **Keyed/anchored audit chain** (HMAC or PAdES-signed checkpoints) — `audit.ts:33`.
8. **Envelope expiration + reminders + scheduler** (`state-machine.ts:20`, `types.ts:106`).
9. **Storage hardening:** DB-assigned monotonic `seq` (`sqlite-repository.ts:36-39`), Postgres init advisory lock, symlink realpath containment.
10. **Server hygiene:** 5xx message sanitization, session-document status checks, token rotation on terminal status, gate `/docs` in prod, default-deny auth guard, email/CRLF + font validation.
11. **Observability:** readiness checks + metrics (`http.ts:126`); refuse-to-boot / warn on ConsoleMailer in prod (`container.ts:109`).

### LATER (parity depth, enterprise, integrations)

1. **Templates + bulk send**; **correct/reassign/delegation**; field-editing UX (move/resize/delete, drag-to-place, radio/dropdown, conditional logic, format masks).
2. **Webhooks (Connect parity)** + embedded-signing view/SDK; richer REST list filtering; per-account keys/OAuth (multi-tenant).
3. **PAdES-B-LT / B-LTA** (DSS + archive timestamp) for long-retention contracts.
4. **Access-code / SMS-OTP / KBA / IDV** step-up authentication; per-recipient auth requirements.
5. **Branding/white-label + i18n + HTML email templates**; SMS delivery channel.
6. **Data retention/erasure/legal-hold**, **backup/DR**, **malware scanning**, EC curve floor, self-signed export hardening.
7. **Uploaded/adopted signatures**, in-person signing, mobile-responsive PdfView, geolocation.

---

*Note on severity corrections applied above:* several originally-high items were downgraded to medium given real-world impact and documented non-goals — DOCX OOM/ENOENT (bounded by 12MB body + timeout), unkeyed audit chain (defends against non-recomputing edits), single-key IDOR (explicit single-tenant non-goal, PRD.md:97). Conversely, the trust-decoupling, concurrency, unsealed-document, and PNG-bomb findings are confirmed at high severity and gate production readiness.