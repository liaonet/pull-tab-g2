// main.ts: the whole Pull Tab app (Even G2 glasses plugin, package com.billliao.pulltab).
//
// WHAT IT DOES
// Pull Tab lets the wearer speak a question to their own Tab assistant from the glasses. Triple-tap starts a recording
// from the glasses mic, a second triple-tap sends it, and the Tab answers by WhatsApp or text message (never on the
// lens). Double-tap exits from any screen.
//
// WHERE IT RUNS
// The app is a small web page (index.html plus this bundle) that runs inside the Even app's WebView on the phone. It
// reaches the glasses only through the Even Hub SDK bridge (waitForEvenAppBridge): drawing text on the lens, opening and
// closing the glasses mic, receiving taps and audio, battery levels, persistent storage, and the system exit menu. The
// same page has a phone screen (the elements in index.html) used to pair the app with the person's Tab.
//
// DATA FLOW FOR ONE QUESTION
//   1. Triple-tap: startRec() opens the glasses mic. Audio arrives as audioEvent chunks of raw PCM (16 kHz, 16-bit,
//      mono) and onAudio() appends them to `chunks`.
//   2. Triple-tap again: stopRec(true) keeps the audio recorded before the sending taps and calls ask().
//   3. ask() encrypts the audio (pt.ts seal(), AES-256-GCM with a key only the app and the Tab hold) and POSTs it to
//      the person's own relay at https://<slug>.sites.tab.bot/v1/ask with an HMAC request signature (pt.ts sign()).
//   4. The relay's answer must carry the relay's own signature (pt.ts respOk()); otherwise it is rejected.
//   5. The lens shows "Sent, reply coming by WhatsApp/text" for SENT_MS (the cancel window), then goes dark.
//   6. Outside this app: the relay emails a "wake mail" to the Tab; the Tab fetches and decrypts the audio with
//      site/files/pulltab.py, transcribes it, and answers on the person's usual channel. The app never polls.
//
// THE PHASE STATE MACHINE (`phase`; what the lens is showing and what taps mean)
//   idle       lens dark (or the setup text if not paired). 1 tap -> hint. 3 taps -> listening.
//   hint       usage help for HINT_MS, then idle. A tap clears it. 3 taps -> listening.
//   listening  mic open, recording. 3 taps -> sending. 2 taps -> recording dropped, exit menu.
//              MAX_REC_MS cap -> "Not sent" (error). NO_VOICE_MS of silence before any speech -> error.
//   sending    upload in flight. 3 taps -> cancelled. Success -> sent. Failure -> error.
//   sent       "Sent, reply coming by ..." for SENT_MS. 3 taps -> cancel on the relay. Timer -> idle.
//   error      a message for ERROR_MS (or a shorter dwell), then idle. A tap clears it.
//   2 taps from any phase opens the system exit menu.
//
// CONCURRENCY NOTE
// Everything runs on one JavaScript thread, but the handlers are async and await the bridge and the network, so a new
// tap or audio chunk can arrive while an earlier handler is paused. Two counters guard against stale work:
// `recGen` (bumped on every recording start/stop, so a mic that opens late is closed again) and `sendToken` (bumped on
// every send and every cancel, so an upload that finishes after a cancel shows nothing). `phase` is always set before
// the first await so a second caller sees the new state.
//
// FILE LAYOUT: constants and state, lens, storage, relay, recording, ask (upload), taps, glasses input, phone screen,
// boot. Helpers live in pt.ts (crypto and relay address), status.ts (status line), sent.ts and resume.ts.
//
// CHANGE HISTORY: see CHANGELOG.md. The summary above and the taps section below describe the current version.
// Even Hub SDK 0.0.16: waitForEvenAppBridge resolves once the Even app has injected its bridge into the WebView. The
// container classes describe what the lens shows; OsEventTypeList names the event types; AudioInputSource picks the mic.
import {
  waitForEvenAppBridge, CreateStartUpPageContainer, TextContainerProperty, TextContainerUpgrade,
  OsEventTypeList, AudioInputSource,
} from "@evenrealities/even_hub_sdk";
import { Keys, keysFrom, parseCode, random, b64u, unb64u, sign, seal, relayOrigin, defaultRelay, respOk } from "./pt";
import { replyWord, clearClipboardLater } from "./sent";
import { Batteries, statusLine, phoneUses12h } from "./status";
import { checkOnOpenAndResume } from "./resume";

// Build-time constants. Vite replaces these identifiers with literal values (vite.config.mjs `define`), so test-only
// branches such as `if (__TEST_AUDIO__)` are removed entirely from store builds by the minifier.
declare const __DOCS__: string;          // where the setup guide lives (build time; vite.config.mjs)
declare const __TEST_RELAY__: string;    // test builds only: a local relay (http://127.0.0.1); empty in real builds
declare const __TEST_AUDIO__: string;    // test builds only: feed a PCM file as the mic
declare const __VERSION__: string;
declare const __DEBUG__: boolean;      // 0.1.13 (review refactor 3): console logging only in debug and test builds (vite.config.mjs)
declare const __FILE_SHA256__: Record<string, string>;   // build time: SHA-256 of each file a Tab downloads (vite.config.mjs)
// ---------- constants ----------
// Timing values, and why each number was chosen:
//   MAX_REC_MS 55 s: the relay refuses uploads over MAX_BODY (1.8 MB, about 56 s of audio once sealed;
//     relay-worker.template.mjs). Capping at 55 s keeps every recording under that limit with a little margin.
//   MIN_BYTES: one second of audio (16000 samples x 2 bytes). Anything shorter is almost certainly an accidental start.
//   SENT_MS 8 s: how long the "Sent" screen stays, which is also how long a triple-tap can still cancel the request.
//   NO_VOICE_MS 8 s: if nobody speaks after the mic opens, close it rather than record silence up to the cap.
//   EXIT_AGAIN_MS 1.5 s: ignore a repeated exit request this soon, so a jittery double-tap raises the menu once.
//   ERROR_MS / HINT_MS: long enough to read a two or three line message on the lens.
const GUIDE = __DOCS__ + "/setup.md";
const NAME = "Pull Tab";
const PROTOCOL = "3";                 // must match the relay's VERSION (3: the relay signs its answers)
// Sample rate of the glasses mic PCM stream (16-bit little-endian mono, so 32,000 bytes per second).
const RATE = 16000;
const MAX_REC_MS = 55_000;
const MIN_BYTES = 32000;              // 1 s: a send (double-tap) with less sends nothing ("too short")
const NOT_SENT_MS = 2500;             // "Not sent" dwell after a recording hit the cap and was thrown away
const SENT_MS = 8000;                  // v0.1.8: "Sent, reply coming by ..." stays 8 s (the cancel window), then the lens goes dark
const CANCELLED_MS = 2000;            // "Cancelled." dwell
const QUEUE_FULL_MS = 4000;           // v0.1.9: "8 questions waiting. Try again soon." dwell, then dark
const EXIT_AGAIN_MS = 1500;           // a second exit request within 1.5 s asks once
const NO_VOICE_MS = 8000;             // close the mic, sending nothing, if nobody speaks for 8 s
const ERROR_MS = 8000;
const HINT_MS = 6000;
// A single space draws an empty lens. withStatus() leaves blank text alone, so a dark lens gets no status line.
const BLANK = " ";
const EMPTY = new Uint8Array(0);

