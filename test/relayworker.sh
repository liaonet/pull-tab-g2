#!/bin/bash
# 0.1.8/0.1.9 relay + Tab-CLI tests (0.1.9: the FIFO queue of 8) (test/relayworker/relayworker-test.ts): the real relay worker on a fake D1 (node:sqlite) and
# the real pulltab.py against it, locally. Usage: test/relayworker.sh [python-with-requests-and-cryptography]
# Each test is TypeScript bundled into one temporary .mjs with esbuild (from test/'s npm install) and run with node.
set -euo pipefail
cd "$(dirname "$0")/.."
ES=test/node_modules/.bin/esbuild; [ -x "$ES" ] || ES=test/node_modules/esbuild/bin/esbuild
JS=$(mktemp -d)/relayworker-test.mjs; trap 'rm -rf "$(dirname "$JS")"' EXIT
"$ES" test/relayworker/relayworker-test.ts --bundle --format=esm --platform=node --log-level=error --outfile="$JS"
PT_PY=${1:-python3} PT_ROOT_REL="$PWD" node --no-warnings "$JS" | tee test/relayworker-results.txt
