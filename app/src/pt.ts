// pt.ts: the Pull Tab protocol and crypto helpers, shared by the app (main.ts) and the tests (test/vec, test/relay).
// Pure functions with no Even SDK or DOM dependency apart from Web Crypto's getRandomValues, btoa and atob.
// Inputs are the 32-byte pairing secret and raw bytes; outputs are derived keys, signatures, sealed boxes and checked
// relay addresses. Any change here must be made identically in the relay and the Tab's CLI (see next line), and
// test/vectors.sh checks that all three still agree on the published test vector.
//
// Pull Tab protocol. Mirrored exactly in site/files/relay-worker.template.mjs and site/files/pulltab.py.
//
// The phone app makes a 32-byte secret S on first open. Everything derives from it:
//   slug  = "pt-" + base32(HMAC(S, "pulltab/v1/slug"))[0:20]  -> the user's relay lives at https://<slug>.sites.tab.bot
//   auth  = HMAC(S, "pulltab/v1/auth")                          -> signs every app request (the relay holds this)
//   enc   = HMAC(S, "pulltab/v1/enc")                           -> AES-256-GCM key for audio and answers (app + Tab only)
//   rkey  = HMAC(S, "pulltab/v1/relay")                         -> the relay's own key: it signs every /v1/ answer
//                                                                  (protocol 3), and the app accepts no answer without it
// Since 0.1.6 the app calls the relay directly (network whitelist "https://*.sites.tab.bot", no switchboard). Any Tab
// can publish a *.sites.tab.bot site, so the address alone proves nothing: the app pins the relay to rkey, which only
// a relay set up from this pairing code holds, and refuses every answer that is not signed with it.
// Pairing code = "PT1-" + BASE32(S || SHA256(S)[0:2]) (55 chars). The user sends it to their own Tab once.
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { gcm } from "@noble/ciphers/aes";

// Lower-case RFC 4648 base32 alphabet without padding: safe in DNS labels (the relay slug) and easy to read aloud.
const TE = new TextEncoder(), TD = new TextDecoder();
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** Base32-encodes bytes (lower case, no padding). Bits are carried MSB first across byte boundaries. */
export function b32enc(b: Uint8Array): string {
  let bits = 0, val = 0, out = "";
  for (const x of b) { val = ((val << 8) | x) >>> 0; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } val &= (1 << bits) - 1; }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
/** Decodes base32 (either case, no padding). @returns the bytes, or null if any character is outside the alphabet. */
export function b32dec(s: string): Uint8Array | null {
  const out: number[] = []; let bits = 0, val = 0;
  for (const ch of s.toLowerCase()) { const i = B32.indexOf(ch); if (i < 0) return null; val = ((val << 5) | i) >>> 0; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; val &= (1 << bits) - 1; } }
  return Uint8Array.from(out);
}
/** Lower-case hex encoding, used for signatures and body hashes. */
export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
/** Base64url encoding without padding (used for the stored secret and sealed payloads). */
export function b64u(b: Uint8Array): string { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
/** Base64url decoding; restores the padding that b64u() removed. */
export function unb64u(s: string): Uint8Array { const t = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(t + "===".slice((t.length + 3) % 4)), (c) => c.charCodeAt(0)); }
/** `n` cryptographically random bytes (Web Crypto). Used for the pairing secret and AES-GCM nonces. */
export function random(n: number): Uint8Array { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; }

/**
 * Everything derived from one pairing secret. `secret` is S itself; `slug` names the relay site; `auth` signs app
 * requests; `enc` encrypts audio; `rkey` verifies the relay's answers; `code` is the pairing code shown to the person.
 */
export type Keys = { secret: Uint8Array; slug: string; auth: Uint8Array; enc: Uint8Array; rkey: Uint8Array; code: string };
// HMAC-SHA256(S, "pulltab/v1/<info>"): one independent key per purpose, so leaking one does not reveal another.
const derive = (S: Uint8Array, info: string) => hmac(sha256, S, TE.encode("pulltab/v1/" + info));
/**
 * Derives all keys and the pairing code from the 32-byte secret S. Deterministic: the same S always gives the same
 * relay address and code, which is how the app knows where its relay lives without being told.
 * The code appends the first 2 bytes of SHA-256(S) as a checksum so a mistyped code is rejected by parseCode().
 */
export function keysFrom(S: Uint8Array): Keys {
  const sum = sha256(S).slice(0, 2);
  const full = new Uint8Array(34); full.set(S); full.set(sum, 32);
  return { secret: S, slug: "pt-" + b32enc(derive(S, "slug")).slice(0, 20), auth: derive(S, "auth"), enc: derive(S, "enc"), rkey: derive(S, "relay"), code: "PT1-" + b32enc(full).toUpperCase() };
}
/**
 * Finds a pairing code inside free text (the person may paste a whole message) and returns its secret.
 * Accepts any case and stray dashes or spaces inside the code.
 * @returns the 32-byte secret, or null when no code is found, it has the wrong length, or the checksum fails.
 */