// ---------- app state (module-level; there is one app instance per WebView) ----------
// Phase: see THE PHASE STATE MACHINE at the top of this file.
type Phase = "idle" | "hint" | "listening" | "sending" | "sent" | "error";
// The Even app bridge from waitForEvenAppBridge(); typed `any` because the app also calls host methods by name.
let bridge: any;
// Keys derived from the pairing secret (pt.ts keysFrom); set in boot() and replaced by pairWith().
let keys: Keys;
let relayUrl = "";                     // the paired relay's origin, checked by relayOrigin() before it is saved
// True once the relay has answered a signed hello correctly; persisted as pt.paired = "1".
let paired = false;
let phase: Phase = "idle";
// Recording buffer: raw PCM chunks as they arrive, and their running total in bytes.
let chunks: Uint8Array[] = [];
let recBytes = 0;
let recTimer: any = null;
// No-voice detection: milliseconds of quiet before the first loud chunk, and whether speech was heard at all.
let silenceMs = 0, heardVoice = false;
let burstBytes = -1;                   // recBytes when a tap burst began while recording; a send keeps only the audio before it
let sentId: string | null = null;     // v0.1.8: the request just sent, cancellable by a triple-tap while "Sent" is on the lens
let askTs: string | null = null;      // v0.1.9: the signed timestamp of the upload just started; a cancel names only this one
let sendToken = 0;                     // bumps on every send and on every triple-tap abort
// Logging is on only in debug and test builds; `DEBUG && log(...)` lets the minifier drop the calls in store builds.
const DEBUG = __DEBUG__ || !!__TEST_AUDIO__ || !!__TEST_RELAY__;
const log = (...a: any[]) => { if (DEBUG) console.log("[pull-tab]", ...a); };
// Shorthand for the phone screen's elements (ids defined in index.html).
const $ = (id: string) => document.getElementById(id) as any;

// ---------- lens ----------
// The single full-screen text container the app draws into (created in boot(), updated by show()).
const MAIN = { containerID: 1, containerName: "main" };
// Every lit screen starts with the status line (time, date, glasses %, ring %; status.ts). A dark lens stays dark:
// nothing is drawn just to update the clock (not yet seen on real glasses).
let batteries: Batteries | null = null;
let h12 = false;
let lensBody = BLANK;
/**
 * Prefixes lit text with the status line (clock, date, battery levels).
 * @param text the screen body; blank text is returned unchanged so a dark lens stays dark.
 * @returns the text to send to the glasses.
 */
function withStatus(text: string) {
  return text.trim() ? statusLine(new Date(), h12, batteries?.glasses ?? null, batteries?.ring ?? null) + "\n" + text : text;
}
// The full text (status line included) most recently passed to show(); refreshStatus() compares against it.
let lastSent = "";
// 0.1.13 (review refactor 8): what the glasses were last sent. The same text again isn't sent again over Bluetooth.
// It is forgotten whenever the glasses report a device status change (e.g. a reconnect), so the next screen is redrawn.
let onLens = "";
const forgetLens = () => { onLens = ""; };
/**
 * Draws `text` on the lens (and mirrors it to the phone page's "lens" element, used by tests and debugging).
 *
 * Side effects: remembers the body for status refreshes, starts or stops the minute timer, and sends the text over
 * Bluetooth through bridge.textContainerUpgrade unless it is identical to what the glasses already show.
 * Gotchas: the text is cut to 1,990 characters; the simulator also refuses more than 999 UTF-8 bytes, so on a refused
 * write a shorter version is tried once. A refused write clears `onLens` so the next call retries instead of assuming
 * the lens is current.
 * @param text the screen body without the status line (BLANK for a dark lens).
 */
async function show(text: string) {
  lensBody = text;
  text = withStatus(text);
  lastSent = text;
  // 0.1.13 (review refactor 5): the minute timer runs only while the lens is lit; a dark lens has no clock to update.
  if (!text.trim()) { clearTimeout(minuteTimer); minuteTimer = null; }
  else if (!minuteTimer) scheduleMinute();
  const t = text.length > 1990 ? text.slice(0, 1987) + "..." : text;
  const el = $("lens"); if (el) el.textContent = t.trim() ? t : "(lens dark)";
  if (__TEST_AUDIO__) DEBUG && log("lens:", JSON.stringify(t));   // test builds only (compiled out of real builds)
  if (!bridge || t === onLens) return;
  onLens = t;
  let ok: any = false;
  try { ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({ ...MAIN, content: t })); }
  catch (e) { DEBUG && log("upgrade failed", e); }
  if (ok === false) {
    if (onLens === t) onLens = "";                  // not confirmed on the glasses: the next show() sends it again
    if (utf8Len(t) > 999) {                         // the simulator refuses >999 bytes; show the first part instead
      try { await bridge.textContainerUpgrade(new TextContainerUpgrade({ ...MAIN, content: cutBytes(t, 990) + "..." })); } catch {}
    }
  }
}
// Redraw the lit screen when the status line changes: on the minute and when a battery level changes.
async function refreshStatus() {
  if (!lensBody.trim() || withStatus(lensBody) === lastSent) return;
  await show(lensBody);
}
let minuteTimer: any = null;
/**
 * Arms a timer for 50 ms after the next wall-clock minute so the status line clock changes on the minute.
 * It re-arms itself only while the lens is lit; show() starts it again when something is drawn.
 * Note: the WebView's timers can stall while the phone is locked, so the clock may lag until the next redraw.
 */
function scheduleMinute() {
  clearTimeout(minuteTimer);
  minuteTimer = setTimeout(() => {
    minuteTimer = null;
    if (lensBody.trim()) scheduleMinute();          // re-armed only while the lens is lit (show() arms it again when lit)
    refreshStatus().catch(() => {});
  }, 60_000 - (Date.now() % 60_000) + 50);
}
// UTF-8 helpers for the glasses' byte limits (the limit is in bytes, not characters).
const TE = new TextEncoder();
const utf8Len = (s: string) => TE.encode(s).length;
// Returns the longest prefix of `s` that fits in `max` UTF-8 bytes without splitting a character.
function cutBytes(s: string, max: number) { let out = ""; for (const ch of s) { if (utf8Len(out + ch) > max) break; out += ch; } return out; }
// Fixed lens texts. Each is drawn below the status line by show().
const LAUNCH = `${NAME} v${__VERSION__}`;   // the version is shown on the launch hint
const IDLE = `${LAUNCH}\n\nTriple-tap to listen, send / cancel.\nDouble-tap to exit.`;
const UNPAIRED = `${LAUNCH}\n\nNot connected to your Tab yet.\nOn your phone, open Pull Tab in the Even app\nand send the setup message to your Tab.\n\nDouble-tap to exit.`;
// Not paired: a double-tap to talk opens no mic and sends nothing; it says this instead.
const NEEDS_SETUP = `${NAME}\n\nSet up Pull Tab on your phone first.`;
const NOT_SENT = `${NAME}\n\nNot sent.\nThe recording hit the 55 s limit.`;

