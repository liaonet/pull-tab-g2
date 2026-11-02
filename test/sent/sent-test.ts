// 0.1.8 unit tests for app/src/sent.ts: the channel word on the "Sent" screen, and clearing the copied setup message
// from the clipboard after 30 s (audit F3). Run: test/sent.sh
import { replyWord, clearClipboardLater, CLIP_CLEAR_MS } from "../../app/src/sent";
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: any, detail: any = "") => results.push({ name, ok: !!ok, detail: String(detail) });
// the channel word: only "WhatsApp" or "text" are shown; anything else (or nothing) is "message"
check("channel: WhatsApp", replyWord("WhatsApp") === "WhatsApp");
check("channel: text", replyWord("text") === "text");
check("channel: default when absent", replyWord(undefined) === "message" && replyWord(null) === "message" && replyWord("") === "message");
check("channel: an unfilled relay template is not shown", replyWord("__REPLY_BY__") === "message");
for (const v of ["whatsapp", "WHATSAPP", "Text", "SMS", "iMessage", "Telegram", "WhatsApp.\nTriple-tap", "<b>x</b>", 1, {}, ["WhatsApp"]])
  check("channel: anything else shows as message: " + JSON.stringify(v), replyWord(v) === "message");
// clipboard: cleared once, 30 s after the copy; a second copy restarts the clock
check("F3 the clear is 30 s", CLIP_CLEAR_MS === 30_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const writes: string[] = []; let done: boolean | null = null;
  clearClipboardLater(async (s) => { writes.push(s); }, 120, (ok) => (done = ok));
  await sleep(60); check("F3 nothing cleared before the time", writes.length === 0);
  await sleep(120); check("F3 cleared (an empty string) after the time", writes.length === 1 && writes[0] === "" && done === true, JSON.stringify(writes));
  const w2: string[] = [];
  clearClipboardLater(async (s) => { w2.push("first:" + s); }, 120);
  await sleep(80);
  clearClipboardLater(async (s) => { w2.push("second:" + s); }, 120);   // copied again: the clock restarts
  await sleep(80); check("F3 a second copy restarts the clock", w2.length === 0, JSON.stringify(w2));
  await sleep(100); check("F3 cleared once, by the latest copy", w2.length === 1 && w2[0] === "second:", JSON.stringify(w2));
  let refused: boolean | null = null;
  clearClipboardLater(async () => { throw new Error("NotAllowedError"); }, 20, (ok) => (refused = ok));
  await sleep(60); check("F3 a phone that refuses the write is reported, not thrown", refused === false);
  const fails = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? "PASS " : "FAIL ") + r.name + (r.ok ? "" : "  (" + r.detail + ")"));
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})();
