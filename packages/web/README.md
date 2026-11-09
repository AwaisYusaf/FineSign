# @finesign/web

The FineSign web UI: **React 19 + TypeScript + Vite**, styled with **Tailwind CSS
v4** and **[shadcn/ui](https://ui.shadcn.com)** components, data via **TanStack
Query**, routing via **react-router v7**, documents rendered with **pdf.js**.

Two surfaces:

- **Sender console** (`/`, `/new`, `/envelopes/:id`, `/envelopes/:id/edit`,
  `/webhooks`) — behind the sender API key. A dashboard with status filters and
  search; a five-step envelope wizard (details → documents → recipients →
  click-to-place fields → review & send) whose drafts can be left and resumed; an
  envelope page with live status, reminders, seal verification and the audit
  trail; webhooks admin.
- **Signer page** (`/s/:token`) — public, token-authenticated, no account. A
  progress checklist with "next field", one adopted signature (typed in the exact
  fonts `finesign-core` stamps with, or drawn), explicit ESIGN/UETA consent,
  decline with a reason, and the finished package for download once complete.

Light and dark themes (follows the OS by default), and laid out for phones.

## Why the signer page is `/s/:token`

The API owns `/sign/*` (JSON + PDF bytes). The human-facing page is the SPA route
`/s/:token`, so it never collides with those API routes behind the proxy. The
server builds email links with this path when `FINESIGN_SIGN_PATH=/s`.

## Run it locally

From the repo root, with `.env` set up as `.env.example` describes:

```bash
npm run dev:api    # API on :4000
npm run dev:web    # this app on :5173 (proxies /api and /sign to :4000)
```

Open http://localhost:5173 and enter the sender API key. With
`FINESIGN_DEV_EXPOSE_TOKENS=true` the envelope page shows each signer's link.

## Scripts

```bash
npm run dev        # Vite dev server
npm run build      # typecheck + production build → dist/
npm run typecheck  # tsc (strict)
npm run lint       # eslint (typescript-eslint + react-hooks), zero warnings
```

Browser tests live in [`packages/e2e`](../e2e) (`npm run e2e` from the root).

## Layout

```
src/
  main.tsx, App.tsx          providers, lazy-loaded routes
  index.css                  Tailwind + design tokens (light/dark CSS variables)
  components/ui/             shadcn/ui primitives (vendored; see components.json)
  components/                app components: shell, PdfView, status badge, …
  lib/                       api client + types, auth/theme contexts, formatting
  pages/                     dashboard, envelope detail, webhooks, sign-in
  pages/wizard/              the envelope wizard, one file per step
  pages/sign/                the signer page, signature dialog, drawing pad
```

Every route is its own chunk: a signer never downloads the sender console, and
pdf.js (the largest dependency) loads only on pages that show a document.

## Adding a shadcn/ui component

`components.json` is configured, so `npx shadcn@latest add <component>` works, or
copy the source from ui.shadcn.com. Components import `cn` from `@/lib/utils` and
`radix-ui` primitives.
