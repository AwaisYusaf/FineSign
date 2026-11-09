# AGENTS.md — `@finesign/web`

Read the root [AGENTS.md](../../AGENTS.md) first. This covers what is different here.

React 18 + Vite + react-router, **plain JavaScript (JSX)** — not TypeScript (a
migration is planned; see `docs/BACKLOG.md`, "Web UI gaps"). This package has its
own ESLint config (`react-hooks` rules); `npm run gate` runs its lint with zero
warnings allowed and a production `vite build`.

## Rules of the road

- **All HTTP goes through `src/api.js`.** Management calls (`/api/*`) pass
  `auth: true`, which attaches the sender API key from `localStorage`; signer calls
  (`/sign/*`) are authenticated by the token in the URL and send no key.
- **Routes:** `/`, `/new`, `/envelopes/:id`, `/webhooks` sit behind `ApiKeyGate`;
  `/s/:token` is the public signer page. `/sign/*` belongs to the API — never add an
  SPA route under it. In dev, Vite proxies `/api`, `/sign` and `/openapi.json` to
  :4000 (`vite.config.js`).
- **PDFs** render through `components/PdfView.jsx` (pdf.js). Overlays are positioned
  in display-space fractions (0–1, top-left origin) — the same numbers the API stores.
- **`.pdf-overlay` is `pointer-events: none`** so a click falls through to the page
  (that is how a field is dropped). Any interactive control inside it must opt back
  in with `pointer-events: auto` in `styles.css`. Forgetting this once silently
  disabled every signer text field and checkbox.
- **Authenticated downloads** (documents, certificate) need the `Authorization`
  header, so use `openAuthedPdf()` — a plain `<a href>` gets a 401.
- **Signature payload** is exactly `{ kind: "image", dataUrl }` or
  `{ kind: "typed", name, font }`, with `font` from `SIGNATURE_FONTS` in
  `src/config.js`. The server validates the font against `finesign-core`'s list.
- **Dev signer links** come from `GET /api/envelopes/:id/dev-links`, which only works
  when the server runs with `FINESIGN_DEV_EXPOSE_TOKENS=true`.

- **PDF pages fit their container** (max 680px). Never give them a fixed width
  again: on a phone that pushed each page's left edge off-screen, where fields
  could not be tapped. The signature canvas scales pointer coordinates to its
  520x160 drawing surface for the same reason.

## Verifying a change

Run `npm run e2e` from the repo root: the Playwright suite in `packages/e2e`
drives this UI against a real API at desktop and phone sizes (see its README).
It locates elements by role, label and text, plus these test ids, which must
survive any redesign: `pdf-page` (with `data-page` and `data-rendered`) and
`signature-canvas`. For anything the suite does not cover yet, also click through
it yourself with `finesign-api` + `finesign-web` (`.claude/launch.json`).
