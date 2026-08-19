/**
 * Certificate of completion — a standalone PDF summarizing an envelope's
 * signers, timestamps, the audit chain, and document hashes (FR-A3). This is the
 * human-readable trust artifact; the machine-verifiable guarantee is the
 * hash-chained audit log itself (`verifyAuditChain`).
 */
import crypto from "crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { ESIGN_CONSENT, type Envelope } from "@finesign/domain";

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export async function buildCertificate(
  env: Envelope,
  documentHashes: { name: string; sha256: string }[]
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  let page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const margin = 54;
  let y = 738;

  const line = (text: string, opts: { size?: number; bold?: boolean; gap?: number } = {}) => {
    const size = opts.size ?? 10;
    if (y < margin) {
      page = pdf.addPage([612, 792]);
      y = 738;
    }
    const f = opts.bold ? bold : font;
    // Attacker-controlled strings (name, email, user-agent, …) reach this render.
    // The standard-font WinAnsi encoder THROWS on unencodable code points, which
    // would crash certificate generation inside `finalize` and permanently wedge
    // envelope completion. Fall back to an ASCII-safe rendering so it can never
    // throw — the certificate is a legal artifact and must always be produced.
    try {
      page.drawText(text, { x: margin, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
    } catch {
      const safe = text.replace(/[^\x20-\x7e]/g, "?");
      page.drawText(safe, { x: margin, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
    }
    y -= opts.gap ?? size + 6;
  };

  /** Word-wrap a long paragraph to the page width. */
  const paragraph = (text: string, size = 8) => {
    const maxChars = Math.floor((612 - 2 * margin) / (size * 0.5));
    const words = text.split(" ");
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).trim().length > maxChars) {
        line(cur, { size, gap: size + 2 });
        cur = w;
      } else {
        cur = (cur + " " + w).trim();
      }
    }
    if (cur) line(cur, { size, gap: size + 2 });
  };

  line("Certificate of Completion", { size: 18, bold: true, gap: 28 });
  line(`Envelope: ${env.title}`, { bold: true });
  line(`Envelope ID: ${env.id}`);
  line(`Status: ${env.status}`);
  line(`Created: ${env.createdAt}`);
  if (env.sentAt) line(`Sent: ${env.sentAt}`);
  if (env.completedAt) line(`Completed: ${env.completedAt}`);
  y -= 8;

  line("Recipients", { size: 13, bold: true, gap: 20 });
  for (const r of env.recipients) {
    line(`• ${r.name} <${r.email}> — ${r.role} — ${r.status}`, { bold: true });
    if (r.authMethod !== "none") line(`    authentication: ${r.authMethod}${r.authenticatedAt ? ` (passed ${r.authenticatedAt})` : ""}`, { size: 9 });
    if (r.signedAt) line(`    signed at ${r.signedAt}`, { size: 9 });
    if (r.consentedAt) line(`    e-consent (ESIGN/UETA v${r.consentDisclosureVersion ?? ESIGN_CONSENT.version}) at ${r.consentedAt}`, { size: 9 });
    if (r.signerIp) line(`    IP address: ${r.signerIp}`, { size: 9 });
    if (r.signerUserAgent) line(`    user agent: ${r.signerUserAgent.slice(0, 90)}`, { size: 8 });
    if (r.declineReason) line(`    declined: ${r.declineReason}`, { size: 9 });
  }
  y -= 8;

  line("Documents", { size: 13, bold: true, gap: 20 });
  for (const d of documentHashes) {
    line(`• ${d.name}`, { bold: true });
    line(`    sha256: ${d.sha256}`, { size: 8 });
  }
  y -= 8;

  line("Audit Trail (hash-chained)", { size: 13, bold: true, gap: 20 });
  for (const e of env.audit) {
    line(`#${e.seq} ${e.type} — ${e.at} — by ${e.actor}`, { size: 9 });
    line(`    hash ${e.hash.slice(0, 32)}…`, { size: 7 });
  }
  y -= 8;

  // The consent disclosure each signer agreed to (ESIGN Act / UETA).
  if (env.recipients.some((r) => r.consentedAt)) {
    line("Electronic Record and Signature Consent", { size: 13, bold: true, gap: 18 });
    paragraph(ESIGN_CONSENT.disclosure, 8);
  }

  return pdf.save();
}

/**
 * Append the certificate PDF's pages to the end of a signed document, so the
 * sealed file carries its own certificate of completion (the DocuSign-standard
 * arrangement). Returns the merged bytes.
 */
export async function appendCertificate(
  docBytes: Uint8Array,
  certBytes: Uint8Array
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(docBytes, { ignoreEncryption: true });
  const cert = await PDFDocument.load(certBytes);
  const pages = await doc.copyPages(cert, cert.getPageIndices());
  for (const p of pages) doc.addPage(p);
  return doc.save();
}
