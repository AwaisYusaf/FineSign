@AGENTS.md

## Claude Code specifics

- **Run the app** with the launch configs in `.claude/launch.json`: `finesign-api`
  (dev settings baked in — API key `dev-sender-key-123456`, dev seal + TSA, signer
  links exposed and pointing at the web UI) and `finesign-web`. Open
  http://localhost:5173 and paste that key.
- **Adversarial review:** for security-sensitive diffs, spawn the
  `adversarial-reviewer` subagent (`.claude/agents/`) and fix every CONFIRMED finding
  with a regression test (FACTORY §4, steps 5–7).
- **Boundary hook:** editing a file in `packages/core` or `packages/domain` runs the
  boundary check automatically. If it reports a violation, fix it before moving on.
- **End of a milestone:** refresh `docs/SESSION-HANDOFF.md` so the next session
  starts from the truth.
