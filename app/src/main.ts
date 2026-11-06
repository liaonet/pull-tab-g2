// main.ts: the Pull Tab app for Even Realities G2 glasses (Even Hub package com.billliao.pulltab).
//
// What it does: triple-tap on the glasses starts a recording, a second triple-tap sends it, and the wearer's own Tab
// answers by WhatsApp or text message, never on the lens. A triple-tap while "Sent" is showing cancels that request.
// Double-tap raises Even's exit menu from any screen. CHANGELOG.md has the history of every version.
//
// Where it runs: a small web page (index.html plus this bundle) inside the Even app's WebView on the phone. It reaches
// the glasses only through the Even Hub SDK bridge: lens text, the glasses mic, taps and audio, battery levels, storage
// and the exit menu. The same page is the phone screen used to pair the app with the wearer's Tab.
//
// One question, end to end:
//   1. startRec() asks the bridge for the glasses mic; onAudio() collects 16 kHz 16-bit mono PCM chunks.
//   2. stopRec(true) keeps the audio recorded before the sending taps and calls ask().
//   3. ask() seals the audio (pt.ts seal(): AES-256-GCM with a key only the app and the Tab hold) and POSTs it, signed
//      (pt.ts sign()), to the wearer's own relay at https://<name>.sites.tab.bot/v1/ask.
//   4. Every relay answer must carry the relay's own signature (pt.ts respOk()) or it is rejected.
//   5. The lens shows "Sent, reply coming by WhatsApp/text" for SENT_MS (the cancel window), then goes dark.
//   6. Outside the app, the relay mails the Tab a wake-up; the Tab fetches and decrypts the audio with
//      site/files/pulltab.py and answers on the wearer's usual channel. The app never polls.
//
// Phases (`phase`: what the lens shows and what taps mean):
//   idle       lens dark (or the setup text if not paired). 1 tap: hint. 3 taps: listening.
//   hint       usage help for HINT_MS. A tap clears it. 3 taps: listening.
//   listening  mic open. 3 taps: send. MAX_REC_MS cap or NO_VOICE_MS of silence: nothing sent.
//   sending    upload in flight. 3 taps: cancel.
//   sent       "Sent ..." for SENT_MS. 3 taps: cancel on the relay.
//   error      a message for ERROR_MS (or a shorter dwell). A tap clears it.
//   2 taps from any phase: the exit menu (a recording in progress is dropped first, never sent).
//
// Lifecycle (`life`), see "lifecycle" below. Rule: the app sends the glasses nothing while Even is closing a page.
//   on      normal.
//   paused  after Even's ABNORMAL_EXIT signal: work in progress dropped, input ignored, nothing sent to the glasses,
//           listeners kept. The next tap that reaches the page makes it live again and is handled as usual.
//   off     after SYSTEM_EXIT, or when a newer Pull Tab page has taken over: inert for good, listeners removed.
//
// Concurrency: one JavaScript thread, but handlers await the bridge and the network, so a tap or audio chunk can arrive
// while an earlier handler is paused. `recGen` (bumped on every recording start and stop) makes a mic that opens late
// close again; `sendToken` (bumped on every send, cancel and stop) makes an upload that finishes after a cancel show
// nothing. `phase` is always set before the first await so a second caller sees the new state.
//
// Layout: constants and state, lens, storage, relay, recording, ask, taps, glasses events, lifecycle, phone screen,
// boot. Helpers: pt.ts (crypto, relay address), status.ts (status line), sent.ts, resume.ts.
import {
  waitForEvenAppBridge, CreateStartUpPageContainer, TextContainerProperty, TextContainerUpgrade,
  OsEventTypeList, AudioInputSource,
} from "@evenrealities/even_hub_sdk";
import { Keys, keysFrom, parseCode, random, b64u, unb64u, sign, seal, relayOrigin, defaultRelay, respOk } from "./pt";
import { replyWord, clearClipboardLater } from "./sent";
import { Batteries, statusLine, phoneUses12h } from "./status";
import { checkOnOpenAndResume } from "./resume";

// Build-time constants, replaced with literals by vite.config.mjs (`define`); test-only branches such as
// `if (__TEST_AUDIO__)` are removed from store builds by the minifier.
declare const __DOCS__: string;                         // where the setup guide lives
declare const __TEST_RELAY__: string;                   // test builds only: a local relay; empty in store builds
declare const __TEST_AUDIO__: string;                   // test builds only: a PCM file played as the mic
declare const __VERSION__: string;
declare const __DEBUG__: boolean;                       // console logging (debug and test builds only)
declare const __FILE_SHA256__: Record<string, string>;  // SHA-256 of each file a Tab downloads at setup

// ---------- constants ----------
// MAX_REC_MS 55 s keeps a sealed recording under the relay's 1.8 MB upload limit (about 56 s of audio).
// MIN_BYTES is 1 s of audio: anything shorter is almost certainly an accidental start.
// SENT_MS is both how long "Sent" stays and how long a triple-tap can still cancel the request.
// EXIT_AGAIN_MS: a repeated exit request this soon is ignored, so a jittery double-tap raises the menu once.
const GUIDE = __DOCS__ + "/setup.md";
const NAME = "Pull Tab";
const PROTOCOL = "3";                 // must match the relay's VERSION (3: the relay signs its answers)
const RATE = 16000;
const MAX_REC_MS = 55_000;
const MIN_BYTES = 32000;
const NOT_SENT_MS = 2500;             // "Not sent" after a recording hit the cap
const SENT_MS = 8000;
const CANCELLED_MS = 2000;
const QUEUE_FULL_MS = 4000;
const EXIT_AGAIN_MS = 1500;
const NO_VOICE_MS = 8000;             // mic closed, nothing sent, if nobody speaks for 8 s
const ERROR_MS = 8000;
const HINT_MS = 6000;
const TAP_WINDOW_MS = 700;            // a burst of taps is over 0.7 s after its last tap
const VOICE_RMS = 700;                // a chunk louder than this counts as speech (above room noise, below speech)
const MAX_ANSWER = 16 * 1024;         // largest relay answer read
const BLANK = " ";

