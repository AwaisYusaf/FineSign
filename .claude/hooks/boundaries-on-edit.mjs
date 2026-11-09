#!/usr/bin/env node
// PostToolUse hook (Edit|Write): when an agent edits a file in a PURE package
// (packages/core/src or packages/domain/src), run the architecture boundary check
// right away instead of waiting for the gate. Exit 2 feeds the violation back to
// the agent so it fixes it before moving on; anything else stays silent.
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

let input = "";
for await (const chunk of process.stdin) input += chunk;

let file;
try {
  const payload = JSON.parse(input);
  file = payload?.tool_input?.file_path ?? payload?.tool_response?.filePath;
} catch {
  process.exit(0); // not our payload — never block an edit on a parse problem
}
if (typeof file !== "string") process.exit(0);

const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join("/");
if (!/^packages\/(core|domain)\/src\//.test(rel)) process.exit(0);

const r = spawnSync("bash", ["scripts/check-boundaries.sh"], { cwd: root, encoding: "utf8" });
if (r.status === 0) process.exit(0);

process.stderr.write(
  `Boundary check failed after editing ${rel} — pure packages may not do I/O or import rightward (AGENTS.md, rule 2):\n` +
    `${r.stdout}${r.stderr}`
);
process.exit(2);
