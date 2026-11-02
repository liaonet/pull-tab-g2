// 0.1.16 tap tests (test/taps.sh): the real app (app/src/main.ts) and the real Even Hub SDK 0.0.16, with a mocked Even
// app host and a switch that stalls the app's timers (as the Even WebView's timers stall while the phone is locked or the
// app is in the background; found in an Oct 31 2026 audit). One scenario per run: PT_TAPS_SCENARIO names it.
// Each scenario prints one JSON line {name, ok, detail}.
// How it works: the SDK talks to the Even app through window.flutter_inappwebview.callHandler, and the Even app talks
// back by calling window._listenEvenAppMessage. This file replaces the first with a fake host that records every call
// (lens text, mic open/close, exit menu, storage) and uses the second to inject taps and audio, so main.ts runs unchanged.
// Scenario names starting "stalled_" freeze all timers mid-gesture to reproduce the phone-locked case.
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
const sleep = (ms: number) => new Promise((r) => realSetTimeout(r, ms));

const slowExit = (process.env.PT_TAPS_SCENARIO || "").includes("slow_exit");
const uploads: number[] = [];   // bytes of each sealed upload the app sent (POST /v1/ask)
const SEAL = 28;                // a sealed box is the audio plus 28 bytes (nonce + tag)
const store: Record<string, string> = { "pt.paired": "1" };   // a paired app (a triple-tap really opens the mic)
const calls: { method: string; data: any }[] = [];
const lens: string[] = [];
const listeners: Record<string, any[]> = {};
const el = () => ({ textContent: "", value: "", className: "", style: {} as any, onclick: null, select() {}, focus() {}, setSelectionRange() {} });
const els: Record<string, any> = {};
// ---------- fake Even app host and browser globals (no DOM, no network: every fetch fails, uploads are only counted) ----------
Object.assign(globalThis, {
  flutter_inappwebview: { callHandler: async (_n: string, msg: any) => {
    const m = typeof msg === "string" ? JSON.parse(msg) : msg;
    const data = m.data ?? m.params ?? m.args;
    calls.push({ method: m.method, data });
    switch (m.method) {
      case "getLocalStorage": { const k = typeof data === "string" ? data : data?.key; return store[k] ?? ""; }
      case "setLocalStorage": { const k = data?.key, v = data?.value; if (k) store[k] = v; return true; }
      case "textContainerUpgrade": { const c = data?.content ?? data?.textContainerUpgrade?.content ?? JSON.stringify(data); lens.push(String(c)); return true; }
      case "createStartUpPageContainer": return 0;
      case "audioControl": return true;
      case "shutDownPageContainer": if (slowExit) await sleep(200); return true;   // slowExit: a host whose exit call takes 200 ms
      default: return null;
    }
  } },
  addEventListener: (t: string, f: any) => { (listeners[t] = listeners[t] || []).push(f); },
  removeEventListener: (t: string, f: any) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
  dispatchEvent: (e: any) => { (listeners[e.type] || []).forEach((f) => f(e)); return true; },
  CustomEvent: class { type: string; detail: any; constructor(t: string, o: any) { this.type = t; this.detail = o?.detail; } },
  fetch: async (u: any, init: any) => { if (String(u).includes("/v1/ask")) uploads.push(init?.body?.byteLength ?? -1); throw new TypeError("no network in this test"); },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
});
(globalThis as any).window = globalThis;
(globalThis as any).document = { readyState: "complete", visibilityState: "visible", addEventListener() {}, removeEventListener() {},
  getElementById: (id: string) => (els[id] = els[id] || el()), execCommand: () => false };
