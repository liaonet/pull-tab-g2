#!/usr/bin/env python3
"""pulltab - a Tab's side of Pull Tab (Even G2 glasses -> your own Tab).

Setup (once):
  pulltab init "<the person's whole setup message>" --to <your-handle>+pulltab@mail.tab.bot --reply-by whatsapp|text
        [--name <site-name>]
        derive the relay name and keys from the pairing code, write the private state file (0600) and the
        relay site folder; prints the publish command. Nothing is sent anywhere. Refuses unless the message carries
        the SHA-256 fingerprints of setup.md, this file and the relay template, and this file and the template (and
        setup.md, when it sits next to this file) match them. --reply-by: how you send your answers, the channel your
        person uses most with you (WhatsApp, or text for iMessage/SMS); the lens says "Sent, reply coming by
        WhatsApp." (or "by text."). --name only if the derived name can't be published: the person then pastes the
        relay address into the app (the guide says how).
  pulltab set-mailer smtp     read {"username","password"} JSON from env TAB_VAULT (a Gmail app password of a
                              throwaway mailbox) and store it, sealed, on the relay. Optional env: PULLTAB_SMTP_HOST,
                              PULLTAB_SMTP_PORT (465 implicit TLS or 587 STARTTLS). Prints no secret.
  pulltab set-mailer resend   read {"password": "<API key>"} (or {"api_key"}) from env TAB_VAULT and store it.
                              Either form: env PULLTAB_WAKE_TO overrides the wake address set at init.
  pulltab health              relay config (never prints a secret)
  pulltab check               do what the app does: a signed hello straight to the relay, and check the relay's
                              signature on the answer (the app refuses any answer without it)
  pulltab test-wake           ask the relay to send one test wake mail (SENDS ONE EMAIL to your own address)

Each request (you answer by message, on your normal channel; nothing you do here reaches the lens):
  The relay queues up to 8 requests, first in, first out; a new ask never replaces a waiting one. Answer them
  oldest first, each by its own id: take, answer, done, then the next.
  pulltab pending             requests waiting on the relay, oldest first
  pulltab take <id>|next      fetch + decrypt the audio, transcribe it in memory (no audio file is written), print
                              JSON. `next` (or no argument) takes the oldest waiting request. Refuses (and clears)
                              audio older than 15 min or already taken (a replay).
  pulltab note <id>           is the request still live? Exits 3 if it is gone (the person cancelled it or it
                              expired): run it right before any outward action, and stop if it fails.
  pulltab done <id>           clear the request, right before you send your answer by message. Exits 3 if it is
                              gone: the person cancelled, so send nothing. (`reply <id>` does the same; no text is
                              sent to the relay or the lens.)

Other:
  pulltab selftest [--whisper] offline check of the protocol against the published test vector; --whisper also
                              downloads and warms the speech model so the first real request isn't slow
  pulltab purge               delete everything in flight on the relay
  pulltab retire [--site-deleted]
                              the person made a new pairing code, or the old one may have leaked: the relay empties
                              itself, drops its mail credential and refuses everything from now on (the old code stops
                              working at once); then the local state and site folder are deleted, and it prints the
                              site.delete command for the old relay. --site-deleted: the relay's site is already gone,
                              only delete the local state.

State: $PULLTAB_HOME (default /home/user/tab/state/pull-tab-relay)/state.json, mode 0600. Never print it.
Needs: python3 with requests + cryptography (the Tab kernel venv has both), faster-whisper for `take`.
"""
import base64, hashlib, hmac, json, os, re, secrets, sys, time

HOME = os.environ.get("PULLTAB_HOME", "/home/user/tab/state/pull-tab-relay")
STATE = os.path.join(HOME, "state.json")
MAX_AGE_S = 15 * 60          # the app stops waiting after 15 min; older audio is stale or replayed
# Published test vector (secret bytes 0..31); the app, relay and this tool must agree.
VECTOR = {"slug": "pt-3n44qqjm4rkb2efcai3m", "code": "PT1-AAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPWGDI",
          "sig": "ff05b6c26a9b4ef0d89a65770155f04375e2ef82cc45977d5349f223a47e2209",
          "rsig": "178639ff520c6d86ddd733c7c97ceb75ce422cf788dae609f625c96d3827ffaf"}