export function parseCode(input: string): Uint8Array | null {
  let s = input.trim().toUpperCase();
  const m = s.match(/PT1[-\s]*([A-Z2-7][A-Z2-7\-\s]{50,80})/);
  if (!m) return null;
  s = m[1].replace(/[-\s]/g, "").slice(0, 55);
  const b = b32dec(s);
  if (!b || b.length !== 34) return null;
  const S = b.slice(0, 32), sum = sha256(S).slice(0, 2);
  return sum[0] === b[32] && sum[1] === b[33] ? S : null;
}

// Request signature: hex(HMAC(auth, METHOD \n PATH \n TS \n hex(SHA256(body)))), PATH as the relay sees it ("/v1/ask").
/**
 * Signs an app request. The relay recomputes this with the auth key and rejects a mismatch, and accepts each signed
 * POST only once, so a captured request cannot be replayed. `ts` is milliseconds since the epoch, as a string; the relay
 * also rejects timestamps too far from its own clock (the "clock" error).
 */
export function sign(k: Keys, method: string, path: string, ts: string, body: Uint8Array): string {
  return hex(hmac(sha256, k.auth, TE.encode(`${method}\n${path}\n${ts}\n${hex(sha256(body))}`)));
}
// AES-256-GCM, 12-byte random nonce, AAD names what the bytes are ("pulltab/audio", "pulltab/reply/<id>", ...).
/**
 * Encrypts `plain` with AES-256-GCM under the enc key. Output layout: 12-byte random nonce, then ciphertext with its
 * 16-byte tag (28 bytes of overhead). `aad` is authenticated but not encrypted: decryption fails if it differs, which
 * binds the box to its purpose and, for audio, to the request's signed timestamp.
 */
export function seal(k: Keys, plain: Uint8Array, aad: string): Uint8Array {
  const n = random(12); const ct = gcm(k.enc, n, TE.encode(aad)).encrypt(plain);
  const out = new Uint8Array(12 + ct.length); out.set(n); out.set(ct, 12); return out;
}
/** Reverses seal(). @throws if the key, the AAD or any byte of the box is wrong. */
export function open(k: Keys, box: Uint8Array, aad: string): Uint8Array {
  return gcm(k.enc, box.slice(0, 12), TE.encode(aad)).decrypt(box.slice(12));
}
/** open() for a base64url box holding UTF-8 text. */
export const openText = (k: Keys, b64: string, aad: string) => TD.decode(open(k, unb64u(b64), aad));

// ---------- the relay's address (0.1.6: direct, no switchboard) ----------
// Only an https origin on one label of sites.tab.bot is accepted ("https://<name>.sites.tab.bot", nothing after it:
// no port, path, query, fragment or login), because that is all the app's network whitelist ("https://*.sites.tab.bot")
// covers. Returns the normalised origin, or null.
export const RELAY_SUFFIX = ".sites.tab.bot";
/**
 * Validates and normalises a relay address typed, pasted or stored on the phone.
 * @param input anything the person or storage provides.
 * @returns "https://<label>.sites.tab.bot" in lower case, or null if the input is anything else.
 */
export function relayOrigin(input: string): string | null {
  const s = (input || "").trim();
  if (!/^https:\/\//i.test(s) || /[\s\\@?#%]/.test(s.slice(8))) return null;   // no spaces, backslashes, logins, queries, fragments, escapes
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash) return null;
  if (u.pathname !== "/" && u.pathname !== "") return null;
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(RELAY_SUFFIX)) return null;
  const label = host.slice(0, -RELAY_SUFFIX.length);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;   // exactly one DNS label before .sites.tab.bot
  return "https://" + host;
}
/** Where a relay set up from these keys lives unless the Tab says otherwise: https://<slug>.sites.tab.bot. */
export const defaultRelay = (k: Keys) => "https://" + k.slug + RELAY_SUFFIX;

// ---------- the relay's signature on its answers (protocol 3) ----------
// rsig = hex(HMAC(rkey, "pulltab/resp" \n STATUS \n the request's x-pt-sig \n hex(SHA256(body)))). Binding the request's
// own signature means an old answer can't be replayed for a new request.
/** Computes the relay's answer signature (the relay worker computes the same value with the same key). */
export function respSig(rkey: Uint8Array, status: number, reqSig: string, body: Uint8Array): string {
  return hex(hmac(sha256, rkey, TE.encode(`pulltab/resp\n${status}\n${reqSig}\n${hex(sha256(body))}`)));
}
/**
 * Checks the relay's answer signature (x-pt-rsig header) in constant time, so response timing does not reveal how
 * many characters matched.
 * @returns true only for a 64-character hex value equal to respSig() for this status, request signature and body.
 */
export function respOk(k: Keys, status: number, reqSig: string, body: Uint8Array, got: string | null): boolean {
  if (!got || !/^[0-9a-f]{64}$/i.test(got)) return false;
  const want = respSig(k.rkey, status, reqSig, body), g = got.toLowerCase();
  let r = 0; for (let i = 0; i < 64; i++) r |= want.charCodeAt(i) ^ g.charCodeAt(i);
  return r === 0;
}