// `clearTimer` takes a temporary screen (hint, error, "Sent") back to dark after its dwell time.
let clearTimer: any = null;
// Stops a pending return-to-dark, e.g. because a new screen replaced the temporary one.
function cancelClear() { clearTimeout(clearTimer); clearTimer = null; }
// Shows the current temporary screen for `ms`, then clears the lens (restarting any earlier countdown).
function armClear(ms: number) { cancelClear(); clearTimer = setTimeout(() => { clearLens("timer").catch(() => {}); }, ms); }
/**
 * Returns the lens to its resting state: dark when paired, the setup text when not.
 * Does nothing while recording or uploading, because those screens must stay until their own flow ends them.
 * Also closes the "Sent" cancel window: once dark, a triple-tap starts a new recording instead of cancelling.
 * @param why a short reason, for the debug log only.
 */
async function clearLens(why: string) {
  cancelClear();
  if (phase === "listening" || phase === "sending") return;
  phase = "idle"; sentId = null; askTs = null;                              // v0.1.8: once "Sent" has gone dark, taps behave as idle
  DEBUG && log("lens cleared", why);
  // Not set up yet: the setup instructions stay on the lens rather than a dark screen.
  await show(!paired && phase === "idle" ? UNPAIRED : BLANK);
}
// Sets the phase, draws the text, and schedules the return to dark after `ms`.
async function showFor(p: Phase, text: string, ms: number) { phase = p; await show(text); armClear(ms); }
const showError = (text: string) => showFor("error", text, ERROR_MS);
// The usage hint (paired) or the setup text (not paired; it stays until pairing succeeds).
async function showHint() { if (paired) await showFor("hint", IDLE, HINT_MS); else { phase = "idle"; cancelClear(); await show(UNPAIRED); } }

// ---------- storage (Even's localStorage survives suspend, kill and update; cleared on uninstall) ----------
// 0.1.13 (review M5): a value that had to fall back to the WebView's own storage is still found when the bridge
// later answers "" for it, so a fallback save can't silently drop the pairing. Once the bridge takes a key again, the
// fallback copy is removed, so it can't come back over a newer value (an emptied pt.paired, a new pt.secret).
// Keys used: pt.secret (the 32-byte pairing secret, base64url), pt.paired ("1" once a relay answered correctly),
// pt.relay (the relay origin). Neither function throws.
/** Saves a value through the bridge; falls back to WebView localStorage if the bridge call fails. */
async function save(k: string, v: string) {
  try { await bridge.setLocalStorage(k, v); } catch { localStorage.setItem(k, v); return; }
  try { localStorage.removeItem(k); } catch {}
}
/** Reads a value from the bridge, then from the WebView fallback; returns "" when neither has it. */
async function load(k: string) {
  let v = ""; try { v = (await bridge.getLocalStorage(k)) || ""; } catch {}
  if (v) return v;
  try { return localStorage.getItem(k) || ""; } catch { return ""; }
}

// ---------- relay (direct, 0.1.6) ----------
// Controller for the upload in flight, so a triple-tap cancel can abort it (abortAll).
let sendCtl: AbortController | null = null;
// Every network call has a deadline (the WebView may lack AbortSignal.timeout, so it's done by hand). The body is read
// inside the same deadline, because the relay's signature covers it.
function withTimeout(ms: number, ctl = new AbortController()) { const t = setTimeout(() => ctl.abort(), ms); return { signal: ctl.signal, done: () => clearTimeout(t) }; }
// 0.1.13 (review L4): cap every response before buffering it. The real relay's answers are tiny. A hostile site
// may omit Content-Length or stream past it, so the reader also enforces the limit as bytes arrive.
const MAX_ANSWER = 16 * 1024;
/**
 * fetch() with a deadline that also covers reading the body, and a hard size cap on the body.
 * @param url full request URL.
 * @param init fetch options (method, headers, body, redirect).
 * @param ms deadline in milliseconds for the whole request, body included.
 * @param ctl optional AbortController the caller keeps, so it can cancel the request early.
 * @returns the Response (status and headers; its body has already been read) and the body bytes.
 * @throws on network failure, timeout (abort) or an answer larger than MAX_ANSWER.
 */
async function timedFetch(url: string, init: any, ms: number, ctl?: AbortController) {
  const t = withTimeout(ms, ctl);
  try {
    const r = await fetch(url, { ...init, signal: t.signal });
    if (Number(r.headers.get("content-length") || 0) > MAX_ANSWER) throw new Error("relay answer too large");
    const reader = r.body?.getReader();
    if (!reader) { const b = new Uint8Array(await r.arrayBuffer()); if (b.byteLength > MAX_ANSWER) throw new Error("relay answer too large"); return { r, bytes: b }; }
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > MAX_ANSWER) throw new Error("relay answer too large");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
    return { r, bytes };
  } finally { t.done(); }
}
// An answer that doesn't carry the pinned relay's signature: some other site (or a relay set up from another code).
class NotYourRelay extends Error {}
// The relay origin for this pairing: a test build's local relay, else the saved one, else the one the code implies.
const relayBase = () => __TEST_RELAY__ || relayUrl || defaultRelay(keys);
// 0.1.13 (review tidy-up): relay() returns the status and the parsed answer, without building a second Response.
type Answer = { status: number; ok: boolean; j: any };
const TD = new TextDecoder();
/**
 * Makes one signed request to the paired relay and verifies the relay's signature on the answer.
 *
 * The request carries x-pt-ts (timestamp) and x-pt-sig (HMAC over method, path, timestamp and body hash; pt.ts sign()).
 * The relay answers with x-pt-rsig, an HMAC made with the relay key that only a relay set up from this pairing code
 * holds, bound to this request's signature so an old answer cannot be replayed. Without a valid rsig the call throws
 * NotYourRelay, whatever the status code.
 * Uploads (POST /v1/ask) get 60 s because they carry up to 1.8 MB over a phone connection; everything else gets 15 s.
 * redirect: "error" stops the relay from bouncing the app to a host outside its network whitelist.
 * @param method HTTP method.
 * @param path relay path, e.g. "/v1/hello", "/v1/ask", "/v1/cancel".
 * @param body optional request body (sealed audio for /v1/ask).
 * @param query optional query string, appended after the path.
 * @param ts the signed timestamp; ask() passes its own so the same value also seals the audio.
 * @returns status, ok (2xx) and the parsed JSON body (an empty object if it was not JSON).
 */
