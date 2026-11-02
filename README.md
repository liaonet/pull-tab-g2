# Pull Tab

Pull Tab lets you talk to your own Tab assistant (https://tab.bot) from Even Realities G2 glasses.

Triple-tap the temple or ring to start talking, triple-tap again to send. Your Tab replies by WhatsApp or text message, so
turn on notifications for your glasses. Double-tap exits from any screen.

Pull Tab is an independent app. It is not made or endorsed by Even Realities or by Tab.

## Install

Install Pull Tab from Even Hub in the Even app. You also need a Tab assistant. Open Pull Tab on your phone and send the
setup message it shows to your Tab; your Tab sets up a private relay for you in about a minute.

- Setup guide and privacy notice: https://pulltab.sites.tab.bot
- Help: the Pull Tab Discord, https://discord.gg/j4kBHPkvC8

## How it works

Pull Tab never talks to a shared server. Each person gets their own small relay, published by their own Tab at a
`https://pt-<id>.sites.tab.bot` address that only their app and their Tab know.

- On first open the app creates a random 32-byte secret on the phone. The relay address and all keys are derived from
  it, so no relay address or key is built into the app.
- The setup message carries a pairing code made from that secret, plus the SHA-256 fingerprints of the files your Tab
  downloads. Your Tab checks the fingerprints before it builds the relay.
- Each recording is encrypted on the phone with AES-256-GCM using a key only the app and your Tab hold. The relay
  stores ciphertext it cannot read. A request is deleted once your Tab answers or you cancel, is never served after 30
  minutes, and is erased the next time your relay is used.
- Every request is signed (HMAC-SHA256 with a timestamp), and the relay rejects replays. Every answer from the relay is
  signed with the relay's own key, and the app accepts nothing that is not.
- The microphone is on only between your triple-tap to start and your triple-tap to send, for at most 55 seconds. A
  recording that reaches the limit is discarded. Nothing is sent without your tap.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the module map, the protocol, the gestures and the timing constants.

## Repository layout

- `app/`: the G2 app (TypeScript, built with Vite) and its Even Hub manifest `app.json`
- `site/`: the setup guide, the privacy notice, the relay worker template and the Tab's command-line tool
- `tools/`: renders the site pages from Markdown
- `listing/`: Even Hub store text, icon and screenshots
- `test/`: unit tests, the local end-to-end test and its rig

The version history is in [CHANGELOG.md](CHANGELOG.md).

## Build

You need Node.js 22.13 or later (the app alone builds on 20.19 or later; the relay worker test needs `node:sqlite`).

```
cd app
npm ci
npx vite build
```

The build output goes to `app/dist`. To package it for Even Hub, use Even's CLI (installed as a dev dependency):

```
npx evenhub pack app.json dist -o pull-tab.ehpk --sdk-ver 0.0.16
```

Even's CLI is Even Realities' own software under its own licence; it is not part of this project.

## Tests

```
cd test && npm ci && cd ..
test/relay.sh                  # relay address check and key pinning
test/status.sh                 # status line
test/sent.sh                   # reply channel word and clipboard clear
test/resume.sh                 # connection check on open and on return
test/taps.sh                   # tap gestures with timers running and stalled
test/vectors.sh python3        # app and Tab tool agree on the protocol test vector
test/relayworker.sh python3    # relay worker and Tab tool together
python3 test/e2e.py            # local end-to-end run with the Even simulator
```

The Python tests need `cryptography` and `requests`. `e2e.py` also needs `faster-whisper`, a short 16 kHz mono speech
recording at `test/rig/q.pcm` (not included), Linux x64 (the rig uses the Even simulator's linux-x64 build), `Xvfb` and
`xdotool`. The rig clears the simulator's WebKit cache on each run. The tests run locally and contact nothing outside
your machine, apart from the one-time download of the speech model (about 500 MB, from Hugging Face) on the first
`e2e.py` run.

## Licence

Copyright 2026 Bill Liao. Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and
[NOTICE](NOTICE) for third-party components.

The name "Pull Tab" and its icon are not licensed for use by forks or clones. If you publish your own build, please
give it a different name and package id.
