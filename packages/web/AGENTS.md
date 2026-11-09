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

## Verifying a change

There are no unit or end-to-end tests for the UI yet. Lint and build passing is
not proof that it works: run `finesign-api` + `finesign-web` (`.claude/launch.json`,
or `npm run dev:api` / `npm run dev:web`) and click through the flow you changed —
create an envelope, sign as each recipient, open the completed document.
