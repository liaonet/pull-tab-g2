// Lifecycle tests (test/lifecycle.sh; new in 0.1.18, rules changed in 2.0.0): the real app (app/src/main.ts) and the real Even Hub SDK 0.0.16 with a
// mocked Even app host, as in test/taps (same mock). Checks Even's exit signals (SYSTEM_EXIT 7 turns the page off,
// ABNORMAL_EXIT 6 pauses it; neither sends the glasses anything), that launch sends no mic command, the
// single-instance launch id (pt.instance in bridge storage), and that phone lock / a hidden page / FOREGROUND_EXIT (5) are
// NOT exits. One scenario per run: PT_LIFE_SCENARIO names it. Each scenario prints one JSON line {name, ok, detail}.
// A newer page is simulated the way it shows up to an older one: another launch id written into the shared storage.
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
const sleep = (ms: number) => new Promise((r) => realSetTimeout(r, ms));

const slowExit = (process.env.PT_LIFE_SCENARIO || "").includes("slow_exit");
const SC = process.env.PT_LIFE_SCENARIO || "";
const hangAsk = SC.includes("sending");
const slowLens = SC.includes("slow_draw");   // a host that takes 300 ms to draw each lens text   // an upload that stays in flight until the app aborts it
const fetches: { url: string; aborted: boolean }[] = [];   // every request the app made (and whether it was aborted)
let storageBroken = false;                // getLocalStorage throws for pt.instance (the guard must carry on)
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
      case "getLocalStorage": { const k = typeof data === "string" ? data : data?.key; if (storageBroken && k === "pt.instance") throw new Error("storage refused"); return store[k] ?? ""; }
      case "setLocalStorage": { const k = data?.key, v = data?.value; if (k) store[k] = v; return true; }
      case "textContainerUpgrade": { const c = data?.content ?? data?.textContainerUpgrade?.content ?? JSON.stringify(data); lens.push(String(c)); if (slowLens) await sleep(300); return true; }
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
  fetch: async (u: any, init: any) => {
    const f = { url: String(u), aborted: false }; fetches.push(f);
    if (String(u).includes("/v1/ask")) {
      uploads.push(init?.body?.byteLength ?? -1);
      if (SC.includes("relayok")) {   // a relay that answers with a valid signature, so the app reaches "Sent" (2.0.0 code review)
        const pt = await import("../../app/src/pt");
        const k = pt.keysFrom(pt.unb64u(store["pt.secret"]));
        const body = new TextEncoder().encode(JSON.stringify({ ok: true, id: "req-1", reply_by: "text" }));
        const rsig = pt.respSig(k.rkey, 200, init.headers["x-pt-sig"], body);
        return new Response(body, { status: 200, headers: { "x-pt-rsig": rsig, "content-length": String(body.length) } });
      }
      if (hangAsk) return new Promise((_, rej) => { init?.signal?.addEventListener?.("abort", () => { f.aborted = true; rej(new Error("aborted")); }); });
    }
    throw new TypeError("no network in this test");
  },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
});
(globalThis as any).window = globalThis;
const docListeners: Record<string, any[]> = {};
(globalThis as any).document = { readyState: "complete", visibilityState: "visible",
  addEventListener: (t: string, f: any) => { (docListeners[t] = docListeners[t] || []).push(f); },
  removeEventListener: (t: string, f: any) => { docListeners[t] = (docListeners[t] || []).filter((x) => x !== f); },
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

// ---------- 0.1.18 helpers ----------
const sys = (t: number) => push({ type: "sysEvent", jsonData: { eventType: t } });
const SYSTEM_EXIT = 7, ABNORMAL_EXIT = 6, FOREGROUND_EXIT = 5;
const micCloses = () => calls.filter((c) => c.method === "audioControl").length - micOpens().length;
const pending = () => [...held].filter((x) => !x.fired).length;   // app timers still armed
// Fires every timer still armed now. shutDownSelf clears the app's timers; one created before the timer switch was
// installed can't be cleared through the switch (a test artifact), so instead of counting, every leftover is fired and
// must do nothing: no bridge call, no lens write, no new timer.
function drain() { for (const x of [...held]) if (!x.fired) { held.delete(x); if (x.real) realClearTimeout(x.real); x.fired = true; x.fn(...x.args); } }
function setVisible(v: boolean) {
  (globalThis as any).document.visibilityState = v ? "visible" : "hidden";
  for (const f of docListeners["visibilitychange"] || []) f({ type: "visibilitychange" });
}
const docCount = () => (docListeners["visibilitychange"] || []).length;
const winCount = () => ["blur", "focus", "pagehide", "pageshow"].reduce((n, t) => n + (listeners[t] || []).length, 0);
async function startRecording() { tap(CLICK); await sleep(120); tap(DOUBLE); await sleep(250); }
async function triple() { tap(CLICK); await sleep(120); tap(DOUBLE); await sleep(400); }

async function main() {
  await import("../../app/src/main");
  for (let i = 0; i < 100 && !appLog.some((m) => m.startsWith("ready")); i++) await sleep(20);
  if (!appLog.some((m) => m.startsWith("ready"))) { report("boot", false, appLog.slice(-5)); process.exit(1); }
  installTimerSwitch();
  await sleep(50);
  const mine = store["pt.instance"];
  const shut = () => appLog.some((m) => m.startsWith("shut down"));
  const st = (extra: any = {}) => ({ shut: shut(), micOpens: micOpens().length, micCloses: micCloses(), exits: exits().length, uploads: uploads.length,
    recording: recording(), lensWrites: lens.length, log: appLog.filter((m) => /shut|instance|tap|listening|exit/.test(m)).slice(-5), ...extra });

  // 2.0.0: launch sends the glasses no mic command at all (0.1.18's boot-time mic close is the suspected cause of
  // "Host shutdown did not complete"; CHANGELOG.md)
  if (SC === "boot_sends_no_mic_command") {
    const ok = typeof mine === "string" && mine.length >= 16 && calls.some((c) => c.method === "setLocalStorage" && (c.data?.key === "pt.instance"))
      && !calls.some((c) => c.method === "audioControl");
    report(SC, ok, { mine, methods: [...new Set(calls.map((c) => c.method))] }); return;
  }
  // 1a. SYSTEM_EXIT: the page turns off for good, and sends the glasses nothing from that moment (the host releases the mic)
  if (SC === "system_exit_idle_then_inert") {
    tap(CLICK); await sleep(900); tap(CLICK); await sleep(900);   // the first tap clears the launch hint; the second shows the
                                                                 // hint again: its clear timer and the minute timer are armed
    const before = { timers: pending(), docL: docCount(), winL: winCount() };
    sys(SYSTEM_EXIT); await sleep(100);
    const lensAt = lens.length, callsAt = calls.length;
    drain(); await sleep(50);
    const after = { timers: pending(), docL: docCount(), winL: winCount() };
    await triple(); tap(DOUBLE); await sleep(900); await audio(3); setVisible(false); setVisible(true); await sleep(200);
    const s = st({ before, after, callsAfter: calls.slice(callsAt).map((c) => c.method) });
    report(SC, s.shut && before.timers > 0 && after.timers === 0 && after.docL === 0 && after.winL === 0 && lens.length === lensAt &&
      calls.length === callsAt && s.micOpens === 0 && s.exits === 0 && s.uploads === 0, s); return;
  }
  if (SC === "system_exit_while_recording_drops_it") {
    await startRecording(); await audio(15);
    const opened = micOpens().length, callsAt = calls.length;
    sys(SYSTEM_EXIT); await sleep(100);
    const atExit = calls.slice(callsAt).map((c) => c.method), lensAt = lens.length;
    drain(); await audio(5); await triple(); await sleep(300);
    const s = st({ opened, atExit, timers: pending(), callsAfter: calls.slice(callsAt).map((c) => c.method) });
    report(SC, opened === 1 && atExit.length === 0 && s.shut && s.uploads === 0 && s.micOpens === 1 && pending() === 0 && calls.length === callsAt && lens.length === lensAt, s); return;
  }
  // 1b. ABNORMAL_EXIT: work dropped and nothing sent to the glasses, but the page stays subscribed; the next tap that
  // reaches it makes it live again (a Bluetooth drop may fire this signal)
  if (SC === "abnormal_exit_idle_pauses_then_tap_resumes") {
    tap(CLICK); await sleep(900); tap(CLICK); await sleep(900);   // hint up: clear timer and minute timer armed
    const before = { timers: pending(), docL: docCount(), winL: winCount() };
    sys(ABNORMAL_EXIT); await sleep(100);
    const lensAt = lens.length, callsAt = calls.length;
    drain(); await sleep(50);
    const after = { timers: pending(), docL: docCount(), winL: winCount() };
    await audio(3); sys(FOREGROUND_EXIT); await sleep(100);
    const glassesCalls = calls.slice(callsAt).filter((c) => !/LocalStorage$/.test(c.method)).map((c) => c.method);
    const quiet = lens.length === lensAt && glassesCalls.length === 0;
    await startRecording(); await audio(15); await triple();          // the first tap resumes; the triple-tap records and sends
    const s = st({ before, after, quiet, glassesCalls });
    report(SC, !s.shut && before.timers > 0 && after.timers === 0 && after.docL === 1 && after.winL === 4 && quiet &&
      s.micOpens === 1 && s.uploads === 1 && s.exits === 0 && appLog.some((m) => m.startsWith("resumed")), s); return;
  }
  if (SC === "abnormal_exit_while_recording_drops_it") {
    await startRecording(); await audio(15);
    const callsAt = calls.length, lensAt = lens.length;
    sys(ABNORMAL_EXIT); await sleep(100);
    drain(); await audio(5); await sleep(100);
    const glassesCalls = calls.slice(callsAt).filter((c) => !/LocalStorage$/.test(c.method)).map((c) => c.method);
    const s = st({ glassesCalls, timers: pending() });
    report(SC, !s.shut && glassesCalls.length === 0 && lens.length === lensAt && s.uploads === 0 && s.micOpens === 1 && pending() === 0 &&
      appLog.some((m) => m.startsWith("paused: abnormal exit phase was listening")), s); return;
  }
  for (const [name, code] of [["system_exit", SYSTEM_EXIT], ["abnormal_exit", ABNORMAL_EXIT]] as [string, number][]) {
    if (SC === `${name}_while_sending_cancels_upload`) {
      await startRecording(); await audio(15); tap(CLICK); await sleep(120); tap(DOUBLE); await sleep(300);   // send: upload hangs
      const inFlight = fetches.filter((f) => f.url.includes("/v1/ask")).length, callsAt = calls.length;
      sys(code); await sleep(200);
      const ask = fetches.find((f) => f.url.includes("/v1/ask"));
      const cancels = fetches.filter((f) => f.url.includes("/v1/cancel")).length;
      const glassesCalls = calls.slice(callsAt).filter((c) => !/LocalStorage$/.test(c.method)).map((c) => c.method);
      const stopped = appLog.some((m) => m.startsWith(code === SYSTEM_EXIT ? "shut down" : "paused"));
      const s = st({ inFlight, aborted: !!ask?.aborted, cancels, glassesCalls, lastLens: lens.slice(-1) });
      const lensAt = lens.length; drain(); await sleep(50);
      report(SC, inFlight === 1 && !!ask?.aborted && cancels === 1 && stopped && glassesCalls.length === 0 && !lens.slice(-1)[0]?.includes("Sent") && pending() === 0 && lens.length === lensAt, s); return;
    }
  }
  // A SYSTEM_EXIT while paused still turns the page off
  if (SC === "abnormal_then_system_exit_turns_off") {
    sys(ABNORMAL_EXIT); await sleep(50); sys(SYSTEM_EXIT); await sleep(50);
    const callsAt = calls.length; await startRecording(); await audio(3);
    const s = st({ docL: docCount() });
    report(SC, s.shut && docCount() === 0 && calls.length === callsAt && s.micOpens === 0, s); return;
  }
  // 3. not exits: FOREGROUND_EXIT (an overlay), and a hidden phone page (phone locked / in a pocket)
  if (SC === "foreground_exit_is_not_an_exit") {
    sys(FOREGROUND_EXIT); await sleep(100); await startRecording();
    const s = st(); report(SC, !s.shut && s.micOpens === 1 && s.recording, s); return;
  }
  if (SC === "hidden_page_is_not_an_exit") {
    setVisible(false); await sleep(100);
    (globalThis as any).dispatchEvent({ type: "pagehide" }); (globalThis as any).dispatchEvent({ type: "blur" }); await sleep(100);
    await startRecording(); await audio(15); await triple();                // a whole ask with the page still hidden
    const s = st(); report(SC, !s.shut && s.micOpens === 1 && s.uploads === 1, s); return;
  }
  // 2. single instance
  if (SC === "superseded_before_mic_shuts_down") {
    store["pt.instance"] = "a-newer-page";
    const closesBefore = micCloses();
    await startRecording(); await audio(3); await triple();
    const s = st({ closedOtherMic: micCloses() - closesBefore });
    report(SC, s.shut && s.micOpens === 0 && s.closedOtherMic === 0 && s.uploads === 0 && s.exits === 0 && store["pt.instance"] === "a-newer-page", s); return;
  }
  // The superseded page drops its recording but leaves the glasses mic to the newer page
  if (SC === "superseded_at_first_tap_drops_recording") {
    await startRecording(); await audio(15);
    store["pt.instance"] = "a-newer-page";
    const closesBefore = micCloses();
    tap(CLICK); await sleep(120); tap(DOUBLE); await sleep(400);           // a send attempt
    const s = st({ closedOwnMic: micCloses() - closesBefore });
    report(SC, s.shut && s.uploads === 0 && s.closedOwnMic === 0 && s.micOpens === 1, s); return;
  }
  if (SC === "superseded_between_send_taps_sends_nothing") {
    await startRecording(); await audio(15);
    tap(CLICK); await sleep(60);                                           // first tap of the send passes the check
    store["pt.instance"] = "a-newer-page"; await sleep(60); tap(DOUBLE); await sleep(400);
    const s = st({ fetches: fetches.map((f) => f.url.replace(/^https?:\/\/[^/]+/, "")) });
    report(SC, s.shut && s.uploads === 0 && !fetches.some((f) => f.url.includes("/v1/ask") || f.url.includes("/v1/cancel")) && micCloses() >= 1, s); return;
  }
  if (SC === "superseded_double_tap_opens_no_exit_menu") {
    store["pt.instance"] = "a-newer-page";
    tap(DOUBLE); await sleep(900);
    const s = st(); report(SC, s.shut && s.exits === 0, s); return;
  }
  if (SC === "current_page_keeps_working") {
    await startRecording(); await audio(15); await triple();
    const s = st(); report(SC, !s.shut && s.micOpens === 1 && s.uploads === 1 && store["pt.instance"] === mine, s); return;
  }
  if (SC === "page_shown_again_reclaims") {
    store["pt.instance"] = "a-background-copy";                           // e.g. the host ran a background copy meanwhile
    setVisible(false); await sleep(50); setVisible(true); await sleep(200);
    await startRecording();
    const s = st({ instance: store["pt.instance"] === mine });
    report(SC, s.instance && !s.shut && s.micOpens === 1, s); return;
  }
  if (SC === "storage_unreadable_carries_on") {
    storageBroken = true;
    await startRecording(); await audio(15); await triple();
    const s = st(); report(SC, !s.shut && s.micOpens === 1 && s.uploads === 1, s); return;
  }
  // An exit while "Sending..." is still being drawn uploads nothing
  if (SC === "system_exit_during_slow_draw_uploads_nothing") {
    await startRecording(); await sleep(400); await audio(15);
    tap(CLICK); await sleep(120); tap(DOUBLE); await sleep(150);          // send; "Sending..." is being drawn
    const drawing = lens.slice(-1)[0]?.includes("Sending") ?? false;
    sys(SYSTEM_EXIT); await sleep(800);
    const s = st({ drawing });
    report(SC, s.shut && drawing && s.uploads === 0 && !fetches.some((f) => f.url.includes("/v1/ask")), s); return;
  }
  // A focus event while the page is still hidden (a ghost WebView) does not reclaim
  if (SC === "focus_while_hidden_does_not_reclaim") {
    store["pt.instance"] = "a-newer-page";
    setVisible(false); await sleep(50);
    (globalThis as any).dispatchEvent({ type: "focus" }); await sleep(200);
    const kept = store["pt.instance"] === "a-newer-page";
    await startRecording();
    const s = st({ kept }); report(SC, kept && s.shut && s.micOpens === 0, s); return;
  }
  // 2.0.0 code review (F1, F2): timers of a replaced page, and timers while Even's exit menu is up, send the glasses nothing
  const glassesWrites = (from: number) => calls.slice(from).filter((c) => !/LocalStorage$/.test(c.method)).map((c) => c.method);
  if (SC === "superseded_hint_timer_writes_nothing") {
    tap(CLICK); await sleep(900); tap(CLICK); await sleep(900);   // hint lit again: its clear timer is armed
    const callsAt = calls.length;
    store["pt.instance"] = "a-newer-page";                        // closed from the phone and reopened: a newer page claimed
    fireLong(1000); await sleep(300);
    const w = glassesWrites(callsAt);
    report(SC, w.length === 0 && shut(), { glassesWrites: w, shut: shut() }); return;
  }
  if (SC === "exit_menu_pending_timer_writes_nothing_relayok") {
    await startRecording(); await audio(15); await triple(); await sleep(300);   // "Sent" lit, 8 s cancel window armed
    const sentShown = lens.some((t) => t.includes("Sent, reply coming by text"));
    tap(DOUBLE); await sleep(900);                                               // exit menu while "Sent" is up
    const callsAt = calls.length, exitsAt = exits().length;
    fireLong(1000); await sleep(300);
    const w = glassesWrites(callsAt);
    report(SC, sentShown && exitsAt === 1 && w.length === 0, { sentShown, exitsAt, glassesWrites: w }); return;
  }
  report(SC || "(none)", false, "unknown scenario");
}
main().then(() => process.exit(0)).catch((e) => { report("error", false, String(e?.stack || e)); process.exit(1); });
