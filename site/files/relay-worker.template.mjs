// Pull Tab relay — one person's private mailbox between their Even G2 app (Pull Tab) and their own Tab.
// Published by that person's Tab at https://<slug>.sites.tab.bot, where slug is derived from the pairing secret.
//
// What it holds: only the requests waiting for the Tab (encrypted audio). Since Pull Tab 0.1.9 it holds up to QUEUE_MAX
// of them, first in, first out (Bill, WhatsApp Oct 26 2026 17:08 Nairobi: "Yes it should fifo say 8 requests"); when
// QUEUE_MAX are waiting a new ask is refused (signed 429 "queue_full") and nothing queued is ever dropped. Since Pull Tab 0.1.8 the Tab answers by message (WhatsApp
// or text, never on the lens), so the relay never holds an answer: the Tab clears the request (POST /tab/done/<id>)
// right before it sends its answer, and the app never asks for one. Everything is deleted when the Tab clears it, when
// the app cancels it, or after TTL_MIN minutes, whichever is first. Audio is end-to-end encrypted between the app and
// the Tab (AES-256-GCM with a key this relay never has), so this relay can't hear it. Since Pull Tab 0.1.6 the app
// calls this relay directly (no switchboard in between).
// Keys: the app signs requests with AUTH_KEY (HMAC-SHA256); this relay signs every /v1/ answer with RELAY_KEY
// (protocol 3), which the app pins at pairing, so no other *.sites.tab.bot site can pass for this relay; the Tab
// and its admin calls use bearer keys checked
// against SHA-256 hashes. The wake-mail credential is sealed (AES-GCM) in D1, put there by PUT /admin/mailer.
// Ordering and replay (protocol 2): every signed POST is accepted once (seen-signature table); each ask keeps the
// app's signed timestamp (client_ts), which is also bound into the audio's AES-GCM associated data, so the Tab can
// refuse stale or replayed audio; a cancel (0.1.9) names the one ask it cancels by that ask's signed timestamp, is
// kept as a tombstone for that ask only, and so works whichever of the ask and the cancel reaches the relay first
// without touching any other queued request.
// Retiring (0.1.8, audit F1): POST /admin/retire empties the relay, drops the mail credential and marks it retired for
// good; from then on every /v1/, /tab/ and /admin/ call (but health) is refused with 410 "retired", so the pairing code
// it was set up from stops working at once, before the Tab deletes the site.
// Limits to keep in mind (D1 Free: 50 queries per invocation, 2,000,000 bytes per row): the biggest ask is
// MAX_BODY (~1.8 MB, one row). Raising MAX_BODY breaks this.
import { connect } from "cloudflare:sockets";

const VERSION = "3";                               // 3: every /v1/ answer carries x-pt-rsig
const AUTH_KEY_HEX = "__AUTH_KEY_HEX__";          // device request-signing key (derived from the pairing secret)
const RELAY_KEY_HEX = "__RELAY_KEY_HEX__";        // this relay's answer-signing key (derived from the pairing secret)
const TAB_KEY_SHA256 = "__TAB_KEY_SHA256__";
const ADMIN_KEY_SHA256 = "__ADMIN_KEY_SHA256__";
const SEAL_KEY = "__SEAL_KEY__";                  // seals the mail credential at rest in D1
// (Claude review M3, 0.1.13: the three keys above sit in this deployed code, which only the Tab account that published
// it can read; the hosting offers no secret store for them. Sealing keeps the mail credential out of the database's
// plain text and nothing more, since SEAL_KEY sits here beside the code that unseals it.)
// 0.1.8: how the Tab sends its answer, chosen by the Tab at setup (the channel its person uses most with it). The app
// shows it on the "Sent" screen ("Sent, reply coming by WhatsApp."); it reaches the app inside the signed upload
// acknowledgement, and the app accepts only "WhatsApp" or "text" (anything else shows as "message").
const REPLY_BY = "__REPLY_BY__";
const TTL_MIN = 30;
const MAX_BODY = 1_800_000;                       // ~56 s of 16 kHz 16-bit mono, sealed
const MAX_ASKS_PER_HOUR = 40;                     // bounds wake mails
const QUEUE_MAX = 8;                              // 0.1.9: requests waiting at once (FIFO); the 9th is refused, none dropped
const CLOCK_SKEW_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 60_000;
// 0.1.8 (audit F12): a tombstone lasts as long as the Tab accepts audio (15 min, pulltab.py MAX_AGE_S), so an ask that
// was cancelled and then reaches the relay late can never be acted on. Since 0.1.9 a tombstone refuses only the one ask
// it names (by its signed timestamp), so it can't block any other ask, queued or later.
const CANCEL_HOLD_MS = 15 * 60_000;
const SCHEMA = "2";

