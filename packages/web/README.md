# @finesign/web

The FineSign web UI — a **React (JavaScript)** app built with Vite. Two surfaces:

- **Sender console** (`/`, `/new`, `/envelopes/:id`) — protected by the sender
  API key. Create an envelope, upload PDF/DOCX documents, add recipients, place
  signature/date/initials fields by clicking on the rendered pages, and send.
- **Signer page** (`/s/:token`) — public, token-authenticated. The signer reviews
  their documents (rendered with pdf.js), draws or types a signature, and signs
  all their fields in one action (or declines).

## Why the signer page is `/s/:token`

The API owns `/sign/*` (JSON + PDF bytes). The human-facing signer *page* is a
separate SPA route, `/s/:token`, so it never collides with those API routes
behind the dev proxy. The server builds signing links with this path when
`FINESIGN_SIGN_PATH=/s` is set (see below).

## Run it locally

1. **Start the API** (from `packages/server`) with dev-friendly settings:

   ```bash
   FINESIGN_SENDER_API_KEY=dev-sender-key-123456 \
   FINESIGN_DEV_EXPOSE_TOKENS=true \
   FINESIGN_BASE_URL=http://localhost:5173 \
   FINESIGN_SIGN_PATH=/s \
   PORT=4000 \
   npm start -w @finesign/server
   ```

   - `FINESIGN_DEV_EXPOSE_TOKENS=true` lets the sender console show signer links
     without reading email. **Never enable in production.**
   - `FINESIGN_BASE_URL` + `FINESIGN_SIGN_PATH` make signing links point at the
     web app's signer route.

2. **Start the web app** (from `packages/web`):

   ```bash
   npm run dev
   ```

   Open http://localhost:5173, enter the sender API key, and create an envelope.
   The Vite dev server proxies `/api` and `/sign` to the API on :4000.

## Scripts

```bash
npm run dev      # Vite dev server (port 5173, proxies to :4000)
npm run build    # production build → dist/
npm run lint     # eslint (react-hooks rules)
```

## Notes / not-yet

- Field placement is one-way in this version (no drag-to-move or delete-field
  endpoint yet). Reload the draft to start fields over.
- Real-time status updates (websockets) are deferred (backlog M5.4); the detail
  page reflects state on load.
- The typed-signature preview uses a system cursive fallback; the *stamped*
  signature uses finesign-core's bundled fonts server-side.
