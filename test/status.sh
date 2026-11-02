#!/bin/bash
# Status line tests: formatting and the battery tracker against the real Even Hub SDK with a mocked Even app host.
# Usage: test/status.sh   (needs app/ and test/ npm installs; esbuild comes with test/'s wrangler)
# Each test is TypeScript bundled into one temporary .mjs with esbuild (from test/'s npm install) and run with node.
set -euo pipefail
cd "$(dirname "$0")/.."
ES=test/node_modules/.bin/esbuild; [ -x "$ES" ] || ES=test/node_modules/esbuild/bin/esbuild
JS=$(mktemp --suffix=.mjs); trap 'rm -f "$JS"' EXIT
NODE_PATH=app/node_modules "$ES" test/status/status-test.ts --bundle --format=esm --platform=node --log-level=error \
  --alias:@evenrealities/even_hub_sdk=./app/node_modules/@evenrealities/even_hub_sdk/dist/index.js --outfile="$JS"
OUT=$(node "$JS"); echo "$OUT" > test/status-results.json
node -e 'const r = JSON.parse(process.argv[1]); for (const [k, v] of Object.entries(r.results || {})) if (!v.ok) console.log("FAIL", k, v.detail);
console.log(`status: ${r.pass} passed, ${r.fail} failed${r.error ? " (" + r.error + ")" : ""}`); process.exit(r.fail ? 1 : 0);' "$OUT"
