// resume.ts: re-runs the app's signed relay connection check when the phone screen opens or is returned to.
//
// v0.1.10 (no "Check connection" button; the phone screen shows the
// connection status by itself when opened). Kept apart from main.ts so it can be unit-tested (test/resume/resume-test.ts).
//
// The signed check runs once when the screen opens, and once each time the person comes back to it (the page was hidden
// or lost focus, e.g. they switched to their chat with Tab and back). There is no timer and no polling loop: with no
// open/resume nothing is checked. A resume while a check is still running doesn't start a second one, and the two
// events a phone may fire for one return (visibilitychange and focus) count once.
// Inputs: the document and window (any objects with addEventListener, so tests can pass fakes) and the check to run.
// Output: a function that removes every listener this added (0.1.18: main.ts calls it when Pull Tab exits); the check's
// own result is handled by the caller (main.ts boot()).
//
// Why several events: Android and iOS WebViews differ in which of visibilitychange, blur/focus and pagehide/pageshow
// they fire when the person switches apps or locks the phone, so all of them are watched and folded into one
// "away / back" state. pageshow with `persisted` means the page came back from the back-forward cache.
// The minimal event-target shape used here, so tests can pass a fake window and document.
type Target = { addEventListener(type: string, fn: (e: any) => void): void; removeEventListener?(type: string, fn: (e: any) => void): void };
/** A document-like target: events plus the page's visibilityState ("visible" or "hidden"). */
export type Doc = Target & { visibilityState?: string };

/**
 * Runs `check("open")` now and `check("resume")` each time the page comes back after being hidden or unfocused.
 * @param doc the document (for visibilitychange).
 * @param win the window (for blur, focus, pagehide, pageshow).
 * @param check the signed connection check; errors are caught and logged, never thrown.
 * @param log optional debug logger.
 * Side effects: adds event listeners until the returned function is called (0.1.18: main.ts calls it when Pull Tab exits).
 * @returns a function that removes the listeners again; afterwards no check runs.
 */
export function checkOnOpenAndResume(doc: Doc, win: Target, check: (why: "open" | "resume") => Promise<unknown>, log?: (...a: any[]) => void): () => void {
  let away = false, busy = false;
  const run = (why: "open" | "resume") => {
    if (busy) { log?.("status check already running:", why, "skipped"); return; }
    busy = true;
    Promise.resolve().then(() => check(why)).catch((e) => log?.("status check failed", e)).then(() => { busy = false; });
  };
  const leave = () => { away = true; };
  const back = () => { if (!away) return; away = false; run("resume"); };
  const vis = () => { if (doc.visibilityState === "hidden") leave(); else back(); };
  const show = (e: any) => { if (e && e.persisted) { away = true; back(); } };
  doc.addEventListener("visibilitychange", vis);
  win.addEventListener("blur", leave);
  win.addEventListener("focus", back);
  win.addEventListener("pagehide", leave);
  win.addEventListener("pageshow", show);
  run("open");
  return () => {
    away = false;
    try { doc.removeEventListener?.("visibilitychange", vis); win.removeEventListener?.("blur", leave); win.removeEventListener?.("focus", back);
      win.removeEventListener?.("pagehide", leave); win.removeEventListener?.("pageshow", show); } catch {}
  };
}
