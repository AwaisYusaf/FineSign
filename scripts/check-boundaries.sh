#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Machine-enforced architecture boundaries (FACTORY §1.3 purity + §2 direction).
# Fails if a PURE package (core, domain) does I/O or imports rightward.
#
# Documented exception (ADR-0002): packages/core/src/engine/fonts.ts may use the
# filesystem to lazily load core's OWN bundled font assets. Nothing else may.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
report() { echo "  ✗ BOUNDARY VIOLATION: $1"; fail=1; }

# I/O + rightward-dependency patterns forbidden in pure packages.
FORBIDDEN='from "(node:)?(fs|http|https|net|child_process|dns|tls|cluster|worker_threads)"|require\("(node:)?(fs|http|net|child_process)"\)|better-sqlite3|process\.env|@finesign/(storage|convert|server)'

scan_pure() {
  local pkg="$1"; local dir="packages/$pkg/src"
  [ -d "$dir" ] || return 0
  while IFS= read -r file; do
    # ADR-0002 exception: the core font-asset loader may touch the filesystem.
    if [ "$file" = "packages/core/src/engine/fonts.ts" ]; then
      hits=$(grep -nE "$FORBIDDEN" "$file" | grep -vE '"(node:)?(fs)"|require\("(node:)?fs"\)' || true)
    else
      hits=$(grep -nE "$FORBIDDEN" "$file" || true)
    fi
    if [ -n "$hits" ]; then
      while IFS= read -r line; do report "$pkg: $file:$line"; done <<< "$hits"
    fi
  done < <(find "$dir" -name '*.ts')
}

echo "▶ boundaries: pure-package purity (core, domain)"
scan_pure core
scan_pure domain

# Domain must import only shared + core (no other @finesign/*).
echo "▶ boundaries: domain dependency direction"
bad_domain=$(grep -rnE 'from "@finesign/' packages/domain/src 2>/dev/null | grep -vE '@finesign/shared' || true)
if [ -n "$bad_domain" ]; then
  while IFS= read -r line; do report "domain imports non-shared @finesign pkg: $line"; done <<< "$bad_domain"
fi
# (domain also imports finesign-core, which is unscoped — allowed and not matched above.)

# core must import NO internal package.
bad_core=$(grep -rnE 'from "@finesign/|from "finesign-core"' packages/core/src 2>/dev/null || true)
if [ -n "$bad_core" ]; then
  while IFS= read -r line; do report "core imports an internal package: $line"; done <<< "$bad_core"
fi

if [ "$fail" -eq 0 ]; then
  echo "  ✓ boundaries clean"
else
  echo "  boundaries check FAILED"
fi
exit $fail
