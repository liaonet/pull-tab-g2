#!/bin/bash
# 0.1.6 unit tests: relay address check and relay key pinning (test/relay/relay-test.ts). Results: test/relay-results.txt
# Each test is TypeScript bundled into one temporary .mjs with esbuild (from test/'s npm install) and run with node.
set -euo pipefail
cd "$(dirname "$0")/.."
ES=test/node_modules/.bin/esbuild; [ -x "$ES" ] || ES=test/node_modules/esbuild/bin/esbuild
JS=$(mktemp --suffix=.mjs); trap 'rm -f "$JS"' EXIT
"$ES" test/relay/relay-test.ts --bundle --format=esm --platform=node --log-level=error --outfile="$JS"
node "$JS" | tee test/relay-results.txt
