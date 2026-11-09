# AGENTS.md — `@finesign/web`

Read the root [AGENTS.md](../../AGENTS.md) first. This covers what is different here.

React 19 + **strict TypeScript** + Vite, Tailwind v4 + shadcn/ui, TanStack Query,
react-router v7. The gate runs this package's typecheck, lint (zero warnings) and
production build; `npm run e2e` drives it in Chromium.

## Rules of the road

- **The web package talks to the API over HTTP only.** Never import server, domain
  or core code. API shapes live in `src/lib/types.ts`; keep them in step with the
  server's JSON by hand.
- **All HTTP goes through `src/lib/api.ts`.** Management calls (`/api/*`) pass
  `auth: true` (the sender key from localStorage); signer calls (`/sign/*`) are
  authenticated by the token in the URL. A rejected key (`isKeyRejection`) signs
  the sender out — don't add other ways to clear the key.
- **Server state lives in TanStack Query** (`["envelopes", cursor]`,
  `["envelope", id]`, `["webhooks"]`, `["session", token]`). Mutations return the
  whole envelope — put it in the cache with `setQueryData`, don't refetch.
- **UI building blocks:** use `src/components/ui/*` (shadcn/ui) and design tokens
  (`bg-primary`, `text-muted-foreground`, `bg-success/15`, …) — never hard-coded
  colours, except the document "paper" (pages, signature boxes) which is white in
  both themes on purpose.
- **Contexts and hooks live in `src/lib/*.ts`, components in `.tsx`.** A file that
  exports a component must not also export hooks or non-primitive constants (React
  Fast Refresh; lint enforces it).
- **Routes:** `/s/:token` is the public signer page; everything else sits behind
  `RequireAuth`. `/sign/*` belongs to the API — never add an SPA route under it.
- **Coordinates:** fields are display-space fractions (0–1, top-left), the API's
  convention. `PdfView` overlays use percentages, so they hold at any size.
- **PDF pages fit their container** (max 680px) and re-render on resize with a
  24px grow margin — never give them a fixed width (a phone pushed page edges
  off-screen) and keep the margin (classic scrollbars made it loop forever). The
  signature pad maps pointer coordinates to its 520x160 surface for the same reason.
- **Production CSP** (`docker/nginx.conf`): `script-src 'self'`. No inline
  scripts (the pre-paint theme script is `public/theme-init.js` for this reason),
  no external fonts or CDNs — fonts are self-hosted via `@fontsource`.
- **Signature fonts** in `SIGNATURE_FONTS` (`src/lib/config.ts`) must match
  `finesign-core`'s list; the server validates the key. Each lists the scripts
  its core font covers (`scripts`), which steers the dialog; the server checks
  every glyph and refuses what a font can't draw (400).
- **What the PDF can print** is mirrored in `src/lib/charset.ts` (text fields:
  WinAnsi only) and `signatureInitials` (`src/lib/format.ts`). Keep both in step
  with the server (`pdf-text.ts`, `initialsOf` in `stamping.ts`) — the preview
  must show what gets stamped.

## Test hooks (keep them)

The e2e suite locates things by role, label and text, plus these test ids:
`pdf-page` (with `data-page` and `data-rendered`) and `signature-canvas`. Placed
fields in the editor are buttons named "<Kind> for <Recipient>", and each page has
a keyboard button "Place <kind> field for <Recipient> on page <n>"; signer fields
are labelled "<Kind> field (required)". Renaming visible labels means updating
`packages/e2e/tests`, deliberately.

## Verifying a change

`npm run e2e` from the repo root. For anything visual, also look at it: run
`finesign-api` + `finesign-web` (`.claude/launch.json`), check light and dark, and
a phone width (390px).