B32 = "abcdefghijklmnopqrstuvwxyz234567"

# ---------- protocol (mirrors the app's pt.ts and the relay) ----------
def b32enc(b):
    bits = val = 0; out = ""
    for x in b:
        val = (val << 8) | x; bits += 8
        while bits >= 5: out += B32[(val >> (bits - 5)) & 31]; bits -= 5
        val &= (1 << bits) - 1
    if bits: out += B32[(val << (5 - bits)) & 31]
    return out
def b32dec(s):
    out = bytearray(); bits = val = 0
    for ch in s.lower():
        i = B32.find(ch)
        if i < 0: return None
        val = (val << 5) | i; bits += 5
        if bits >= 8: out.append((val >> (bits - 8)) & 255); bits -= 8; val &= (1 << bits) - 1
    return bytes(out)
def b64u(b): return base64.urlsafe_b64encode(b).decode().rstrip("=")
def unb64u(s): return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
def derive(S, info): return hmac.new(S, ("pulltab/v1/" + info).encode(), hashlib.sha256).digest()
def keys_from(S):
    return {"slug": "pt-" + b32enc(derive(S, "slug"))[:20], "auth": derive(S, "auth"), "enc": derive(S, "enc"),
            "rkey": derive(S, "relay"), "code": "PT1-" + b32enc(S + hashlib.sha256(S).digest()[:2]).upper()}
def parse_code(text):
    m = re.search(r"PT1[-\s]*([A-Z2-7][A-Z2-7\-\s]{50,80})", text.upper())
    if not m: return None
    b = b32dec(re.sub(r"[-\s]", "", m.group(1))[:55])
    if not b or len(b) != 34: return None
    S = b[:32]
    return S if hashlib.sha256(S).digest()[:2] == b[32:] else None
def seal(enc, plain, aad):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    n = os.urandom(12); return n + AESGCM(enc).encrypt(n, plain, aad.encode())
def unseal(enc, box, aad):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    return AESGCM(enc).decrypt(box[:12], box[12:], aad.encode())
def sign(auth, method, path, ts, body=b""):
    return hmac.new(auth, f"{method}\n{path}\n{ts}\n{hashlib.sha256(body).hexdigest()}".encode(), hashlib.sha256).hexdigest()
# Protocol 3: the relay signs every /v1/ answer with rkey, bound to the request's own signature (the app pins rkey).
def resp_sig(rkey, status, req_sig, body=b""):
    return hmac.new(rkey, f"pulltab/resp\n{status}\n{req_sig}\n{hashlib.sha256(body).hexdigest()}".encode(), hashlib.sha256).hexdigest()
NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")   # one DNS label: the app takes https://<label>.sites.tab.bot only
ID_RE = re.compile(r"[A-Za-z0-9_-]{6,40}")   # a relay request id (the relay's own pattern); checked before it goes in a URL (audit F13)
REPLY_BY = {"whatsapp": "WhatsApp", "text": "text"}   # the word the lens shows: "Sent, reply coming by <word>."
FINGERPRINTED = ("setup.md", "pulltab.py", "relay-worker.template.mjs")

# ---------- state + http ----------
def out(obj): print(json.dumps(obj, ensure_ascii=False))
def die(msg, code=1): out({"ok": False, "error": msg}); sys.exit(code)
def load():
    if not os.path.exists(STATE): die(f"no state at {STATE}; run `pulltab init` first")
    s = json.load(open(STATE)); s["_S"] = unb64u(s["secret"]); s["_k"] = keys_from(s["_S"]); return s
def base(s): return os.environ.get("PULLTAB_BASE", s["base_url"]).rstrip("/")
def call(s, method, path, key="tab_key", **kw):
    import requests
    return requests.request(method, base(s) + path, headers={"authorization": f"Bearer {s[key]}"}, timeout=40, **kw)
