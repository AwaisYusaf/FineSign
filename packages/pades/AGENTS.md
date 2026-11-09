# AGENTS.md — `@finesign/pades`

Read the root [AGENTS.md](../../AGENTS.md) first. **This package is what makes a
FineSign agreement cryptographically defensible. A subtle bug here produces PDFs
that look sealed and are not.** Treat every change as security-sensitive.

## Before you change anything

- Read the relevant design doc and review report: `docs/design/pades-bt-blueprint.md`,
  `docs/design/pades-ltlta-blueprint.md`, `docs/review/pades-*.md`, ADR-0003. The
  reviews list attacks that already worked once; don't reopen them.
- Every change needs tests in `test/` that would catch a forged or tampered document
  (see `pades-security.test.ts` for the style), plus an adversarial review of the diff.
- If the bytes a seal produces change, re-validate them outside this codebase with
  OpenSSL (`openssl cms -verify`, `openssl ts -verify`, `openssl crl -verify`). The
  blueprints show the exact commands. This was done by hand, not in CI.

## Invariants (each one was a real bug)

- **Authenticity comes only from a trusted CAdES signature covering the whole
  document:** `valid = cmsSigs.some(s => s.trusted && s.coversWholeDocument)`. A
  trusted *document timestamp* never makes a document authentic.
- **Trust is bound to the signer certificate.** Resolve the signer by
  issuer+serial / SKI, and check the chain for *that* certificate — never "some
  certificate in the bag chains to a trusted root".
- **Coverage:** no bytes outside the `/ByteRange` except legitimate append-only
  revisions (DSS, `/DocTimeStamp`). Content or overlay changes in an appended
  revision must fail verification.
- **The incremental writer (`incremental.ts`) is byte-preserving.** Earlier
  revisions are never rewritten; pdf-lib has no incremental mode, which is why this
  writer exists.
- **Revocation is checked as of the trusted time** (the timestamp's genTime when
  trusted), not "now".
- Weak digests (SHA-1, MD5) and non-RSA/EC keys are rejected.

## Library quirks

- pkijs: the CMS eContent can arrive as a CONSTRUCTED OCTET STRING; handle both forms.
- node-forge mis-derives the leaf AuthorityKeyIdentifier — test leaf certificates
  omit it on purpose.
- OpenSSL rejects non-minimal DER serial numbers; generators emit minimal DER.
- PKCS#12 loading goes through node-forge and is **RSA-only**; EC keys in a P12 are
  backlog item R.4.

## Ports and wiring

`SigningCredential` (`LocalSigningCredential` today; HSM/KMS implement the same
interface), `TimestampAuthority` and `ValidationDataProvider` each have an
in-process implementation for tests and an HTTP one for production. Tests never
use the network. The server wires sealing in `server/src/sealer.ts` and
`buildSealerFromEnv` in `server/src/container.ts`; `assertSealableLevel` refuses
to boot with a level whose inputs are missing — extend it whenever you add a level
or an input.
