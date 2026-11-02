#!/bin/bash
# 0.1.10 phone screen check-on-open/resume tests. Results: test/resume-results.txt
# Each test is TypeScript bundled into one temporary .mjs with esbuild (from test/'s npm install) and run with node.
set -euo pipefail
cd "$(dirname "$0")/.."
ES=test/node_modules/.bin/esbuild; [ -x "$ES" ] || ES=test/node_modules/esbuild/bin/esbuild
JS=$(mktemp --suffix=.mjs); trap 'rm -f "$JS"' EXIT
"$ES" test/resume/resume-test.ts --bundle --format=esm --platform=node --log-level=error --outfile="$JS"
node "$JS" | tee test/resume-results.txt