// ---------- state ----------
type Phase = "idle" | "hint" | "listening" | "sending" | "sent" | "error";
let bridge: any;
let keys: Keys;
let relayUrl = "";                    // the paired relay's origin, always checked by relayOrigin() first
let paired = false;
let phase: Phase = "idle";
let life: "on" | "paused" | "off" = "on";
let chunks: Uint8Array[] = [];
let recBytes = 0;
let recTimer: any = null;
let recGen = 0;
let micMine = false;                  // Pull Tab asked the glasses for the mic and hasn't asked to close it since
let exitDialogUsed = false;           // the exit menu was raised at least once (the mic can be refused afterwards)
let silenceMs = 0, heardVoice = false;
let burstBytes = -1;                  // recBytes when a tap burst began while recording; a send keeps only audio before it
let sentId: string | null = null;     // the request on the "Sent" screen, cancellable by a triple-tap
let askTs: string | null = null;      // the signed timestamp of the upload just started; a cancel names only this one
let sendToken = 0;
let sendCtl: AbortController | null = null;
const INSTANCE_KEY = "pt.instance";   // bridge storage, shared by every page of the app: the newest page's launch id
let instanceId = "";
const offs: (() => void)[] = [];      // removers for every listener this page added

const DEBUG = __DEBUG__ || !!__TEST_AUDIO__ || !!__TEST_RELAY__;
const log = (...a: any[]) => { if (DEBUG) console.log("[pull-tab]", ...a); };
const $ = (id: string) => document.getElementById(id) as any;
const live = () => life === "on";
const isOff = () => life === "off";

// ---------- lens ----------
// One text container (id 1) fills the 576 x 288 lens. Every lit screen starts with the status line (clock, date,
// batteries); a dark lens is a single space.
const MAIN = { containerID: 1, containerName: "main" };
let batteries: Batteries | null = null;
let h12 = false;
let lensBody = BLANK;                 // the last body drawn, without the status line (redrawn when the line changes)
let onLens = "";                      // what the glasses last confirmed; "" forces the next write
let minuteTimer: any = null;
const TE = new TextEncoder(), TD = new TextDecoder();
const utf8Len = (s: string) => TE.encode(s).length;
const cutBytes = (s: string, max: number) => { let out = ""; for (const ch of s) { if (utf8Len(out + ch) > max) break; out += ch; } return out; };
const withStatus = (text: string) =>
  text.trim() ? statusLine(new Date(), h12, batteries?.glasses ?? null, batteries?.ring ?? null) + "\n" + text : text;

/**
 * Draws `text` (without the status line) on the lens and mirrors it to the phone page's "lens" box.
 * Skips a write identical to what the glasses already show. Text is cut to 1,990 characters; a refused write is
 * retried once cut to 990 UTF-8 bytes (the simulator refuses more than 999), and leaves `onLens` empty so the next
 * call sends again. Draws nothing unless the page is live.
 */
async function show(text: string) {
  if (!live()) return;
  lensBody = text;
  text = withStatus(text);
  if (!text.trim()) { clearTimeout(minuteTimer); minuteTimer = null; } else if (!minuteTimer) scheduleMinute();
  const t = text.length > 1990 ? text.slice(0, 1987) + "..." : text;
  const el = $("lens"); if (el) el.textContent = t.trim() ? t : "(lens dark)";
  if (__TEST_AUDIO__) DEBUG && log("lens:", JSON.stringify(t));
  if (!bridge || t === onLens) return;
  onLens = t;
  let ok: any = false;
  try { ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({ ...MAIN, content: t })); } catch (e) { DEBUG && log("upgrade failed", e); }
  if (ok !== false) return;
  if (onLens === t) onLens = "";
  if (utf8Len(t) > 999) { try { await bridge.textContainerUpgrade(new TextContainerUpgrade({ ...MAIN, content: cutBytes(t, 990) + "..." })); } catch {} }
}
/** Redraws a lit lens when its status line has changed (minute tick, battery level). */
async function refreshStatus() {
  if (lensBody.trim() && withStatus(lensBody) !== onLens) await show(lensBody);
}
/** Fires just after each wall-clock minute while the lens is lit, so the clock changes on the minute. */
function scheduleMinute() {
  clearTimeout(minuteTimer);
  if (!live()) return;
  minuteTimer = setTimeout(async () => {
    minuteTimer = null;
    if (!(await stillCurrent("minute tick")) || !live()) return;        // a replaced or paused page's tick sends nothing
    if (lensBody.trim()) scheduleMinute();
    refreshStatus().catch(() => {});
  }, 60_000 - (Date.now() % 60_000) + 50);
}

const LAUNCH = `${NAME} v${__VERSION__}`;
const IDLE = `${LAUNCH}\n\nTriple-tap to listen, send / cancel.\nDouble-tap to exit.`;
const UNPAIRED = `${LAUNCH}\n\nNot connected to your Tab yet.\nOn your phone, open Pull Tab in the Even app\nand send the setup message to your Tab.\n\nDouble-tap to exit.`;
const NEEDS_SETUP = `${NAME}\n\nSet up Pull Tab on your phone first.`;
const NOT_SENT = `${NAME}\n\nNot sent.\nThe recording hit the 55 s limit.`;
const QUEUE_FULL = `${NAME}\n\n8 questions waiting.\nTry again soon.`;
const sentScreen = (word: string) => `${NAME}\n\nSent, reply coming by ${word}.\nTriple-tap to cancel.`;

