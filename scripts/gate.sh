#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# FineSign quality gate (FACTORY §1.2 — "the gate is law").
# Build (with typecheck, in dependency order via project references) + tests
# across all workspaces. Exit 0 == task may be called done. Any red == not done.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
step() {
  local name="$1"; shift
  echo ""
  echo "▶ $name"
  if "$@"; then
    echo "  ✓ $name"
  else
    echo "  ✗ $name FAILED"
    fail=1
  fi
}

# Architecture boundaries: pure packages stay pure, deps point leftward.
step "boundaries" bash scripts/check-boundaries.sh
# Build: `tsc -b` typechecks AND emits every package to its dist/ in dependency
# order, so cross-package test imports resolve to built code.
step "build+typecheck" npx tsc -b
# Lint (FACTORY §1.2 / §3): zero warnings tolerated.
step "lint" npx eslint packages --max-warnings 0
# Only run tests if the build was clean — testing a broken tree wastes signal.
if [ "$fail" -eq 0 ]; then
  step "test" npm run test --workspaces --if-present
else
  echo ""
  echo "  ⤹ skipping tests (build red)"
fi

# Browser E2E specs must keep compiling even where browsers aren't installed;
# running them is `npm run e2e` (CI runs it as its own job).
step "e2e typecheck" npx tsc -p packages/e2e

# Web app (React + TypeScript + Vite) — strict typecheck, its own lint, and a
# production build.
step "web typecheck" bash -c 'cd packages/web && npx tsc -p tsconfig.json'
step "web lint" bash -c 'cd packages/web && npx eslint src --max-warnings 0'
step "web build" bash -c 'cd packages/web && npx vite build'

echo ""
if [ "$fail" -eq 0 ]; then
  echo "═══════════════════════════════════════"
  echo "  GATE GREEN ✓  — task may be marked done"
  echo "═══════════════════════════════════════"
else
  echo "═══════════════════════════════════════"
  echo "  GATE RED ✗   — do NOT mark done"
  echo "═══════════════════════════════════════"
fi
exit $fail
