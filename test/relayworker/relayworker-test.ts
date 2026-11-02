// 0.1.9: also the FIFO queue of 8 (oldest first, a 9th refused with nothing dropped, cancel removes only its own request,
// each id handled on its own, expiry per request). The 0.1.8 cancel checks now name the ask they cancel (its signed ts).
// 0.1.8 relay + Tab-CLI tests: the real relay worker (as `pulltab init` writes it) on a fake D1 (node:sqlite) with a
// controllable clock, served on a local port so the real pulltab.py talks to it. Nothing leaves this machine.
// Covers: the channel word in the signed upload acknowledgement (WhatsApp / text), no answer route, done/status, the
// fingerprint gate (F4), retire (F1), the 15-minute cancel tombstone (F12) and request-id checks (F13). Run: test/relayworker.sh
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { keysFrom, sign, respOk, seal, b64u } from "../../app/src/pt";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), process.env.PT_ROOT_REL || "..");
const PY = process.env.PT_PY || "python3";
const TOOL = path.join(ROOT, "site/files/pulltab.py");
const TEMPLATE = path.join(ROOT, "site/files/relay-worker.template.mjs");
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: any, detail: any = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 200) }); };
const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const TE = new TextEncoder();

// ---------- fake D1 ----------
class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private args: any[] = []) {}
  bind(...a: any[]) { return new Stmt(this.db, this.sql, a); }
  async first() { return (this.db.prepare(this.sql).get(...this.args) as any) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes) } }; }
}
class D1 { db = new DatabaseSync(":memory:"); prepare(sql: string) { return new Stmt(this.db, sql); } async batch(s: Stmt[]) { const o = []; for (const x of s) o.push(await x.run()); return o; } }

// ---------- clock + outbound mail stub ----------
process.on("unhandledRejection", (e: any) => console.log("UNHANDLED", e?.stack || e));
process.on("uncaughtException", (e: any) => { console.log("UNCAUGHT", e?.stack || e); process.exit(2); });
const realNow = Date.now.bind(Date);
let skew = 0;                                   // ms added to the relay's clock
Date.now = () => realNow() + skew;
const mails: string[] = [];
const mailBodies: string[] = [];                // 0.1.9: what each wake mail said (the queue tests check it names its own id)
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => { mails.push(String(url)); mailBodies.push(String(init?.body ?? "")); return new Response('{"id":"stub"}', { status: 200 }); };

// ---------- a pairing, set up the way a Tab does it ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pt-rw-"));
function message(S: Uint8Array, fps: Record<string, string>) {
  return `Set up Pull Tab for my Even G2 glasses. Guide: https://pulltab.sites.tab.bot/setup.md Pairing code: ${keysFrom(S).code} Check SHA-256 before using any file, stop if one differs: ` +
    Object.entries(fps).map(([f, h]) => `${f} ${h}`).join(" ");
}
const FPS = { "setup.md": sha(path.join(ROOT, "site/setup.md")), "pulltab.py": sha(TOOL), "relay-worker.template.mjs": sha(TEMPLATE) };
// async: the relay under test runs in this same process, so a blocking spawn would stall it
function cli(home: string, base: string, args: string[]): Promise<any> {
  return new Promise((done) => {
    const p = spawn(PY, [TOOL, ...args], { env: { ...process.env, PULLTAB_HOME: home, PULLTAB_BASE: base } });
    let out = "", err = ""; const kill = setTimeout(() => p.kill("SIGKILL"), 60_000);
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (rc) => { clearTimeout(kill); try { done({ rc, ...JSON.parse(out.trim().split("\n").pop() || "{}") }); } catch { done({ rc, out, err }); } });
  });
}