// 0.1.13 (Claude review L6): cross-origin headers only on the app's /v1/ answers (signed() adds them); /tab/ and /admin/
// are called by the Tab's own CLI, never from a web page, so they carry none.
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const TE = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
async function sha256hex(data) { return hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? TE.encode(data) : data)); }
function eqConst(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

async function bearer(req) {
  const m = /^Bearer\s+(\S{20,200})$/.exec(req.headers.get("authorization") || "");
  if (!m) return null;
  const x = await sha256hex(m[1]);
  if (eqConst(x, TAB_KEY_SHA256)) return "tab";
  if (eqConst(x, ADMIN_KEY_SHA256)) return "admin";
  return null;
}
let authKey, relayKey;
// x-pt-rsig = hex(HMAC(RELAY_KEY, "pulltab/resp" \n STATUS \n the request's x-pt-sig \n hex(SHA256(body)))), on every
// /v1/ answer, errors included. Exposed to the app's WebView by CORS.
// 0.1.13 (Claude review L1): only a request signature that verified with AUTH_KEY is bound (verifiedSig, set by
// device()); an answer to a request that failed the check binds "", so a signature seen once can't be turned into a
// relay-signed refusal. The app's own requests always verify, so what it receives is unchanged.
const CORS_DEVICE = { "access-control-allow-origin": "*", "access-control-expose-headers": "X-PT-RSIG" };
async function signed(res, verifiedSig) {
  const body = new Uint8Array(await res.arrayBuffer());
  const rs = (verifiedSig || "").toLowerCase();
  relayKey ??= await crypto.subtle.importKey("raw", unhex(RELAY_KEY_HEX), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const msg = `pulltab/resp\n${res.status}\n${/^[0-9a-f]{64}$/.test(rs) ? rs : ""}\n${await sha256hex(body)}`;
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_DEVICE)) h.set(k, v);
  h.set("x-pt-rsig", hex(await crypto.subtle.sign("HMAC", relayKey, TE.encode(msg))));
  return new Response(body, { status: res.status, headers: h });
}
async function deviceOk(req, path, body) {
  const ts = req.headers.get("x-pt-ts") || "", sig = (req.headers.get("x-pt-sig") || "").toLowerCase();
  if (!/^\d{12,14}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, error: "bad_signature" };
  authKey ??= await crypto.subtle.importKey("raw", unhex(AUTH_KEY_HEX), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const msg = `${req.method}\n${path}\n${ts}\n${await sha256hex(body)}`;
  const good = await crypto.subtle.verify("HMAC", authKey, unhex(sig), TE.encode(msg));
  if (!good) return { ok: false, error: "bad_signature" };
  if (Math.abs(Date.now() - Number(ts)) > CLOCK_SKEW_MS) return { ok: false, error: "clock", sig };
  return { ok: true, ts: Number(ts), sig };
}

let schemaReady = null;              // once per isolate, not per request
function ensureSchema(db) {
  schemaReady ??= db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS req (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, client_ts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, audio BLOB, audio_bytes INTEGER, heard TEXT, note TEXT, reply TEXT, mail_error TEXT, updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS cfg (k TEXT PRIMARY KEY, v TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS asks (t INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS seen (sig TEXT PRIMARY KEY, t INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS cancels (ts INTEGER PRIMARY KEY, at INTEGER NOT NULL)`),   // 0.1.9: per-ask tombstones
  ]).then(async () => {
    // A relay first published with protocol 1 has a req table without client_ts. It only ever holds in-flight
    // requests, so it is simply rebuilt once.
    if ((await getCfg(db, "schema")) === SCHEMA) return;
    await db.batch([
      db.prepare(`DROP TABLE IF EXISTS req`),
      db.prepare(`CREATE TABLE req (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, client_ts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL, audio BLOB, audio_bytes INTEGER, heard TEXT, note TEXT, reply TEXT, mail_error TEXT, updated_at INTEGER NOT NULL)`),
      db.prepare(`DELETE FROM cfg WHERE k IN ('last_ask_ts', 'cancel_before')`),
    ]);
    await setCfg(db, "schema", SCHEMA);
  }).catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}
let lastSweep = 0;                   // at most once a minute per isolate; reads below also filter by age
async function sweep(db, now) {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  await db.batch([
    db.prepare(`DELETE FROM req WHERE created_at < ?`).bind(now - TTL_MIN * 60_000),
    db.prepare(`DELETE FROM asks WHERE t < ?`).bind(now - 3_600_000),
    db.prepare(`DELETE FROM seen WHERE t < ?`).bind(now - 2 * CLOCK_SKEW_MS),
    db.prepare(`DELETE FROM cancels WHERE at < ?`).bind(now - CANCEL_HOLD_MS),
  ]);
}
// A signed POST is accepted once: a replayed signature inside the clock window is refused.
async function firstUse(db, sig, now) {
  const r = await db.prepare(`INSERT OR IGNORE INTO seen (sig, t) VALUES (?, ?)`).bind(sig, now).run();
  return (r.meta?.changes ?? 0) === 1;
}
const getCfg = async (db, k) => (await db.prepare(`SELECT v FROM cfg WHERE k = ?`).bind(k).first())?.v ?? null;
const setCfg = (db, k, v) => db.prepare(`INSERT INTO cfg (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(k, v).run();

// ---- sealing the mail credential at rest ----
async function sealKey() {
  const raw = await crypto.subtle.digest("SHA-256", TE.encode("pulltab-seal:" + SEAL_KEY));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function seal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(), TE.encode(JSON.stringify(obj)));
  return b64(iv) + "." + b64(ct);
}
async function unseal(s) {
  const [iv, ct] = s.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await sealKey(), unb64(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
async function getMailer(db) { const v = await getCfg(db, "mailer"); return v ? unseal(v) : null; }

// ---- wake mail: SMTP (implicit TLS 465 or STARTTLS 587) or an HTTPS mail API (Resend) ----
class Smtp {
  constructor(sock) { this.attach(sock); this.buf = ""; this.dec = new TextDecoder(); }
  attach(sock) { this.sock = sock; this.r = sock.readable.getReader(); this.w = sock.writable.getWriter(); }
  async line() {
    for (;;) {
      const i = this.buf.indexOf("\r\n");
      if (i >= 0) { const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2); return l; }
      const { value, done } = await this.r.read();
      if (done) throw new Error("smtp: connection closed");
      this.buf += this.dec.decode(value, { stream: true });
    }
  }
  async reply() { let text = [], l; do { l = await this.line(); text.push(l.slice(4)); } while (l[3] === "-"); return { code: +l.slice(0, 3), text: text.join(" ") }; }
  async send(s) { await this.w.write(TE.encode(s + "\r\n")); }
  async cmd(s, want, label) {
    await this.send(s); const r = await this.reply();
    if (!want.includes(r.code)) throw new Error(`smtp ${label || s.split(" ")[0]}: ${r.code} ${r.text.slice(0, 200)}`);
    return r;
  }
  async close() { try { await this.send("QUIT"); } catch {} try { await this.sock.close(); } catch {} }
}
const dotStuff = (s) => s.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
async function sendSmtp(cfg, { subject, text }) {
  const local = cfg.host === "127.0.0.1" || cfg.host === "localhost";
  const port = Number(cfg.port || 465);
  const mode = local && cfg.tls === "off" ? "off" : port === 465 ? "on" : "starttls";
  const c = new Smtp(connect({ hostname: cfg.host, port }, { secureTransport: mode, allowHalfOpen: false }));
  try {
    const hello = await c.reply();
    if (hello.code !== 220) throw new Error(`smtp greeting: ${hello.code} ${hello.text.slice(0, 200)}`);
    await c.cmd("EHLO pulltab-relay.local", [250]);
    if (mode === "starttls") {
      await c.cmd("STARTTLS", [220]);
      c.r.releaseLock(); c.w.releaseLock();
      c.attach(c.sock.startTls()); c.buf = "";
      await c.cmd("EHLO pulltab-relay.local", [250]);
    }
    await c.cmd(`AUTH PLAIN ${btoa(`\u0000${cfg.user}\u0000${cfg.pass}`)}`, [235], "AUTH");
    await c.cmd(`MAIL FROM:<${cfg.from}>`, [250]);
    await c.cmd(`RCPT TO:<${cfg.to}>`, [250, 251]);
    await c.cmd("DATA", [354]);
    const msgId = `<${crypto.randomUUID()}@pulltab-relay>`;
    const head = [`From: Pull Tab <${cfg.from}>`, `To: <${cfg.to}>`, `Subject: ${subject}`,
      `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`, `Message-ID: ${msgId}`,
      `MIME-Version: 1.0`, `Content-Type: text/plain; charset=utf-8`, `Content-Transfer-Encoding: 8bit`, `X-Pull-Tab: 1`].join("\r\n");
    await c.send(head + "\r\n\r\n" + dotStuff(text) + "\r\n.");
    const r = await c.reply();
    if (r.code !== 250) throw new Error(`smtp DATA end: ${r.code} ${r.text.slice(0, 200)}`);
    return { ok: true, message_id: msgId };
  } finally { await c.close(); }
}
async function sendResend(cfg, { subject, text }) {
  const r = await fetch(cfg.api_url || "https://api.resend.com/emails", {
    method: "POST", headers: { authorization: `Bearer ${cfg.api_key}`, "content-type": "application/json" },
    body: JSON.stringify({ from: cfg.from || "Pull Tab <onboarding@resend.dev>", to: [cfg.to], subject, text }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`mail api ${r.status}: ${body.slice(0, 200)}`);
  return { ok: true, provider_answer: body.slice(0, 200) };
}
const sendMail = (cfg, m) => (cfg.type === "resend" ? sendResend(cfg, m) : sendSmtp(cfg, m));
function wakeText(id, host, seconds) {
  return { subject: `[Pull Tab] request ${id}`,
    text: `Pull Tab request ${id} is waiting on your relay.\n` +
      `No audio, words or keys are in this mail. Fetch it from the relay with your Tab key:\n  pulltab take ${id}\n` };
}

// The app's /v1/ API. Its answer is signed by the caller (signed()), whatever it is.
// 0.1.13 (Claude review M1): the size and the signature are checked before the body is kept or the database is touched,
// so a caller without the key can't spend the relay's database quota. The app always signs, so for the app the answers
// and their order are as before: a signed request to a retired relay still gets 410 "retired", and "clock" comes after it.
async function device(req, env, ctx, url, p, now, db, st) {
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY) return json({ error: "too_large" }, 413);
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > MAX_BODY) return json({ error: "too_large" }, 413);
  const v = await deviceOk(req, p, body);
  if (!v.ok && v.error === "bad_signature") return json({ error: v.error }, 401);
  st.sig = v.sig;                                  // verified with AUTH_KEY (the clock is checked below)
  if (!db) return json({ error: "no_store" }, 500);
  await ensureSchema(db); await sweep(db, now);
  if (await getCfg(db, "retired")) return json({ error: "retired" }, 410);
  if (!v.ok) return json({ error: v.error }, 401);
  if (req.method === "POST" && !(await firstUse(db, v.sig, now))) return json({ error: "replay" }, 409);
  if (req.method === "GET" && p === "/v1/hello") return json({ ok: true, version: VERSION, mail: !!(await getCfg(db, "mailer")) });
  if (req.method === "POST" && p === "/v1/ask") {
    // 0.1.9: a triple tap that got here first left a tombstone for exactly this ask (its signed timestamp)
    if (await db.prepare(`SELECT ts FROM cancels WHERE ts = ? AND at >= ?`).bind(v.ts, now - CANCEL_HOLD_MS).first()) return json({ error: "cancelled" }, 409);
    const mailer = await getMailer(db);
    if (!mailer) return json({ error: "not_configured" }, 503);
    if (body.byteLength < 28 + 6400) return json({ error: "too_short" }, 400);
    const live = now - TTL_MIN * 60_000;
    const q = (await db.prepare(`SELECT COUNT(*) AS n FROM req WHERE created_at >= ?`).bind(live).first()).n;
    if (q >= QUEUE_MAX) return json({ error: "queue_full" }, 429);   // 0.1.9: refuse the new one; nothing queued is dropped
    const n = (await db.prepare(`SELECT COUNT(*) AS n FROM asks`).first()).n;
    if (n >= MAX_ASKS_PER_HOUR) return json({ error: "rate_limited" }, 429);
    const id = now.toString(36) + "-" + hex(crypto.getRandomValues(new Uint8Array(4)));
    const seconds = Math.round(((body.byteLength - 28) / 32000) * 10) / 10;
    // 0.1.9: queued behind any waiting requests (FIFO). The count is checked again inside the insert itself, so two
    // asks arriving at once can't make the queue longer than QUEUE_MAX.
    const ins = await db.prepare(`INSERT INTO req (id, created_at, client_ts, status, audio, audio_bytes, updated_at)
      SELECT ?, ?, ?, 'waiting', ?, ?, ? WHERE (SELECT COUNT(*) FROM req WHERE created_at >= ?) < ?`).bind(id, now, v.ts, body, body.byteLength, now, live, QUEUE_MAX).run();
    if ((ins.meta?.changes ?? 0) !== 1) return json({ error: "queue_full" }, 429);
    await db.prepare(`INSERT INTO asks (t) VALUES (?)`).bind(now).run();
    ctx.waitUntil(sendMail(mailer, wakeText(id, url.host, seconds)).catch(async (e) => {
      await db.prepare(`UPDATE req SET status = 'wake_failed', mail_error = ?, updated_at = ? WHERE id = ? AND status = 'waiting'`).bind(String(e.message || e).slice(0, 300), Date.now(), id).run();
    }));
    return json({ id, seconds, reply_by: REPLY_BY });
  }
  let m;
  if (req.method === "POST" && p === "/v1/cancel") {
    // Triple tap (0.1.9): the body is the signed timestamp of the one ask being cancelled (the app's own upload).
    // That ask is deleted now, or refused if it arrives within CANCEL_HOLD_MS (by the relay's clock), so the order in
    // which the two reach the relay doesn't matter. No other queued request is touched.
    const t = new TextDecoder().decode(body).trim();
    if (!/^\d{12,14}$/.test(t)) return json({ error: "bad_cancel" }, 400);
    await db.batch([
      db.prepare(`INSERT INTO cancels (ts, at) VALUES (?, ?) ON CONFLICT(ts) DO UPDATE SET at = excluded.at`).bind(Number(t), now),
      db.prepare(`DELETE FROM req WHERE client_ts = ?`).bind(Number(t)),
    ]);
    return json({ ok: true });
  }
  if (req.method === "POST" && (m = /^\/v1\/ack\/([\w-]{6,40})$/.exec(p))) {
    await db.prepare(`DELETE FROM req WHERE id = ?`).bind(m[1]).run();
    return json({ ok: true });
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname, now = Date.now(), db = env.DB;
    // L6: only the app's /v1/ calls get a cross-origin preflight answer (the app sends no Authorization header).
    if (req.method === "OPTIONS") return p.startsWith("/v1/")
      ? new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Content-Type, X-PT-TS, X-PT-SIG", "access-control-expose-headers": "X-PT-RSIG", "access-control-max-age": "86400" } })
      : new Response(null, { status: 204 });
    // ---------- device (the Pull Tab app, directly; HMAC-signed both ways) ----------
    if (p.startsWith("/v1/")) {
      let res; const st = { sig: "" };
      try { res = await device(req, env, ctx, url, p, now, db, st); }
      catch (e) { console.log("device error", String(e && e.message || e).slice(0, 200)); res = json({ error: "relay_error" }, 500); }
      return signed(res, st.sig);
    }
    if (!p.startsWith("/tab/") && !p.startsWith("/admin/")) return json({ error: "not_found" }, 404);
    // M1: the bearer key is checked before any database work.
    const role = await bearer(req);
    if (p.startsWith("/tab/") ? role !== "tab" && role !== "admin" : role !== "admin") return json({ error: "unauthorized" }, 401);
    if (!db) return json({ error: "no_store" }, 500);
    await ensureSchema(db); await sweep(db, now);
    const retired = !!(await getCfg(db, "retired"));
    // ---------- the person's Tab (bearer tab key) ----------
    if (p.startsWith("/tab/")) {
      if (role !== "tab" && role !== "admin") return json({ error: "unauthorized" }, 401);
      if (retired) return json({ error: "retired" }, 410);
      let m;
      if (req.method === "GET" && p === "/tab/pending") {
        const rows = (await db.prepare(`SELECT id, created_at, client_ts, status, audio_bytes, mail_error FROM req WHERE created_at >= ? ORDER BY created_at, rowid`).bind(now - TTL_MIN * 60_000).all()).results;
        // 0.1.9: oldest first (FIFO); the Tab takes them in this order
        return json({ pending: rows.map((r) => ({ ...r, seconds: Math.round(((r.audio_bytes - 28) / 32000) * 10) / 10 })), queue_max: QUEUE_MAX });
      }
      if (req.method === "GET" && (m = /^\/tab\/audio\/([\w-]{6,40})$/.exec(p))) {
        const r = await db.prepare(`SELECT audio FROM req WHERE id = ? AND created_at >= ?`).bind(m[1], now - TTL_MIN * 60_000).first();
        if (!r || !r.audio) return json({ error: "gone" }, 404);
        return new Response(new Uint8Array(r.audio), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
      }
      // 0.1.8: the Tab answers by message, never on the lens, so nothing it writes here carries words.
      // status = "is this request still live?" (404 once the person cancelled it or it expired; since 0.1.9 a newer ask never
      // replaces it);
      // done = clear it, right before the Tab sends its answer (404 means cancelled: the Tab sends nothing).
      if (req.method === "POST" && (m = /^\/tab\/(status|done)\/([\w-]{6,40})$/.exec(p))) {
        const id = m[2];
        const r = await db.prepare(`SELECT id, status FROM req WHERE id = ? AND created_at >= ?`).bind(id, now - TTL_MIN * 60_000).first();
        if (!r) return json({ error: "gone" }, 404);
        if (m[1] === "done") await db.prepare(`DELETE FROM req WHERE id = ?`).bind(id).run();
        return json({ ok: true, status: m[1] === "done" ? "done" : r.status });
      }
      return json({ error: "not_found" }, 404);
    }

    // ---------- admin (bearer admin key; used only from the person's Tab) ----------
    if (p.startsWith("/admin/")) {
      if (role !== "admin") return json({ error: "unauthorized" }, 401);
      if (retired && !(req.method === "GET" && p === "/admin/health")) return json({ error: "retired" }, 410);
      if (req.method === "POST" && p === "/admin/retire") {
        // 0.1.8 (audit F1): the pairing code this relay was set up from stops working now, for good.
        await db.batch([db.prepare(`DELETE FROM req`), db.prepare(`DELETE FROM asks`), db.prepare(`DELETE FROM seen`),
          db.prepare(`DELETE FROM cancels`), db.prepare(`DELETE FROM cfg WHERE k IN ('mailer', 'cancel')`),
          db.prepare(`INSERT INTO cfg (k, v) VALUES ('retired', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(String(now))]);
        return json({ ok: true, retired: true });
      }
      if (req.method === "PUT" && p === "/admin/mailer") {
        const j = await req.json().catch(() => ({}));
        const to = String(j.to || "");
        if (!/^[^@\s]+@[^@\s]+$/.test(to)) return json({ error: "bad_to" }, 400);
        let cfg;
        if (j.type === "resend") {
          if (!j.api_key) return json({ error: "missing_api_key" }, 400);
          // L7: a sender may carry a display name ("Pull Tab <onboarding@resend.dev>"), never a line break
          if (j.from && /[\r\n]/.test(String(j.from))) return json({ error: "bad_from" }, 400);
          cfg = { type: "resend", api_key: String(j.api_key), to, from: j.from ? String(j.from) : undefined, api_url: j.api_url ? String(j.api_url) : undefined };
        } else {
          if (!j.user || !j.pass) return json({ error: "missing_user_or_pass" }, 400);
          const from = String(j.from || j.user);
          // 0.1.13 (Claude review L7): the sender goes into MAIL FROM and the From: header, so it may hold no line break,
          // space or angle bracket (that is what could add a mail header). An SMTP login that isn't an address still works.
          if (!/^[^\s<>]{1,254}$/.test(from)) return json({ error: "bad_from" }, 400);
          cfg = { type: "smtp", host: String(j.host || "smtp.gmail.com"), port: Number(j.port || 465), tls: j.tls === "off" ? "off" : "on", user: String(j.user), pass: String(j.pass), from, to };
        }
        await setCfg(db, "mailer", await seal(cfg));
        return json({ ok: true, type: cfg.type, to, from: cfg.from || null, host: cfg.host || null });
      }
      if (req.method === "DELETE" && p === "/admin/mailer") { await db.prepare(`DELETE FROM cfg WHERE k = 'mailer'`).run(); return json({ ok: true }); }
      if (req.method === "GET" && p === "/admin/health") {
        const c = await getMailer(db);
        const n = (await db.prepare(`SELECT COUNT(*) AS n FROM req`).first()).n;
        const a = (await db.prepare(`SELECT COUNT(*) AS n FROM asks`).first()).n;
        if (retired) return json({ ok: true, version: VERSION, retired: true });
        return json({ ok: true, version: VERSION, reply_by: REPLY_BY, mailer: c ? { type: c.type, to: c.to, from: c.from || null, host: c.host || null, password_set: !!(c.pass || c.api_key) } : null, in_flight: n, queue_max: QUEUE_MAX, asks_last_hour: a });
      }
      if (req.method === "POST" && p === "/admin/test-wake") {
        const c = await getMailer(db);
        if (!c) return json({ error: "not_configured" }, 503);
        try { return json(await sendMail(c, { subject: "[Pull Tab] test wake", text: "Test wake from your Pull Tab relay. No request is waiting; nothing to do.\n" })); }
        catch (e) { return json({ ok: false, error: String(e.message || e).slice(0, 300) }, 502); }
      }
      if (req.method === "POST" && p === "/admin/purge") { await db.batch([db.prepare(`DELETE FROM req`), db.prepare(`DELETE FROM asks`), db.prepare(`DELETE FROM seen`), db.prepare(`DELETE FROM cancels`)]); return json({ ok: true }); }
      return json({ error: "not_found" }, 404);
    }
    return json({ error: "not_found" }, 404);
  },
};