let clearTimer: any = null;
// Stops a pending return-to-dark, e.g. because a new screen replaced the temporary one.
function cancelClear() { clearTimeout(clearTimer); clearTimer = null; }
function armClear(ms: number) { cancelClear(); if (live()) clearTimer = setTimeout(() => { clearLens("timer").catch(() => {}); }, ms); }
/**
 * Returns the lens to rest (dark when paired, the setup text when not) and closes the "Sent" cancel window.
 * Does nothing while recording or uploading: those screens end with their own flow.
 */
async function clearLens(why: string) {
  cancelClear();
  // A timer's clear first checks that no newer page has replaced this one (a replaced page sends the glasses nothing),
  // and gives way if another screen armed its own timer meanwhile.
  if (why === "timer" && (!(await stillCurrent("clear timer")) || clearTimer)) return;
  if (phase === "listening" || phase === "sending") return;
  phase = "idle"; sentId = null; askTs = null;
  DEBUG && log("lens cleared", why);
  await show(paired ? BLANK : UNPAIRED);
}
async function showFor(p: Phase, text: string, ms: number) { if (!live()) return; phase = p; await show(text); armClear(ms); }
const showError = (text: string) => showFor("error", text, ERROR_MS);
async function showHint() { if (paired) await showFor("hint", IDLE, HINT_MS); else { phase = "idle"; cancelClear(); await show(UNPAIRED); } }

// ---------- storage ----------
// Bridge storage (kept by the Even app per plugin) holds pt.secret, pt.relay, pt.paired and pt.instance. The WebView's
// localStorage is only a fallback for a bridge call that fails.
async function save(k: string, v: string) {
  try { await bridge.setLocalStorage(k, v); } catch { localStorage.setItem(k, v); return; }
  try { localStorage.removeItem(k); } catch {}
}
async function load(k: string) {
  let v = ""; try { v = (await bridge.getLocalStorage(k)) || ""; } catch {}
  if (v) return v;
  try { return localStorage.getItem(k) || ""; } catch { return ""; }
}

// ---------- relay ----------
class NotYourRelay extends Error {}
const tooLarge = () => new Error("relay answer too large");
/**
 * fetch() with one deadline covering the body as well, and a MAX_ANSWER cap on the body.
 * @returns the Response (body already read) and the body bytes. @throws on network failure, timeout or a large answer.
 */
async function timedFetch(url: string, init: any, ms: number, ctl = new AbortController()) {
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    if (Number(r.headers.get("content-length") || 0) > MAX_ANSWER) throw tooLarge();
    const reader = r.body?.getReader();
    if (!reader) { const b = new Uint8Array(await r.arrayBuffer()); if (b.byteLength > MAX_ANSWER) throw tooLarge(); return { r, bytes: b }; }
    const bytes = new Uint8Array(MAX_ANSWER); let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        if (size + value.byteLength > MAX_ANSWER) throw tooLarge();
        bytes.set(value, size); size += value.byteLength;
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return { r, bytes: bytes.slice(0, size) };
  } finally { clearTimeout(timer); }
}

const relayBase = () => __TEST_RELAY__ || relayUrl || defaultRelay(keys);
type Answer = { status: number; ok: boolean; j: any };
/**
 * One signed request to the paired relay (x-pt-ts, x-pt-sig; pt.ts sign()). The answer must carry x-pt-rsig, made with
 * the key only a relay set up from this pairing code holds and bound to this request's signature, or NotYourRelay is
 * thrown whatever the status. Uploads get 60 s (up to 1.8 MB over a phone link), everything else 15 s.
 * redirect "error" keeps the app inside its network whitelist.
 * @param ts the signed timestamp; ask() passes its own so the same value also seals the audio.
 */
async function relay(method: string, path: string, body?: Uint8Array, ts = String(Date.now())): Promise<Answer> {
  const b = body || new Uint8Array(0);
  const sig = sign(keys, method, path, ts, b);
  const headers: any = { "x-pt-ts": ts, "x-pt-sig": sig };
  if (body) headers["content-type"] = "application/octet-stream";
  const isAsk = path === "/v1/ask";
  const { r, bytes } = await timedFetch(`${relayBase()}${path}`, { method, headers, body: body ? b : undefined, redirect: "error" },
    isAsk ? 60_000 : 15_000, isAsk ? (sendCtl = new AbortController()) : undefined);
  if (!respOk(keys, r.status, sig, bytes, r.headers.get("x-pt-rsig"))) { DEBUG && log("relay answer not signed by the paired relay", r.status, path); throw new NotYourRelay(String(r.status)); }
  let j: any = {}; try { j = JSON.parse(TD.decode(bytes)); } catch {}
  return { status: r.status, ok: r.status >= 200 && r.status < 300, j: j && typeof j === "object" ? j : {} };
}
/** Drops a request from the relay's queue (best effort). */
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/;   // a relay id goes into a URL path: only this shape is used
const ack = (id: string | null) => { if (id && paired && ID_OK.test(id)) relay("POST", "/v1/ack/" + id).catch(() => {}); };
/** Withdraws the upload signed with timestamp `ts`, whether or not the relay has taken it yet (best effort). */
const cancelOnRelay = (ts: string | null) => { if (ts && paired) relay("POST", "/v1/cancel", TE.encode(ts)).catch(() => {}); };

const RETIRED = "Your Tab shut down the relay for this pairing code. Tap Reset pairing below, then send the setup message to your Tab.";
const NOT_YOURS = "That relay didn't prove it's yours (it isn't the one set up from this pairing code). Send the setup message below to your Tab again.";
async function unpair(msg: string) { paired = false; await save("pt.paired", ""); renderPhone(msg); return false; }
/**
 * Signed hello: is the relay up, set up from this pairing code, and on PROTOCOL? Updates `paired` and the phone status.
 * @returns true when connected; false when the relay is definitely not this code's (the app unpairs); null when it
 *   can't tell (offline, relay not published yet, unexpected status), and then nothing changes.
 */
