# Pull Tab architecture

This is the map for a developer opening the repo for the first time. The version history is in
`CHANGELOG.md`; this page explains how the pieces fit together today (v0.1.17).

## What the product is

Pull Tab is an Even Realities G2 glasses app. The wearer triple-taps the temple (or the R1 ring), speaks, and triple-taps
again to send. The recording goes, encrypted, to a small relay that belongs to that person, and the person's own Tab
assistant picks it up, transcribes it and answers by WhatsApp or text message. Nothing is ever answered on the lens.
Double-tap exits.

Three programs make this work, and they live in three different places:

| Program | Where it runs | Source |
|---|---|---|
| The glasses app | Inside the Even app's WebView on the person's phone, talking to the glasses over the Even Hub SDK bridge | `app/` |
| The relay | A Cloudflare Worker with a D1 database, one per person, published by their Tab at `https://pt-<20 chars>.sites.tab.bot` | `site/files/relay-worker.template.mjs` |
| The Tab CLI | On the person's Tab (their AI assistant's own computer) | `site/files/pulltab.py` |

`site/` is also the public docs site (`https://pulltab.sites.tab.bot`): the setup guide a Tab follows (`setup.md`), the
privacy notice, and the two files above, which a Tab downloads during setup.

## Module map

```
app/
  app.json            Even Hub manifest: package id com.billliao.pulltab, version, network whitelist, permissions
  index.html          The phone screen (setup message, pairing code box, connection status, help links)
  vite.config.mjs     Build: injects build-time constants and the SHA-256 of the three downloadable site files
  src/main.ts         The whole app: lens drawing, recording, upload, tap gestures, phone screen, startup
  src/pt.ts           Protocol: key derivation, pairing code, request signing, AES-GCM sealing, relay address check,
                      relay answer signature check
  src/status.ts       Status line on lit screens (time, date, glasses and ring battery)
  src/sent.ts         The "reply coming by WhatsApp/text" word; clearing the copied pairing code from the clipboard
  src/resume.ts       Re-check the relay connection when the phone screen is opened or returned to
site/
  setup.md            Instructions a Tab follows to set up a relay for its person (fingerprinted, see below)
  files/pulltab.py    The Tab's CLI: init, set-mailer, pending, take, done, retire, selftest (fingerprinted)
  files/relay-worker.template.mjs   The relay worker; `pulltab init` fills in the keys (fingerprinted)
  index.html, privacy.md, setup/, privacy/   The public site pages (HTML rendered by tools/pages.py)
tools/pages.py        Renders site/setup/index.html and site/privacy/index.html from markdown
listing/              Even Hub store listing text, icon and screenshots
test/                 Unit tests (*.sh + */*-test.ts), the local end-to-end test (e2e.py) and its rig (rig/)
```

## Pairing and keys

1. On first open the app creates a random 32-byte secret S and stores it in Even's app storage (`pt.secret`).
2. Every key is derived from S with HMAC-SHA256 and a label (`pt.ts keysFrom`):
   - `slug`: the relay's address, `https://pt-<20 base32 chars>.sites.tab.bot`. Because it is derived, the app knows
     where its relay is without being told.
   - `auth`: signs every request the app makes. The relay holds it.
   - `enc`: AES-256-GCM key for the audio. Only the app and the Tab hold it, so the relay cannot listen.
   - `rkey`: the relay signs every answer with it. The app accepts no answer without that signature (pinning). This
     matters because anyone can publish a `*.sites.tab.bot` site, so the address alone proves nothing.
3. The phone screen shows a setup message containing the guide URL, the pairing code (`PT1-` + base32 of S plus a
   2-byte checksum) and the SHA-256 of the three downloadable files.
4. The person pastes that message to their Tab. The Tab follows `setup.md`, checks the fingerprints, runs
   `pulltab init`, publishes the relay, and stores a mail credential for wake-up mails.
5. The app's signed `GET /v1/hello` then succeeds and the app marks itself paired (`pt.paired = "1"`).

## Data flow for one question

```
glasses mic --PCM 16 kHz--> app (phone)                relay (Cloudflare)                 Tab
  triple-tap: mic on          |                            |                               |
  audio chunks (~100 ms)      |                            |                               |
  triple-tap: send            |                            |                               |
                              |--POST /v1/ask (sealed)---->| stores ciphertext, queue <= 8 |
                              |<--signed {id, reply_by}----|--wake mail------------------->|
  lens: "Sent, reply coming   |                            |<--GET /tab/pending, /audio----| decrypts, transcribes
   by WhatsApp." (8 s)        |                            |<--POST /tab/done/<id>---------| then replies by message
  triple-tap within 8 s:      |--POST /v1/ack/<id>, ------>| request deleted / tombstoned  |
   cancel                     |  POST /v1/cancel           |                               |
```

- Requests carry `x-pt-ts` and `x-pt-sig` (HMAC over method, path, timestamp and body hash). The relay rejects bad
  signatures, timestamps more than 10 minutes off its clock, and any signed POST it has seen before (409 `replay`).
- Answers carry `x-pt-rsig`, bound to the request's own signature, so an old answer cannot be replayed.
- The audio's AES-GCM associated data includes the signed timestamp, and the Tab refuses audio older than 15 minutes
  or already taken. The relay deletes every request after 30 minutes (`TTL_MIN`) in any case.
