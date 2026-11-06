// status.ts: the status line at the top of every lit lens screen (time, date, glasses and ring battery), and the battery
// levels behind it. Output: a one-line string such as "14:05  Mon 2 Nov  |  Glasses 80%".
// Time and date come from the phone's clock. Battery comes from the Even Hub SDK 0.0.16:
//   bridge.getDeviceInfo(): Promise<DeviceInfo | null>  (host method "getGlassesInfo"; DeviceInfo.model is g1|g2|ring1,
//                                                        DeviceInfo.status.batteryLevel is 0-100)
//   bridge.onDeviceStatusChanged(cb: (status: DeviceStatus) => void): () => void  (pushes carry sn, no model)
// The SDK has no call that returns the R1 ring, so its level shows only if the host ever answers getDeviceInfo with a
// ring1 device; a status push is matched to a device by serial number and is never guessed to be the ring.
// A missing value is left out, never shown as 0: the SDK fills a missing batteryLevel with 0.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// 12- or 24-hour, as the phone's locale writes 1 pm (ASCII only: the lens font is not proven beyond it).
/** @returns true when the phone's locale writes 1 pm with a 12-hour clock (formats 13:00 and looks for "13"). */
export function phoneUses12h(): boolean {
  try { return !/13/.test(new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2020, 0, 1, 13))); }
  catch { return false; }
}
/** Formats time and date, e.g. "2:05pm  Mon 2 Nov" or "14:05  Mon 2 Nov". English names: the lens font is ASCII. */
export function clockText(d: Date, h12: boolean): string {
  const h = d.getHours(), m = String(d.getMinutes()).padStart(2, "0");
  const time = h12 ? `${h % 12 || 12}:${m}${h < 12 ? "am" : "pm"}` : `${String(h).padStart(2, "0")}:${m}`;
  return `${time}  ${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
/**
 * Reads one battery level from an SDK device status. A level is shown only when it is a real reading: connected, a
 * number from 1 to 100.
 * @returns the rounded level, or null when there is no real reading.
 */
export function level(s: any): number | null {
  if (!s) return null;
  const c = String(s.connectType ?? "").toLowerCase();
  if (c && c !== "connected") return null;
  const v = Number(s.batteryLevel);
  return Number.isFinite(v) && v >= 1 && v <= 100 ? Math.round(v) : null;
}
/**
 * Joins the clock and any known battery levels into the status line. A null level is omitted.
 * @returns e.g. "14:05  Mon 2 Nov  |  Glasses 80%  Ring 55%".
 */
export function statusLine(now: Date, h12: boolean, glasses: number | null, ring: number | null): string {
  const parts = [clockText(now, h12)];
  const batt = [glasses != null ? `Glasses ${glasses}%` : "", ring != null ? `Ring ${ring}%` : ""].filter(Boolean).join("  ");
  if (batt) parts.push(batt);
  return parts.join("  |  ");
}

/** Keeps the glasses and ring battery levels current from the SDK. onChange runs when a shown value changes. */
export class Batteries {
  glasses: number | null = null;
  ring: number | null = null;
  private glassesSn = "";
  private ringSn = "";
  private lastAsk = 0;
  // onPush (optional) runs on every device status push; main.ts uses it to rewrite the lens at its next draw, since a
  // push may follow a reconnect.
  constructor(private bridge: any, private onChange: () => void, private onPush?: () => void) {}
  // Listens for pushes (call refresh() first for the starting levels). Returns the SDK's unsubscribe function, or null
  // if subscribing failed; main.ts calls it when Pull Tab is turned off.
  start(): (() => void) | null {
    try { const off = this.bridge.onDeviceStatusChanged((s: any) => this.onStatus(s)); return typeof off === "function" ? off : null; } catch { return null; }
  }
  /** One getDeviceInfo call, at most every 30 s (it is only asked again when a push names a device we don't know). */
  async refresh() {
    this.lastAsk = Date.now();
    let d: any = null;
    try { d = await this.bridge.getDeviceInfo(); } catch {}
    if (!d || !d.sn) return;
    const model = String(d.model ?? "").toLowerCase();
    if (model === "ring1") { this.ringSn = d.sn; this.set("ring", level(d.status)); }
    else if (model === "g1" || model === "g2") { this.glassesSn = d.sn; this.set("glasses", level(d.status)); }
  }
  // Handles one device status push: notify the app (lens redraw), then update the matching level by serial number.
  onStatus(s: any) {
    try { this.onPush?.(); } catch {}
    if (!s || !s.sn) return;
    if (s.sn === this.glassesSn) return this.set("glasses", level(s));
    if (s.sn === this.ringSn) return this.set("ring", level(s));
    if (Date.now() - this.lastAsk > 30_000) this.refresh().catch(() => {});   // a device we don't know yet: ask the host which
  }
  // Stores a level and calls onChange only when it actually changed, to avoid needless lens writes over Bluetooth.
  private set(k: "glasses" | "ring", v: number | null) {
    if (this[k] === v) return;
    this[k] = v; this.onChange();
  }
}