async function checkPaired(): Promise<boolean | null> {
  try {
    const { ok, status, j } = await relay("GET", "/v1/hello");
    if (ok && j.ok && j.version !== PROTOCOL) return unpair("Your Tab's relay is out of date. Send the setup message below to your Tab again.");
    if (ok && j.ok) { paired = true; await save("pt.paired", "1"); renderPhone(j.mail ? "Connected to your Tab." : "Relay is up, but your Tab hasn't set up its wake-up mail yet."); return true; }
    if (status === 401) return unpair("Your relay doesn't recognise this pairing code. Send the code below to your Tab again.");
    if (status === 410 && j.error === "retired") return unpair(RETIRED);
    renderPhone(`Couldn't check (error ${status}).`); return null;
  } catch (e) {
    if (e instanceof NotYourRelay) return unpair(NOT_YOURS);
    DEBUG && log("hello failed", e);
    renderPhone(paired ? "Not connected: can't reach your relay. Is your phone online?" : "Not connected yet. If your Tab is still setting up, come back here once it says it's ready.");
    return null;
  }
}

// ---------- recording ----------
/** Audio chunks arrive as a Uint8Array, a number array, a base64 string or another typed array, by SDK and platform. */
function toBytes(pcm: any): Uint8Array {
  if (pcm instanceof Uint8Array) return pcm;
  if (Array.isArray(pcm)) return Uint8Array.from(pcm);
  if (typeof pcm === "string") return Uint8Array.from(atob(pcm), (c) => c.charCodeAt(0));
  if (pcm && pcm.buffer) return new Uint8Array(pcm.buffer, pcm.byteOffset || 0, pcm.byteLength ?? pcm.buffer.byteLength);   // a view, not its whole buffer
  return new Uint8Array(0);
}
/** Root-mean-square loudness of 16-bit little-endian PCM (0 to 32767). */
function rms(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength); let s = 0; const n = b.byteLength >> 1;
  for (let i = 0; i < n; i++) { const x = v.getInt16(i * 2, true); s += x * x; }
  return n ? Math.sqrt(s / n) : 0;
}
/**
 * Asks the glasses to close the mic, only if Pull Tab asked for it and the page is live. A close for a mic Pull Tab
 * never opened, or one sent while Even is closing the page, is what 0.1.18 got wrong (CHANGELOG.md).
 */
function micOff() {
  const mine = micMine; micMine = false;
  return mine && live() ? Promise.resolve(bridge.audioControl(false)).catch(() => {}) : Promise.resolve();
}
async function micOn() {
  micMine = true;                     // asked for: a close follows even if the host refuses or the answer is late
  return (await Promise.resolve(bridge.audioControl(true, AudioInputSource.Glasses)).catch(() => false)) || !!__TEST_AUDIO__;
}
/** Ends the current recording's timer and generation and closes the mic; the audio itself is left to the caller. */
function endRec() { clearTimeout(recTimer); recTimer = null; recGen++; return micOff(); }
/**
 * Starts a recording: opens the glasses mic, shows the listening screen and arms the 55 s cap. Not paired: shows
 * NEEDS_SETUP and opens nothing. After every await the recording is re-checked (`recGen`, `phase`), because a cancel or
 * an exit may have ended it meanwhile; a mic that opened late is then closed again.
 */
async function startRec() {
  if (phase === "listening" || !live()) return;
  if (!paired) return showError(NEEDS_SETUP);
  cancelClear();
  burstBytes = -1; chunks = []; recBytes = 0; silenceMs = 0; heardVoice = false;
  phase = "listening";
  const myRec = ++recGen;
  const current = () => myRec === recGen && phase === "listening";
  if (!(await stillCurrent("mic")) || !current()) return;
  let ok = await micOn();
  if (!current()) return void micOff();
  if (!ok && exitDialogUsed) {        // the mic can be refused after a cancelled exit menu: close, wait, ask once more
    DEBUG && log("mic refused after the exit dialog; asking once more");
    await micOff(); await new Promise((r) => setTimeout(r, 300));
    if (!current()) return;
    ok = await micOn();
    DEBUG && log("mic re-arm", ok ? "worked" : "refused again");
    if (!current()) return void micOff();
  }
  if (!ok) {
    await micOff();
    return showError(exitDialogUsed ? `${NAME}\n\nThe glasses refused the mic after the exit menu.\nDouble-tap to exit, then reopen Pull Tab.` : `${NAME}\n\nCouldn't open the glasses mic.\nCheck the mic permission, then try again.`);
  }
  await show(`${NAME}  * listening\n\nTriple-tap to send.\nDouble-tap to exit.`);
  if (!current()) return;
  recTimer = setTimeout(function cap() {
    if (!current()) return;
    if (taps > 0) { recTimer = setTimeout(cap, 1000); return; }    // a burst (maybe a send) is being decided: look again
    discardRec("cap");
  }, MAX_REC_MS);
  if (__TEST_AUDIO__) feedTestAudio();
}
/** Stores one chunk (about 100 ms) and, until speech is heard, ends a silent recording. Never sends by itself. */
function onAudio(ev: any) {
  if (phase !== "listening") return;
  const b = toBytes(ev.audioPcm);
  if (!b.byteLength) return;
  chunks.push(b); recBytes += b.byteLength;
  if (heardVoice) return;
  if (rms(b) > VOICE_RMS) { heardVoice = true; silenceMs = 0; }
  else if (taps === 0) { silenceMs += (b.byteLength / 2 / RATE) * 1000; if (silenceMs > NO_VOICE_MS) stopRec(false, true); }
}
/** The 55 s cap: the recording is thrown away, never sent. A page a newer one replaced leaves the mic alone. */
async function discardRec(why: string) {
  if (phase !== "listening" || !(await stillCurrent("cap")) || phase !== "listening") return;
  chunks = []; recBytes = 0; resetTaps();
  await endRec();
  DEBUG && log("recording discarded, not sent:", why);
  phase = "error";
  await show(NOT_SENT); armClear(NOT_SENT_MS);
}
/**
 * Ends the recording and either sends it (a triple-tap) or drops it.
 * @param silent stopped by the no-voice timeout: shows "Didn't hear anything".
 * When a tap burst began while recording, only the audio before its first tap is sent (`burstBytes`).
 */
