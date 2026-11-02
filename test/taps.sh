#!/bin/bash
# 0.1.16 tap tests: the real app + real SDK, mocked Even host, timers running or stalled. Results: test/taps-results.txt
# Usage: test/taps.sh   (needs app/ and test/ npm installs; esbuild comes with test/'s wrangler)
# Each test is TypeScript bundled into one temporary .mjs with esbuild (from test/'s npm install) and run with node.
set -uo pipefail
cd "$(dirname "$0")/.."
ES=test/node_modules/.bin/esbuild; [ -x "$ES" ] || ES=test/node_modules/esbuild/bin/esbuild
JS=$(mktemp --suffix=.mjs); trap 'rm -f "$JS"' EXIT
VER=$(node -p 'require("./app/app.json").version')
NODE_PATH=app/node_modules "$ES" test/taps/taps-test.ts --bundle --format=esm --platform=node --log-level=error \
  --alias:@evenrealities/even_hub_sdk=./app/node_modules/@evenrealities/even_hub_sdk/dist/index.js \
  --define:__DOCS__='"https://pulltab.sites.tab.bot"' --define:__TEST_RELAY__='""' --define:__TEST_AUDIO__='""' \
  --define:__VERSION__="\"$VER\"" --define:__DEBUG__=true --define:__FILE_SHA256__='{}' --outfile="$JS" || exit 1
SCEN="running_double_tap_exits running_single_tap_does_not_record running_triple_tap_records
stalled_single_tap_after_double_tap_does_not_record stalled_double_tap_still_exits_at_next_tap
stalled_double_tap_exits_once_when_timers_resume stalled_late_settle_then_resume_no_second_exit
stalled_triple_tap_1+2_records stalled_triple_tap_2+1_records stalled_triple_tap_1+1+1_records
stalled_triple_tap_after_stale_single_records_once
stalled_single_tap_while_recording_keeps_audio stalled_double_tap_while_recording_exits_on_audio
stalled_triple_during_slow_exit_settle_records running_send_trims_the_send_taps running_single_tap_while_recording_keeps_all_audio
audit_cap_between_send_taps"
pass=0; fail=0; : > test/taps-results.txt
for s in $SCEN; do
  line=$(PT_TAPS_SCENARIO=$s timeout 30 node "$JS" 2>&1 | tail -1)
  if echo "$line" | grep -q '"ok":true'; then pass=$((pass+1)); echo "PASS $s" | tee -a test/taps-results.txt
  else fail=$((fail+1)); echo "FAIL $s  $line" | tee -a test/taps-results.txt; fi
done
echo "taps: $pass passed, $fail failed" | tee -a test/taps-results.txt
[ $fail -eq 0 ]
