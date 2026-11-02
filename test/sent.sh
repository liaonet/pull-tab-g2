#!/bin/bash
# 0.1.8 unit tests for app/src/sent.ts (the channel word, F3 clipboard clear). Results: test/sent-results.txt
# Each test is TypeScript bundled into one temporary .mjs with esbuild (from test/'s npm install) and run with node.
set -euo pipefail
cd "$(dirname "$0")/.."
ES=test/node_modules/.bin/esbuild; [ -x "$ES" ] || ES=test/node_modules/esbuild/bin/esbuild
JS=$(mktemp --suffix=.mjs); trap 'rm -f "$JS"' EXIT
"$ES" test/sent/sent-test.ts --bundle --format=esm --platform=node --log-level=error --outfile="$JS"
node "$JS" | tee test/sent-results.txt