// F4: no fingerprints, no setup (and nothing written)
const S1 = crypto.getRandomValues(new Uint8Array(32));
const home1 = path.join(tmp, "h1");
for (const drop of Object.keys(FPS)) {
  const f: any = { ...FPS }; delete f[drop];
  const j = await cli(home1, "http://127.0.0.1:1", ["init", message(S1, f), "--to", "t+pulltab@example.invalid", "--reply-by", "whatsapp"]);
  check(`F4 init refuses a message without the ${drop} fingerprint`, j.ok === false && /no SHA-256 fingerprint/.test(j.error) && !fs.existsSync(path.join(home1, "state.json")), j.error);
}
{
  const j = await cli(home1, "http://127.0.0.1:1", ["init", `Set up Pull Tab. Pairing code: ${keysFrom(S1).code}`, "--to", "t+pulltab@example.invalid", "--reply-by", "whatsapp"]);
  check("F4 init refuses a message with no fingerprints at all", j.ok === false && /no SHA-256 fingerprint/.test(j.error) && !fs.existsSync(path.join(home1, "state.json")), j.error);
  const bad = { ...FPS, "relay-worker.template.mjs": "0".repeat(64) };
  const k = await cli(home1, "http://127.0.0.1:1", ["init", message(S1, bad), "--to", "t+pulltab@example.invalid", "--reply-by", "whatsapp"]);
  check("F4 init refuses a fingerprint mismatch and writes nothing", k.ok === false && /does not match/.test(k.error) && !fs.existsSync(path.join(home1, "state.json")), k.error);
  const dup = await cli(home1, "http://127.0.0.1:1", ["init", message(S1, FPS).replace("relay-worker.template.mjs ", "relay-worker.template.mjs " + "0".repeat(64) + " relay-worker.template.mjs "), "--to", "t+pulltab@example.invalid", "--reply-by", "whatsapp"]);
  check("F4 (0.1.13) init refuses a file named twice with two different fingerprints", dup.ok === false && /does not match/.test(dup.error) && !fs.existsSync(path.join(home1, "state.json")), dup.error);
  const n = await cli(home1, "http://127.0.0.1:1", ["init", message(S1, FPS), "--to", "t+pulltab@example.invalid"]);
  check("channel: init refuses without --reply-by", n.ok === false && /--reply-by whatsapp\|text is required/.test(n.error) && !fs.existsSync(path.join(home1, "state.json")), n.error);
  const o = await cli(home1, "http://127.0.0.1:1", ["init", message(S1, FPS), "--to", "t+pulltab@example.invalid", "--reply-by", "telegram"]);
  check("channel: init refuses a channel other than whatsapp or text", o.ok === false && !fs.existsSync(path.join(home1, "state.json")), o.error);
}

