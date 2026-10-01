# finesign-core

**An open-source, self-hostable e-signature engine for PDFs — a DocuSign alternative you own.**

finesign-core takes an unsigned PDF and stamps signatures onto it: a hand-drawn/uploaded
signature image, or a typed name in a handwriting font, plus auto-dating. It finds
the "sign here" spots for you, handles rotated pages correctly, flattens form
fields so nothing paints over the signature, and returns the signed PDF bytes.

It is **bytes-in, bytes-out**. finesign-core does **not** talk to a database, a storage
bucket, an auth system, or the network. That is deliberate — persistence and
identity are your app's concern, and keeping them out is what makes this engine
drop into any stack.

> **Name is a placeholder.** `finesign-core` is a working title — rename freely before
> you publish.

---

## Why

DocuSign and Adobe Sign are SaaS black boxes with per-envelope pricing and your
documents on someone else's servers. For a lot of products you don't need the
SaaS — you need the *engine*: reliably burn a signature onto a PDF at the right
place. That's what this is. Self-host it, keep every document in your own
infrastructure, pay nothing per signature.

## Features

- ✍️ **Two signing modes** — stamp a captured **signature image** onto detected
  fields, or render a **typed name** in one of four handwriting fonts.
- 🔎 **Automatic field detection** — finds `/Sig` signature widgets and
  signature/date form fields straight from the PDF's AcroForm. No AI, no service
  calls.
- 🗓️ **Smart auto-dating** — fills "date signed" fields, including forms that
  split the date into separate MM / DD / YYYY boxes.
- 🔄 **Rotation-correct** — every transform handles `/Rotate` 0/90/180/270; a
  detected anchor round-trips to exactly where the mark lands (proven by tests).
- 🖊️ **Ink-trimming** — crops the whitespace around a canvas-drawn signature so
  it fills the signature line instead of shrinking to a dot.
- 🛡️ **Hardened** — magic-byte PDF/image validation, decompression-bomb guards,
  best-effort flattening that never crashes on a malformed form.
- 📦 **Zero infra** — three runtime deps (`pdf-lib`, `@pdf-lib/fontkit`,
  `@napi-rs/canvas`). No native build step beyond canvas's prebuilt binary.

## Install

```bash
npm install finesign-core   # placeholder name; not yet published
```

Requires Node 18+.

## Quick start

### Sign every field with one captured signature

```ts
import { SignEngine, detectAnchorsFromAcroForm } from "finesign-core";
import fs from "fs";

const pdf = fs.readFileSync("agreement.pdf");

// 1. Find where to sign (straight from the PDF's form fields).
const anchors = await detectAnchorsFromAcroForm(pdf);

// 2. Stamp the captured signature image + auto-date every date field.
const engine = new SignEngine();
const { pdf: signed, signatureCount, dateCount } = await engine.signWithImage(
  pdf,
  anchors,
  signatureDataUrl, // "data:image/png;base64,..." from a canvas or upload
);

fs.writeFileSync("agreement.signed.pdf", signed);
console.log(`stamped ${signatureCount} signatures, ${dateCount} dates`);
```

### Sign with a typed name

```ts
import { SignEngine } from "finesign-core";

const engine = new SignEngine();
const signed = await engine.signWithTypedNames(pdf, [
  {
    signatureName: "Jane Q. Public",
    signatureFont: "great_vibes",
    pageNumber: 1,
    xPercent: 0.12, // display-space fractions (top-left origin) — what a
    yPercent: 0.83, // browser overlay hands you
    scale: 1.3,
  },
]);
```

### Place your own anchors (from a drag-to-place UI)

```ts
import { SignEngine, anchorFromDisplayBox } from "finesign-core";

const anchor = anchorFromDisplayBox({
  box: { x: 0.1, y: 0.82, width: 0.3, height: 0.05 }, // fractions of the page
  page: 1,
  kind: "signature",
});

const { pdf: signed } = await engine.signWithImage(pdf, [anchor], signatureDataUrl);
```

Run the bundled examples against a generated demo form:

```bash
npm run example:detect   # print what gets detected
npm run example:image    # → examples/out/signed-image.pdf
npm run example:typed    # → examples/out/signed-typed.pdf
```

## The one coordinate convention you need to know

finesign-core's public surface speaks **display space**: fractions (0–1) of the
*displayed* page, origin at the **top-left**, y pointing **down** — the natural
coordinates of a page rendered in a browser. Hand it the same numbers your
front-end overlay uses; it deals with PDF user space, the bottom-left origin, and
`/Rotate` internally.

## API surface

| Export | What it does |
| --- | --- |
| `new SignEngine(opts?)` | The engine. `opts`: `fontRegistry`, `now` (inject a clock). |
| `engine.signWithImage(pdf, anchors, image)` | Stamp a signature image + auto-dates. Returns `{ pdf, stamped, signatureCount, dateCount }`. |
| `engine.signWithTypedNames(pdf, placements)` | Render scripted typed names. Returns signed bytes. |
| `detectAnchorsFromAcroForm(pdf, opts?)` | Detect signature/date fields → ready-to-stamp anchors. |
| `detectFields(pdf, opts?)` | Lower-level: detected fields with point-space boxes (build your own review UI). |
| `anchorFromDisplayBox(...)` / `anchorFromPointBox(...)` | Build anchors from a drawn box or a form-schema field. |
| `isPdfBuffer`, `decodeSignatureImage`, `trimSignatureImage` | Guards + image helpers. |
| `FontRegistry` | Register custom signature fonts or a different fonts dir. |
| geometry / stamping primitives | `schemaFieldToDisplayBox`, `displayBoxToPageRect`, `stampImageAnchor`, `flattenForStamping`, … — compose your own flow. |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the internals and
[ROADMAP.md](./ROADMAP.md) for what turns this engine into a full signing
*product* (envelopes, multi-recipient routing, audit trails, cryptographic
signatures).

## What finesign-core is *not* (yet)

This is the **signing engine**, not the whole DocuSign product. It does not (yet)
do envelopes, multi-recipient routing, email delivery, a signer web UI, an audit
trail, or cryptographic/PAdES digital signatures. Signatures are **visual
overlays** (an image/text drawn on the page), not PKI signatures embedded in the
PDF. See the roadmap — these are the intended next layers, and the engine is
designed to sit under them.

## Development

```bash
npm install --legacy-peer-deps
npm run build       # tsc → dist/
npm test            # node:test suite (geometry round-trips + end-to-end signing)
npm run typecheck
```

## License

[Apache-2.0](LICENSE) — the same license as the rest of FineSign. Bundled fonts
(Dancing Script, Great Vibes, Pacifico, Pinyon Script) are under the SIL Open
Font License.