async function relay(method: string, path: string, body?: Uint8Array, query = "", ts = String(Date.now())): Promise<Answer> {
  const b = body || new Uint8Array(0);
  const sig = sign(keys, method, path, ts, b);
  const headers: any = { "x-pt-ts": ts, "x-pt-sig": sig };
  if (body) headers["content-type"] = "application/octet-stream";
  const isAsk = method === "POST" && path === "/v1/ask";
  const ms = isAsk ? 60_000 : 15_000;
  // 0.1.13 (refactor 2): the bytes go to fetch as they are (no Blob copy of the sealed audio)
  const { r, bytes } = await timedFetch(`${relayBase()}${path}${query}`, { method, headers, body: body ? b : undefined, redirect: "error" }, ms, isAsk ? (sendCtl = new AbortController()) : undefined);
  if (!respOk(keys, r.status, sig, bytes, r.headers.get("x-pt-rsig"))) { DEBUG && log("relay answer not signed by the paired relay", r.status, path); throw new NotYourRelay(String(r.status)); }
  let j: any = {}; try { j = JSON.parse(TD.decode(bytes)); } catch {}
  return { status: r.status, ok: r.status >= 200 && r.status < 300, j: j && typeof j === "object" ? j : {} };
}
// Deletes a request on the relay (fire and forget). Used when a request is cancelled after the relay accepted it.
const ack = (id: string | null) => { if (id && paired) relay("POST", "/v1/ack/" + id).catch(() => {}); };
// v0.1.8 (audit F1): the Tab retired the relay set up from this code (a new code was made, or the old one may have leaked).
const RETIRED = "Your Tab shut down the relay for this pairing code. Tap Reset pairing below, then send the setup message to your Tab.";
const NOT_YOURS = "That relay didn't prove it's yours (it isn't the one set up from this pairing code). Send the setup message below to your Tab again.";
// Forgets the pairing (the secret is kept; only the paired flag is cleared) and shows `msg` on the phone screen.
async function unpair(msg: string) { paired = false; await save("pt.paired", ""); renderPhone(msg); return false; }
/**
 * Signed hello to the relay: confirms the relay exists, is the one set up from this pairing code, and speaks PROTOCOL.
 * Updates `paired` and the phone screen's status text.
 * @returns true when connected, false when the relay definitely does not belong to this code (the app unpairs), and
 *   null when it could not tell (offline, relay not published yet, unexpected status), in which case nothing changes.
 */
async function checkPaired(): Promise<boolean | null> {
  try {
    const r = await relay("GET", "/v1/hello");
    const j = r.j;
    if (r.ok && j.ok && j.version !== PROTOCOL) return unpair("Your Tab's relay is out of date. Send the setup message below to your Tab again.");
    if (r.ok && j.ok) { paired = true; await save("pt.paired", "1"); renderPhone(j.mail ? "Connected to your Tab." : "Relay is up, but your Tab hasn't set up its wake-up mail yet."); return true; }
    if (r.status === 401) return unpair("Your relay doesn't recognise this pairing code. Send the code below to your Tab again.");
    if (r.status === 410 && j.error === "retired") return unpair(RETIRED);
    renderPhone(`Couldn't check (error ${r.status}).`); return null;
  } catch (e) {
    if (e instanceof NotYourRelay) return unpair(NOT_YOURS);
    DEBUG && log("hello failed", e);
    // A relay that isn't published yet answers without CORS, which looks the same as no connection.
    renderPhone(paired ? "Not connected: can't reach your relay. Is your phone online?" : "Not connected yet. If your Tab is still setting up, come back here once it says it's ready.");
    return null;
  }
}

// ---------- recording ----------
/**
 * Normalises an audio chunk from the bridge to bytes. Depending on SDK and platform the host can deliver PCM as a
 * Uint8Array, a plain number array, a base64 string, or another typed array, so all four are accepted.
 */
function toBytes(pcm: any): Uint8Array {
  if (pcm instanceof Uint8Array) return pcm;
  if (Array.isArray(pcm)) return Uint8Array.from(pcm);
  if (typeof pcm === "string") return Uint8Array.from(atob(pcm), (c) => c.charCodeAt(0));
  if (pcm && pcm.buffer) return new Uint8Array(pcm.buffer);
  return new Uint8Array(0);
}
/**
 * Root-mean-square loudness of a chunk of 16-bit little-endian PCM (0 to 32767). onAudio() treats a chunk above 700 as
 * speech: a threshold above a quiet room's noise and below normal speech at the glasses mic.
 */
function rms(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength); let s = 0; const n = b.byteLength >> 1;
  for (let i = 0; i < n; i++) { const x = v.getInt16(i * 2, true); s += x * x; }
  return n ? Math.sqrt(s / n) : 0;
}
// v0.1.5: the system exit menu (0.1.15: raised only by a double-tap). Known glasses bug (seen on real G2): after the menu is
// cancelled the glasses can refuse the mic until the app restarts. The app remembers the menu was raised; if the mic is
// then refused it asks once more and, failing that, says so on the lens.
let exitAskedAt = 0, exitDialogUsed = false;
/**
 * Raises the system exit menu (bridge.shutDownPageContainer(1)). Mode 1 asks the wearer to confirm and is the only exit
 * the app uses; mode 0 would close without asking, which the Oct 31 2026 audit advised against.
 * @param why a short reason, for the debug log only.
 */
async function openExitDialog(why: string) {
  const now = Date.now();
  if (now - exitAskedAt < EXIT_AGAIN_MS) { DEBUG && log("exit dialog already requested", why); return; }
  exitAskedAt = now; exitDialogUsed = true;
  DEBUG && log("exit dialog requested", why);
  const r = await Promise.resolve(bridge.shutDownPageContainer(1)).catch((e: any) => { DEBUG && log("exit dialog failed", e); return false; });
  DEBUG && log("exit dialog call returned", r);
}
let recGen = 0;                        // bumped by every start and stop of a recording; a stale mic-open is closed again
/**
 * Starts a recording (phase "listening"): opens the glasses mic, shows the listening screen, and arms the 55 s cap.
 * If not paired it shows NEEDS_SETUP and opens nothing. Every await is followed by a check of `recGen` and `phase`,
 * because a double-tap exit or a cancel may have ended this recording while the bridge call was pending; in that case
 * the mic is closed again.
 */
async function startRec() {
  if (phase === "listening") return;
  if (!paired) return showError(NEEDS_SETUP);   // no mic, nothing sent
  cancelClear();
  burstBytes = -1; chunks = []; recBytes = 0; silenceMs = 0; heardVoice = false;
  phase = "listening";
  const myRec = ++recGen;
  const openMic = async () => (await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false)) || !!__TEST_AUDIO__;
  let ok = await openMic();
  if (myRec !== recGen || phase !== "listening") { await bridge.audioControl(false).catch(() => {}); return; }
  if (!ok && exitDialogUsed) {         // known glasses bug: the mic can be refused after a cancelled exit menu; ask once more
    DEBUG && log("mic refused after the exit dialog; asking once more");
    await bridge.audioControl(false).catch(() => {}); await new Promise((r) => setTimeout(r, 300));
    if (myRec !== recGen || phase !== "listening") return;
    ok = await openMic();
    DEBUG && log("mic re-arm", ok ? "worked" : "refused again");
    if (myRec !== recGen || phase !== "listening") { await bridge.audioControl(false).catch(() => {}); return; }
  }
  if (!ok) {
    await bridge.audioControl(false).catch(() => {});
    return showError(exitDialogUsed ? `${NAME}\n\nThe glasses refused the mic after the exit menu.\nDouble-tap to exit, then reopen Pull Tab.` : `${NAME}\n\nCouldn't open the glasses mic.\nCheck the mic permission, then try again.`);
  }
  await show(`${NAME}  * listening\n\nTriple-tap to send.\nDouble-tap to exit.`);
  if (myRec !== recGen || phase !== "listening") return;
    // The 55 s cap. If a tap burst is still open when it fires, the wearer may be in the middle of a send (a triple-tap
    // keeps the audio recorded before its first tap), so the cap waits a second and checks again rather than discard audio
    // the wearer is about to send. A burst is settled within 0.7 s, or at the next audio chunk, so this does not loop.
  recTimer = setTimeout(function cap() {                         // hard cap: never sent, thrown away
    if (myRec !== recGen || phase !== "listening") return;
    if (taps > 0) { recTimer = setTimeout(cap, 1000); return; }    // a tap burst is being decided (<0.7 s; a send keeps the audio before it): check again
    discardRec("cap");
  }, MAX_REC_MS);
  if (__TEST_AUDIO__) feedTestAudio();
}
/**
 * Handles one audio chunk from the glasses mic while recording: stores it and, until speech is heard, tracks silence.
 * About 100 ms of audio arrives per chunk. Nothing is ever sent automatically; a send needs the triple-tap.
 */
