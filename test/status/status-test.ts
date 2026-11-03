// Status line tests (test/status.sh). Pure formatting, plus the battery tracker driven through the real
// Even Hub SDK 0.0.16 with a mocked Even app host (no glasses, no network).
import { clockText, level, statusLine, Batteries } from "../../app/src/status";

let pass = 0, fail = 0;
const results: Record<string, { ok: boolean; detail: string }> = {};
function check(name: string, ok: boolean, detail = "") { results[name] = { ok, detail }; ok ? pass++ : fail++; }
const tick = () => new Promise((r) => setTimeout(r, 20));

// ---------- formatting ----------
const d = new Date(2026, 9, 25, 14, 5);     // Sun 25 Oct 2026, 14:05 local
check("clock_24h", clockText(d, false) === "14:05  Sun 25 Oct", clockText(d, false));
check("clock_12h_pm", clockText(d, true) === "2:05pm  Sun 25 Oct", clockText(d, true));
check("clock_12h_midnight", clockText(new Date(2026, 0, 1, 0, 7), true) === "12:07am  Thu 1 Jan");
check("clock_12h_noon", clockText(new Date(2026, 0, 1, 12, 0), true) === "12:00pm  Thu 1 Jan");
check("clock_24h_pads", clockText(new Date(2026, 11, 31, 9, 3), false) === "09:03  Thu 31 Dec");
check("line_all", statusLine(d, false, 77, 60) === "14:05  Sun 25 Oct  |  Glasses 77%  Ring 60%", statusLine(d, false, 77, 60));
check("line_glasses_only", statusLine(d, false, 77, null) === "14:05  Sun 25 Oct  |  Glasses 77%");
check("line_ring_only", statusLine(d, false, null, 60) === "14:05  Sun 25 Oct  |  Ring 60%");
check("line_none", statusLine(d, false, null, null) === "14:05  Sun 25 Oct");
check("line_ascii_only", /^[\x20-\x7e]*$/.test(statusLine(d, true, 100, 1)));
check("line_fits_one_lens_line", statusLine(new Date(2026, 8, 30, 12, 59), true, 100, 100).length <= 54);
check("level_ok", level({ connectType: "connected", batteryLevel: 77 }) === 77);
check("level_rounds", level({ connectType: "connected", batteryLevel: 76.6 }) === 77);
check("level_zero_is_unknown", level({ connectType: "connected", batteryLevel: 0 }) === null);   // the SDK's default
check("level_disconnected_hidden", level({ connectType: "disconnected", batteryLevel: 50 }) === null);
check("level_missing", level({ connectType: "connected" }) === null && level(null) === null);
check("level_out_of_range", level({ connectType: "connected", batteryLevel: 140 }) === null);

// ---------- SDK path, mocked host ----------
type Dev = any;
let glassesInfo: Dev = null;
let calls: string[] = [];
const listeners: Record<string, any[]> = {};
Object.assign(globalThis, {
  flutter_inappwebview: { callHandler: async (_n: string, msg: any) => {
    const m = typeof msg === "string" ? JSON.parse(msg) : msg; calls.push(m.method);
    return m.method === "getGlassesInfo" ? glassesInfo : null; } },
  addEventListener: (t: string, f: any) => { (listeners[t] = listeners[t] || []).push(f); },
  removeEventListener: (t: string, f: any) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
  dispatchEvent: (e: any) => { (listeners[e.type] || []).forEach((f) => f(e)); return true; },
  CustomEvent: class { type: string; detail: any; constructor(t: string, o: any) { this.type = t; this.detail = o?.detail; } },
});
(globalThis as any).window = globalThis;
(globalThis as any).document = { readyState: "complete", addEventListener() {} };
console.log = () => {};                       // the SDK logs every push
const push = (data: any) => (globalThis as any)._listenEvenAppMessage({ type: "listen_even_app_data", method: "deviceStatusChanged", data });

async function main() {
  const sdk: any = await import("@evenrealities/even_hub_sdk");
  const bridge = sdk.EvenAppBridge.getInstance();

  glassesInfo = { model: "g2", sn: "G2-1", status: { sn: "G2-1", connectType: "connected", batteryLevel: 77 } };
  let changes = 0;
  const b = new Batteries(bridge, () => changes++);
  await b.refresh(); b.start();
  check("sdk_calls_getGlassesInfo", calls.includes("getGlassesInfo"), calls.join(","));
  check("sdk_glasses_level", b.glasses === 77 && b.ring === null, `${b.glasses}/${b.ring}`);
  check("sdk_change_on_first_read", changes === 1, String(changes));
  push({ sn: "G2-1", connectType: "connected", batteryLevel: 71 }); await tick();
  check("sdk_push_updates_glasses", b.glasses === 71 && changes === 2, `${b.glasses} ${changes}`);
  push({ sn: "G2-1", connectType: "connected", batteryLevel: 71 }); await tick();
  check("sdk_same_level_no_redraw", changes === 2, String(changes));
  calls = [];
  push({ sn: "OTHER-9", connectType: "connected", batteryLevel: 40 }); await tick();
  check("sdk_unknown_device_not_called_ring", b.ring === null && b.glasses === 71, `${b.glasses}/${b.ring}`);
  check("sdk_unknown_device_asks_at_most_every_30s", calls.length === 0, calls.join(","));
  push({ sn: "G2-1", connectType: "disconnected", batteryLevel: 0 }); await tick();
  check("sdk_disconnect_hides_glasses", b.glasses === null && changes === 3, `${b.glasses} ${changes}`);

  glassesInfo = null;                         // host answers nothing: nothing shown, nothing thrown
  const b2 = new Batteries(bridge, () => {}); await b2.refresh();
  check("sdk_no_device_info", b2.glasses === null && b2.ring === null);

  glassesInfo = { model: "ring1", sn: "R1-1", status: { sn: "R1-1", connectType: "connected", batteryLevel: 60 } };
  const b3 = new Batteries(bridge, () => {}); await b3.refresh(); b3.start();
  check("sdk_ring_only_when_host_says_ring1", b3.ring === 60 && b3.glasses === null, `${b3.glasses}/${b3.ring}`);
  push({ sn: "R1-1", connectType: "connected", batteryLevel: 58 }); await tick();
  check("sdk_ring_push_updates_ring", b3.ring === 58, String(b3.ring));
  // 0.1.18: start() returns the SDK's unsubscribe; after it, pushes change nothing (main.ts calls it when Pull Tab exits)
  const b18 = new Batteries(bridge, () => {}); glassesInfo = { model: "g2", sn: "G2-4", status: { sn: "G2-4", connectType: "connected", batteryLevel: 50 } };
  await b18.refresh(); const off4 = b18.start();
  check("sdk_start_returns_unsubscribe", typeof off4 === "function", typeof off4);
  off4?.(); push({ sn: "G2-4", connectType: "connected", batteryLevel: 44 }); await tick();
  check("sdk_no_push_after_unsubscribe", b18.glasses === 50, String(b18.glasses));

  glassesInfo = { model: "g2", sn: "G2-2" };  // no status: the SDK fills batteryLevel 0, which must not show as 0%
  const b4 = new Batteries(bridge, () => {}); await b4.refresh();
  check("sdk_missing_status_not_zero", b4.glasses === null, String(b4.glasses));

  process.stdout.write(JSON.stringify({ pass, fail, results }) + "\n");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { process.stdout.write(JSON.stringify({ pass, fail: fail + 1, error: String(e) }) + "\n"); process.exit(1); });
