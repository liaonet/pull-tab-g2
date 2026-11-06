# Changelog

Newest first. Older entries describe the gestures of their time; the README and docs/ARCHITECTURE.md describe the
current version.

## 2.0.0

Fixes 0.1.18's reopen bug. After Pull Tab was closed from the phone, the next open could fail with the Even app's own message "Failed to load: Bad state: Host shutdown did not complete" (force-stopping the Even app cleared it). Before the Even app opens a plugin it shuts down the previous session on the glasses and waits for them to confirm; 0.1.18 sent a mic-close at every launch, even with no mic open, and another while Even was closing the page, and the likely cause is the launch mic-close (not proven: the simulator doesn't contain Even's shutdown code). 2.0.0 sends the glasses no mic command at launch (the only glasses calls are creating the page and drawing on it, as in 0.1.17) and no glasses command on any exit path; on Even's exit signals Pull Tab stops its own work (timers, recording, upload) and leaves the mic to the host, and it closes the mic only if it opened it and only while the page is live. ABNORMAL_EXIT (6) now pauses instead of shutting down (it can also fire when the Bluetooth link drops): work in progress is dropped, nothing is sent to the glasses, and input is ignored until a tap reaches the page again; SYSTEM_EXIT (7) still turns the page off for good. The single-instance launch id from 0.1.18 is kept.

