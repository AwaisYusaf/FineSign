# Provenance

finesign-core was extracted from the VA Claim Made Easy backend's document-signing
service. This maps each library module to the app source it was derived from, so
the copy can be kept in parity as the app evolves. **No app code was modified**
during extraction — everything here is a decoupled copy with the DB / S3 / auth /
case-state shell removed.

| finesign-core module | Derived from (app) | What changed in extraction |
| --- | --- | --- |
| `src/types.ts` | `src/types/signing.types.ts` | Dropped the `form-extraction` type import; defined `SignatureFieldKind`, `DisplayBox`, `PointBox` locally; boxes use `{x,y,width,height}` uniformly. |
| `src/geometry/coordinates.ts` | `src/services/cases/signature-anchor.util.ts` + `toPageCoords` from `document-signing.service.ts` | Pure functions verbatim in spirit; renamed `displayBoxToSchemaField` → `displayBoxToPointBox`; unified box shape. |
| `src/engine/pdf-guards.ts` | `signing-policy.ts` `isPdfBuffer` | Copied as-is (dropped the app-policy parts of that file). |
| `src/engine/image.ts` | `document-signing.service.ts` (`decodeSignatureImage`, `trimSignatureImage`, `readImageDimensions`) | Threw `SignatureImageError` instead of the app's `ValidationError`; same magic-byte + bomb guards. |
| `src/engine/fonts.ts` | font loading block in `document-signing.service.ts` | Replaced the hard-coded project `fonts/` path with a configurable `FontRegistry`; fonts bundled in `assets/fonts/`. |
| `src/engine/flatten.ts` | `flattenForStamping` in `document-signing.service.ts` | Copied; dropped the `logger`/`documentId` args. |
| `src/engine/dates.ts` | `buildDateValues` in `document-signing.service.ts` | Copied; reads `anchor.x` instead of `anchor.xPercent`. |
| `src/engine/stamp.ts` | `applySignature`, `applyImageAnchor`, `applyDateAnchor` in `document-signing.service.ts` | Copied the pdf-lib draw math; parameterized instead of closure over service state. |
| `src/engine/sign.ts` | `DocumentSigningService.signDocument` / `signAllDocuments` / `stampDocumentWithImage` | Kept ONLY the PDF pipeline; removed all DB reads/writes, S3 download/upload, presigned URLs, case-ownership/state checks, and notifications. |
| `src/detect/field-heuristics.ts` | `src/services/cases/signature-field.util.ts` | Inlined the deny list (the app imported `NON_VETERAN_SEMANTIC_PREFIXES`); same `SIGN_TOKEN` whole-token regex + date precedence. |
| `src/detect/acroform-fields.ts` | **new** (generic) — conceptually replaces the app's Stage-1 structural + Stage-3.5 AI signer classifier | Reads `/Sig` widgets + named fields directly from the PDF via pdf-lib. The app derives fields from its OpenAI form-extraction pipeline; this is an AI-free generic equivalent. |
| `src/anchors.ts` | `deriveSignatureAnchors` in `signature-anchor.service.ts` | Kept the point-box → display-anchor conversion; removed the `jobId → form_schema` DB resolution and S3 download (caller supplies geometry). |

## Deliberately NOT extracted (app-coupled)

- **Persistence** — `case_package_documents` reads/writes, `signatures` /
  `stamped_anchors` / `signature_anchors` columns, `signing_status` machine.
- **Storage** — `s3Service.downloadFile/uploadBuffer/getSignedUrl` and the
  `signed-documents/{caseId}/...` key scheme.
- **Auth / ownership** — `authenticateToken`, `requireVeteran`, case-owner and
  `state ∈ {delivered, closed}` gates.
- **Routes** — the Fastify handlers under `src/routes/cases/`.
- **Delivery-time policy** — `signing-policy.ts` (`INITIAL_SIGNING_STATUS`,
  `resolveSigningStatus`, `isSigningComplete`) and the form-generation coupling
  (`signerOwnedDateFieldIds`).
- **AI signer classifier** — `stage-3_5-signer-classifier.ts`,
  `admin-signer-placement.service.ts`, `signer-review.util.ts` (OpenAI +
  form-schema store). Slated as an optional add-on (see ROADMAP).

## Keeping parity

If the app's stamping math changes (e.g. a fix in `document-signing.service.ts`
or `signature-anchor.util.ts`), mirror it into the corresponding module above and
re-run `npm test` — the geometry round-trip tests catch coordinate regressions.
