#!/bin/bash
# The app (pt.ts) and the Tab's CLI (pulltab.py) must derive the same slug, code and signature from the published
# test vector (secret bytes 0..31), and the relay's answer signature (protocol 3). Usage: test/vectors.sh [python-with-cryptography]
# Each test is TypeScript bundled into one temporary .mjs with esbuild (from test/'s npm install) and run with node.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${1:-python3}
ES=test/node_modules/.bin/esbuild; [ -x "$ES" ] || ES=test/node_modules/esbuild/bin/esbuild
JS=$(mktemp --suffix=.mjs); trap 'rm -f "$JS"' EXIT
"$ES" test/vec/vec.ts --bundle --format=esm --platform=node --log-level=error --outfile="$JS"
APP=$(node "$JS"); TAB=$("$PY" site/files/pulltab.py selftest)
node -e '
const a = JSON.parse(process.argv[1]), t = JSON.parse(process.argv[2]);
const ok = t.ok && t.vector === "matches" && a.slug === t.slug && a.slug === "pt-3n44qqjm4rkb2efcai3m" && a.rt === "hi" && a.parse === true
  && a.sig === "ff05b6c26a9b4ef0d89a65770155f04375e2ef82cc45977d5349f223a47e2209"
  && a.rsig === t.rsig && a.rsig === "178639ff520c6d86ddd733c7c97ceb75ce422cf788dae609f625c96d3827ffaf";
console.log(ok ? "vectors: app and Tab agree" : "vectors: MISMATCH " + JSON.stringify({ a, t })); process.exit(ok ? 0 : 1);' "$APP" "$TAB"