From an external code review and security audit of 2.0.0: timers of a page replaced by a reopen (the hint's clear timer, the minute tick) check the launch id first, so a replaced page sends the glasses nothing (F1); the "Sent" timer and the minute tick stop while Even's exit menu is up and restart if it is cancelled (F2); launch draws the startup hint once, not twice (F3); audio chunks delivered as a view into a larger buffer are read from the right offset (F6); the relay's request id is accepted only as 1-64 letters, digits, `-` or `_` before it goes into a URL path (F7); a store build refuses `PT_DEBUG` outside a separate test output folder (F8).

Refactored and compacted with no other change in behaviour: duplicated recording teardown merged (`endRec`, `halt`), dead code removed, the version history moved out of the code comments into this file, and every comment rewritten to match the code (`app/src/main.ts` 1,027 to 757 lines). New TESTING.md lists the checks that need real glasses, since the simulator can't cover Even's host; any new bridge call at launch or on an exit path gets that checklist before release. `test/lifecycle.sh` now checks that launch sends no mic command, that neither exit signal sends the glasses anything, that an abnormal exit pauses rather than kills, and the two timer cases (21 scenarios). `setup.md`, `pulltab.py` and the relay template are unchanged, so the three file fingerprints are unchanged and existing relays keep working; the protocol stays "3".

## 0.1.18

Lifecycle only: no change to the taps, the lens text, the relay or the protocol. Even's host doesn't always destroy a plugin page closed from the phone (that close sends no exit event), and a relaunch can leave the old page running beside the new one, so the app makes a page that should be gone do nothing. On the host's exit signals (SYSTEM_EXIT 7, ABNORMAL_EXIT 6) the page shuts itself down: the glasses mic is closed, a recording is dropped (never sent), an upload in flight is aborted and cancelled on the relay, every timer and listener is removed, and every later event is ignored. FOREGROUND_EXIT (5) is still not an exit. Single instance: each launch writes a fresh launch id (`pt.instance`) to bridge storage; before opening the mic, before sending, and on the first tap of a burst a page reads it back, and if a newer page has taken over, the older one shuts itself down. A new page takes the glasses mic at boot, and only the current page ever closes it. A hidden phone page (phone locked) is still not an exit; a page that comes back into view claims the launch id again. New `test/lifecycle.sh` (18 scenarios). `setup.md`, `pulltab.py` and the relay template are unchanged, so the three file fingerprints are unchanged.

## 0.1.17

Phone screen only. The Tab invite line now sits directly under the status pill, so it shows without scrolling on both phone screens: the setup screen a new user sees first and the paired screen. It reads "Not Invited to TAB yet? Apply here!" and links to the same invite; it appears once, still above the Privacy statement. Nothing on the lens, the relay, the protocol, `setup.md` or `pulltab.py` changed, so the three file fingerprints are unchanged.

## 0.1.16

A tap burst is also settled by the clock (settleStale() on every event), so a burst timer that stalled while the phone slept can't turn a later single tap into a recording; the double-tap still exits once.

## 0.1.15

The hold gesture is gone; a hold does nothing at all and double-tap exits from any screen.

## 0.1.13

Fixes from an external code review of 0.1.12 with no change of behaviour (storage fallback M5, answer size cap L4, error lookup L5, setup message not kept on the page once paired F3, fewer audio copies, minute timer only while the lens is lit, no logging in store builds, no loudness check after speech is heard, no repeat lens writes), and the current gesture map: triple-tap records, sends, and cancels what was just sent; double-tap exits (see the taps section of app/src/main.ts).

## 0.1.10

Phone screen only. Every button is white. No "Check connection" button: the screen shows the connection status by itself, from the same signed check, once when it opens and once each time the person comes back to it (app/src/resume.ts; no polling). "Make a new pairing code" is now a small "Reset pairing" link at the bottom, with the same two-tap F1 confirmation. The help is three short points. A permanent "Get help on Discord" link sits beside Reset pairing, apart from the 3 points. Under it, "Not a TAB member? Join here" links to a Tab invite; also not a help point.

## 0.1.9

The relay queues up to 8 requests, first in, first out, and the Tab answers the oldest first. With 8 waiting the relay refuses a new upload (signed "queue_full") and the lens shows "8 questions waiting. Try again soon." for QUEUE_FULL_MS, then goes dark; nothing queued is dropped. A triple-tap cancels only the request just sent: the cancel names that upload by its signed timestamp, so the other queued requests are untouched.

## 0.1.8

Answers never appear on the lens; the Tab replies on the person's usual messaging channel, which avoids duplicate answers. After the upload the lens shows "Sent, reply coming by <channel>." / "Triple-tap to cancel." for SENT_MS, then goes dark; a triple-tap while it is up cancels the request on the relay ("Cancelled.", then dark). Once dark, taps behave as idle. The app never asks the relay for an answer (no polling, no answer screen). The channel word: the Tab chooses it at setup (pulltab init --reply-by) from the channel the person uses most, it is built into the relay, and it reaches the app in the relay's signed upload acknowledgement (reply_by); only "WhatsApp" or "text" is shown, anything else (or none) shows as "message". Also from a security audit: the copied setup message is cleared from the clipboard after 30 s (F3), and a relay its Tab retired (F1) unpairs the app.

## 0.1.7

System overlays (a notification, the system menu, the exit dialog; eventType 4/5) never light the lens and never touch a recording, upload, wait or tap burst in progress; a DOUBLE-tap while recording sends (a single tap is ignored, triple-tap still cancels and never sends).

## 0.1.6

The app calls the person's own relay directly. The network whitelist is the one wildcard "https://*.sites.tab.bot"; there is no switchboard. No keys or URLs of any user are built in: the app makes its own secret on first open (see pt.ts), the relay address comes from pairing (derived from the code, or pasted from the Tab) and must be https://<name>.sites.tab.bot, and every relay answer must carry the relay's signature made with the key fixed by the pairing code (pinning), so another *.sites.tab.bot site can't stand in for it.

## 0.1.5

A DOUBLE-tap starts a recording once the tap burst is over (so a triple-tap never starts one), to cut accidental recordings; a single tap while recording sends it, the only way anything is sent; triple-tap cancels. Hold-to-talk is gone (0.1.15: a hold does nothing at all; double-tap exits). Also in this version: touch events need a real tap source (phantom-tap guard), nothing is ever sent by itself (no send on silence; a recording that reaches the 55 s cap is thrown away), and the waiting screen goes dark after 30 s (the answer still lights the lens).