async function stopRec(send: boolean, silent = false) {
  if (phase !== "listening") return;
  phase = send ? "sending" : "idle";  // claimed before any await, so a second caller can't send twice
  askTs = null;
  const tok = sendToken;
  await endRec();
  if (tok !== sendToken) return;      // cancelled or stopped while the mic was closing
  if (silent) { chunks = []; return showError(`${NAME}\n\nDidn't hear anything.\nTriple-tap to try again.`); }
  if (!send) { chunks = []; return clearLens("cancelled"); }
  const keep = burstBytes >= 0 ? Math.min(burstBytes, recBytes) : recBytes;
  if (keep < MIN_BYTES) { chunks = []; return showError(`${NAME}\n\n${ERRORS.too_short}`); }
  await ask(takeRecording(keep));
}
/** Joins the first `limit` bytes of the recording into one buffer and releases the chunks. */
function takeRecording(limit: number) {
  const pcm = new Uint8Array(limit); let o = 0;
  for (const c of chunks) { if (o >= limit) break; const n = Math.min(c.byteLength, limit - o); pcm.set(c.subarray(0, n), o); o += n; }
  chunks = [];
  return pcm;
}
async function feedTestAudio() {     // test builds only
  const b = new Uint8Array(await (await fetch(__TEST_AUDIO__)).arrayBuffer());
  for (let o = 0; o < b.byteLength && phase === "listening"; o += 3200) {
    onAudio({ audioPcm: b.slice(o, o + 3200) }); await new Promise((r) => setTimeout(r, 100));
  }
}

// ---------- ask (upload) ----------
// The relay's signed error codes, as the lens words them. Anything else shows "Error <status>".
const ERRORS: Record<string, string> = {
  bad_signature: "Your relay doesn't know this pairing code.",
  clock: "Your phone's clock is off. Check date & time settings.",
  not_configured: "Your Tab hasn't finished setting up the relay.",
  rate_limited: "Too many asks this hour.",
  wake_failed: "Couldn't wake your Tab (its mail failed).",
  too_large: "That was too long. Keep it under a minute.",
  too_short: "That was too short.\nTriple-tap, speak, then triple-tap to send.",
  replay: "That request was already sent.",
  cancelled: "Cancelled.",
  retired: "Your Tab shut down this pairing code.\nSet up Pull Tab again on your phone.",
  relay_error: "Your relay had a problem. Ask your Tab to check it.",
};
/**
 * Seals and uploads one recording and shows the outcome. The seal's associated data names the sample rate and the
 * signed timestamp, so the Tab can reject audio that is stale, replayed or moved to another request. A cancel during
 * the upload bumps `sendToken`; the result is then dropped (and removed from the relay if it was taken).
 * Handled: 410 retired (unpair), 429 queue_full (8 already waiting; nothing queued is lost), other relay error codes
 * (ERRORS), a network failure, and a relay that fails the signature check.
 */
async function ask(pcm: Uint8Array) {
  phase = "sending";
  const before = sendToken;
  if (!(await stillCurrent("send")) || before !== sendToken) return;
  const ts = String(Date.now()); askTs = ts;   // set before the next await: a cancel from here on names this upload
  await show(`${NAME}\n\nSending...`);
  if (!live() || sendToken !== before) return; // cancelled or stopped while "Sending..." was drawn: upload nothing
  const token = ++sendToken;
  try {
    const box = seal(keys, pcm, `pulltab/audio/${RATE}/${ts}`); pcm = new Uint8Array(0);
    const { ok, status, j } = await relay("POST", "/v1/ask", box, ts);
    if (token !== sendToken) { ack(j.id); return; }
    if (status === 410 && j.error === "retired") { await unpair(RETIRED); return showError(`${NAME}\n\n${ERRORS.retired}`); }
    if (status === 429 && j.error === "queue_full") return showFor("error", QUEUE_FULL, QUEUE_FULL_MS);
    if (!ok || typeof j.id !== "string" || !ID_OK.test(j.id)) return showError(`${NAME}\n\n${Object.prototype.hasOwnProperty.call(ERRORS, j.error) ? ERRORS[j.error] : `Error ${status}.`}\nTriple-tap to try again.`);
    const word = replyWord(j.reply_by);       // "WhatsApp" or "text" from the signed acknowledgement, else "message"
    sentId = j.id; phase = "sent";
    DEBUG && log("sent", j.id, "reply by", word);
    await show(sentScreen(word));
    if (phase === "sent" && sentId === j.id) armClear(SENT_MS);
  } catch (e) {
    DEBUG && log("ask failed", e);
    if (token !== sendToken) return;
    if (e instanceof NotYourRelay) { await unpair(NOT_YOURS); return showError(`${NAME}\n\nThat isn't your relay.\nSet up Pull Tab again on your phone.`); }
    await showError(`${NAME}\n\nCouldn't reach your relay.\nIs the Even app open with internet?\nTriple-tap to try again.`);
  }
}

// ---------- taps ----------
// The glasses report CLICK (1 tap) and DOUBLE_CLICK (2); there is no triple event. Taps are counted into a burst: a
// burst reaching 3 acts at once (onTriple); 1 or 2 taps are decided TAP_WINDOW_MS after the last tap (resolveTaps).
// The WebView pauses timers while the phone is locked, so a burst whose timer stalled is settled by the clock when the
// next event arrives (settleStale).
let taps = 0;
let tapTimer: any = null;
let burstPhase: Phase = "idle";       // the phase when the burst's first tap landed
let lastTapAt = 0;
let exitAskedAt = 0;
function resetTaps() { clearTimeout(tapTimer); tapTimer = null; taps = 0; }
function settleStale() {
  if (taps > 0 && Date.now() - lastTapAt > TAP_WINDOW_MS) { DEBUG && log("tap burst settled late", taps); return resolveTaps(); }
  return undefined;
}
/**
 * Adds `n` taps to the burst. The first tap of a burst also clears an error or hint (the wearer is done reading) and,
 * while recording, marks where the audio stood in case the burst becomes a send.
 */