const appLog: string[] = [];
const realLog = console.log;
console.log = (...a: any[]) => { if (a[0] === "[pull-tab]") appLog.push(a.slice(1).map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };

// ---------- the timer switch ----------
// Installed over whatever setTimeout the SDK put in place. Running: the SDK's timers as usual. Stalled: a timer is kept
// but never fires (clearTimeout still removes it); resume() fires every overdue one, as a host catching up would.
let stalled = false;
type Held = { fn: Function; due: number; args: any[]; real: any; fired: boolean };
const held = new Set<Held>();
function installTimerSwitch() {
  const sdkSet = globalThis.setTimeout, sdkClear = globalThis.clearTimeout;
  (globalThis as any).setTimeout = (fn: Function, ms = 0, ...args: any[]) => {
    const h: Held = { fn, due: Date.now() + ms, args, real: null, fired: false };
    if (!stalled) h.real = sdkSet(() => { h.fired = true; held.delete(h); fn(...args); }, ms);
    held.add(h); return h;
  };
  (globalThis as any).clearTimeout = (h: any) => { if (h && held.has(h)) { held.delete(h); if (h.real) sdkClear(h.real); } };
}
function stall() { stalled = true; }
function fireLong(minMs: number) { for (const h of [...held]) if (!h.fired && h.due - Date.now() > minMs) { held.delete(h); if (h.real) realClearTimeout(h.real); h.fired = true; h.fn(...h.args); } }
function resume() {
  stalled = false;
  for (const h of [...held]) if (!h.real && !h.fired && h.due <= Date.now()) { held.delete(h); h.fired = true; h.fn(...h.args); }
}

// ---------- events ----------
const push = (data: any) => (globalThis as any)._listenEvenAppMessage({ type: "listen_even_app_data", method: "evenHubEvent", data });
// OsEventTypeList values in SDK 0.0.16: 0 = CLICK_EVENT, 3 = DOUBLE_CLICK_EVENT. tap() sends one as a textEvent.
const CLICK = 0, DOUBLE = 3;
const tap = (t: number) => push({ type: "textEvent", jsonData: { containerID: 1, containerName: "main", eventType: t } });
const CHUNK = 3200;   // 100 ms of 16 kHz 16-bit audio, as the glasses send it
const loud = Array.from({ length: CHUNK }, (_, i) => (i % 2 ? 40 : 0));   // loud enough to count as speech
async function audio(n: number) { for (let k = 0; k < n; k++) { push({ type: "audioEvent", jsonData: { audioPcm: loud } }); await sleep(100); } }
const sentChunks = () => uploads.map((b) => (b - SEAL) / CHUNK);   // each upload, in 100 ms chunks of audio
const exits = () => calls.filter((c) => c.method === "shutDownPageContainer");
const micOpens = () => calls.filter((c) => c.method === "audioControl" && (c.data === true || c.data?.isOpen === true || c.data?.open === true || (Array.isArray(c.data) && c.data[0] === true) || JSON.stringify(c.data ?? "").includes("true")));
const recording = () => appLog.some((m) => m.includes("* listening")) || lens.some((t) => t.includes("* listening"));

function report(name: string, ok: boolean, detail: any) {
  realLog(JSON.stringify({ name, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) }));
}

