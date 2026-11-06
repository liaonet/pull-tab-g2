#!/bin/bash
# Lifecycle tests (0.1.18, rules changed in 2.0.0): exit signals and the single-instance guard; real app + real SDK, mocked Even host. Results: test/lifecycle-results.txt
# Usage: test/lifecycle.sh   (needs app/ and test/ npm installs; esbuild comes with test/'s wrangler)
# Each test is TypeScript bundled into one temporary .mjs with esbuild (from test/'s npm install) and run with node.
set -uo pipefail
cd "$(dirname "$0")/.."
ES=test/node_modules/.bin/esbuild; [ -x "$ES" ] || ES=test/node_modules/esbuild/bin/esbuild
JS=$(mktemp --suffix=.mjs); trap 'rm -f "$JS"' EXIT
VER=$(node -p 'require("./app/app.json").version')
NODE_PATH=app/node_modules "$ES" test/lifecycle/lifecycle-test.ts --bundle --format=esm --platform=node --log-level=error \
  --alias:@evenrealities/even_hub_sdk=./app/node_modules/@evenrealities/even_hub_sdk/dist/index.js \
  --define:__DOCS__='"https://pulltab.sites.tab.bot"' --define:__TEST_RELAY__='""' --define:__TEST_AUDIO__='""' \
  --define:__VERSION__="\"$VER\"" --define:__DEBUG__=true --define:__FILE_SHA256__='{}' --outfile="$JS" || exit 1
SCEN="boot_sends_no_mic_command
system_exit_idle_then_inert abnormal_exit_idle_pauses_then_tap_resumes abnormal_then_system_exit_turns_off
system_exit_while_recording_drops_it abnormal_exit_while_recording_drops_it
system_exit_while_sending_cancels_upload abnormal_exit_while_sending_cancels_upload
foreground_exit_is_not_an_exit hidden_page_is_not_an_exit
superseded_before_mic_shuts_down superseded_at_first_tap_drops_recording superseded_between_send_taps_sends_nothing
superseded_double_tap_opens_no_exit_menu current_page_keeps_working page_shown_again_reclaims storage_unreadable_carries_on
system_exit_during_slow_draw_uploads_nothing focus_while_hidden_does_not_reclaim
superseded_hint_timer_writes_nothing exit_menu_pending_timer_writes_nothing_relayok"
pass=0; fail=0; : > test/lifecycle-results.txt
for s in $SCEN; do
  line=$(PT_LIFE_SCENARIO=$s timeout 30 node "$JS" 2>&1 | tail -1)
  if echo "$line" | grep -q '"ok":true'; then pass=$((pass+1)); echo "PASS $s" | tee -a test/lifecycle-results.txt
  else fail=$((fail+1)); echo "FAIL $s  $line" | tee -a test/lifecycle-results.txt; fi
done
echo "lifecycle: $pass passed, $fail failed" | tee -a test/lifecycle-results.txt
[ $fail -eq 0 ]
