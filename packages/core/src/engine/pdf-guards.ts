/** Byte-level PDF capability check — the authoritative "can this take a stamp?"
 *  signal. Only real PDF bytes can be signed; anything else should be rejected
 *  before pdf-lib tries to parse it (a parse crash otherwise surfaces as a 500).
 *
 *  Scans the first 1024 bytes for the `%PDF-` magic — some generators emit a BOM
 *  or junk preamble before the header, and conforming readers scan for it too. */
export function isPdfBuffer(buffer: Buffer | Uint8Array): boolean {
  const head = Buffer.from(buffer.subarray(0, 1024)).toString("latin1");
  return head.includes("%PDF-");
}
