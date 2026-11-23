#!/usr/bin/env bash
# Runs the browser E2E specs in order against a running stack (see e2e/stack.sh). Exit code != 0 on the first failure.
#   E2E_DATABASE_URL=postgresql://migrator:...@localhost:5432/teamos ./e2e/run.sh [spec-substring]
set -euo pipefail
cd "$(dirname "$0")/.."
: "${E2E_DATABASE_URL:?set E2E_DATABASE_URL to the schema-owner connection string of the stack database}"
out=e2e/out; mkdir -p "$out/shots"
export NODE_PATH="${NODE_PATH:-$(npm root -g)}:$(pwd)/node_modules"
fail=0
for spec in e2e/specs/*${1:-}*.js; do
  echo "=== $spec"
  node "$spec" "$out" || { echo "FAILED: $spec" >&2; fail=1; break; }
done
exit $fail
