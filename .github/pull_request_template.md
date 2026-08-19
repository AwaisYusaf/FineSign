## What & why

<!-- What changes, and the reason it is worth changing. Link any issue. -->

## Checklist

- [ ] `npm run gate` is green (boundaries + build + type-aware lint + tests + web).
- [ ] New or changed behavior has tests; a bug fix has a regression test that
      fails without the fix.
- [ ] Pure packages (`core`, `domain`) stayed pure — no I/O, no `process.env`.
- [ ] Public API is typed and JSDoc'd; no `any` on a package boundary.
- [ ] Docs updated in the same change (`docs/`, `.env.example`, README) if
      behavior or configuration changed.
- [ ] An ADR in `docs/adr/` for any non-obvious decision.

## Security

<!-- If this touches crypto, auth, tokens, uploads, webhooks, or key handling:
     what threat did you consider, and what stops it? Otherwise write "n/a". -->
