// 0.1.10: the phone's signed connection check runs once on open and once each time it returns, never on a timer.
import { checkOnOpenAndResume } from "../../app/src/resume";
const r: { name: string; ok: boolean; detail: string }[] = [];
const test = (name: string, ok: any, detail = "") => r.push({ name, ok: !!ok, detail });
class E { h = new Map<string, Function[]>(); addEventListener(k: string, f: Function) { this.h.set(k, [...(this.h.get(k) || []), f]); }
  removeEventListener(k: string, f: Function) { this.h.set(k, (this.h.get(k) || []).filter(x => x !== f)); }
  count() { let n = 0; this.h.forEach(v => { n += v.length; }); return n; }
  fire(k: string, arg: any = {}) { (this.h.get(k) || []).forEach(f => f(arg)); } }
const sleep = (ms = 5) => new Promise(done => setTimeout(done, ms));
async function main() {
  const doc = Object.assign(new E(), { visibilityState: "visible" }); const win = new E(); const seen: string[] = [];
  checkOnOpenAndResume(doc, win, async why => { seen.push(why); }); await sleep();
  test("open checks once", seen.join(",") === "open", seen.join(","));
  win.fire("focus"); doc.fire("visibilitychange"); await sleep(); test("without leaving, neither focus nor visibility creates another check", seen.length === 1, seen.join(","));
  doc.visibilityState = "hidden"; doc.fire("visibilitychange"); win.fire("blur"); await sleep();
  test("no check while away", seen.length === 1, seen.join(","));
  doc.visibilityState = "visible"; doc.fire("visibilitychange"); win.fire("focus"); await sleep();
  test("return via visibility + focus is one check", seen.join(",") === "open,resume", seen.join(","));
  win.fire("blur"); win.fire("focus"); await sleep(); test("another return checks once", seen.join(",") === "open,resume,resume", seen.join(","));
  win.fire("pagehide"); win.fire("pageshow", { persisted: true }); await sleep();
  test("page restored from cache checks once", seen.length === 4 && seen[3] === "resume", seen.join(","));
  const d2 = Object.assign(new E(), { visibilityState: "visible" }); const w2 = new E(); let runs = 0; let release!: () => void;
  checkOnOpenAndResume(d2, w2, async () => { runs++; await new Promise<void>(resolve => { release = resolve; }); });
  await sleep(); w2.fire("blur"); w2.fire("focus"); await sleep();
  test("resume while check in flight does not overlap", runs === 1, String(runs)); release(); await sleep();
  w2.fire("blur"); w2.fire("focus"); await sleep(); test("a later resume works after flight", runs === 2, String(runs)); release();
  const d3 = Object.assign(new E(), { visibilityState: "visible" }); const w3 = new E(); let failures = 0;
  checkOnOpenAndResume(d3, w3, async () => { failures++; if (failures === 1) throw Error("network failed"); });
  await sleep(); w3.fire("blur"); w3.fire("focus"); await sleep(); test("a failed check does not block the next return", failures === 2, String(failures));
  // 0.1.18: the returned function removes every listener (main.ts calls it when Pull Tab exits); no check runs after it
  const d4 = Object.assign(new E(), { visibilityState: "visible" }); const w4 = new E(); let runs4 = 0;
  const off = checkOnOpenAndResume(d4, w4, async () => { runs4++; }); await sleep();
  const had = d4.count() + w4.count(); off();
  test("0.1.18 the remover takes every listener off", had === 5 && d4.count() + w4.count() === 0, `${had} -> ${d4.count() + w4.count()}`);
  w4.fire("blur"); w4.fire("focus"); d4.visibilityState = "hidden"; d4.fire("visibilitychange"); d4.visibilityState = "visible"; d4.fire("visibilitychange"); await sleep();
  test("0.1.18 no check after removal", runs4 === 1, String(runs4));
  const fail = r.filter(x => !x.ok); for (const x of r) console.log((x.ok ? "PASS " : "FAIL ") + x.name + (x.detail ? " (" + x.detail + ")" : ""));
  console.log(`${r.length - fail.length}/${r.length} passed`); if (fail.length) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
