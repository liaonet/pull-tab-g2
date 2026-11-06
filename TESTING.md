# Testing Pull Tab

Two kinds of test, and the second can't be skipped.

## 1. On this machine (no glasses)

From the repo root, after `npm ci` in `app/` and `test/`:

```
test/lifecycle.sh          # exit signals, pause/resume, single-instance guard, no mic command at launch
test/taps.sh               # tap bursts with timers running and stalled
test/resume.sh             # phone status check on open and on return
test/status.sh             # status line and batteries
test/sent.sh               # channel word, clipboard clear
test/relay.sh              # relay address check and key pinning
test/vectors.sh python3    # app and Tab CLI agree on the protocol test vector
test/relayworker.sh python3   # relay worker and Tab CLI
python3 test/e2e.py        # Even simulator end to end (needs test/rig/q.pcm)
```

All of these use the real app code. None of them contains Even's host: the unit tests mock it, and the simulator
(0.9.5) has none of the Even app's session shutdown code. **0.1.18 passed every one of these tests and still broke
reopening on real phones.** Anything that changes what the app sends the glasses at launch or on exit needs part 2.

## 2. On real glasses, in Even's Beta Testing mode, before any store release

Beta Testing is the only mode Even documents as behaving like a released app. Use the Even app version most people
have (2.4.0 as of Nov 2026) and note the phone (Android or iPhone). Pair the app first, so a triple-tap really opens the
mic.

For each check, write down pass or fail and anything odd (a blank page, "Failed to load", the mic light staying on).

| # | Do this | Pass when |
|---|---|---|
| 1a | Open Pull Tab and, within 3 s (the hint still lit), close it from the phone (the Even app's close for the plugin). Reopen within 5 s. **Do this 3 times in a row.** | It opens every time, showing the hint with the new version. Never "Failed to load: Bad state: Host shutdown did not complete". |
| 1b | Same close with the hint lit, but reopen after 15 s. 3 times. | Same as 1a. |
| 1c | Open Pull Tab, wait until the hint has gone dark (about 6 s), then close from the phone and reopen. 3 times. | Same as 1a. If 1c passes and 1a or 1b fail, a page closed from the phone is still writing to the lens from its timer: report it. |
| 2 | Open Pull Tab, double-tap, confirm Exit on the glasses. Reopen. | The exit menu appears, the app closes, the phone page closes too, and it reopens normally. (If this misbehaves, the battery read Pull Tab makes when the menu opens is the first suspect.) |
| 3 | Open Pull Tab, double-tap, then cancel the exit menu. Triple-tap to record. | The mic opens (or the lens says it was refused and how to recover). |
| 4 | Open Pull Tab. Force-stop the Even app (Android: App info, Force stop; iPhone: swipe it away). Reopen Even, then Pull Tab. | It opens normally. |
| 5a | Open Pull Tab, triple-tap and start talking, then close it from the phone mid-recording. Reopen at once. Repeat 2 times. | Nothing is sent (no reply arrives), the glasses mic indicator goes off, and Pull Tab reopens normally. |
| 5b | Same, but wait 60 s after the close before reopening (the closed page's 55 s recording limit fires in that time). | Same as 5a. |
| 6a | Open Pull Tab, triple-tap, speak, triple-tap to send, then close from the phone while "Sending..." shows. Reopen. | It reopens normally. The request is either cancelled or answered once, never twice. |
| 6b | Send a question; while "Sent, reply coming by ..." shows, double-tap, leave the exit menu up 10 s, then confirm Exit. Reopen. | It reopens normally, and the reply still arrives. |
| 6c | Same as 6b, but cancel the exit menu instead of confirming. | "Sent" goes dark within 8 s, and a triple-tap afterwards starts a new recording (it must not cancel the request already sent). |
| 7 | Open Pull Tab, then open another Even Hub app from the glasses menu (Even's reviewers use Conversate). Then go back to Pull Tab. | The other app opens straight away, and Pull Tab opens again afterwards. |
| 8 | Open Pull Tab. Turn the phone's Bluetooth off for 10 s, then on. When the glasses reconnect, tap once, then triple-tap to record and send. | Pull Tab works again after the tap without being reopened. If it doesn't, note what the lens shows, and whether it stays blank after the tap: this checks how 2.0.0 handles ABNORMAL_EXIT, which Even doesn't document. A blank lens means the page has to be rebuilt after a reconnect. |
| 9 | With Pull Tab open, lock the phone for 2 minutes. Unlock. Triple-tap to record and send. | Works. A locked phone is not an exit. |
| 10 | Normal use: triple-tap, ask a question, triple-tap to send. | "Sent, reply coming by ..." and the Tab answers by message. |
| 11 | On the phone page, tap "Get help on Discord" and "Apply here!". | Each opens its page. (discord.gg redirects to discord.com, which isn't on the network whitelist; if the link dies silently, report it.) |

If any check fails: don't release. Note the Even app version, the phone and the exact text on the phone and lens.
A failed check 1, 4, 5, 6 or 7 that shows "Host shutdown did not complete" is the 0.1.18 class of bug: force-stop the
Even app to recover, and compare what the build sends the glasses at launch and on exit with 0.1.17.
