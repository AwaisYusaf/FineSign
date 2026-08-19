/**
 * DSS (Document Security Store) construction for PAdES-B-LT (ETSI EN 319 142).
 *
 * The DSS is a `/Catalog` entry holding the validation material — the certificate
 * chain + CRLs/OCSP responses as uncompressed DER streams — so a verifier can
 * validate the signature offline after the certs expire. A `/VRI` (Validation
 * Related Information) dict maps each signature (keyed by the UPPERCASE-hex SHA-1
 * of its `/Contents`) to the material that validates it.
 *
 * This module builds the objects with pdf-lib's model and mutates the EXISTING
 * catalog in place; the caller (`augmentToBLt`) writes them as an incremental
 * update so the signed bytes are preserved.
 */
import crypto from "crypto";
import { type PDFDocument, PDFName, PDFDict, PDFRawStream, type PDFRef } from "pdf-lib";
import type { IncrementalObject } from "./incremental";
import type { ValidationData } from "./validation-data";

/**
 * Build the DSS/VRI objects for `vd` against an already-loaded signed PDF, mutate
 * its catalog to reference the DSS, and return the changed-object list to feed
 * `appendIncrementalUpdate` (which serializes them via `doc.context`).
 * `contentsForVriKey` is the raw `/Contents` bytes (INCLUDING the zero padding) of
 * the signature this material validates.
 */
export function buildDssRevision(
  doc: PDFDocument,
  vd: ValidationData,
  contentsForVriKey: Uint8Array
): { changed: IncrementalObject[] } {
  const ctx = doc.context;
  const catalogRef = ctx.trailerInfo.Root as PDFRef;
  const catalog = ctx.lookup(catalogRef, PDFDict);

  const changed: IncrementalObject[] = [];
  const mkStream = (der: Uint8Array): PDFRef => {
    // Uncompressed raw DER (matches PDFBox / EU-DSS convention; OpenSSL-checkable).
    const stream = PDFRawStream.of(ctx.obj({ Length: der.length }), der);
    const ref = ctx.register(stream);
    changed.push({ ref, obj: stream });
    return ref;
  };
  const certRefs = vd.certs.map(mkStream);
  const crlRefs = vd.crls.map(mkStream);
  const ocspRefs = vd.ocsps.map(mkStream);

  const vriKey = crypto.createHash("sha1").update(Buffer.from(contentsForVriKey)).digest("hex").toUpperCase();
  const vriEntry = ctx.obj({
    Type: "VRI",
    ...(certRefs.length ? { Cert: certRefs } : {}),
    ...(crlRefs.length ? { CRL: crlRefs } : {}),
    ...(ocspRefs.length ? { OCSP: ocspRefs } : {}),
  });
  const vriEntryRef = ctx.register(vriEntry);
  changed.push({ ref: vriEntryRef, obj: vriEntry });

  const vriMap = PDFDict.withContext(ctx);
  vriMap.set(PDFName.of(vriKey), vriEntryRef);
  const vriMapRef = ctx.register(vriMap);
  changed.push({ ref: vriMapRef, obj: vriMap });

  const dss = ctx.obj({
    Type: "DSS",
    ...(certRefs.length ? { Certs: certRefs } : {}),
    ...(crlRefs.length ? { CRLs: crlRefs } : {}),
    ...(ocspRefs.length ? { OCSPs: ocspRefs } : {}),
    VRI: vriMapRef,
  });
  const dssRef = ctx.register(dss);
  changed.push({ ref: dssRef, obj: dss });

  catalog.set(PDFName.of("DSS"), dssRef); // the ONLY change to the catalog
  changed.push({ ref: catalogRef, obj: catalog });

  return { changed };
}