function onAudio(ev: any) {
  if (phase !== "listening") return;
  const b = toBytes(ev.audioPcm);
  if (!b.byteLength) return;
  chunks.push(b); recBytes += b.byteLength;
  // Speech is only noted, for the no-speech drop. Nothing is sent by itself (0.1.0-0.1.3 sent after 1.5 s of quiet).
  // 0.1.13 (review refactor 4): once speech has been heard the loudness no longer changes anything, so it isn't measured.
  if (heardVoice) return;
  const ms = (b.byteLength / 2 / RATE) * 1000;
  if (rms(b) > 700) { heardVoice = true; silenceMs = 0; }
  else if (taps === 0) { silenceMs += ms; if (silenceMs > NO_VOICE_MS) stopRec(false, true); }   // nothing said for 8 s: mic off, nothing sent (not while a tap burst is being decided)
}
// A recording that reaches the cap is thrown away, never sent: mic closed, audio dropped, a brief "Not sent".
async function discardRec(why: string) {
  if (phase !== "listening") return;
  clearTimeout(recTimer); recGen++; chunks = []; recBytes = 0;
  resetTaps();
  await bridge.audioControl(false).catch(() => {});
  DEBUG && log("recording discarded, not sent:", why);
  phase = "error";
  await show(NOT_SENT); armClear(NOT_SENT_MS);
}
// The ONLY caller of stopRec(true) is onTriple (a triple-tap while recording). Everything else stops with send = false.
/**
 * Ends the recording and either sends it or drops it.
 * @param send true only from a triple-tap while recording: upload the audio via ask().
 * @param silent true when stopped by the no-voice timeout: show "Didn't hear anything".
 * Gotcha: when a tap burst began while recording, `burstBytes` marks where the audio stood at its first tap, and only
 * the audio before it is sent, so the sending taps themselves are not part of the question.
 */
async function stopRec(send: boolean, silent = false) {
  if (phase !== "listening") return;
  phase = send ? "sending" : "idle";      // claim it before any await, so a second caller can't send twice
  askTs = null;                           // v0.1.9: no upload of this recording yet, so a triple-tap names none
  const tok = sendToken;
  clearTimeout(recTimer); recGen++;
  await bridge.audioControl(false).catch(() => {});
  if (tok !== sendToken) return;          // triple-tapped while the mic was closing: abortAll owns the lens
  if (silent) { chunks = []; return showError(`${NAME}\n\nDidn't hear anything.\nTriple-tap to try again.`); }
  if (!send) { chunks = []; phase = "idle"; return clearLens("cancelled"); }
  const keep = burstBytes >= 0 ? Math.min(burstBytes, recBytes) : recBytes;   // the sending taps themselves are not sent
  if (keep < MIN_BYTES) { chunks = []; return showError(`${NAME}\n\n${ERRORS.too_short}`); }
  await ask(takeRecording(keep));          // 0.1.13: no local copy of the joined audio stays alive during the upload
}
// The first `limit` bytes of the recording as one buffer; the chunks are let go at once.
function takeRecording(limit: number) {
  const pcm = new Uint8Array(limit); let o = 0;
  for (const c of chunks) { if (o >= limit) break; const n = Math.min(c.byteLength, limit - o); pcm.set(n === c.byteLength ? c : c.subarray(0, n), o); o += n; }
  chunks = [];
  return pcm;
}
// Test builds only: plays a PCM file into onAudio() in 100 ms chunks, standing in for the glasses mic.
async function feedTestAudio() {
  const b = new Uint8Array(await (await fetch(__TEST_AUDIO__)).arrayBuffer());
  for (let o = 0; o < b.byteLength && phase === "listening"; o += 3200) {
    onAudio({ audioPcm: b.slice(o, o + 3200) }); await new Promise((r) => setTimeout(r, 100));
  }
}

// Lens text for each error code the relay can return in its signed JSON answer ({ error: "..." }).
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
// v0.1.8: the Tab answers by message, never on the lens. The app uploads the recording, shows "Sent, reply coming by
// <channel>." for SENT_MS (the cancel window) and goes dark. It never asks the relay for an answer.
const QUEUE_FULL = `${NAME}\n\n8 questions waiting.\nTry again soon.`;   // v0.1.9: the relay's queue (8) is full
const sentScreen = (word: string) => `${NAME}\n\nSent, reply coming by ${word}.\nTriple-tap to cancel.`;
/**
 * Uploads one recording to the relay and shows the result on the lens.
 *
 * The audio is sealed with AES-256-GCM; the associated data names the sample rate and the signed timestamp, so the Tab
 * can reject audio that is stale, replayed, or moved to another request. A triple-tap during the upload bumps
 * `sendToken`; the token check after the await then drops the result (and deletes the request if the relay took it).
 * Relay answers handled: 410 retired (unpair), 429 queue_full (8 requests already waiting), any other error code
 * (ERRORS), and a network failure or a relay that fails the signature check.
 * @param pcm the recording (raw PCM). Released as soon as it is sealed, to keep memory low in the WebView.
 */