async function onTap(n: number) {
  lastTapAt = Date.now();             // before any await: a tap during a late settle still extends this burst
  const first = taps === 0;
  if (first) { burstPhase = phase; stillCurrent("tap").catch(() => {}); }
  taps += n; clearTimeout(tapTimer); tapTimer = null;
  if (taps >= 3) { DEBUG && log("taps", taps, "-> triple"); resetTaps(); await onTriple(); return; }
  tapTimer = setTimeout(() => { resolveTaps().catch((x) => DEBUG && log("tap error", x)); }, TAP_WINDOW_MS);
  if (!first) return;
  if (phase === "listening") { burstBytes = recBytes; DEBUG && log("tap while recording"); }
  else if (phase === "error" || phase === "hint") await clearLens("tap");
}
async function onTriple() {
  if (phase === "listening") return stopRec(true);
  if (phase === "sending" || phase === "sent") return abortAll();
  return startRec();
}
/**
 * Decides a burst of 1 or 2 taps. 1 tap: the hint on a dark lens (only if the burst started on one); ignored while
 * recording (all audio kept). 2 taps: drop any recording, then raise the exit menu.
 */
async function resolveTaps() {
  const n = taps, from = burstPhase; resetTaps();
  DEBUG && log("taps", n, "phase", phase);
  if (n === 1) {
    if (phase === "listening") { burstBytes = -1; DEBUG && log("single tap while recording: ignored, still recording"); }
    else if (phase === "idle" && from === "idle") await showHint();
  } else if (n === 2) {
    if (phase === "listening") {
      chunks = []; recBytes = 0; sendToken++; phase = "idle";
      await endRec();
      DEBUG && log("recording discarded, not sent: double-tap exit");
      await clearLens("double-tap exit");
    }
    await openExitDialog("double-tap");
  }
}
/**
 * Raises Even's exit menu: shutDownPageContainer(1), which asks the wearer to confirm. It is the only exit call the
 * app makes; Even sends SYSTEM_EXIT when the wearer confirms.
 */
async function openExitDialog(why: string) {
  if (!live()) return;
  const now = Date.now();
  if (now - exitAskedAt < EXIT_AGAIN_MS) { DEBUG && log("exit dialog already requested", why); return; }
  exitAskedAt = now; exitDialogUsed = true;
  cancelClear(); clearTimeout(minuteTimer); minuteTimer = null;         // nothing drawn while Even's exit menu is up
  DEBUG && log("exit dialog requested", why);
  const r = await Promise.resolve(bridge.shutDownPageContainer(1)).catch((e: any) => { DEBUG && log("exit dialog failed", e); return false; });
  DEBUG && log("exit dialog call returned", r);
}
/**
 * Triple-tap while recording-to-send, sending or "Sent": cancels. A recording is dropped; an upload is aborted and
 * withdrawn on the relay by its signed timestamp; a request the relay already took is removed from its queue.
 */
async function abortAll() {
  const was = phase;
  const busy = was === "listening" || was === "sending" || (was === "sent" && !!sentId);
  const id = was === "sent" ? sentId : null, ts = was === "sending" || id ? askTs : null;
  sendToken++; chunks = []; sentId = null; askTs = null;
  if (was === "listening") await endRec(); else clearTimeout(recTimer);
  try { sendCtl?.abort(); } catch {}
  ack(id); cancelOnRelay(ts);
  DEBUG && log("aborted (triple tap)", was, id || "");
  if (busy) await showFor("error", `${NAME}\n\nCancelled.`, CANCELLED_MS);
  else await clearLens("triple-tap");
}

// ---------- glasses events ----------
/**
 * The event type of a raw bridge event (text, system or list event). Protobuf omits a field equal to 0 (CLICK), so a
 * missing type counts as a click only when the event really came from a touch: a text event, or a system event from the
 * temple or ring (source 1-3) with no IMU data and no exit reason.
 */
function evType(e: any) {
  const raw = e?.textEvent?.eventType ?? e?.sysEvent?.eventType ?? e?.listEvent?.eventType;
  const t = OsEventTypeList.fromJson ? OsEventTypeList.fromJson(raw) : raw;
  if (t !== undefined) return t;
  if (e?.textEvent) return OsEventTypeList.CLICK_EVENT;
  const s = e?.sysEvent;
  if (s && !s.imuData && s.systemExitReasonCode === undefined) {
    if (s.eventSource === 1 || s.eventSource === 2 || s.eventSource === 3) return OsEventTypeList.CLICK_EVENT;
    DEBUG && log("system event without a touch source ignored", JSON.stringify(s));
  }
  return undefined;
}
/**
 * Every glasses event comes here. Exit signals first; while paused, everything but a tap is ignored (a tap resumes
 * the page and is then handled as usual); then a stale tap burst is settled and the event routed: audio, taps, scroll (keeps an error up longer),
 * and system overlays (a notification, the system menu, the exit menu), which never touch the lens or a recording.
 */
