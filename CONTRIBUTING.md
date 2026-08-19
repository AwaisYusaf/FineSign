# Contributing to FineSign

Thanks for helping build an open e-signature platform. This project favors
**small, verifiable changes** over big rewrites.

## Ground rules

1. **`npm run gate` must pass.** It is the single source of truth for "is this
   change OK": architecture boundaries + build + type-aware lint + the full test
   suite + the web app's lint/build. CI runs exactly this on every pull request
   (`.github/workflows/gate.yml`, on Node 20 and 22); run it locally before you push.
2. **New behavior ships with tests.** Domain logic is pure and fast to test; the
   server has HTTP-level integration tests; storage adapters share a contract.
3. **Respect the architecture.** Pure packages (`core`, `domain`) do no I/O and
   never import "rightward" — the boundary check enforces this. Business logic
   lives in services; routes stay thin. See [FACTORY.md](FACTORY.md) and
   [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
4. **Security-sensitive changes** (crypto, auth, webhooks, SSRF, key handling)
   should explain the threat considered and, ideally, add an adversarial test.

## Getting set up

```bash
npm install --legacy-peer-deps                 # the flag is required (peer-dep conflict)
npm run gate                                   # everything green?
cp .env.example .env                           # set FINESIGN_SENDER_API_KEY at minimum
npm start --workspace @finesign/server         # API on :4000
npm run dev --workspace @finesign/web          # web UI on :5173 (proxies to the API)
```

For local end-to-end clicking, also set `FINESIGN_DEV_EXPOSE_TOKENS=true` so the
UI can show signer links instead of you reading them out of the mail log.

Node 20+ recommended. DOCX conversion needs LibreOffice on the host (optional for
most work). SQLite is bundled via `better-sqlite3`.

## Useful commands

| Command | What it does |
| --- | --- |
| `npm run gate` | The full quality gate (run this before every PR). |
| `npm run build` | `tsc -b` across all packages. |
| `npm test -w <pkg>` | Run one package's tests (e.g. `@finesign/domain`). |
| `npm run lint` | Type-aware ESLint. |
| `npm run licenses` | Regenerate the third-party dependency-license report. |
| `docker compose up --build` | The self-host stack (web on :8080), as CI builds it. |

## Making a change

1. Branch off `main`.
2. Keep the diff focused; match the surrounding code's style and comment density.
3. Add/adjust tests. Update the relevant `docs/` file if you change behavior.
4. `npm run gate` → green.
5. Open a PR describing **what** and **why**. Link any issue.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
(Contributor Covenant 2.1).

## Reporting bugs & vulnerabilities

Functional bugs → GitHub issues. Security vulnerabilities → **private** disclosure,
see [SECURITY.md](SECURITY.md). Please don't file security reports as public issues.

## License of contributions

By contributing, you agree your contributions are licensed under the project's
[Apache-2.0](LICENSE) license.