async function ask(pcm: Uint8Array) {
  const ts = String(Date.now()); askTs = ts;   // v0.1.9: set before any await, so a triple-tap from here on names this upload
  phase = "sending"; await show(`${NAME}\n\nSending...`);
  const token = ++sendToken;
  try {
    // 0.1.13 (refactor 2): seal, then let go of the plain audio, so only the sealed copy is held during the upload.
    // The audio is sealed with the same signed timestamp, so the Tab can refuse stale or replayed audio (protocol 2).
    const box = seal(keys, pcm, `pulltab/audio/16000/${ts}`); pcm = EMPTY;
    const r = await relay("POST", "/v1/ask", box, "", ts);
    const j = r.j;
    if (token !== sendToken) {               // triple-tapped while uploading: drop it on the relay, show nothing
      if (j.id) ack(j.id);
      return;
    }
    if (r.status === 410 && j.error === "retired") { await unpair(RETIRED); return showError(`${NAME}\n\n${ERRORS.retired}`); }
    if (r.status === 429 && j.error === "queue_full") return showFor("error", QUEUE_FULL, QUEUE_FULL_MS);   // v0.1.9; nothing queued is dropped
    if (!r.ok || !j.id) {
      return showError(`${NAME}\n\n${Object.prototype.hasOwnProperty.call(ERRORS, j.error) ? ERRORS[j.error] : `Error ${r.status}.`}\nTriple-tap to try again.`);
    }
    const word = replyWord(j.reply_by);     // only "WhatsApp" or "text" from the signed acknowledgement, else "message"
    sentId = j.id; phase = "sent";
    DEBUG && log("sent", j.id, "reply by", word);
    await show(sentScreen(word));
    if (phase === "sent" && sentId === j.id) armClear(SENT_MS);   // then dark; taps behave as idle again
  } catch (e) {
    DEBUG && log("ask failed", e);
    if (token !== sendToken) return;
    if (e instanceof NotYourRelay) { await unpair(NOT_YOURS); return showError(`${NAME}\n\nThat isn't your relay.\nSet up Pull Tab again on your phone.`); }
    await showError(`${NAME}\n\nCouldn't reach your relay.\nIs the Even app open with internet?\nTriple-tap to try again.`);
  }
}

// ---------- taps: the v0.1.13 map (triple-tap records, then sends, and if needed cancels what was just sent;
// double-tap exits) ----------
// The glasses report CLICK and DOUBLE_CLICK only, so the app counts taps itself: CLICK = 1, DOUBLE_CLICK = 2. A burst is
// taps less than TAP_WINDOW_MS apart. A triple-tap (however the glasses split it: 2+1, 1+2, 1+1+1) acts the moment the
// count reaches 3; a double-tap acts only once the burst is over, so the start of a triple-tap never exits.
//   1 tap:  recording -> nothing; dark lens -> the hint; hint / error -> clear the lens; sending / "Sent" -> nothing.
//   2 taps: exit Pull Tab (the system exit menu), from any screen. A recording in progress is
//           thrown away first (nothing is sent).
//   3+:     dark lens / hint / error -> start a recording; recording -> SEND (the only way anything is sent); sending /
//           "Sent" -> cancel that request on the relay (abortAll, the v0.1.8/0.1.9 cancel window, unchanged).
// Instant, harmless effects of a first tap: clearing the lens, marking where the recording's audio stood (a possible send).
// Why 700 ms: long enough for a deliberate triple-tap on the temple (which the glasses may report as 2+1, 1+2 or 1+1+1),
// short enough that a single tap feels answered. It is also the bound used to decide a burst is stale (settleStale).
const TAP_WINDOW_MS = 700;
let taps = 0;
let tapTimer: any = null;
// Taps counted in the current burst, and the timer that decides the burst once no tap has come for TAP_WINDOW_MS.
let burstPhase: Phase = "idle";   // the phase when this burst's first tap landed
// Ends the current burst without acting on it.
function resetTaps() { clearTimeout(tapTimer); tapTimer = null; taps = 0; }
// 0.1.16 (found in testing: a single tap could record and a double tap did nothing): the burst timer may not
// fire (the Even WebView's timers stall while the phone is locked or the app is in the background), leaving a double-tap's
// 2 taps waiting, so the next single tap made 3 = a recording. Now a tap more than TAP_WINDOW_MS after the previous one
// first settles the old burst, judged by the clock (Date.now keeps counting while the phone sleeps). The timer is still
// the normal path; this only catches a burst it left open.
let lastTapAt = 0;
// A burst its timer left open is settled by the clock on the next event of any kind (onEvent): the next tap, or, while
// recording, the next audio chunk (~100 ms), so a tap never joins a stale burst and a tap while recording is decided
// without a timer.
/**
 * Phone sleep and lock recovery for taps. If a burst is open and its last tap is older than TAP_WINDOW_MS, the burst
 * timer must have stalled (the WebView pauses timers while the phone is locked or Even is in the background), so the
 * burst is decided now, before the new event is handled. Date.now() is used because it follows the wall clock and
 * keeps advancing through sleep.
 * @returns the promise from resolveTaps() when it settled a burst (the caller awaits it), otherwise undefined.
 */
function settleStale() {
  if (taps > 0 && Date.now() - lastTapAt > TAP_WINDOW_MS) { DEBUG && log("tap burst settled late", taps); return resolveTaps(); }
}
/**
 * Counts taps into the current burst. The glasses report CLICK (n = 1) and DOUBLE_CLICK (n = 2); there is no
 * triple event, so a triple-tap is any burst reaching 3 and acts at once. Fewer taps wait for the burst timer.
 * The first tap of a burst has two instant, harmless effects: on an error or hint screen it clears the lens (the wearer
 * is done reading), and while recording it marks where the audio stood, in case the burst becomes a send.
 * @param n taps carried by this event (1 or 2).
 */
async function onTap(n: number) {
  lastTapAt = Date.now();                  // before any await: a tap that lands during a settle still extends this burst
  const first = taps === 0;
  if (first) burstPhase = phase;
  taps += n; clearTimeout(tapTimer); tapTimer = null;
  if (taps >= 3) { DEBUG && log("taps", taps, "-> triple"); resetTaps(); await onTriple(); return; }
  tapTimer = setTimeout(() => { resolveTaps().catch((x) => DEBUG && log("tap error", x)); }, TAP_WINDOW_MS);
  if (!first) return;
  if (phase === "listening") {                                   // possible send (triple-tap): a send keeps only the audio before this tap
    burstBytes = recBytes; DEBUG && log("tap while recording");
  } else if (phase === "error" || phase === "hint") {
    await clearLens("tap");                                      // tap = done reading
  }
}
// Triple tap: start, send, or cancel what was just sent.
async function onTriple() {
  if (phase === "listening") return stopRec(true);               // send
  if (phase === "sending" || phase === "sent") return abortAll(); // cancel the request just sent (its cancel window)
  return startRec();                                             // dark lens / hint / error: start talking
}
/**
 * Decides a burst of 1 or 2 taps once it is over (timer fired, or settled late by settleStale).
 * 1 tap: on a dark lens shows the hint (only if the burst also started on a dark lens); while recording it is ignored
 *   and the send mark is cleared, so all audio is kept. 2 taps: exit (exitByDoubleTap).
 * Uses `burstPhase` (the phase at the first tap) as well as the current phase, because the first tap may already have
 * changed the screen (cleared a hint, for example).
 */