async function onEvent(e: any) {
  if (isOff()) return;
  const t = e?.audioEvent ? undefined : evType(e);
  if (t === OsEventTypeList.SYSTEM_EXIT_EVENT) return halt("off", "system exit");
  if (t === OsEventTypeList.ABNORMAL_EXIT_EVENT) return halt("paused", "abnormal exit");
  if (life === "paused" && !((t === OsEventTypeList.CLICK_EVENT || t === OsEventTypeList.DOUBLE_CLICK_EVENT) && await resumeInput())) return;
  const late = settleStale(); if (late) await late;
  if (!live()) return;
  if (e?.audioEvent) return onAudio(e.audioEvent);
  switch (t) {
    case OsEventTypeList.CLICK_EVENT: await onTap(1); break;
    case OsEventTypeList.DOUBLE_CLICK_EVENT: await onTap(2); break;
    case OsEventTypeList.SCROLL_TOP_EVENT:
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      if (phase === "error" && clearTimer) armClear(ERROR_MS);
      break;
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      h12 = phoneUses12h(); batteries?.refresh().catch(() => {});
      DEBUG && log(exitAskedAt && Date.now() - exitAskedAt < 3000 ? "exit dialog opened" : "system overlay opened: lens left as it was, phase " + phase);
      break;
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      DEBUG && log(exitAskedAt && Date.now() - exitAskedAt < 120_000 ? "exit dialog closed (cancelled if Pull Tab keeps running)" : "system overlay closed: lens left as it was, phase " + phase);
      if (!clearTimer && (phase === "hint" || phase === "error" || phase === "sent")) armClear(phase === "sent" ? SENT_MS : ERROR_MS);   // the exit menu was cancelled: the screen's dwell resumes
      if (lensBody.trim() && !minuteTimer) scheduleMinute();
      break;
  }
}

// ---------- lifecycle ----------
// Even closes a plugin in three ways: the exit menu (double-tap, then SYSTEM_EXIT), a close from the phone (no signal
// reaches the page, and the Even app may leave the WebView running), and an abnormal exit (ABNORMAL_EXIT, which may
// also be a Bluetooth drop). While Even shuts a session down it waits for the glasses to confirm; a command from the
// page in that moment can leave the next launch failing with "Host shutdown did not complete" (0.1.18, CHANGELOG.md).
// So: no glasses command at launch beyond creating the page, and none on any exit path; the host releases the mic.
// A hidden phone page, a locked phone and FOREGROUND_EXIT are not exits.
//
// Single instance: each launch writes a fresh id to bridge storage (claim). Before opening the mic, before an upload
// and at the first tap of a burst, a page checks the id (stillCurrent); a page that a newer launch has replaced turns
// itself off without touching the mic, which the newer page owns. Storage lives on the phone, not the glasses.
async function claim(why: string) {
  if (isOff()) return;
  if (!instanceId) instanceId = b64u(random(12));
  await save(INSTANCE_KEY, instanceId);
  DEBUG && log("instance claimed", why);
}
/** @returns false when this page is off (now or before); true otherwise, also when storage can't answer. */
async function stillCurrent(why: string) {
  if (isOff()) return false;
  if (!instanceId) return true;
  const v = await load(INSTANCE_KEY);
  if (isOff()) return false;
  if (v && v !== instanceId) { halt("off", `a newer Pull Tab page took over (${why})`); return false; }
  return true;
}
/**
 * Stops all work at once, sending the glasses nothing: a recording is dropped (never sent), an upload in flight is
 * aborted and withdrawn on the relay, every timer is cleared, and the mic is left to the host. A request the relay
 * already took ("Sent") stays sent.
 * "paused" keeps the listeners so the page can resume (resumeInput). "off" also removes every listener and leaves the
 * phone page inert; nothing turns it back on.
 */
function halt(next: "paused" | "off", why: string) {
  if (life === "off" || life === next) return;
  const ts = phase === "sending" ? askTs : null, was = phase;
  life = next;
  for (const t of [recTimer, tapTimer, clearTimer, minuteTimer]) clearTimeout(t);
  recTimer = tapTimer = clearTimer = minuteTimer = null;
  taps = 0; recGen++; sendToken++; chunks = []; recBytes = 0; burstBytes = -1; sentId = null; askTs = null; phase = "idle"; micMine = false;
  try { sendCtl?.abort(); } catch {}
  cancelOnRelay(ts);
  DEBUG && log(next === "off" ? "shut down:" : "paused:", why, "phase was", was);
  if (next === "paused") return;
  for (const off of offs.splice(0)) { try { off(); } catch {} }
  try {
    for (const id of ["copy", "msg", "use", "userelay", "reset"]) { const el = $(id); if (el) el.onclick = (e: any) => { e?.preventDefault?.(); }; }
    const st = $("state"); if (st) { st.textContent = "Pull Tab was closed. Open it again from the Even app."; st.className = ""; }
  } catch {}
}
/**
 * A tap reached a paused page, so Even is routing input to it again: the page is live again and the tap is handled as
 * usual. The lens is rewritten at the next draw (it may still show what was there before the abnormal exit).
 * @returns true when the page is live again.
 */
async function resumeInput() {
  if (!(await stillCurrent("resume")) || life !== "paused") return false;
  life = "on"; onLens = "";
  DEBUG && log("resumed: a tap reached the page after an abnormal exit");
  return true;
}