- The app never asks the relay for the answer; the Tab replies on the person's usual channel.

Relay endpoints (see the header of `relay-worker.template.mjs` for details):

| Caller | Endpoint | Purpose |
|---|---|---|
| App | `GET /v1/hello` | Connection check; returns protocol version and whether wake mail is set up |
| App | `POST /v1/ask` | Upload one sealed recording; refused with 429 `queue_full` when 8 are waiting |
| App | `POST /v1/ack/<id>` | Delete a request (cancel after the relay accepted it) |
| App | `POST /v1/cancel` | Tombstone the upload named by its signed timestamp (works even if the upload is still in flight) |
| Tab | `GET /tab/pending`, `GET /tab/audio/<id>`, `POST /tab/status/<id>`, `POST /tab/done/<id>` | List the queue oldest first, fetch one sealed recording, check it is still live, clear it before replying (bearer key, not HMAC) |
| Tab admin | `/admin/health`, `PUT`/`DELETE /admin/mailer`, `/admin/test-wake`, `/admin/purge`, `/admin/retire` | Configuration and shutdown |

## Gestures

The glasses report only CLICK and DOUBLE_CLICK, so the app counts taps itself (`main.ts`, taps section). A burst is taps
less than 700 ms apart.

| Taps | Dark lens / hint / error | Recording | Sending or "Sent" screen |
|---|---|---|---|
| 1 | Shows the usage hint (or clears the hint or error) | Ignored, recording continues | Ignored |
| 2 | Exit menu | Recording dropped (nothing sent), then exit menu | Exit menu |
| 3 | Start recording | Send (the only way anything is sent) | Cancel the request just sent |

A triple-tap acts the moment the count reaches 3, however the glasses split it (2+1, 1+2, 1+1+1). A double-tap acts only
after the 700 ms window closes, so the start of a triple-tap never exits. A hold (long press) does nothing.

## Timing constants and why

| Constant | Value | Why |
|---|---|---|
| `MAX_REC_MS` | 55 s | The relay refuses bodies over 1.8 MB (about 56 s of sealed audio), the limit of one D1 row. A recording that reaches the cap is thrown away, never sent, so nothing leaves without the wearer's send. |
| `MIN_BYTES` | 1 s of audio | Shorter sends are almost always accidental. |
| `TAP_WINDOW_MS` | 700 ms | Fits a deliberate triple-tap; short enough that a single tap feels answered. |
| `SENT_MS` | 8 s | The "Sent" screen, and the window in which a triple-tap can still cancel. |
| `NO_VOICE_MS` | 8 s | Close the mic if nobody speaks, instead of recording silence until the cap. |
| `QUEUE_FULL_MS`, `ERROR_MS`, `HINT_MS`, `CANCELLED_MS`, `NOT_SENT_MS` | 2 to 8 s | Long enough to read the message, then the lens goes dark. |
| Upload deadline | 60 s (`/v1/ask`), 15 s otherwise | Up to 1.8 MB over a phone connection versus tiny JSON calls. |
| Clipboard clear | 30 s | The setup message holds the pairing code; it should not stay on the clipboard. |

## Phone sleep, lock and background

The Even WebView pauses JavaScript timers while the phone is locked or the Even app is in the background. Three things
keep the app correct across that:

- Taps: every event first runs `settleStale()`, which decides any tap burst whose last tap is older than 700 ms by the
  wall clock (`Date.now()` keeps counting through sleep). Without this, a double-tap made just before the phone slept
  could stay open, and the next single tap would make it a triple-tap and start a recording (the 0.1.15 bug).
- The 55 s cap waits while a tap burst is open, so a send that straddles the cap is not thrown away.
- Pairing lives in the bridge's storage, which survives suspend, kill and app update. The phone screen re-checks the
  relay each time it is shown again (`resume.ts`), with no polling.

## Build, test and release

```
cd app && npm ci && npx vite build          # output in app/dist (index.html + one JS bundle)
cd ../test && npm ci && cd ..               # test tools (wrangler, which brings esbuild)
test/relay.sh; test/sent.sh; test/resume.sh; test/status.sh; test/taps.sh
test/vectors.sh python3                     # python with `cryptography`
test/relayworker.sh python3                 # python with `requests` and `cryptography`
python3 test/e2e.py                         # full local run in the Even simulator; needs test/rig/q.pcm
```

Packaging for Even Hub: `npx evenhub pack app.json dist -o pull-tab-<version>.ehpk --sdk-ver 0.0.16` from `app/`, then
upload through the Even Hub developer portal.

### Fingerprinted files: edit with care

`vite.config.mjs` hashes `site/setup.md`, `site/files/pulltab.py` and `site/files/relay-worker.template.mjs` into the
app bundle, and the setup message tells the Tab to refuse any file whose hash differs. Any edit to those three files,
including a comment, changes the app build and must ship together with a new app release and a site deploy. They are
not re-commented on each release for that reason; their own header comments describe them, and this page describes how
they fit in.

### Codes in comments

Codes such as F1 to F13, M1 to M5 and L1 to L7 in comments refer to findings of two private security reviews (of 0.1.8
and 0.1.12). The property each one guards is described beside it.
