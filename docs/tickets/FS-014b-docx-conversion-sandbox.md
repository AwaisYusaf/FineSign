# FS-014b — Sandboxed DOCX conversion

| Priority | Size | Milestone | Depends on | Backlog / PRD | Status |
| --- | --- | --- | --- | --- | --- |
| P2 | M | M11 Hardening & operations | — | X.7 | Approved · adversarial review required |

## Problem
LibreOffice already runs with a per-run profile, no first-start wizard and a
timeout (`docx-libreoffice.ts`), but in the same container and network as the
server: a document that exploits LibreOffice gets the server's filesystem,
secrets and network.

## Goal
In the Docker deployment, DOCX conversion runs in a separate, unprivileged
container with no internet access and no access to the server's data or secrets.

**Out of scope:** sandboxing for non-Docker installs beyond documentation;
replacing LibreOffice.

## Design
- A `converter` service: a minimal image with LibreOffice and a tiny HTTP
  endpoint (`POST /convert`, DOCX in, PDF out, size-capped, one request at a time
  per process, timeout), running as a non-root user with a read-only root
  filesystem and a tmpfs for work.
- Networking: the converter joins only an `internal: true` Docker network shared
  with the server (no route to the internet); it has no volumes from the server
  and no FineSign environment variables.
- Server: a `RemoteDocxConverter` adapter implementing `DocumentConverter`
  (selected by `FINESIGN_CONVERTER_URL`), with the same caps and error mapping as
  the local runner; the local runner stays for non-Docker installs.
- Compose profile `sandboxed-docx` (made the default in the shipped compose file
  if it proves reliable in CI).

## API and data changes
New env `FINESIGN_CONVERTER_URL`; new image and compose service.

## Acceptance criteria
1. With the profile, a DOCX upload converts via the converter container and the
   envelope signs end to end.
2. From inside the converter, outbound internet requests fail and the server's
   data directory and env are not visible.
3. A conversion timeout or crash returns 422 to the uploader and the converter
   recovers for the next request.
4. Without `FINESIGN_CONVERTER_URL`, behaviour is unchanged.

## Test plan
- `convert`: `RemoteDocxConverter` against a fake HTTP server (caps, errors).
- Docker CI job: boot the profile, convert and sign a DOCX, run the isolation
  checks from criterion 2 inside the container.

## Security and risks
Isolation is only as good as the container config; documented, CI-verified.

## Docs to update
SECURITY.md, docker README/compose, `.env.example`, CHANGELOG, BACKLOG (X.7).