_model = None
# 0.1.13 (Claude review M4): the default speech model is one fixed revision of Systran/faster-whisper-small (the repo
# faster-whisper's "small" resolves to), not whatever is served that day. PULLTAB_WHISPER (another model) is used as given.
WHISPER_REPO, WHISPER_REVISION = "Systran/faster-whisper-small", "536b0662742c02347bc0e980a01041f333bce120"
def model():
    global _model
    from faster_whisper import WhisperModel
    if _model is None:
        name = os.environ.get("PULLTAB_WHISPER")
        _model = WhisperModel(name, device="cpu", compute_type="int8") if name else \
            WhisperModel(WHISPER_REPO, device="cpu", compute_type="int8", revision=WHISPER_REVISION)
    return _model
def transcribe(pcm):
    # 16 kHz mono s16le -> float32 in memory; the audio never touches the disk.
    import numpy as np
    audio = np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0
    segs, info = model().transcribe(audio, language=os.environ.get("PULLTAB_LANG") or None, vad_filter=True, beam_size=5)
    return " ".join(x.text.strip() for x in segs).strip(), info

def req_id(rid):
    if not isinstance(rid, str) or not ID_RE.fullmatch(rid): die(f"{rid!r} is not a request id (6-40 of a-z, A-Z, 0-9, '_', '-'); use the id from `pending` or the doorbell mail")
    return rid
