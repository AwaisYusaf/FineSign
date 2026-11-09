# @finesign/e2e

Browser end-to-end tests: the web UI's production build (served by `vite preview`)
against the real API (SQLite, local blobs, dev PAdES seal + in-process timestamp
authority), driven by
[Playwright](https://playwright.dev) in Chromium at a desktop and a phone size.

## Run

```bash
npx playwright install chromium   # once per machine (and after Playwright upgrades)
npm run e2e                       # from the repo root: builds, boots both servers, runs everything
```

Useful flags (passed through to Playwright):

```bash
npm run e2e -- tests/signing.spec.ts     # one file
npm run e2e -- -g "access code"          # tests whose title matches
npm run e2e -- --project mobile          # phone viewport only
npm run e2e -- --headed                  # watch it in a real window
npm run e2e -- --ui                      # Playwright's interactive runner
npm run e2e -- --repeat-each=5           # hunt for flakiness
npx playwright show-trace packages/e2e/test-results/<test>/trace.zip   # after a failure
```

The suite boots its own servers on ports **4010** (API) and **5180** (web), so it
runs alongside your dev servers and never touches your dev data. Each run starts
from an empty database in `packages/e2e/.data/`. Your local settings cannot leak
in: the API starts with `FINESIGN_ENV_FILE=none` (no `.env`) and with every
`FINESIGN_*` / `SMTP_*` variable from your shell blanked. It never drains the
webhook outbox, so the suite makes no outbound requests.

## What it covers

| Spec | Scenarios |
| --- | --- |
| `sender.spec.ts` | API-key gate; the five-step wizard end to end (upload, recipients incl. access code + CC, click-to-place fields, remove a field, send with expiry), cross-checked against the API |
| `signing.spec.ts` | Sequential signing with an access code → completion → PAdES seal verified (API + UI) → CC downloads the signed copy; parallel signers at once; sign button gating; required-field rejection; drawn-signature accuracy |
| `lifecycle.spec.ts` | Decline (and cancelling a decline); void; unknown link; remind + resend rotate the link; a double-clicked Remind sends one; webhooks admin |
| `mobile.spec.ts` | Signing on a phone with fields at the left margin; PDF pages fit the screen; signature accuracy in a narrow window |
| `layout.spec.ts` | With classic (space-taking) scrollbars, the fit-to-width viewer settles instead of re-rendering forever |

Expiry is not driven here (it needs a controllable clock); the server's
integration tests cover it with a `FixedClock`.

## Writing tests

- **Locate things the way a person would:** `getByRole`, `getByLabel`, visible
  text. That keeps specs working through a visual redesign. The only test ids are
  on elements with no accessible handle: `pdf-page` (with `data-page` and
  `data-rendered`) and `signature-canvas`. The web UI must keep them.
- **Set up through the API, test through the UI.** `seedSentEnvelope()` in
  `tests/support.ts` builds a sent envelope in milliseconds; spend browser time on
  the behavior under test.
- **Each test makes its own data** and asserts only on it, so tests run in
  parallel against one server.
- **No retries.** A test that only passes on a second try is a bug to fix.
- **Known bugs:** write the test for the correct behavior and mark it
  `test.fail(true, "BACKLOG <id>: …")`. It stays green while the bug exists and
  turns red when the bug is fixed, which is your cue to delete the marker.