// Boots the real app, waits for its "ready" log line, installs the timer switch, then runs the named scenario.
async function main() {
  await import("../../app/src/main");
  for (let i = 0; i < 100 && !appLog.some((m) => m.startsWith("ready")); i++) await sleep(20);
  if (!appLog.some((m) => m.startsWith("ready"))) { report("boot", false, appLog.slice(-5)); process.exit(1); }
  installTimerSwitch();
  await sleep(50);
  const sc = process.env.PT_TAPS_SCENARIO || "";
  const state = () => ({ exits: exits().length, micOpens: micOpens().length, recording: recording(), sent: sentChunks(), log: appLog.filter((m) => /tap|exit|triple|listening|recording/.test(m)).slice(-6) });

  if (sc === "boot_probe") {   // what the mocked host saw (for debugging the mock)
    report(sc, true, { calls: calls.map((c) => c.method), store: Object.keys(store), log: appLog.slice(-8), lens: lens.slice(-2) }); return;
  }
  if (sc === "running_double_tap_exits") {
    tap(DOUBLE); await sleep(900);
    const s = state(); report(sc, s.exits === 1 && s.micOpens === 0 && !s.recording, s); return;
  }
  if (sc === "running_single_tap_does_not_record") {
    tap(CLICK); await sleep(900);
    const s = state(); report(sc, s.exits === 0 && s.micOpens === 0 && !s.recording, s); return;
  }
  if (sc === "running_triple_tap_records") {
    tap(CLICK); await sleep(120); tap(DOUBLE); await sleep(300);
    const s = state(); report(sc, s.micOpens === 1 && s.recording && s.exits === 0, s); return;
  }
  // The bug (Oct 31 2026): with the app's timers stalled, a double-tap left 2 taps waiting and the next single tap
  // (seconds later) made 3 = a recording, while the double-tap never exited.
  if (sc === "stalled_single_tap_after_double_tap_does_not_record") {
    stall(); tap(DOUBLE); await sleep(1500); tap(CLICK); await sleep(300);
    const s = state(); report(sc, s.micOpens === 0 && !s.recording, s); return;
  }
  if (sc === "stalled_double_tap_still_exits_at_next_tap") {
    stall(); tap(DOUBLE); await sleep(1500); tap(CLICK); await sleep(300);
    const s = state(); report(sc, s.exits === 1, s); return;
  }
  if (sc === "stalled_double_tap_exits_once_when_timers_resume") {
    stall(); tap(DOUBLE); await sleep(1000); resume(); await sleep(300);
    const s = state(); report(sc, s.exits === 1 && s.micOpens === 0, s); return;
  }
  if (sc === "stalled_late_settle_then_resume_no_second_exit") {
    stall(); tap(DOUBLE); await sleep(1500); tap(CLICK); await sleep(300); resume(); await sleep(2000);
    const s = state(); report(sc, s.exits === 1 && s.micOpens === 0 && !s.recording, s); return;
  }
  for (const [name, seq] of [["1+2", [CLICK, DOUBLE]], ["2+1", [DOUBLE, CLICK]], ["1+1+1", [CLICK, CLICK, CLICK]]] as [string, number[]][]) {
    if (sc === `stalled_triple_tap_${name}_records`) {
      stall(); for (let i = 0; i < seq.length; i++) { if (i) await sleep(120); tap(seq[i]); } await sleep(300);
      const s = state(); report(sc, s.micOpens === 1 && s.recording && s.exits === 0, s); return;
    }
  }
  if (sc === "stalled_triple_tap_after_stale_single_records_once") {
    // a stale single tap (its burst left open) followed seconds later by a real triple-tap: the old tap is settled
    // first (a hint, nothing else) and the triple starts exactly one recording
    stall(); tap(CLICK); await sleep(1500); tap(CLICK); await sleep(120); tap(DOUBLE); await sleep(300);
    const s = state(); report(sc, s.micOpens === 1 && s.recording && s.exits === 0, s); return;
  }
  // ---------- 0.1.16b (re-audit, Oct 31 2026): settleStale() on every event, lastTapAt first, burstBytes ----------
  // (a) a single tap while recording, timers stalled: the rest of the recording is still kept (0.1.16 muted it until the next tap)
  if (sc === "stalled_single_tap_while_recording_keeps_audio") {
    tap(CLICK); await sleep(120); tap(DOUBLE); await sleep(200);          // timers running: start recording
    await audio(10); stall(); tap(CLICK); await audio(15);                // one tap, then 1.5 s more speech with timers stalled
    tap(CLICK); await sleep(120); tap(DOUBLE); await sleep(400);          // send
    const s = state(); report(sc, s.micOpens === 1 && s.exits === 0 && s.sent.length === 1 && s.sent[0] === 25, s); return;
  }
  // (b) a double-tap while recording, timers stalled: the audio chunks settle it (exit) about 0.7 s later; a triple-tap
  // much later starts a new recording and pops no exit menu (0.1.16 raised the menu only at that later triple)
  if (sc === "stalled_double_tap_while_recording_exits_on_audio") {
    tap(CLICK); await sleep(120); tap(DOUBLE); await sleep(200);
    await audio(5); stall(); tap(DOUBLE); await audio(10);
    const mid = state();
    await sleep(2000); tap(CLICK); await sleep(120); tap(DOUBLE); await sleep(400);   // past the 1.5 s exit guard
    const s = state();
    report(sc, mid.exits === 1 && s.exits === 1 && s.micOpens === 2 && s.recording && s.sent.length === 0, { mid, end: s }); return;
  }
  // (c) a stale double settled on the next tap while the host takes 200 ms to answer the exit call: a real 1+1+1
  // triple-tap (gaps 150 ms, 600 ms) still records (0.1.16 wrote the first tap's older time after the await and split it)
  if (sc === "stalled_triple_during_slow_exit_settle_records") {
    stall(); tap(DOUBLE); await sleep(1500);
    tap(CLICK); await sleep(150); tap(CLICK); await sleep(600); tap(CLICK); await sleep(400);
    const s = state(); report(sc, s.exits === 1 && s.micOpens === 1 && s.recording, s); return;
  }
  // a send keeps only the audio before the send's first tap (the taps' own sound is not uploaded)
  if (sc === "running_send_trims_the_send_taps") {
    tap(CLICK); await sleep(120); tap(DOUBLE); await sleep(200);
    await audio(12); tap(CLICK); await audio(2); tap(DOUBLE); await sleep(400);
    const s = state(); report(sc, s.micOpens === 1 && s.sent.length === 1 && s.sent[0] === 12, s); return;
  }
  // trade-off: a lone tap while recording no longer pauses the audio; its click stays in, nothing is lost
  if (sc === "running_single_tap_while_recording_keeps_all_audio") {
    tap(CLICK); await sleep(120); tap(DOUBLE); await sleep(200);
    await audio(10); tap(CLICK); await audio(10);                         // the tap's 700 ms window passes during these
    tap(CLICK); await sleep(120); tap(DOUBLE); await sleep(400);
    const s = state(); report(sc, s.micOpens === 1 && s.exits === 0 && s.sent.length === 1 && s.sent[0] === 20, s); return;
  }
  // cap trade-off: the 55 s cap fires between the taps of a 1+2 send: recording discarded, leftover taps = exit menu
  if (sc === "audit_cap_between_send_taps") {
    tap(CLICK); await sleep(120); tap(DOUBLE); await sleep(200); await audio(10);
    tap(CLICK); await sleep(100); fireLong(30_000); await sleep(100); tap(DOUBLE); await sleep(900);
    const s = state(); report(sc, s.exits === 0 && s.sent.length === 1, { ...s, lens: lens.slice(-2) }); return;
  }
  report(sc || "(none)", false, "unknown scenario");
}
main().then(() => process.exit(0)).catch((e) => { report("error", false, String(e?.stack || e)); process.exit(1); });
