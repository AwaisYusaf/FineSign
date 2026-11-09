# FS-010 — HTML email templates and instance branding

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P2 (scheduled before FS-004a so its emails use the templates) | M | M9 Delivery | FS-017 (adds the `voided` email) | parity 15 | Approved · adversarial review required (HTML injection) |

## Problem
Every email is a one-line plain-text message with a bare link (`app.ts`
`notifyBestEffort`). That reads like phishing, tends to land in spam, and gives
the signer no context (who sent it, what it is, when it expires). Replies go to
the instance's from-address, not to the person who sent the envelope. A
self-hoster cannot put their organization's name or logo on emails or pages.

## Goal
Emails are clear multipart (HTML + text) messages with the sender, the title, a
prominent button and the expiry, replies reach the sender, and operators can
brand emails, the signer page and the sign-in page.

**Out of scope:** per-sender branding, DKIM/custom mail domains (the operator's
SMTP), translations (templates are built on message keys so i18n can follow).

## Design
- `Mailer.send` gains optional `html` and `replyTo`; the SMTP adapter sends
  multipart with `Reply-To` set to the envelope's sender (D15 default) for
  envelope emails.
- **The console mailer keeps logging metadata only** (`to`, `subject`,
  `hasLink`) — it must never print a body, because bodies contain signing,
  invitation and reset links (AGENTS.md rule 6).
- `server/src/email/`: one typed template per reason — your_turn, reminder,
  resent, completed_copy, declined, expired, voided (FS-017), invite and reset
  (FS-004a/b) — rendering text and HTML from message keys. **Every interpolated
  value is HTML-escaped** (titles, names, decline and void reasons are user
  input); URLs are emitted only from the server's own base URL. Inline CSS, no
  remote images except an operator-configured https logo, no tracking pixels.
- Branding env: `FINESIGN_BRAND_NAME`, `FINESIGN_BRAND_LOGO_URL` (https only),
  `FINESIGN_BRAND_COLOR` (hex), `FINESIGN_SUPPORT_EMAIL`, validated at boot;
  served unauthenticated at `GET /api/branding` (allowlisted in FS-001a's route
  table) for the signer and sign-in pages, with FineSign defaults.
- The production CSP allows the logo only if configured: the nginx config reads
  the origin from an env-substituted variable, or the server proxies the logo —
  pick the simpler in implementation; no logo by default.

## API and data changes
`Mailer` message `html?`, `replyTo?`; `GET /api/branding`; four env vars.

## Acceptance criteria
1. Each reason produces an HTML and a text part with the title, sender name, the
   action link/button and (when set) the expiry date; envelope emails carry
   `Reply-To: <sender email>`.
2. A title, name or reason containing `<script>`, `"><img onerror=…>` or
   `javascript:` appears inert (escaped) in the HTML.
3. Over the whole server test suite, a capturing logger never receives a signing,
   invitation or reset token (console mailer included).
4. With branding env set, emails, the signer page header and the sign-in page
   show the brand; without it, FineSign defaults.
5. A non-https logo URL or a malformed colour fails boot with a clear message.

## Test plan
- `server`: snapshot per reason; escaping (2); the suite-wide token check (3);
  SMTP adapter multipart + Reply-To via an injected transport; branding route;
  boot validation.
- `e2e`: signer page shows a configured brand name.

## Security and risks
HTML injection into emails (escape-by-default + tests), secrets in logs
(criterion 3), CSP widening (opt-in only). Adversarial review required.

## Docs to update
`.env.example`, README (branding), SECURITY.md (CSP), CHANGELOG.
