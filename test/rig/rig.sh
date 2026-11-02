#!/bin/bash
# Local end-to-end rig for Pull Tab: simulator + the docs site + local relay + stub SMTP. Sends nothing anywhere.
# 0.1.6: no switchboard. The test build of the app calls the relay "directly" through netsim.py (a logging pass-through
# that can also play an impostor relay); docs are site/ served as pulltab.sites.tab.bot would serve it.
T=$(cd "$(dirname "$0")" && pwd); A=$T/../../app; W=$T/../node_modules/.bin/wrangler; PY=${PT_PY:-python3}; cd $T
start() { # name cmd...
  local n=$1; shift; setsid nohup "$@" > $T/$n.log 2>&1 < /dev/null & echo $! > $T/$n.pid; }
case "$1" in
 base)
  rm -rf "$HOME/.local/share/com.evenrealities.evenhub-simulator/WebKitCache"   # 0.1.10: never serve a cached older build
  start smtp python3 smtp_stub.py 2525 $T/outbox stubuser stubpass-not-real
  start static python3 -m http.server 5180 --bind 127.0.0.1 --directory $A/dist-test
  start docs python3 -m http.server 8790 --bind 127.0.0.1 --directory $T/../../site
  : > $T/netsim.requests; echo pass > $T/netsim.mode
  start netsim $PY netsim.py 8788 http://127.0.0.1:8787 $T/netsim.mode $T/netsim.requests
  start xvfb Xvfb :77 -screen 0 1280x900x24
  sleep 2
  DISPLAY=:77 start sim $A/node_modules/@evenrealities/sim-linux-x64/bin/evenhub-simulator http://127.0.0.1:5180/index.html --automation-port 9898 --no-glow
  ;;
 relay)
  start relay $W dev -c wrangler-relay.toml --port 8787 --ip 127.0.0.1 --inspector-port 9229
  ;;
 stop)
  for f in $T/*.pid; do kill -- -$(cat $f) 2>/dev/null; kill $(cat $f) 2>/dev/null; rm -f $f; done
  ;;
esac