def save_state(s):
    st = {k: v for k, v in s.items() if not k.startswith("_")}
    fd = os.open(STATE + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f: json.dump(st, f, indent=1)
    os.replace(STATE + ".tmp", STATE)
def posted(r, what):
    # Every write to the relay either lands or ends the command with a non-zero exit and the relay's words.
    if r.status_code == 404: die(f"{what}: gone (cancelled by the person or expired). Do nothing more for it.", 3)
    if r.status_code != 200: die(f"{what}: relay answered {r.status_code}: {r.text[:200]}")

def cmd_init(a):
    to = None; template = None; site_name = None; reply_by = None; text = []
    i = 0
    while i < len(a):
        if a[i] == "--to": to = a[i + 1]; i += 2
        elif a[i] == "--template": template = a[i + 1]; i += 2
        elif a[i] == "--name": site_name = a[i + 1].strip().lower(); i += 2
        elif a[i] == "--reply-by": reply_by = a[i + 1].strip().lower(); i += 2
        else: text.append(a[i]); i += 1
    S = parse_code(" ".join(text))
    if not S: die("no valid pairing code found (it starts with PT1- and is 55 characters after the dash)")
    if not to or "@" not in to: die("--to <your own Tab address, e.g. handle+pulltab@mail.tab.bot> is required")
    if reply_by not in REPLY_BY: die("--reply-by whatsapp|text is required: the channel your person uses most with you, where your answers will go (the lens says \"Sent, reply coming by WhatsApp.\" or \"by text.\")")
    # The relay template must sit next to this file (the guide downloads both); nothing is fetched here.
    here = os.path.dirname(os.path.abspath(__file__))
    template = template or os.path.join(here, "relay-worker.template.mjs")
    # The setup message carries the app's SHA-256 of each file a Tab downloads. The guide's step 1 checks all of
    # them first; given the whole message, init checks this file and the template again (and setup.md, when it sits
    # next to this file). 0.1.8 (audit F4): no fingerprints, no setup. A message without all three is refused, and
    # every check runs before anything is written.
    found = re.findall(r"(setup\.md|pulltab\.py|relay-worker\.template\.mjs)\s+([0-9a-f]{64})", " ".join(text))
    fps = dict(found)
    missing = [n for n in FINGERPRINTED if n not in fps]
    if missing: die(f"the setup message has no SHA-256 fingerprint for {', '.join(missing)}. Stop setup and ask your person to copy the setup message from Pull Tab again (guide, step 1).")
    if not os.path.exists(template): die(f"relay template not found at {template}; download it next to pulltab.py (see the guide)")
    checks = [("pulltab.py", os.path.abspath(__file__)), ("relay-worker.template.mjs", template)]
    if os.path.exists(os.path.join(here, "setup.md")): checks.append(("setup.md", os.path.join(here, "setup.md")))
    for name, path in checks:
        # 0.1.13 (Claude review, F4 note): a file named twice with two different fingerprints counts as a mismatch
        if hashlib.sha256(open(path, "rb").read()).hexdigest() != fps[name] or any(n == name and h != fps[name] for n, h in found):
            die(f"{name} does not match the SHA-256 in your person's setup message. Stop setup and tell your person (guide, step 1).")
    src = open(template).read()
    for ph in ("__AUTH_KEY_HEX__", "__RELAY_KEY_HEX__", "__TAB_KEY_SHA256__", "__ADMIN_KEY_SHA256__", "__SEAL_KEY__", "__REPLY_BY__"):
        if ph not in src: die(f"relay template is missing {ph}; wrong file?")
    k = keys_from(S)
    name = site_name or k["slug"]
    if not NAME_RE.match(name): die("--name must be one DNS label (a-z, 0-9, '-'): the app accepts only https://<name>.sites.tab.bot")
    if os.path.exists(STATE):
        old = json.load(open(STATE))
        if old.get("secret") != b64u(S): die(f"state already exists for {old.get('slug')}, set up from another pairing code. Your person made a new code (or wants the old one shut): run `pulltab retire` first, which makes the old relay refuse the old code at once, delete the old relay site as it says, then run init again")
        st = old
    else:
        st = {"secret": b64u(S), "slug": k["slug"], "tab_key": secrets.token_urlsafe(32), "admin_key": secrets.token_urlsafe(32),
              "seal_key": secrets.token_urlsafe(32), "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    st.update({"base_url": f"https://{name}.sites.tab.bot", "name": name, "wake_to": to, "reply_by": REPLY_BY[reply_by]})
    os.makedirs(HOME, mode=0o700, exist_ok=True); os.chmod(HOME, 0o700)
    fd = os.open(STATE + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f: json.dump(st, f, indent=1)
    os.replace(STATE + ".tmp", STATE)
    h = lambda x: hashlib.sha256(x.encode()).hexdigest()
    for ph, v in {"__AUTH_KEY_HEX__": k["auth"].hex(), "__RELAY_KEY_HEX__": k["rkey"].hex(), "__TAB_KEY_SHA256__": h(st["tab_key"]), "__ADMIN_KEY_SHA256__": h(st["admin_key"]), "__SEAL_KEY__": st["seal_key"], "__REPLY_BY__": st["reply_by"]}.items():
        src = src.replace(ph, v)
    site = os.path.join(HOME, "site"); os.makedirs(site, exist_ok=True)
    open(os.path.join(site, "worker.mjs"), "w").write(src)
    json.dump({"kind": "worker", "entry": "worker.mjs", "bindings": [{"type": "d1", "name": "DB"}],
               "worker": {"compatibility_date": "2026-08-01", "compatibility_flags": ["nodejs_compat"]}}, open(os.path.join(site, "tab-site.json"), "w"), indent=1)
    res = {"ok": True, "slug": name, "relay": st["base_url"], "site_dir": site, "wake_to": to, "reply_by": st["reply_by"],
           "publish": f"node /home/user/tab/publish-cli.mjs site.publish '{json.dumps({'slug': name, 'source_dir': site, 'title': 'Pull Tab relay (private)'})}'"}
    if name == k["slug"]: res["note"] = "Publish under exactly this name: the app derives it from the same code, so your person types nothing."
    else: res["note"] = f"Not the name the app derives: once the relay is up, your person must paste {st['base_url']} into Pull Tab on their phone (Did your Tab give you a relay address?)."
    out(res)

def cmd_retire(s, a):
    # 0.1.8 (audit F1): retire the relay this state was set up from, so its pairing code stops working at once.
    import shutil
    if "--site-deleted" not in a:
        try: r = call(s, "POST", "/admin/retire", key="admin_key")
        except Exception as e: die(f"retire: couldn't reach the relay ({type(e).__name__}); nothing was changed. If its site is already deleted, run `pulltab retire --site-deleted`.")
        if not (r.status_code == 200 or (r.status_code == 410 and "retired" in r.text)):
            die(f"retire: the relay answered {r.status_code}: {r.text[:200]}; nothing was changed. If its site is already deleted, run `pulltab retire --site-deleted`.")
    name = s.get("name") or s.get("slug")
    shutil.rmtree(os.path.join(HOME, "site"), ignore_errors=True)
    os.remove(STATE)
    out({"ok": True, "retired": name, "relay_refuses_old_code": "--site-deleted" not in a, "local_state": "deleted",
         "next": f"node /home/user/tab/publish-cli.mjs site.delete '{json.dumps({'slug': name})}'",
         "note": "Delete the old relay site with the command above, then set up again from the person's new setup message (guide, step 2)."})

def main(a):
    if not a or a[0] in ("-h", "--help", "help"): print(__doc__); return
    c = a[0]
    if c == "selftest":
        S = bytes(range(32)); k = keys_from(S)
        sig = sign(k["auth"], "POST", "/v1/ask", "1760000000000", b"hello")
        box = seal(k["enc"], b"hi", "pulltab/reply/x"); assert unseal(k["enc"], box, "pulltab/reply/x") == b"hi"
        assert parse_code(k["code"]) == S and parse_code("Pairing code: " + k["code"] + " thanks") == S
        rsig = resp_sig(k["rkey"], 200, sig, b'{"ok":true}')
        got = {"slug": k["slug"], "code": k["code"], "sig": sig, "rsig": rsig}
        bad = [n for n in VECTOR if got[n] != VECTOR[n]]
        if bad: die(f"selftest: {', '.join(bad)} differ from the published test vector; this copy of pulltab.py is wrong")
        res = {"ok": True, "slug": k["slug"], "rsig": rsig, "vector": "matches"}
        if "--whisper" in a:
            t0 = time.time(); model(); res["whisper_ready_s"] = round(time.time() - t0, 1)
        out(res); return
    if c == "init": return cmd_init(a[1:])
    s = load()
    if c == "pending": print(call(s, "GET", "/tab/pending").text); return
    if c == "retire": return cmd_retire(s, a[1:])
    if c == "take":
        # 0.1.9: the relay queues up to 8 requests (FIFO); `next` (or no argument) is the oldest waiting one.
        if len(a) > 1 and a[1] == "latest": die("`take latest` is gone since 0.1.9: requests queue, oldest first. Use `take next` (the oldest) or `take <id>`.")
        rid = req_id(a[1]) if len(a) > 1 and a[1] != "next" else "next"
        p = call(s, "GET", "/tab/pending").json().get("pending", [])
        if not p: die("nothing pending", 3)
        p = sorted(p, key=lambda x: x.get("created_at") or 0)   # oldest first (the relay already sends them in this order)
        row = p[0] if rid == "next" else next((x for x in p if x["id"] == rid), None)
        if not row: die(f"{rid}: gone (cancelled by the person or expired). Do nothing more for it.", 3)
        rid, ts = req_id(row["id"]), int(row.get("client_ts") or 0)
        # Stale or replayed audio is refused: the app's signed time is bound into the audio's encryption, so the relay
        # can't change it. Taken requests are remembered by that time for 30 min (not a high-water mark, which a phone
        # clock that was fast and then corrected would turn into a lockout). A refused request is cleared on the relay.
        now_ms = time.time() * 1000
        taken = [x for x in s.get("taken", []) if now_ms - x[0] < 30 * 60_000]
        def refuse(why):
            call(s, "POST", f"/tab/done/{rid}")
            die(f"{rid}: {why}; not acting on it (cleared on the relay)", 3)
        if now_ms - ts > MAX_AGE_S * 1000: refuse(f"recorded more than {MAX_AGE_S // 60} min ago")
        if any(x[0] == ts and x[1] != rid for x in taken): refuse("already taken (a replay?)")
        r = call(s, "GET", f"/tab/audio/{rid}")
        posted(r, f"audio {rid}")
        try: pcm = unseal(s["_k"]["enc"], r.content, f"pulltab/audio/16000/{ts}")
        except Exception: die("could not decrypt the audio: the glasses are paired with a different code, or the audio was tampered with")
        if not any(x[1] == rid for x in taken): taken.append([ts, rid])
        s["taken"] = taken; s.pop("last_taken", None); save_state(s)
        t0 = time.time()
        try: text, info = transcribe(pcm)
        except Exception as e:
            die(f"transcription failed ({type(e).__name__}: {str(e)[:200]}). Tell your person by message that you couldn't hear it, then run `done {rid}`. Run `selftest --whisper` to check the speech model.")
        del pcm
        out({"ok": True, "id": rid, "transcript": text, "language": info.language, "seconds": round(len(r.content) / 32000, 1), "transcribe_s": round(time.time() - t0, 1)}); return
    if c in ("note", "done", "reply"):
        # 0.1.8: answers go by message, never to the lens, so neither command carries words (any extra words are ignored).
        if len(a) < 2: die(f"usage: pulltab {c} <id>")
        rid = req_id(a[1])
        r = call(s, "POST", f"/tab/{'status' if c == 'note' else 'done'}/{rid}")
        posted(r, c); print(r.text); return
    if c == "health": print(call(s, "GET", "/admin/health", key="admin_key").text); return
    if c == "check":
        # What the app does: a signed /v1/hello straight to the relay, and the relay's signature on the answer.
        import requests
        ts = str(int(time.time() * 1000)); k = s["_k"]; sig = sign(k["auth"], "GET", "/v1/hello", ts)
        r = requests.get(f"{base(s)}/v1/hello", headers={"x-pt-ts": ts, "x-pt-sig": sig}, timeout=30)
        good = hmac.compare_digest(r.headers.get("x-pt-rsig", "").lower(), resp_sig(k["rkey"], r.status_code, sig, r.content))
        out({"ok": r.status_code == 200 and good, "status": r.status_code, "relay_signed": good, "relay": base(s), "answer": r.text[:300]}); return
    if c == "purge": print(call(s, "POST", "/admin/purge", key="admin_key").text); return
    if c == "test-wake": print(call(s, "POST", "/admin/test-wake", key="admin_key").text); return
    if c == "set-mailer":
        kind = a[1] if len(a) > 1 else ""
        if os.environ.get("PULLTAB_WAKE_TO"): s["wake_to"] = os.environ["PULLTAB_WAKE_TO"]
        v = json.loads(os.environ.get("TAB_VAULT") or "null") or {}
        if kind == "smtp":
            if not v.get("username") or not v.get("password"): die("TAB_VAULT needs {username, password}")
            body = {"type": "smtp", "user": v["username"], "pass": v["password"].replace(" ", ""), "from": v["username"], "to": s["wake_to"],
                    "host": os.environ.get("PULLTAB_SMTP_HOST", "smtp.gmail.com"), "port": int(os.environ.get("PULLTAB_SMTP_PORT", "465"))}
            if os.environ.get("PULLTAB_SMTP_TLS") == "off": body["tls"] = "off"
        elif kind == "resend":
            key = v.get("api_key") or v.get("password")
            if not key: die("TAB_VAULT needs {password: <API key>} or {api_key}")
            body = {"type": "resend", "api_key": key, "to": s["wake_to"]}
            if os.environ.get("PULLTAB_MAIL_API_URL"): body["api_url"] = os.environ["PULLTAB_MAIL_API_URL"]
        else: die("usage: pulltab set-mailer smtp|resend")
        print(call(s, "PUT", "/admin/mailer", key="admin_key", json=body).text); return
    print(__doc__)

if __name__ == "__main__":
    main(sys.argv[1:])