// ---------- phone screen ----------
const FINGERPRINTS = Object.entries(__FILE_SHA256__).map(([f, h]) => `${f} ${h}`).join(" ");
const setupMessage = () => `Set up Pull Tab for my Even G2 glasses. Guide: ${GUIDE} Pairing code: ${keys.code} Check SHA-256 before using any file, stop if one differs: ${FINGERPRINTS}`;
/** Redraws the phone screen: the setup message to copy when not paired, the help when paired. */
function renderPhone(status?: string) {
  if (isOff()) return;         // keeps the "closed" note
  if (status !== undefined) { $("state").textContent = status; DEBUG && log("phone:", status); }
  $("state").className = paired ? "ok" : "";
  $("msg").value = paired ? "" : setupMessage();   // the pairing code isn't left on the page once paired
  $("setup").style.display = paired ? "none" : "block";
  $("connected").style.display = paired ? "block" : "none";
  $("relayname").textContent = relayBase().replace(/^https?:\/\//, "");
  $("ver").textContent = "v" + __VERSION__;
}
/** Copies the setup message; it holds the pairing code, so the clipboard is cleared again after 30 s (best effort). */
async function copyMessage() {
  const ta = $("msg"); const text = setupMessage(); let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {}
  if (!ok) { try { ta.focus(); ta.select(); ta.setSelectionRange(0, text.length); ok = document.execCommand("copy"); } catch {} }
  $("copied").textContent = ok ? "Copied. Paste it into your chat with Tab now: it's cleared from the clipboard in 30 seconds." : "Press and hold the text above, then Select all and Copy.";
  if (ok) clearClipboardLater((s) => navigator.clipboard.writeText(s), undefined, (done) => DEBUG && log("clipboard cleared", done ? "yes" : "refused by the phone"));
}
async function pairWith(S: Uint8Array) {
  keys = keysFrom(S); await save("pt.secret", b64u(S)); paired = false; await save("pt.paired", "");
  relayUrl = relayOrigin(defaultRelay(keys)) || ""; await save("pt.relay", relayUrl);
}
let resetArmed = false;
const RESET = "Reset pairing";
/** Phone buttons: copy the setup message, use a pasted code, use a relay address from the Tab, reset pairing. */
function wirePhone() {
  $("copy").onclick = () => copyMessage();
  $("msg").onclick = () => { try { $("msg").select(); } catch {} };
  $("use").onclick = async () => {
    const S = parseCode($("code").value || "");
    if (!S) { $("codemsg").textContent = "That doesn't look like a Pull Tab code (it starts with PT1-)."; return; }
    await pairWith(S);
    $("code").value = ""; $("codemsg").textContent = "Code saved. Checking your relay..."; await checkPaired(); if (phase === "idle") await showHint();
  };
  $("userelay").onclick = async () => {   // kept only if the signed hello proves it is this code's relay
    const o = relayOrigin($("relayurl").value || "");
    if (!o) { $("relaymsg").textContent = "That isn't a relay address. It looks like name.sites.tab.bot"; return; }
    const before = relayUrl; relayUrl = o; $("relaymsg").textContent = "Checking that relay...";
    const ok = await checkPaired();
    if (ok) { await save("pt.relay", o); $("relayurl").value = ""; $("relaymsg").textContent = "Relay address saved."; if (phase === "idle") await showHint(); return; }
    relayUrl = before; renderPhone();
    $("relaymsg").textContent = ok === false ? "That relay isn't the one paired with this code. Nothing was changed." : "Couldn't reach that relay. Nothing was changed.";
  };
  $("reset").onclick = async (e: any) => {  // two taps within 6 s: a new secret, so the old code stops working
    e?.preventDefault?.();
    if (!resetArmed) { resetArmed = true; $("reset").textContent = "Tap again to replace the pairing code. Then send the new setup message to your Tab, so it shuts down the old code"; setTimeout(() => { resetArmed = false; $("reset").textContent = RESET; }, 6000); return; }
    resetArmed = false; $("reset").textContent = RESET;
    await pairWith(random(32));
    renderPhone("New code made. Send the setup message below to your Tab: it shuts down the old code and relay, and sets up a new one."); if (phase === "idle") await showHint();
  };
}

// ---------- boot ----------
/**
 * Runs once when the WebView loads the page: wait for the bridge; claim the launch id; load or create the pairing
 * secret (32 random bytes) and the relay address (re-checked every start); draw the phone screen and read the 12/24 h
 * setting and batteries; create the lens container (event capture on, so taps reach the app); subscribe to glasses
 * events and battery pushes; show the hint; check the relay now and each time the phone screen is shown again.
 * The only glasses commands at launch are creating the page and drawing on it: no mic command (0.1.18's mistake).
 */
async function boot() {
  bridge = await waitForEvenAppBridge();
  await claim("launch");
  let s = await load("pt.secret");
  if (!s) { s = b64u(random(32)); await save("pt.secret", s); }
  keys = keysFrom(unb64u(s));
  relayUrl = relayOrigin(await load("pt.relay")) || relayOrigin(defaultRelay(keys)) || "";
  paired = (await load("pt.paired")) === "1";
  wirePhone(); renderPhone("Checking connection...");
  h12 = phoneUses12h();
  batteries = new Batteries(bridge, () => { refreshStatus().catch(() => {}); }, () => { onLens = ""; });   // a push may follow a reconnect: rewrite next time
  await batteries.refresh();
  const res = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({ xPosition: 0, yPosition: 0, width: 576, height: 288, borderWidth: 0, borderColor: 0,
      paddingLength: 6, ...MAIN, content: withStatus(paired ? IDLE : UNPAIRED), isEventCapture: 1 })],
  }));
  DEBUG && log("startup", res);
  if (res === 0) onLens = withStatus(paired ? IDLE : UNPAIRED);   // the startup page already shows the hint: don't draw it twice
  const keep = (off: any) => { if (typeof off === "function") offs.push(off); };
  keep(bridge.onEvenHubEvent((e: any) => { onEvent(e).catch((x) => DEBUG && log("event error", x)); }));
  keep(batteries.start());
  scheduleMinute();
  await showHint();
  if (isOff()) return;
  keep(checkOnOpenAndResume(document as any, window as any, async (why) => {
    if (isOff()) return;
    // The phone page shown again is the page the wearer is using: it is the newest. A focus event on a hidden page
    // (a background copy) is not.
    if (why === "resume" && document.visibilityState !== "hidden") await claim("phone page shown again");
    const was = paired; DEBUG && log("status check on", why);
    if (why === "resume") renderPhone("Checking connection...");
    const ok = await checkPaired();
    if (phase !== "idle" || clearTimer) return;
    if (why === "open" ? ok !== null : ok && !was) await showHint();
  }, log));
  if (__TEST_AUDIO__) DEBUG && log("TEST-ONLY setup message:", setupMessage());
  DEBUG && log("ready", "v" + __VERSION__, relayBase());
}

boot().catch((e) => { DEBUG && log("boot failed", e); const el = $("state"); if (el) el.textContent = "Couldn't start: " + e; });
