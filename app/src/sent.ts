// sent.ts: two small helpers for the "Sent" flow and the setup screen, kept apart from main.ts so they can be
// unit-tested (test/sent/sent-test.ts). No Even SDK or DOM dependency.

// The channel word on the "Sent" screen. The Tab picks it at setup (pulltab init --reply-by whatsapp|text) and it reaches
// the app in the relay's signed upload acknowledgement. Only these two words are ever shown; anything else, or none,
// shows as "message".
/** @param v the relay's reply_by value. @returns "WhatsApp", "text" or "message"; never echoes other input to the lens. */
export function replyWord(v: unknown): string {
  return v === "WhatsApp" || v === "text" ? v : "message";
}

// Audit F3: the setup message holds the pairing code, so once it has been copied it is cleared from the clipboard after
// CLIP_CLEAR_MS (best effort: a phone may refuse a clipboard write that no tap started). A second copy restarts the clock.
export const CLIP_CLEAR_MS = 30_000;
let clipTimer: any = null;
/**
 * Schedules the clipboard to be overwritten with an empty string after `ms`.
 * @param write the clipboard writer (navigator.clipboard.writeText in the app; a fake in tests).
 * @param ms delay before clearing; defaults to CLIP_CLEAR_MS.
 * @param after optional callback told whether the clear worked.
 * Only one clear is pending at a time (module-level timer); a later call replaces the earlier one.
 */
export function clearClipboardLater(write: (s: string) => Promise<void>, ms = CLIP_CLEAR_MS, after?: (ok: boolean) => void) {
  clearTimeout(clipTimer);
  clipTimer = setTimeout(() => {
    clipTimer = null;
    Promise.resolve().then(() => write("")).then(() => after?.(true), () => after?.(false));
  }, ms);
}