// ---------- serve a relay from an init'd site folder ----------
async function relayFrom(home: string) {
  const src = fs.readFileSync(path.join(home, "site/worker.mjs"), "utf8").replace('import { connect } from "cloudflare:sockets";', 'const connect = () => { throw new Error("no sockets in tests"); };');
  const file = path.join(home, `worker-${crypto.randomUUID()}.mjs`); fs.writeFileSync(file, src);
  const w = (await import(file)).default;
  const env = { DB: new D1() };
  let hits: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    hits.push(`${req.method} ${req.url}`);
    if (process.env.PT_DEBUG) console.error("HIT", req.method, req.url, chunks.reduce((n, c) => n + c.length, 0));
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    let r: Response;
    try { r = await w.fetch(new Request("http://relay.test" + req.url, { method: req.method, headers: req.headers as any, body: req.method === "GET" || req.method === "HEAD" ? undefined : body }), env, { waitUntil: (p: Promise<any>) => p.catch(() => {}) }); }
    catch (e: any) { console.log("SERVER ERROR", req.method, req.url, e?.stack || e); res.writeHead(599); res.end(); return; }
    const h: any = {}; r.headers.forEach((v, k) => (h[k] = v));
    try { const buf = Buffer.from(await r.arrayBuffer()); res.writeHead(r.status, h); res.end(buf); if (process.env.PT_DEBUG) console.error("RES", r.status, buf.length); }
    catch (e: any) { console.log("WRITE ERROR", e?.stack || e); }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return { w, env, src, base, server, hits: () => hits, resetHits: () => (hits = []) };
}
function state(home: string) { return JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8")); }
async function app(base: string, k: any, method: string, p: string, body?: Uint8Array, ts = String(Date.now())) {
  const b = body || new Uint8Array(0); const sig = sign(k, method, p, ts, b);
  const r = await realFetch(base + p, { method, headers: { "x-pt-ts": ts, "x-pt-sig": sig, ...(body ? { "content-type": "application/octet-stream" } : {}) }, body: body ? Buffer.from(b) : undefined });
  const bytes = new Uint8Array(await r.arrayBuffer());
  let j: any = {}; try { j = JSON.parse(new TextDecoder().decode(bytes)); } catch {}
  return { status: r.status, j, signed: respOk(k, r.status, sig, bytes, r.headers.get("x-pt-rsig")) };
}
async function tab(base: string, key: string, method: string, p: string, body?: any) {
  const r = await realFetch(base + p, { method, headers: { authorization: "Bearer " + key, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j: any = {}; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
const audio = (k: any, ts: string) => seal(k, new Uint8Array(64000), `pulltab/audio/16000/${ts}`);

for (const [word, flag] of [["WhatsApp", "whatsapp"], ["text", "text"]] as const) {
  const S = crypto.getRandomValues(new Uint8Array(32)); const k = keysFrom(S);
  const home = path.join(tmp, "h-" + flag);
  const j = await cli(home, "http://127.0.0.1:1", ["init", message(S, FPS), "--to", "t+pulltab@example.invalid", "--reply-by", flag]);
  check(`channel ${word}: init accepts --reply-by ${flag}`, j.ok === true && j.reply_by === word, JSON.stringify(j).slice(0, 160));
  const R = await relayFrom(home);
  check(`channel ${word}: the relay is built with it`, R.src.includes(`const REPLY_BY = "${word}";`) && !R.src.includes("__REPLY_BY__"));
  check(`channel ${word}: no key placeholders left in the relay`, !/__[A-Z_]+__/.test(R.src));
  const st = state(home);
  const m = await tab(R.base, st.admin_key, "PUT", "/admin/mailer", { type: "resend", api_key: "re_test_not_real", to: "t@example.invalid" });
  const ts = String(Date.now());
  const a = await app(R.base, k, "POST", "/v1/ask", audio(k, ts), ts);
  check(`channel ${word}: the upload acknowledgement carries reply_by "${word}", signed by the paired relay`, m.status === 200 && a.status === 200 && a.j.reply_by === word && a.signed && typeof a.j.id === "string", JSON.stringify(a));
  const h = await tab(R.base, st.admin_key, "GET", "/admin/health");
  check(`channel ${word}: health shows it`, h.j.reply_by === word, JSON.stringify(h.j));
  R.server.close();
}

// ---------- one relay (WhatsApp) for the rest ----------
const S = crypto.getRandomValues(new Uint8Array(32)); const k = keysFrom(S);
const home = path.join(tmp, "main");
await cli(home, "http://127.0.0.1:1", ["init", message(S, FPS), "--to", "t+pulltab@example.invalid", "--reply-by", "whatsapp"]);
const Rl = await relayFrom(home); const base = Rl.base; const st = state(home);
await tab(base, st.admin_key, "PUT", "/admin/mailer", { type: "resend", api_key: "re_test_not_real", to: "t@example.invalid" });
const ask = async (ts = String(Date.now())) => app(base, k, "POST", "/v1/ask", audio(k, ts), ts);
const pend = async () => (await tab(base, st.tab_key, "GET", "/tab/pending")).j.pending || [];

// 0.1.13 (review of 0.1.12): M1 no database work before the key is checked, L1 no relay-signed refusal for a
// request that didn't verify, L6 cross-origin headers on /v1/ only, L7 the mail sender is checked like the recipient.
{
  let q = 0; const D = Rl.env.DB as any; const prep = D.prepare.bind(D); D.prepare = (sql: string) => { q++; return prep(sql); };
  const ts = String(Date.now());
  const forged = await realFetch(base + "/v1/hello", { headers: { "x-pt-ts": ts, "x-pt-sig": "ab".repeat(32) } });
  const fb = new Uint8Array(await forged.arrayBuffer());
  check("M1 an unsigned hello is refused 401 before any database query", forged.status === 401 && q === 0, `${forged.status} queries=${q}`);
  check("L1 that refusal is not signed for the forged signature (bound to nothing)", !respOk(k, 401, "ab".repeat(32), fb, forged.headers.get("x-pt-rsig")), "");
  const seen = sign(k, "GET", "/v1/hello", ts, new Uint8Array(0));
  const replayed = await realFetch(base + "/v1/hello", { method: "POST", headers: { "x-pt-ts": ts, "x-pt-sig": seen } });
  const rb = new Uint8Array(await replayed.arrayBuffer());
  check("L1 a real request signature reused on another request gets no relay-signed refusal", replayed.status === 401 && !respOk(k, 401, seen, rb, replayed.headers.get("x-pt-rsig")) && q === 0, `${replayed.status} queries=${q}`);
  const big = await realFetch(base + "/v1/ask", { method: "POST", headers: { "x-pt-ts": ts, "x-pt-sig": "cd".repeat(32), "content-type": "application/octet-stream" }, body: Buffer.alloc(1_800_001) });
  check("M1 an oversized upload is refused 413 before its signature or any database query", big.status === 413 && q === 0, `${big.status} queries=${q}`);
  const tb = await realFetch(base + "/tab/pending", { headers: { authorization: "Bearer " + "x".repeat(40) } });
  const ab = await realFetch(base + "/admin/health", { headers: { authorization: "Bearer " + st.tab_key } });
  check("M1 /tab/ and /admin/ without the right key are refused 401 before any database query", tb.status === 401 && ab.status === 401 && q === 0, `${tb.status} ${ab.status} queries=${q}`);
  const good = await app(base, k, "GET", "/v1/hello");
  check("M1 the app's signed hello still answers ok, signed", good.status === 200 && good.j.ok === true && good.signed && q > 0, JSON.stringify(good));
  const late = await app(base, k, "GET", "/v1/hello", undefined, String(Date.now() - 11 * 60_000));
  check("M1 a signed request with a wrong clock still gets a signed 401 \"clock\"", late.status === 401 && late.j.error === "clock" && late.signed, JSON.stringify(late));
  D.prepare = prep;
  const pv1 = await realFetch(base + "/v1/ask", { method: "OPTIONS" });
  const ptab = await realFetch(base + "/tab/pending", { method: "OPTIONS" });
  const tj = await realFetch(base + "/tab/pending", { headers: { authorization: "Bearer " + st.tab_key } });
  check("L6 cross-origin headers only on /v1/ (preflight, answers), none on /tab/ or /admin/",
    pv1.headers.get("access-control-allow-origin") === "*" && !/authorization/i.test(pv1.headers.get("access-control-allow-headers") || "")
    && !ptab.headers.get("access-control-allow-origin") && !tj.headers.get("access-control-allow-origin") && tj.status === 200
    && forged.headers.get("access-control-allow-origin") === "*", "");
  const bad = await tab(base, st.admin_key, "PUT", "/admin/mailer", { type: "smtp", user: "a@example.invalid", pass: "p", from: "a@example.invalid\r\nBcc: x@example.invalid", to: "t@example.invalid" });
  const badR = await tab(base, st.admin_key, "PUT", "/admin/mailer", { type: "resend", api_key: "k", from: "Pull Tab <a@example.invalid>\nBcc: x", to: "t@example.invalid" });
  const ok = await tab(base, st.admin_key, "PUT", "/admin/mailer", { type: "resend", api_key: "re_test_not_real", to: "t@example.invalid" });
  check("L7 a mail sender with a line break is refused (smtp and mail API); a normal one is kept", bad.status === 400 && bad.j.error === "bad_from" && badR.status === 400 && ok.status === 200, `${bad.status} ${badR.status} ${ok.status}`);
}

// no answer route: the app never asks for one, and the relay has none
{
  const a = await ask();
  const g = await app(base, k, "GET", "/v1/reply/" + a.j.id);
  check("no answer route: GET /v1/reply/<id> is not found (signed)", g.status === 404 && g.j.error === "not_found" && g.signed, JSON.stringify(g));
  const old = await tab(base, st.tab_key, "POST", "/tab/reply/" + a.j.id, { reply: "x" });
  check("no answer route: the Tab can't post answer text (old /tab/reply is gone)", old.status === 404 && old.j.error === "not_found", JSON.stringify(old));
  // status = still live?; done = clear it
  const s1 = await tab(base, st.tab_key, "POST", "/tab/status/" + a.j.id);
  check("status: a live request answers 200", s1.status === 200 && s1.j.ok === true, JSON.stringify(s1));
  const d1 = await tab(base, st.tab_key, "POST", "/tab/done/" + a.j.id);
  check("done: clears the request", d1.status === 200 && (await pend()).length === 0, JSON.stringify(d1));
  const d2 = await tab(base, st.tab_key, "POST", "/tab/done/" + a.j.id);
  const s2 = await tab(base, st.tab_key, "POST", "/tab/status/" + a.j.id);
  check("done: a second done, and status, then say gone (404)", d2.status === 404 && s2.status === 404, `${d2.status} ${s2.status}`);
  check("done/status need the tab key", (await tab(base, "x".repeat(30), "POST", "/tab/done/" + a.j.id)).status === 401);
}
// a request the person cancelled in the "Sent" window: done answers 404, so the Tab sends nothing
{
  const ts = String(Date.now()); const a = await ask(ts);
  const c1 = await app(base, k, "POST", "/v1/ack/" + a.j.id);
  const c2 = await app(base, k, "POST", "/v1/cancel", TE.encode(ts));   // 0.1.9: the cancel names its ask
  const d = await tab(base, st.tab_key, "POST", "/tab/done/" + a.j.id);
  check("cancel in the Sent window: the relay deletes it and done answers 404 (send nothing)", c1.status === 200 && c1.signed && c2.status === 200 && c2.signed && d.status === 404, `${c1.status} ${c2.status} ${d.status}`);
  const dc = await cli(home, base, ["done", a.j.id]);
  check("cancel in the Sent window: pulltab done exits 3 with 'gone'", dc.rc === 3 && dc.ok === false && /gone/.test(dc.error), JSON.stringify(dc));
}
// pulltab CLI: note / done / reply on a live request
{
  const a = await ask();
  const n = await cli(home, base, ["note", a.j.id, "checking", "your", "calendar"]);
  check("pulltab note: a live request is ok, and sends no words", n.rc === 0 && /"ok": ?true/.test(JSON.stringify(n)) && (await pend()).length === 1, JSON.stringify(n));
  const d = await cli(home, base, ["reply", a.j.id, "the", "answer"]);
  check("pulltab reply (= done): clears it, sends no words", d.rc === 0 && (await pend()).length === 0, JSON.stringify(d));
  const n2 = await cli(home, base, ["note", a.j.id]);
  check("pulltab note on a cleared request exits 3 (gone)", n2.rc === 3 && /gone/.test(n2.error), JSON.stringify(n2));
}
// F13: request ids are checked before they go into a URL
for (const bad of ["../admin/purge", "abc", "x".repeat(41), "id with space", "abc/../../admin/retire", "%2e%2e%2fadmin", "a?b=c#dd"]) {
  Rl.resetHits();
  const r1 = await cli(home, base, ["done", bad]), r2 = await cli(home, base, ["note", bad]), r3 = await cli(home, base, ["take", bad]), r4 = await cli(home, base, ["reply", bad, "x"]);
  check(`F13 ${JSON.stringify(bad)} refused by done, note, reply and take, nothing sent`, [r1, r2, r3, r4].every((r) => r.ok === false && /not a request id/.test(r.error)) && Rl.hits().length === 0, JSON.stringify([r1.error, Rl.hits()]));
}
{
  const a = await ask(); Rl.resetHits();
  const r = await cli(home, base, ["done", a.j.id]);
  check("F13 a real id still passes", r.rc === 0 && Rl.hits().some((h) => h.startsWith("POST /tab/done/" + a.j.id)), JSON.stringify(r));
}


// ---------- 0.1.9: the FIFO queue of 8 ----------
const purge = async () => { await tab(base, st.admin_key, "POST", "/admin/purge"); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ids = async () => (await pend()).map((x: any) => x.id);
const askAt = async (ts: string, body?: Uint8Array) => app(base, k, "POST", "/v1/ask", body || audio(k, ts), ts);
let tsN = Date.now() - 60_000;                    // distinct, increasing app timestamps
const nextTs = () => String(++tsN);
check("queue: the relay holds up to 8 (QUEUE_MAX = 8)", /const QUEUE_MAX = 8;/.test(Rl.src) && !/DELETE FROM req`\),\s+\/\/ one request/.test(Rl.src));
// 3 queued requests, taken in FIFO order (pending lists them oldest first; pulltab take next takes the oldest)
{
  await purge();
  const a: any[] = [];
  for (let i = 0; i < 3; i++) { a.push(await askAt(nextTs())); await sleep(15); }
  check("FIFO: 3 asks are all queued (none replaces another)", a.every((x) => x.status === 200 && x.signed && x.j.id) && (await pend()).length === 3, JSON.stringify(a.map((x) => x.status)));
  const p = await tab(base, st.tab_key, "GET", "/tab/pending");
  check("FIFO: pending lists them oldest first, and says the queue holds 8", JSON.stringify(p.j.pending.map((x: any) => x.id)) === JSON.stringify(a.map((x) => x.j.id)) && p.j.queue_max === 8, JSON.stringify(p.j).slice(0, 200));
  const lt = await cli(home, base, ["take", "latest"]);
  check("FIFO: pulltab take latest is refused (points to take next) and takes nothing", lt.ok === false && /take next/.test(lt.error) && (await pend()).length === 3, JSON.stringify(lt));
  const order: string[] = [];
  for (let i = 0; i < 3; i++) {
    const tk = await cli(home, base, ["take", "next"]);
    order.push(tk.id);
    const d = await cli(home, base, ["done", tk.id]);
    if (!(tk.ok === true && d.rc === 0)) console.log("take/done detail", JSON.stringify(tk), JSON.stringify(d));
  }
  check("FIFO: pulltab take next + done walks the queue oldest first", JSON.stringify(order) === JSON.stringify(a.map((x) => x.j.id)) && (await pend()).length === 0, JSON.stringify(order));
  const b1 = await askAt(nextTs()); await sleep(15); const b2 = await askAt(nextTs());
  const tk = await cli(home, base, ["take"]);
  check("FIFO: pulltab take with no id also takes the oldest", tk.ok === true && tk.id === b1.j.id && (await ids()).join() === [b1.j.id, b2.j.id].join(), JSON.stringify(tk));
}
// a 9th upload is refused (signed "queue_full"); nothing queued is dropped
{
  await purge(); const m0 = mails.length;
  const a: any[] = [];
  for (let i = 0; i < 8; i++) { a.push(await askAt(nextTs())); await sleep(5); }
  const eight = a.map((x) => x.j.id);
  check("queue full: 8 asks are accepted", a.every((x) => x.status === 200 && x.j.id) && (await pend()).length === 8, JSON.stringify(a.map((x) => x.status)));
  const ninth = await askAt(nextTs());
  await sleep(50);
  check("queue full: the 9th upload is refused 429 queue_full, signed by the relay", ninth.status === 429 && ninth.j.error === "queue_full" && ninth.signed && !ninth.j.id, JSON.stringify(ninth));
  check("queue full: nothing queued is dropped (the same 8, same order)", (await ids()).join() === eight.join());
  check("queue full: no wake mail for the refused 9th (one per accepted request)", mails.length - m0 === 8, `${mails.length - m0}`);
  const h = await tab(base, st.admin_key, "GET", "/admin/health");
  check("queue full: health shows 8 in flight of 8", h.j.in_flight === 8 && h.j.queue_max === 8, JSON.stringify(h.j).slice(0, 200));
  await tab(base, st.tab_key, "POST", "/tab/done/" + eight[0]);
  const tenth = await askAt(nextTs());
  check("queue full: once the Tab clears the oldest, a new ask is accepted at the back", tenth.status === 200 && (await ids()).join() === [...eight.slice(1), tenth.j.id].join(), JSON.stringify(tenth));
  await tab(base, st.tab_key, "POST", "/tab/done/" + eight[1]);
  const both = await Promise.all([askAt(nextTs()), askAt(nextTs())]);
  check("queue full: two asks at once with one place left: exactly one is accepted, the queue stays at 8",
    both.filter((x) => x.status === 200).length === 1 && both.filter((x) => x.status === 429 && x.j.error === "queue_full").length === 1 && (await pend()).length === 8, JSON.stringify(both.map((x) => x.status)));
}
// cancel removes only its own request
{
  await purge();
  const ts = [nextTs(), nextTs(), nextTs()]; const a: any[] = [];
  for (const t1 of ts) { a.push(await askAt(t1)); await sleep(10); }
  const c = await app(base, k, "POST", "/v1/cancel", TE.encode(ts[1]));
  check("cancel: the triple tap's cancel removes only the request it names (the middle one)", c.status === 200 && c.signed && (await ids()).join() === [a[0].j.id, a[2].j.id].join(), JSON.stringify(await ids()));
  check("cancel: the Tab's done on the cancelled one says gone; the others are live",
    (await tab(base, st.tab_key, "POST", "/tab/done/" + a[1].j.id)).status === 404 && (await tab(base, st.tab_key, "POST", "/tab/status/" + a[0].j.id)).status === 200 && (await tab(base, st.tab_key, "POST", "/tab/status/" + a[2].j.id)).status === 200);
  const t4 = nextTs();
  const c4 = await app(base, k, "POST", "/v1/cancel", TE.encode(t4));
  const late = await askAt(t4);
  check("cancel first, then its ask arrives: that ask is refused, the queue is untouched", c4.status === 200 && late.status === 409 && late.j.error === "cancelled" && late.signed && (await ids()).join() === [a[0].j.id, a[2].j.id].join(), JSON.stringify(late));
  const a5 = await askAt(nextTs());
  check("cancel: a later ask still queues behind the others", a5.status === 200 && (await ids()).join() === [a[0].j.id, a[2].j.id, a5.j.id].join());
  const ack = await app(base, k, "POST", "/v1/ack/" + a[0].j.id);
  check("cancel: ack by id deletes only that id", ack.status === 200 && ack.signed && (await ids()).join() === [a[2].j.id, a5.j.id].join());
  const bad = await app(base, k, "POST", "/v1/cancel");
  const bad2 = await app(base, k, "POST", "/v1/cancel", TE.encode("not-a-time"));
  check("cancel without a named ask is refused 400 (signed) and deletes nothing", bad.status === 400 && bad.j.error === "bad_cancel" && bad.signed && bad2.status === 400 && (await pend()).length === 2, `${bad.status} ${bad2.status}`);
}
// each request's id is handled independently: its own audio, timestamps, status, done and wake mail
{
  await purge(); const mb0 = mailBodies.length;
  const ts = [nextTs(), nextTs(), nextTs()]; const boxes: Uint8Array[] = []; const a: any[] = [];
  for (let i = 0; i < 3; i++) {
    const pcm = new Uint8Array(64000).fill(i + 1);
    boxes.push(seal(k, pcm, `pulltab/audio/16000/${ts[i]}`));
    a.push(await askAt(ts[i], boxes[i])); await sleep(10);
  }
  await sleep(50);
  const got: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await realFetch(base + "/tab/audio/" + a[i].j.id, { headers: { authorization: "Bearer " + st.tab_key } });
    got.push(r.status === 200 && Buffer.compare(Buffer.from(await r.arrayBuffer()), Buffer.from(boxes[i])) === 0);
  }
  check("ids: each id serves its own audio", got.every(Boolean), JSON.stringify(got));
  const p = await pend();
  check("ids: each request keeps its own app timestamp, in order", JSON.stringify(p.map((x: any) => String(x.client_ts))) === JSON.stringify(ts) && new Set(p.map((x: any) => x.id)).size === 3, JSON.stringify(p.map((x: any) => x.client_ts)));
  const wm = mailBodies.slice(mb0);
  check("ids: one wake mail per request, each naming its own id", wm.length === 3 && a.every((x, i) => wm[i].includes(x.j.id) && a.every((y, j) => j === i || !wm[i].includes(y.j.id))), `${wm.length}`);
  const d2 = await cli(home, base, ["done", a[1].j.id]);
  const n1 = await cli(home, base, ["note", a[0].j.id]), n3 = await cli(home, base, ["note", a[2].j.id]), n2 = await cli(home, base, ["note", a[1].j.id]);
  check("ids: done on one clears only that one (note: the others live, it gone)", d2.rc === 0 && n1.rc === 0 && n3.rc === 0 && n2.rc === 3 && (await ids()).join() === [a[0].j.id, a[2].j.id].join(), JSON.stringify([d2.rc, n1.rc, n3.rc, n2.rc]));
  const d2b = await cli(home, base, ["done", a[1].j.id]);
  check("ids: a second done on a cleared id exits 3 (gone) and touches no other", d2b.rc === 3 && (await pend()).length === 2);
  const tk = await cli(home, base, ["take", a[2].j.id]);
  check("ids: take <id> takes that one, not the oldest", tk.ok === true && tk.id === a[2].j.id && (await pend()).length === 2, JSON.stringify(tk).slice(0, 160));
}
// expiry is per request: each one is served for 30 min from its own arrival
{
  await purge();
  const a1 = await ask();
  skew = 20 * 60_000; const a2 = await ask();
  skew = 31 * 60_000;
  const s1 = await tab(base, st.tab_key, "POST", "/tab/status/" + a1.j.id), s2 = await tab(base, st.tab_key, "POST", "/tab/status/" + a2.j.id);
  check("expiry per request: at 31 min the first is gone, the second (11 min old) is still queued", a1.status === 200 && a2.status === 200 && s1.status === 404 && s2.status === 200 && (await ids()).join() === a2.j.id, `${s1.status} ${s2.status}`);
  const fill: any[] = [];
  for (let i = 0; i < 7; i++) fill.push(await ask());
  check("expiry per request: an expired request doesn't hold a place in the queue (1 live + 7 = 8 accepted)", fill.every((x) => x.status === 200) && (await pend()).length === 8, JSON.stringify(fill.map((x) => x.status)));
  skew = 0;
  await purge();
}

// F12: the cancel tombstone lasts 15 minutes (the Tab accepts audio for 15)
{
  const tAsk = Date.now(); const tCancel = tAsk + 500;
  const c = await app(base, k, "POST", "/v1/cancel", TE.encode(String(tAsk)), String(tCancel));
  skew = 9.5 * 60_000;                           // the cancelled ask reaches the relay 9.5 min late (inside the clock window)
  const late = await ask(String(tAsk));
  check("F12 a cancelled ask arriving 9.5 min late is refused (the 2-min tombstone let it in)", c.status === 200 && late.status === 409 && late.j.error === "cancelled" && late.signed && (await pend()).length === 0, JSON.stringify(late));
  const fresh = await ask(String(Date.now()));
  check("F12 an ask made after the cancel is accepted", fresh.status === 200, JSON.stringify(fresh));
  skew = 0;
  // 0.1.9: a tombstone refuses only the ask it names, so even a phone clock that was 5 min fast can't block other asks
  const tf = Date.now() + 5 * 60_000; const named = String(Date.now() - 1000);
  await app(base, k, "POST", "/v1/cancel", TE.encode(named), String(tf));
  const other = await ask(String(Date.now()));
  const theOne = await ask(named);
  check("F12 a tombstone (even from a fast clock) refuses only the ask it names", other.status === 200 && theOne.status === 409 && theOne.j.error === "cancelled", `${other.status} ${theOne.status}`);
  check("F12 the hold is 15 minutes in the relay", /const CANCEL_HOLD_MS = 15 \* 60_000;/.test(Rl.src));
  skew = 0;
  await tab(base, st.admin_key, "POST", "/admin/purge");
}

// F1: retire. The old code stops working at once; the Tab's state goes; a new code can be set up.
{
  const a = await ask();
  check("F1 retire needs the admin key (the tab key can't)", (await tab(base, st.tab_key, "POST", "/admin/retire")).status === 401 && (await realFetch(base + "/admin/retire", { method: "POST" })).status === 401);
  // a new pairing code arrives while the old state is there: init points at retire
  const S2 = crypto.getRandomValues(new Uint8Array(32));
  const ni = await cli(home, base, ["init", message(S2, FPS), "--to", "t+pulltab@example.invalid", "--reply-by", "text"]);
  check("F1 init with a new code while the old state exists says to retire first", ni.ok === false && /pulltab retire/.test(ni.error), ni.error);
  const r = await cli(home, base, ["retire"]);
  check("F1 pulltab retire: ok, the relay confirmed, local state and site folder deleted", r.ok === true && r.relay_refuses_old_code === true && !fs.existsSync(path.join(home, "state.json")) && !fs.existsSync(path.join(home, "site")) && /site\.delete/.test(r.next || ""), JSON.stringify(r));
  const h = await app(base, k, "GET", "/v1/hello");
  check("F1 after retire the old code's hello is refused 410 retired, signed (the app unpairs)", h.status === 410 && h.j.error === "retired" && h.signed, JSON.stringify(h));
  const ts = String(Date.now() + 1000); const mails0 = mails.length;
  const ak = await app(base, k, "POST", "/v1/ask", audio(k, ts), ts);
  check("F1 after retire an ask with the old code is refused 410, and no wake mail goes", ak.status === 410 && ak.signed && mails.length === mails0, JSON.stringify(ak));
  const db = (Rl.env.DB as any).db as DatabaseSync;
  const left = (db.prepare("SELECT (SELECT COUNT(*) FROM req) AS r, (SELECT COUNT(*) FROM asks) AS a, (SELECT COUNT(*) FROM seen) AS s, (SELECT COUNT(*) FROM cfg WHERE k = 'mailer') AS m").get() as any);
  check("F1 after retire the relay holds no request, ask log, signature log or mail credential", left.r === 0 && left.a === 0 && left.s === 0 && left.m === 0, JSON.stringify(left));
  check("F1 after retire the Tab's API refuses (410)", (await tab(base, st.tab_key, "GET", "/tab/pending")).status === 410 && (await tab(base, st.tab_key, "GET", "/tab/audio/" + a.j.id)).status === 410);
  check("F1 after retire admin calls refuse (410), health says retired", (await tab(base, st.admin_key, "PUT", "/admin/mailer", { type: "resend", api_key: "k", to: "t@example.invalid" })).status === 410
    && (await tab(base, st.admin_key, "GET", "/admin/health")).j.retired === true);
  const ni2 = await cli(home, base, ["init", message(S2, FPS), "--to", "t+pulltab@example.invalid", "--reply-by", "text"]);
  check("F1 after retire, init with the new code proceeds", ni2.ok === true && ni2.slug === keysFrom(S2).slug, JSON.stringify(ni2).slice(0, 120));
  // retire refuses to forget the state when the relay didn't confirm (unless the site is already deleted)
  const home3 = path.join(tmp, "h3"); const S3 = crypto.getRandomValues(new Uint8Array(32));
  await cli(home3, "http://127.0.0.1:1", ["init", message(S3, FPS), "--to", "t+pulltab@example.invalid", "--reply-by", "text"]);
  const r3 = await cli(home3, "http://127.0.0.1:1", ["retire"]);
  check("F1 retire with an unreachable relay changes nothing", r3.ok === false && fs.existsSync(path.join(home3, "state.json")), r3.error);
  const r4 = await cli(home3, "http://127.0.0.1:1", ["retire", "--site-deleted"]);
  check("F1 retire --site-deleted removes the local state only", r4.ok === true && r4.relay_refuses_old_code === false && !fs.existsSync(path.join(home3, "state.json")), JSON.stringify(r4));
}
Rl.server.close();
fs.rmSync(tmp, { recursive: true, force: true });
const fails = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? "PASS " : "FAIL ") + r.name + (r.ok ? "" : "  (" + r.detail + ")"));
console.log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