async function resolveTaps() {
  const n = taps, from = burstPhase; resetTaps();
  DEBUG && log("taps", n, "phase", phase);
  if (n === 1) {
    if (phase === "listening") { burstBytes = -1; DEBUG && log("single tap while recording: ignored, still recording"); }
    else if (phase === "idle" && from === "idle") await showHint();   // a tap on a dark lens: how to talk, nothing starts
    else if (phase === "sent") DEBUG && log("single tap ignored while Sent is shown");
  } else if (n === 2) {
    await exitByDoubleTap();
  }
}
// Double tap = exit (v0.1.13). A recording in progress is thrown away first: mic closed, audio dropped, nothing sent.
// Then the system exit menu.
async function exitByDoubleTap() {
  if (phase === "listening") await dropRecordingForExit();
  await openExitDialog("double-tap");
}
// Throws away a recording in progress (mic closed, audio dropped, nothing sent) before the exit menu opens.
async function dropRecordingForExit() {
  clearTimeout(recTimer); recGen++; chunks = []; recBytes = 0; sendToken++;
  phase = "idle";
  await bridge.audioControl(false).catch(() => {});
  DEBUG && log("recording discarded, not sent: double-tap exit");
  await clearLens("double-tap exit");
}
// Hold: removed in 0.1.15, since double-tap exits.
// A hold (LONG_PRESS) is not handled at all: it does nothing on any screen.
// Cancel (v0.1.13: a triple tap while sending or while "Sent" is on the lens; a recording is never cancelled here, a triple
// tap sends it). A recording is discarded (nothing left the glasses). An upload in flight, or (v0.1.8) the request while
// "Sent" is on the lens, is cancelled on the relay: the request is deleted (ack) and a tombstone for that one upload (v0.1.9:
// named by its signed timestamp) stops it if it is still in flight; the other queued requests are untouched. Once "Sent" has gone dark, a triple tap is an idle one: it clears the lens and tells the relay
// nothing, so it can't cancel a request whose cancel window has closed.
// abortAll() is the triple-tap cancel. `wasBusy` decides the screen: "Cancelled." when something was actually
// cancelled, otherwise the lens just clears. The cancel is sent only if this upload has a signed timestamp (askTs),
// meaning it may have reached the relay.
async function abortAll() {
  const was = phase;
  const wasBusy = was === "listening" || was === "sending" || (was === "sent" && !!sentId);
  sendToken++;
  clearTimeout(recTimer); chunks = [];
  if (was === "listening") { recGen++; await bridge.audioControl(false).catch(() => {}); }
  try { sendCtl?.abort(); } catch {}
  const id = was === "sent" ? sentId : null;
  const ts = was === "sending" || id ? askTs : null;
  sentId = null; askTs = null;
  if (paired && ts) {
    ack(id);
    // v0.1.9: a tombstone for this one upload (its signed timestamp): it also stops it if it is still in flight, and
    // leaves every other queued request alone.
    relay("POST", "/v1/cancel", TE.encode(ts)).catch(() => {});
  }
  DEBUG && log("aborted (triple tap)", was, id || "");
  if (wasBusy) await showFor("error", `${NAME}\n\nCancelled.`, CANCELLED_MS);
  else await clearLens("triple-tap");
}

// ---------- glasses input ----------
// v0.1.5 phantom-tap guard: a touch from the temples or the ring carries its source
// (eventSource 1 = right temple, 2 = ring, 3 = left temple; SDK 0.0.16). A system event with no eventType and no touch
// source (the glasses send IMU and other system events too) is NOT a click; before, it could open the mic by itself.
const isTouchSource = (x: any) => x === 1 || x === 2 || x === 3;
/**
 * Works out the event type of a raw bridge event. Taps can arrive as textEvent (the app's text container has
 * isEventCapture set), sysEvent or listEvent. A protobuf field equal to 0 (CLICK) is omitted on the wire, so a missing
 * type is treated as a click only when the event really came from a touch: a textEvent, or a sysEvent from the temple
 * or ring with no IMU data and no exit reason.
 * @returns an OsEventTypeList value, or undefined for events the app ignores.
 */
function evType(e: any) {
  const raw = e?.textEvent?.eventType ?? e?.sysEvent?.eventType ?? e?.listEvent?.eventType;
  const t = OsEventTypeList.fromJson ? OsEventTypeList.fromJson(raw) : raw;
  if (t === undefined) {
    if (e?.textEvent) return OsEventTypeList.CLICK_EVENT;   // a click can arrive with eventType omitted (proto default 0)
    if (e?.sysEvent && !e.sysEvent.imuData && e.sysEvent.systemExitReasonCode === undefined) {
      if (isTouchSource(e.sysEvent.eventSource)) return OsEventTypeList.CLICK_EVENT;
      DEBUG && log("system event without a touch source ignored", JSON.stringify(e.sysEvent));
    }
  }
  return t;
}
/**
 * Single entry point for every event from the glasses (registered with bridge.onEvenHubEvent in boot()).
 * It first settles a stale tap burst (see settleStale), then routes: audio to onAudio(), CLICK and DOUBLE_CLICK to
 * onTap(), scroll to extending an error's dwell, and system overlay open/close to housekeeping only.
 */
async function onEvent(e: any) {
  const late = settleStale(); if (late) await late;
  if (e?.audioEvent) return onAudio(e.audioEvent);
  const t = evType(e);
  switch (t) {
    case OsEventTypeList.CLICK_EVENT: await onTap(1); break;
    case OsEventTypeList.DOUBLE_CLICK_EVENT: await onTap(2); break;
        // A swipe while an error is showing restarts its timer, so the wearer can keep reading a longer message.
    case OsEventTypeList.SCROLL_TOP_EVENT:
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      if (phase === "error" && clearTimer) armClear(ERROR_MS);
      break;
    // v0.1.7 (seen on real glasses: the lens lit ~10 times in 30 min with no tap, every time on eventType 4): a system
    // overlay (a notification, the system menu, the exit dialog) opening (4) or closing (5) leaves everything as it was. The
    // lens is not lit, no hint is shown, and a recording, upload, "Sent" screen (with its cancel window) or tap burst being
    // decided carries on untouched. Only housekeeping runs: the 12 h clock setting and the batteries are
    // re-read (a lit screen's status line may update; a dark lens stays dark).
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      h12 = phoneUses12h(); batteries?.refresh().catch(() => {});
      if (exitAskedAt && Date.now() - exitAskedAt < 3000) DEBUG && log("exit dialog opened");
      else DEBUG && log("system overlay opened: lens left as it was, phase", phase);
      break;
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      if (exitAskedAt && Date.now() - exitAskedAt < 120_000) DEBUG && log("exit dialog closed (cancelled if Pull Tab keeps running)");
      else DEBUG && log("system overlay closed: lens left as it was, phase", phase);
      break;
  }
}
// ---------- phone screen (setup) ----------
// The fingerprints come from this app build (signed into the store package), not from the website, so a Tab can
// tell whether what it downloads is what this app version was built with.
// The setup message the person sends to their Tab: guide URL, pairing code, and the file fingerprints.
const FINGERPRINTS = Object.entries(__FILE_SHA256__).map(([f, h]) => `${f} ${h}`).join(" ");
// Builds the one-line setup message shown on the phone screen and copied for the person to send to their Tab.
function setupMessage() { return `Set up Pull Tab for my Even G2 glasses. Guide: ${GUIDE} Pairing code: ${keys.code} Check SHA-256 before using any file, stop if one differs: ${FINGERPRINTS}`; }
/**
 * Redraws the phone screen. When not paired it shows the setup message to copy; when paired, the connected view.
 * @param status optional status line to show; omitted means keep the current one.
 */
function renderPhone(status?: string) {
  if (status !== undefined) { $("state").textContent = status; DEBUG && log("phone:", status); }
  $("state").className = paired ? "ok" : "";
  $("msg").value = paired ? "" : setupMessage();
  $("setup").style.display = paired ? "none" : "block";
  $("connected").style.display = paired ? "block" : "none";
  $("relayname").textContent = relayBase().replace(/^https?:\/\//, "");
  $("ver").textContent = "v" + __VERSION__;
}
// Copies the setup message, with a manual select-and-copy fallback for WebViews that block the clipboard API.
async function copyMessage() {
  const ta = $("msg"); const text = setupMessage(); let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {}
  if (!ok) { try { ta.focus(); ta.select(); ta.setSelectionRange(0, text.length); ok = document.execCommand("copy"); } catch {} }
  $("copied").textContent = ok ? "Copied. Paste it into your chat with Tab now: it's cleared from the clipboard in 30 seconds." : "Press and hold the text above, then Select all and Copy.";
  // v0.1.8 (audit F3): the copied pairing code doesn't stay on the clipboard
  if (ok) clearClipboardLater((s) => navigator.clipboard.writeText(s), undefined, (done) => DEBUG && log("clipboard cleared", done ? "yes" : "refused by the phone"));
}
// A new pairing secret also sets the relay address it implies (checked like any other before it is saved).
async function pairWith(S: Uint8Array) {
  keys = keysFrom(S); await save("pt.secret", b64u(S)); paired = false; await save("pt.paired", "");
  relayUrl = relayOrigin(defaultRelay(keys)) || ""; await save("pt.relay", relayUrl);
}
// Reset pairing needs two taps within 6 s, because a new code means the Tab must set up a new relay.
let resetArmed = false;
const RESET = "Reset pairing";
/**
 * Attaches the phone screen's handlers: copy setup message, use a pasted pairing code ("use"), use a relay address the
 * Tab published under another name ("userelay"), and reset pairing ("reset").
 */
function wirePhone() {
  $("copy").onclick = () => copyMessage();
  $("msg").onclick = () => { try { $("msg").select(); } catch {} };
  $("use").onclick = async () => {
    const S = parseCode($("code").value || "");
    if (!S) { $("codemsg").textContent = "That doesn't look like a Pull Tab code (it starts with PT1-)."; return; }
    await pairWith(S);
    $("code").value = ""; $("codemsg").textContent = "Code saved. Checking your relay..."; await checkPaired(); if (phase === "idle") await showHint();
  };
  // Only if the Tab had to publish the relay under another name: the address must be https://<name>.sites.tab.bot,
  // and it is kept only once that relay has answered with this pairing's signature.
  $("userelay").onclick = async () => {
    const o = relayOrigin($("relayurl").value || "");
    if (!o) { $("relaymsg").textContent = "That isn't a relay address. It looks like name.sites.tab.bot"; return; }
    const before = relayUrl; relayUrl = o; $("relaymsg").textContent = "Checking that relay...";
    const ok = await checkPaired();
    if (ok) { await save("pt.relay", o); $("relayurl").value = ""; $("relaymsg").textContent = "Relay address saved."; if (phase === "idle") await showHint(); return; }
    relayUrl = before; renderPhone();
    $("relaymsg").textContent = ok === false ? "That relay isn't the one paired with this code. Nothing was changed." : "Couldn't reach that relay. Nothing was changed.";
  };
  $("reset").onclick = async (e: any) => {
    e?.preventDefault?.();   // v0.1.10: a small link at the bottom now, not a button
    // v0.1.8 (audit F1): the old code keeps working on the old relay until the Tab retires it, so the wording says so.
    if (!resetArmed) { resetArmed = true; $("reset").textContent = "Tap again to replace the pairing code. Then send the new setup message to your Tab, so it shuts down the old code"; setTimeout(() => { resetArmed = false; $("reset").textContent = RESET; }, 6000); return; }
    resetArmed = false; $("reset").textContent = RESET;
    await pairWith(random(32));
    renderPhone("New code made. Send the setup message below to your Tab: it shuts down the old code and relay, and sets up a new one."); if (phase === "idle") await showHint();
  };
}

// ---------- boot ----------
/**
 * Startup sequence, run once when the WebView loads the page:
 *   1. wait for the Even bridge;
 *   2. load the pairing secret, or create one on first open (32 random bytes), and derive the keys;
 *   3. load the relay address (re-validated every start) and the paired flag;
 *   4. draw the phone screen, read the 12/24 h setting and battery levels;
 *   5. create the lens text container (576 x 288, the whole text area the app uses) with event capture on, so taps reach the app;
 *   6. subscribe to glasses events, battery pushes and the minute timer, and show the hint;
 *   7. check the relay connection now and each time the phone screen is shown again (resume.ts).
 * Phone sleep and lock: nothing here re-runs on wake. Pairing survives in bridge storage; the tap logic recovers from
 * stalled timers by the clock (settleStale); the connection is re-checked when the screen is shown again.
 */
async function boot() {
  bridge = await waitForEvenAppBridge();
  let s = await load("pt.secret");
  if (!s) { s = b64u(random(32)); await save("pt.secret", s); }
  keys = keysFrom(unb64u(s));
  relayUrl = relayOrigin(await load("pt.relay")) || relayOrigin(defaultRelay(keys)) || "";   // a saved address is checked again on every start
  paired = (await load("pt.paired")) === "1";
  wirePhone(); renderPhone("Checking connection...");
  h12 = phoneUses12h();
  batteries = new Batteries(bridge, () => { refreshStatus().catch(() => {}); }, forgetLens);
  await batteries.refresh();
  const res = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({ xPosition: 0, yPosition: 0, width: 576, height: 288, borderWidth: 0, borderColor: 0,
      paddingLength: 6, ...MAIN, content: withStatus(paired ? IDLE : UNPAIRED), isEventCapture: 1 })],
  }));
  DEBUG && log("startup", res);
  bridge.onEvenHubEvent((e: any) => { onEvent(e).catch((x) => DEBUG && log("event error", x)); });
  batteries.start();
  scheduleMinute();
  await showHint();
  // v0.1.10: the status shows by itself, once on open and once on each return to the screen (no button, no polling).
  // On open the lens hint follows the result, as before; on a return the lens is lit only when this check is what
  // connected the app (the person's Tab just finished setup), the moment 0.1.9's check button used to cover.
  checkOnOpenAndResume(document as any, window as any, async (why) => {
    const was = paired; DEBUG && log("status check on", why);
    if (why === "resume") renderPhone("Checking connection...");
    const ok = await checkPaired();
    if (phase !== "idle" || clearTimer) return;
    if (why === "open" ? ok !== null : ok && !was) await showHint();
  }, log);
  if (__TEST_AUDIO__) DEBUG && log("TEST-ONLY setup message:", setupMessage());   // compiled out of real builds
  DEBUG && log("ready", "v" + __VERSION__, relayBase());
}
// Start the app. A failure here (for example no bridge outside the Even app) is shown on the phone screen.
boot().catch((e) => { DEBUG && log("boot failed", e); const el = $("state"); if (el) el.textContent = "Couldn't start: " + e; });
