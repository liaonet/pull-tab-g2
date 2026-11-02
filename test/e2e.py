#!/usr/bin/env python3
"""Pull Tab local end-to-end test. Runs only on this machine and sends nothing anywhere (the first run downloads the
speech model once).

  python3 test/e2e.py            (run with a python that has requests, cryptography and faster-whisper)

It starts the rig (test/rig/rig.sh): stub SMTP, the site/ folder served as pulltab.sites.tab.bot would serve it, the
relay under `wrangler dev`, netsim (a logging pass-through to the relay that can also play an impostor relay), and the
Even simulator running a test build of the app pointed at the local relay. 0.1.6: there is no switchboard; the app calls
the relay directly and checks the relay's signature on every answer. It pairs, asks, cancels, and checks each step. 0.1.8:
the Tab answers by message, never on the lens: the app shows "Sent, reply coming by <channel>." for 8 s and goes dark.
0.1.9: the relay queues up to 8 requests (FIFO); a 9th upload is refused and the lens says "8 questions waiting.".
0.1.10: no "Check connection" button: the phone screen checks once on open and once on each return to it (no polling);
every button is white; "Reset pairing" is a small link (F1, tapped for real with xdotool); the help is three points.
Needs test/rig/q.pcm (16 kHz mono s16le speech; kept out of git) and xdotool (taps "Reset pairing" on the phone). Results go to test/local-e2e-results.json.
"""
import hashlib, json, os, re, subprocess, sys, tempfile, time, requests, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[1]
RIG = ROOT / "test" / "rig"; APP = ROOT / "app"; PY = sys.executable
TOOL = str(ROOT / "site" / "files" / "pulltab.py")
DOCS, RELAY, NET, SIM = "http://127.0.0.1:8790", "http://127.0.0.1:8787", "http://127.0.0.1:8788", "http://127.0.0.1:9898"
ENV = dict(os.environ, PULLTAB_HOME=str(RIG / "relayhome"), PULLTAB_BASE=RELAY,
           PULLTAB_SMTP_HOST="127.0.0.1", PULLTAB_SMTP_PORT="2525", PULLTAB_SMTP_TLS="off",
           TAB_VAULT=json.dumps({"username": "stubuser", "password": "stubpass-not-real"}))
results, fails = {}, []

def check(name, ok, detail=""):
    results[name] = {"ok": bool(ok), "detail": detail}
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)
    if not ok: fails.append(name)
def sh(*a, env=None, timeout=300):
    r = subprocess.run(a, capture_output=True, text=True, env=env or ENV, timeout=timeout)
    return r.returncode, r.stdout.strip(), r.stderr.strip()
def tool(*a):
    rc, out, err = sh(PY, TOOL, *a)
    try: return json.loads(out)
    except Exception: return {"rc": rc, "out": out[-400:], "err": err[-400:]}
def wait_http(url, secs=90):
    t = time.time()
    while time.time() - t < secs:
        try: requests.get(url, timeout=3); return True
        except Exception: time.sleep(1)
    return False
cid = 0
def console():
    global cid
    j = requests.get(f"{SIM}/api/console", params={"since_id": cid}, timeout=5).json()
    entries = j if isinstance(j, list) else j.get("entries", j.get("logs", []))
    for e in entries: cid = max(cid, e.get("id", cid))
    return [e.get("message", e.get("text", "")) for e in entries]
logs = []
def pump(): logs.extend(console())
def lens_now():
    pump()
    for m in reversed(logs):
        i = m.find("lens: ")
        if "[pull-tab]" in m and i >= 0:
            try: return json.loads(m[i + 6:])
            except Exception: return m[i + 6:]
    return None
def wait_lens(pred, secs=30):
    t = time.time(); last = None
    while time.time() - t < secs:
        last = lens_now()
        if last is not None and pred(last): return True, last
        time.sleep(0.3)
    return False, last
def press(action): requests.post(f"{SIM}/api/input", json={"action": action}, timeout=5)
def tri(): press("click"); time.sleep(0.12); press("double_click")   # 0.1.13: a triple tap (split 1+2, as the glasses may send it)
def lens_after(mark):          # every lens text the app showed since logs[mark]
    pump(); out = []
    for m in logs[mark:]:
        i = m.find("lens: ")
        if "[pull-tab]" in m and i >= 0:
            try: out.append(json.loads(m[i + 6:]))
            except Exception: out.append(m[i + 6:])
    return out
def sb_requests(pat=r"^(GET|POST|OPTIONS) "):   # requests the app has sent toward its relay (netsim's log)
    try: return len(re.findall(pat, (RIG / "netsim.requests").read_text(), re.M))
    except FileNotFoundError: return -1
ASKS = r"^POST /v1/ask "
def netmode(m): (RIG / "netsim.mode").write_text(m + "\n")
def snap(name):
    shot = requests.get(f"{SIM}/api/screenshot/glasses", timeout=10)
    if shot.ok: (ROOT / "test" / "shots").mkdir(exist_ok=True); (ROOT / "test" / "shots" / name).write_bytes(shot.content)
def sha(b): return hashlib.sha256(b).hexdigest()
# 0.1.7: synthetic system overlay events (4 = a notification / system menu / exit dialog opened, 5 = closed). Test builds
# only: e2e adds a hook to dist-test/index.html that polls inj.json and hands each event to the SDK as the host would.
INJ_HOOK = ("<script>(function(){var seen=0;function p(){fetch('inj.json?'+Date.now(),{cache:'no-store'}).then(function(r){return r.json()})"
            ".then(function(j){if(j.seq>seen){seen=j.seq;j.events.forEach(function(t){"
            "if(t==='resume'){console.log('[pt-test] inject resume');window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));return;}"
            "if(t==='probe'){var r=document.getElementById('reset');r.scrollIntoView({block:'center'});var b=r.getBoundingClientRect(),m=document.getElementById('msg').value,"
            "i=m.indexOf('Pairing code: ');console.log('[pt-test] probe '+JSON.stringify({reset:r.textContent,x:b.left+b.width/2,y:b.top+b.height/2,"
            "discord:(document.getElementById('discord')||{}).textContent,dvis:!!(document.getElementById('discord')&&document.getElementById('discord').offsetParent),"
            "join:(document.getElementById('joinline')||{}).textContent,jhref:(document.getElementById('join')||{}).href,jvis:!!(document.getElementById('join')&&document.getElementById('join').offsetParent),"
            "setup:document.getElementById('setup').style.display,state:document.getElementById('state').textContent,code:m.substr(i+14,16)}));return;}"
            "console.log('[pt-test] inject overlay '+t);"
            "if(window._listenEvenAppMessage)window._listenEvenAppMessage({method:'evenHubEvent',data:{type:'sysEvent',jsonData:{eventType:t}}});});}})"
            ".catch(function(){}).then(function(){setTimeout(p,150)});}setTimeout(p,150);})();</script>")
inj_seq = 0
def overlay(*types, settle=0.8):
    global inj_seq; inj_seq += 1
    (APP / "dist-test" / "inj.json").write_text(json.dumps({"seq": inj_seq, "events": list(types)})); time.sleep(settle)
def ov_handled(mark):          # overlay events the app handled since logs[mark]
    pump(); return [m for m in logs[mark:] if "[pull-tab] system overlay" in m or "[pull-tab] exit dialog opened" in m]
def body(t): return t.split("\n", 1)[1] if isinstance(t, str) and "\n" in t else t
def lens_changes(mark, before):  # lens writes since logs[mark] that change what it shows (a minute-clock redraw doesn't count)
    return [t for t in lens_after(mark) if body(t) != body(before)]
STATUS_RE = re.compile(r"^(?:(\d{2}):(\d{2})|(\d{1,2}):(\d{2})([ap]m))  (Sun|Mon|Tue|Wed|Thu|Fri|Sat) (\d{1,2}) "
                       r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:  \|  (?:Glasses \d{1,3}%)?(?:  )?(?:Ring \d{1,3}%)?)?$")
def status_minutes_off(m):     # minutes between the lens clock and this machine's local clock (the simulator's)
    if m.group(1): h, mi = int(m.group(1)), int(m.group(2))
    else: h, mi = int(m.group(3)) % 12 + (12 if m.group(5) == "pm" else 0), int(m.group(4))
    now = time.localtime(); d = abs((h * 60 + mi) - (now.tm_hour * 60 + now.tm_min))
    return min(d, 1440 - d)
def phone_resume():
    # 0.1.10: the person comes back to the phone screen (e.g. from their chat with Tab). The hook fires the window's blur
    # then focus, as the phone does on a return; the app runs its one signed check. True once the app logged it.
    mark = len(logs); overlay("resume", settle=0.3)
    t = time.time()
    while time.time() - t < 5:
        pump()
        if any("status check on resume" in m for m in logs[mark:]): return True
        time.sleep(0.2)
    return False
def probe():
    # what the phone screen shows now (test builds only; the hook scrolls the Reset pairing link into view and reports it)
    mark = len(logs); overlay("probe", settle=0.4)
    for _ in range(20):
        pump()
        for m in logs[mark:]:
            i = m.find("[pt-test] probe ")
            if i >= 0: return json.loads(m[i + 16:])
        time.sleep(0.2)
    return {}
def phone_shot(name):
    png = requests.get(f"{SIM}/api/screenshot/webview", timeout=15).content
    (ROOT / "test" / "shots").mkdir(exist_ok=True); (ROOT / "test" / "shots" / name).write_bytes(png); return png
def phone_tap(x, y):
    # a real tap on the phone screen (needs xdotool; the simulator's phone webview is the X window "Browser" on :77)
    env = dict(os.environ, DISPLAY=":77")
    win = subprocess.run(["xdotool", "search", "--name", "^Browser$"], capture_output=True, text=True, env=env).stdout.split()
    if not win: return False
    subprocess.run(["xdotool", "mousemove", "--window", win[0], str(int(x)), str(int(y)), "click", "1"], env=env); return True
def button_rows(png):
    # rows where a full-width button crosses x=30 and x=570: white (244) or the old dark grey (35, 0.1.9's .sec)
    from PIL import Image; import io, numpy as np
    a = np.array(Image.open(io.BytesIO(png)).convert("RGB")).astype(int)
    row = lambda c: int(((a[:, 30] == c).all(1) & (a[:, 570] == c).all(1)).sum())
    return row([244, 244, 244]), row([35, 35, 35])
FILES = {"setup.md": "/setup.md", "pulltab.py": "/files/pulltab.py", "relay-worker.template.mjs": "/files/relay-worker.template.mjs"}

def main():
    sh("bash", str(RIG / "rig.sh"), "stop")
    for d in ["relayhome", "outbox", ".wrangler"]: subprocess.run(["rm", "-rf", str(RIG / d)])
    (RIG / "outbox").mkdir()
    pcm = RIG / "q.pcm"
    if not pcm.exists(): sys.exit("need test/rig/q.pcm (16 kHz mono s16le speech)")
    version = json.loads((APP / "app.json").read_text())["version"]
    # real build (what ships): wildcard whitelist only, no test relay, no switchboard
    wl = json.loads((APP / "app.json").read_text())["permissions"][0]["whitelist"]
    check("whitelist_is_the_0_1_11_list", wl == ["https://*.sites.tab.bot", "https://pulltab.sites.tab.bot", "https://discord.gg", "https://tab.bot"], str(wl))   # relays + help links
    rc = subprocess.run("npx vite build", shell=True, cwd=APP, capture_output=True, text=True, env={k: v for k, v in os.environ.items() if not k.startswith("PT_")}).returncode
    js = "".join(p.read_text() for p in (APP / "dist" / "assets").glob("*.js")) if rc == 0 else ""
    check("real_build", rc == 0 and ".sites.tab.bot" in js)
    check("real_build_has_no_switchboard_or_test_relay", js and not re.search(r"workers\.dev|127\.0\.0\.1|localhost|/r/pt-", js), "")
    check("real_build_guide_on_sites_tab_bot", "https://pulltab.sites.tab.bot" in js)
    rc = subprocess.run("PT_TEST_RELAY=x npx vite build", shell=True, cwd=APP, capture_output=True, text=True).returncode
    check("test_relay_refused_in_real_build", rc != 0)
    # the test build (local relay via netsim + test audio)
    rc = subprocess.run("npx vite build", shell=True, cwd=APP, capture_output=True, text=True,
                        env=dict(os.environ, PT_TEST_RELAY=NET, PT_DOCS=DOCS, PT_TEST_AUDIO="q.pcm", PT_OUT="dist-test")).returncode
    check("test_build", rc == 0)
    subprocess.run(["cp", str(pcm), str(APP / "dist-test" / "q.pcm")])
    ix = APP / "dist-test" / "index.html"; ix.write_text(ix.read_text().replace("</body>", INJ_HOOK + "</body>", 1))
    (APP / "dist-test" / "inj.json").write_text(json.dumps({"seq": 0, "events": []}))
    check("test_build_overlay_hook", INJ_HOOK in ix.read_text())
    sh("bash", str(RIG / "rig.sh"), "base", env=dict(ENV, PT_PY=PY))
    check("docs_up", wait_http(DOCS + "/"))
    check("simulator_up", wait_http(SIM + "/api/ping"))

    # the docs site (site/, to be served at pulltab.sites.tab.bot): pages and downloads; static only, no server code
    for p in ["/", "/setup/", "/setup.md", "/privacy/", "/files/pulltab.py", "/files/relay-worker.template.mjs"]:
        r = requests.get(DOCS + p); check("docs_get " + p, r.status_code == 200, str(r.status_code))
    check("guide_points_at_sites_tab_bot", "https://pulltab.sites.tab.bot/setup" in requests.get(DOCS + "/setup.md").text)
    server = [str(x.relative_to(ROOT)) for x in (ROOT / "site").rglob("*") if x.name in ("worker.mjs", "worker.js", "_worker.js", "_worker.mjs", "index.mjs", "tab-site.json", "wrangler.toml", "pages.py")]
    check("docs_site_is_static_only", not server, str(server))
    texts = {str(x.relative_to(ROOT)): x.read_text() for x in [*ROOT.glob("site/**/*.*"), APP / "index.html", APP / "app.json", APP / "src" / "main.ts", *ROOT.glob("listing/*.txt"), *ROOT.glob("listing/*.json")] if x.suffix in (".md", ".html", ".py", ".mjs", ".txt", ".json", ".ts")}
    stale = [n for n, t in texts.items() if re.search(r"workers\.dev|/r/pt-|PULLTAB_SWITCHBOARD", t)]
    check("no_switchboard_address_in_shipped_files", not stale, str(stale))

    # app boots unpaired, shows the version on the launch hint
    ok, lens = wait_lens(lambda t: "Not connected" in t, 60)
    check("lens_unpaired_hint", ok, repr(lens)[:120])
    check("lens_unpaired_double_tap_exit_line", ok and "send the setup message to your Tab.\n\nDouble-tap to exit." in lens, repr(lens)[-60:])
    first, _, rest = (lens or "").partition("\n")
    check("lens_shows_version", ok and rest.startswith(f"Pull Tab v{version}"), repr(lens)[:60])
    # status line on top of every lit screen: time and date from the phone clock, battery from the Even app (0.1.3)
    m = STATUS_RE.match(first)
    check("lens_status_line_format", bool(m), repr(first))
    check("lens_status_time_is_now", bool(m) and status_minutes_off(m) <= 2, repr(first))
    check("lens_status_glasses_battery", bool(m) and bool(re.search(r"\|  Glasses ([1-9]\d?|100)%", first)), repr(first))
    check("lens_status_no_ring_from_glasses_info", "Ring" not in first, repr(first))
    # the status line redraws on the minute while the lens is lit, with no input
    mark = len(logs); t_next = 60 - time.time() % 60
    time.sleep(t_next + 4); pump()
    later = [t for t in lens_after(mark) if STATUS_RE.match(t.partition("\n")[0])]
    check("lens_status_redraws_on_minute", bool(later) and later[-1].partition("\n")[0] != first and "Not connected" in later[-1],
          f"{len(later)} redraws, {repr(later[-1].partition(chr(10))[0]) if later else ''}")
    snap("10_unpaired_hint.png")
    setup = next((m.split("TEST-ONLY setup message:", 1)[1].strip() for m in logs if "TEST-ONLY setup message:" in m), "")
    check("setup_message", "PT1-" in setup and f"Guide: {DOCS}/setup.md " in setup, setup[:60] + "...")
    # 0.1.10: no button; the phone screen checked on its own when it opened (one signed hello, nobody tapped anything;
    # with no relay yet only the browser's preflight for it reaches netsim)
    pump(); opened = [m for m in logs if "status check on" in m]
    check("phone_auto_status_on_open", len(opened) == 1 and "status check on open" in opened[0] and any("phone: Checking connection..." in m for m in logs)
          and sb_requests(r"^(GET|OPTIONS) /v1/hello ") >= 1, f"{[m[-22:] for m in opened]}, hello attempts {sb_requests(r'^(GET|OPTIONS) /v1/hello ')}")
    check("unpublished_relay_phone_says_not_yet", any("phone: Not connected yet." in m for m in logs), "")
    # 0.1.10 phone screen: no Check connection button, every button white, Reset pairing a small link, help in 3 points
    ix = (APP / "dist-test" / "index.html").read_text()
    check("phone_no_check_connection_button", "Check connection" not in ix and not re.search(r'id="check2?"', ix) and "Check connection" not in (APP / "src" / "main.ts").read_text().split("// ---------- phone screen")[1], "")
    btns = re.findall(r"<button([^>]*)>([^<]*)</button>", ix)
    check("phone_buttons_all_white", btns and all("class" not in a for a, _ in btns) and ".sec" not in ix and re.search(r"button\{color:#111;background:#f4f4f4", ix) is not None, str([t for _, t in btns]))
    check("phone_reset_is_small_link", re.search(r'<a class="link" id="reset" href="#" role="button">Reset pairing</a>', ix) is not None and "Make a new pairing code" not in ix, "")
    helps = re.findall(r"<li>(.*?)</li>", ix.split('<ol id="help">')[1].split("</ol>")[0]) if '<ol id="help">' in ix else []
    check("phone_help_three_points", helps == ["Triple Tap to Listen, Send / Cancel",
          "Tab will reply by Text or WhatsApp (turn on notifications for your glasses)",   # the exact approved wording
          "Double Tap to Exit"], str(helps))
    # 0.1.10: a permanent "Get help on Discord" link on the phone screen, apart from the 3 help points
    check("phone_discord_help_link", re.search(r'<a class="link" id="discord" href="https://discord\.gg/j4kBHPkvC8" target="_blank" rel="noopener">Get help on Discord</a>', ix) is not None
          and "discord" not in ix.split('<ol id="help">')[1].split("</ol>")[0] and ix.index('id="discord"') > ix.index('id="connected"'), "")
    # 0.1.10: "Not a TAB member? Join here" under the Discord link, "Join here" to a Tab invite, not a help point
    INVITE = "https://tab.bot/r/F97BF7357521A088"
    check("phone_join_invite_link", re.search(r'<p class="join" id="joinline">Not a TAB member\? <a id="join" href="https://tab\.bot/r/F97BF7357521A088" target="_blank" rel="noopener">Join here</a></p>', ix) is not None
          and "tab.bot/r/" not in ix.split('<ol id="help">')[1].split("</ol>")[0] and ix.index('id="discord"') < ix.index('id="joinline"') < ix.index('id="reset"'), "")
    check("site_join_invite_link", f'<p>Not a TAB member? <a href="{INVITE}">Join here</a></p>' in (ROOT / "site" / "index.html").read_text(), "")
    png = phone_shot("phone-unpaired-0.1.10.png"); w, dark = button_rows(png)
    check("phone_screen_buttons_render_white", w > 30 and dark == 0, f"white rows {w}, dark rows {dark}")

    # no demo: no shipped text mentions one
    shipped = ["app/src/main.ts", "app/index.html", "site/index.html", "site/setup.md",
               "site/privacy.md", "site/privacy/index.html", "site/setup/index.html",
               "listing/description.txt", "listing/listing.json"]
    hits = [p for p in shipped if re.search(r"demo", (ROOT / p).read_text(), re.I)]
    check("no_demo_anywhere", not hits, str(hits))
    # before pairing, a double-tap to talk shows one line, opens no mic and sends nothing (0.1.5: double-tap = talk)
    before, mark = sb_requests(), len(logs)
    tri()
    ok, lens = wait_lens(lambda t: "Set up Pull Tab on your phone first" in t, 10); check("unpaired_triple_tap_shows_setup_line", ok, repr(lens)[:80])
    snap("11_unpaired_double_tap.png")
    press("click"); time.sleep(1.0)              # a tap clears the line (back to the setup hint)
    tri(); time.sleep(1.5)                   # triple-tap to talk again
    shown = lens_after(mark)
    check("unpaired_triple_tap_again_shows_setup_line", sum("Set up Pull Tab on your phone first" in t for t in shown) >= 2, str(len(shown)))
    check("unpaired_no_mic", not any("listening" in t or "Sending" in t for t in shown), str(shown)[:120])
    time.sleep(1.0); check("unpaired_sends_nothing", sb_requests() == before, f"{before} -> {sb_requests()}")
    ok, lens = wait_lens(lambda t: "Not connected" in t, 15); check("unpaired_back_to_setup_hint", ok, repr(lens)[:80])

    # file fingerprints: the setup message carries the SHA-256 of every file a Tab downloads
    fps = dict(re.findall(r"(setup\.md|pulltab\.py|relay-worker\.template\.mjs) ([0-9a-f]{64})", setup))
    served = {n: sha(requests.get(DOCS + p).content) for n, p in FILES.items()}
    check("setup_message_fingerprints_match_served_files", set(fps) == set(FILES) and fps == served, str({n: fps.get(n, "")[:8] for n in FILES}))
    check("setup_message_length", len(setup) < 520, str(len(setup)))
    # the guide's step 1, run as written (pointed at the local docs site and a scratch folder)
    guide = (ROOT / "site/setup.md").read_text()
    block = guide[guide.index("    mkdir -p /home/user/tab/state/pull-tab-relay/bin"):]
    block = "\n".join(l[4:] for l in block[: block.index("\n    EOF\n") + 9].splitlines())
    tmp = tempfile.mkdtemp(prefix="pt-guide-")
    block = block.replace("https://pulltab.sites.tab.bot", DOCS).replace("/home/user/tab/state/pull-tab-relay/bin", tmp)
    for n in FILES: block = block.replace(f"<{n} fingerprint from the message>", fps.get(n, "0" * 64))
    rc, out, err = sh("bash", "-c", "set -e\n" + block)
    check("guide_step1_check_passes", rc == 0 and out.count(": OK") == 3, (out + err)[-160:])
    with open(os.path.join(tmp, "relay-worker.template.mjs"), "a") as f: f.write("\n// tampered\n")
    check_only = block[block.index("sha256sum -c"):]
    rc, out, err = sh("bash", "-c", f"cd {tmp}\n" + check_only)
    check("guide_step1_check_refuses_tampered_file", rc != 0 and "relay-worker.template.mjs: FAILED" in out, (out + err)[-160:])
    bad = re.sub(r"(pulltab\.py )[0-9a-f]{64}", lambda m: m.group(1) + "0" * 64, setup)
    j = tool("init", bad, "--to", "test+pulltab@example.invalid", "--reply-by", "whatsapp")
    check("init_refuses_fingerprint_mismatch", j.get("ok") is False and "does not match" in j.get("error", ""), str(j)[:120])
    check("init_refusal_writes_nothing", not (RIG / "relayhome" / "state.json").exists())

    # the Tab's side: init, run the relay, mailer, check the relay directly (signed both ways)
    nofp = re.sub(r" Check SHA-256.*$", "", setup)   # 0.1.8 (audit F4): a message without the fingerprints is refused
    j = tool("init", nofp, "--to", "test+pulltab@example.invalid", "--reply-by", "whatsapp")
    check("init_refuses_message_without_fingerprints", j.get("ok") is False and "no SHA-256 fingerprint" in j.get("error", "") and not (RIG / "relayhome" / "state.json").exists(), str(j)[:120])
    # 0.1.8: the Tab sets the channel word at install (the channel its person uses most): here WhatsApp
    j = tool("init", setup, "--to", "test+pulltab@example.invalid", "--reply-by", "whatsapp"); check("tab_init", j.get("ok") is True and j.get("reply_by") == "WhatsApp", j.get("slug", str(j)))
    sh("bash", str(RIG / "rig.sh"), "relay")
    check("relay_up", wait_http(RELAY + "/v1/hello"))
    j = tool("set-mailer", "smtp"); check("tab_set_mailer", j.get("ok") is True, str(j)[:120])
    j = tool("check"); check("tab_check_direct_relay_signed", j.get("ok") is True and j.get("relay_signed") is True, str(j)[:160])
    # 0.1.10: the person comes back to the phone screen once their Tab says it's ready: it checks by itself, says
    # "Connected to your Tab." and the lens shows how to talk (no button)
    hello0 = sb_requests(r"^GET /v1/hello ")
    check("phone_resume_checks_once", phone_resume() and (time.sleep(2.0) or True) and sb_requests(r"^GET /v1/hello ") == hello0 + 1, f"hellos +{sb_requests(r'^GET /v1/hello ') - hello0}")
    ok, lens = wait_lens(lambda t: "Triple-tap to listen, send / cancel." in t, 20); check("app_paired_after_resume", ok, repr(lens)[:80])
    pump(); check("phone_says_connected_to_your_tab", any("phone: Connected to your Tab." in m for m in logs), "")
    if os.environ.get("PT_E2E_EXIT_REC"):
        # 0.1.13: a double-tap during a recording throws it away (mic closed, nothing sent), then raises the exit menu
        time.sleep(6.5); wait_lens(lambda t: t.strip() == "", 12)
        asks0 = sb_requests(ASKS); mails0 = len(list((RIG / "outbox").glob("*.eml")))
        tri(); okl, _ = wait_lens(lambda t: "listening" in t, 10); time.sleep(3.0); mark = len(logs)
        press("double_click"); time.sleep(3.0); pump(); seen = logs[mark:]
        check("double_tap_exit_discards_recording_sends_nothing", okl and any("recording discarded, not sent: double-tap exit" in m for m in seen)
              and sb_requests(ASKS) == asks0 and len(list((RIG / "outbox").glob("*.eml"))) == mails0 and tool("pending").get("pending", None) == []
              and not any("Sending" in t or "Sent, reply" in t for t in lens_after(mark)), str([m[:60] for m in seen if "discard" in m or "exit" in m])[:160])
        check("double_tap_during_recording_opens_exit_menu", any("exit dialog requested double-tap" in m for m in seen) and any("exit dialog call returned true" in m for m in seen), "")
        return
    time.sleep(6.5)                              # let the hint clear itself
    pump(); check("app_called_relay_directly", re.search(r"^GET /v1/hello ", (RIG / "netsim.requests").read_text(), re.M) is not None
                    and any("phone: Connected to your Tab." in m for m in logs), "")

    # 0.1.6 key pinning: an answer not signed by the paired relay's key (another *.sites.tab.bot site) is refused
    import importlib.util
    spec = importlib.util.spec_from_file_location("pt", TOOL); pt = importlib.util.module_from_spec(spec)
    os.environ.update({k: v for k, v in ENV.items() if k.startswith("PULLTAB_")}); spec.loader.exec_module(pt)
    st = pt.load(); k = st["_k"]
    ts = str(int(time.time() * 1000)); sg = pt.sign(k["auth"], "GET", "/v1/hello", ts)
    r = requests.get(f"{RELAY}/v1/hello", headers={"x-pt-ts": ts, "x-pt-sig": sg, "origin": "http://127.0.0.1:5180"})
    check("relay_signs_hello", r.ok and r.headers.get("x-pt-rsig") == pt.resp_sig(k["rkey"], 200, sg, r.content), r.headers.get("x-pt-rsig", "none")[:12])
    check("relay_exposes_signature_to_app", "x-pt-rsig" in r.headers.get("access-control-expose-headers", "").lower() and r.headers.get("access-control-allow-origin") == "*",
          r.headers.get("access-control-expose-headers", ""))
    r = requests.options(f"{RELAY}/v1/hello", headers={"origin": "http://127.0.0.1:5180", "access-control-request-method": "POST", "access-control-request-headers": "x-pt-ts,x-pt-sig,content-type"})
    check("relay_preflight_allows_app", r.status_code == 204 and "x-pt-sig" in r.headers.get("access-control-allow-headers", "").lower(), str(r.status_code))
    for mode in ["impostor", "strip"]:
        netmode(mode); mark = len(logs)
        check(f"pin_{mode}_resume_checked", phone_resume())
        time.sleep(3.0); pump()
        check(f"pin_{mode}_refused_on_phone", any("phone: That relay didn't prove it's yours" in m for m in logs[mark:]) and any("not signed by the paired relay" in m for m in logs[mark:]),
              str([m[:60] for m in logs[mark:] if "phone:" in m])[:160])
        asks0 = sb_requests(ASKS); mark = len(logs)
        tri(); ok, lens = wait_lens(lambda t: "Set up Pull Tab on your phone first" in t, 10)
        time.sleep(1.5)
        check(f"pin_{mode}_unpaired_no_mic_no_send", ok and not any("listening" in t for t in lens_after(mark)) and sb_requests(ASKS) == asks0, repr(lens)[:60])
        netmode("pass"); press("click"); time.sleep(1.0)
        check(f"pin_{mode}_resume_checked_again", phone_resume())
        ok, lens = wait_lens(lambda t: "Triple-tap to listen, send / cancel." in t, 20); check(f"pin_{mode}_real_relay_paired_again", ok, repr(lens)[:80])
        time.sleep(6.5)
    # an impostor that answers an ask (the audio is sealed, it can't open it): the lens says so, nothing is shown as an answer
    tri(); ok, lens = wait_lens(lambda t: "listening" in t, 10); time.sleep(2.5)
    netmode("impostor"); mark = len(logs); tri()
    ok, lens = wait_lens(lambda t: "isn't your relay" in t, 15)
    check("pin_impostor_ask_refused_on_lens", ok and not any("Sent, reply coming" in t for t in lens_after(mark)), repr(lens)[:80])
    netmode("pass"); requests.post(f"{RELAY}/admin/purge", headers={"authorization": "Bearer " + st["admin_key"]})
    time.sleep(1.0); press("click"); time.sleep(1.0)
    check("pin_ask_resume_checked", phone_resume())
    ok, lens = wait_lens(lambda t: "Triple-tap to listen, send / cancel." in t, 20); check("pin_ask_real_relay_paired_again", ok, repr(lens)[:80])
    time.sleep(6.5)

    # gestures (0.1.13 map: triple-tap records, sends and cancels what was sent; double-tap exits; a single tap shows the hint)
    # a single tap on a dark lens only shows the hint: no mic, nothing sent
    asks0 = sb_requests(ASKS); mark = len(logs)
    press("click"); time.sleep(1.8)
    shown = lens_after(mark)
    check("single_tap_dark_lens_only_hint", any("Triple-tap to listen" in t for t in shown) and not any("listening" in t for t in shown) and sb_requests(ASKS) == asks0, str(shown)[:120])
    time.sleep(6.5)                              # let the hint clear itself
    # 0.1.13: a triple tap from a dark lens, however the glasses split it, starts a recording; a second triple-tap under
    # 1 s later sends nothing ("too short")
    for name, seq in [("1+1+1", ["click", "click", "click"]), ("2+1", ["double_click", "click"]), ("1+2", ["click", "double_click"])]:
        mark = len(logs)
        for i, a in enumerate(seq):
            press(a)
            if i < len(seq) - 1: time.sleep(0.15)
        okl, _ = wait_lens(lambda t: "listening" in t, 10); time.sleep(0.2); tri()
        okt, _ = wait_lens(lambda t: "too short" in t, 6); time.sleep(1.0); press("click"); time.sleep(1.0)
        check(f"triple_tap_{name}_from_dark_starts_then_short_sends_nothing", okl and okt and sb_requests(ASKS) == asks0, f"asks +{sb_requests(ASKS) - asks0}")
    time.sleep(1.0)
    # 0.1.13 (triple-tap records, then sends, and if needed cancels; double-tap exits): a triple-tap starts a recording
    # at once
    asks0, mails0 = sb_requests(ASKS), len(list((RIG / "outbox").glob("*.eml")))
    mark = len(logs); tri()
    ok, lens = wait_lens(lambda t: "listening" in t, 10)
    check("triple_tap_starts_listening", ok, repr(lens)[:60])
    check("listening_text_approved", ok and "Triple-tap to send.\nDouble-tap to exit." in lens, repr(lens)[:90])
    snap("listening-0.1.7.png")
    # a single tap while recording does nothing: no send, still recording; nor do two slow single taps
    time.sleep(2.0); mark = len(logs)
    press("click"); time.sleep(1.6)
    pump(); seen = logs[mark:]
    check("single_tap_while_recording_ignored", any("single tap while recording: ignored" in m for m in seen) and sb_requests(ASKS) == asks0
          and not any("Sending" in t or "Sent, reply" in t or "Cancelled" in t for t in lens_after(mark)) and "listening" in (lens_now() or ""), str([m[:60] for m in seen if "tap" in m])[:160])
    mark = len(logs); press("click"); time.sleep(1.1); press("click"); time.sleep(1.6)
    pump(); seen = logs[mark:]
    check("two_slow_single_taps_while_recording_ignored", sum("single tap while recording: ignored" in m for m in seen) == 2 and sb_requests(ASKS) == asks0
          and "listening" in (lens_now() or ""), str([m[:60] for m in seen if "tap" in m])[:160])
    # 0.1.13: a triple-tap sends, at once
    mark = len(logs)
    tri(); t0 = time.time()
    ok, lens = wait_lens(lambda t: "Sent, reply coming by" in t, 30); took = time.time() - t0
    check("triple_tap_sends_once", ok and sb_requests(ASKS) == asks0 + 1, f"{took:.2f}s, asks {sb_requests(ASKS) - asks0}")
    # 0.1.8 (answers never on the lens): "Sent, reply coming by WhatsApp." / "Triple-tap to cancel." for 8 s, then dark
    t_sent = time.time()
    check("sent_screen_text_whatsapp", ok and body(lens) == "Pull Tab\n\nSent, reply coming by WhatsApp.\nTriple-tap to cancel.", repr(lens)[-80:])
    snap("sent-0.1.8.png")
    ok, lens = wait_lens(lambda t: t.strip() == "", 12); dark_after = time.time() - t_sent
    check("sent_screen_dark_after_8s", ok and 7.0 <= dark_after <= 9.5, f"{dark_after:.1f}s")
    pend = []
    for _ in range(30):
        pend = tool("pending").get("pending", [])
        if pend: break
        time.sleep(1)
    rid = pend[0]["id"] if pend else "latest"
    check("dark_after_sent_request_still_on_relay", len(pend) == 1, str(pend)[:80])
    j = tool("take", rid); check("triple_tap_send_audio_heard", bool(j.get("transcript")), repr(j.get("transcript", j))[:80])
    mark = len(logs)
    j = tool("done", rid); check("tab_done_clears_request", j.get("ok") is True and tool("pending").get("pending", None) == [], str(j)[:80])
    time.sleep(3.0)
    check("nothing_on_lens_after_tab_answers", lens_after(mark) == [] and (lens_now() or "").strip() == "", str(lens_after(mark))[:80])
    check("no_answer_gets", sb_requests(r"^GET /v1/reply") == 0 and sb_requests(r"^GET ") == sb_requests(r"^GET /v1/hello "), f"{sb_requests(r'^GET ')} GETs")
    # a send within 1 s of the recording sends nothing: "too short"
    asks0 = sb_requests(ASKS)
    tri(); ok, lens = wait_lens(lambda t: "listening" in t, 10); time.sleep(0.2); tri()
    ok, lens = wait_lens(lambda t: "too short" in t, 6)
    check("send_under_1s_sends_nothing", ok and sb_requests(ASKS) == asks0, repr(lens)[:60])
    press("click"); time.sleep(1.0)

    # 0.1.7 overlay fix (seen on real glasses: the lens lit with no tap, every time on eventType 4): a system overlay
    # opening (4) / closing (5) never lights the lens or shows the hint, and never touches a recording, wait or tap burst
    asks0, req0 = sb_requests(ASKS), sb_requests(); mark = len(logs); before = lens_now()
    overlay(4, 5, settle=2.5)
    check("overlay_on_dark_lens_lights_nothing", len(ov_handled(mark)) == 2 and (before or " ").strip() == "" and lens_changes(mark, before) == []
          and sb_requests() == req0, str(ov_handled(mark))[:80] + str(lens_changes(mark, before))[:80])
    mark = len(logs); req0 = sb_requests()
    overlay(*([4, 5] * 10), settle=3.0)
    check("ten_overlays_light_nothing", len(ov_handled(mark)) == 20 and lens_changes(mark, before) == [] and sb_requests() == req0,
          f"{len(ov_handled(mark))} handled, {lens_changes(mark, before)[:2]}")
    # during a recording: the lens is untouched, the recording carries on, and a triple-tap then sends it once
    tri(); ok, before = wait_lens(lambda t: "listening" in t, 10)
    time.sleep(1.5); mark = len(logs)
    overlay(4, settle=1.2); overlay(5, settle=1.5)
    pump(); seen = logs[mark:]
    check("overlay_during_recording_untouched", ok and len(ov_handled(mark)) == 2 and lens_changes(mark, before) == []
          and not any("discarded" in m or "aborted" in m for m in seen) and "listening" in (lens_now() or ""), str(lens_changes(mark, before))[:120])
    asks0 = sb_requests(ASKS); mark = len(logs)
    tri(); time.sleep(0.25); overlay(4, 5, settle=0.2)   # an overlay inside the triple-tap send
    ok, lens = wait_lens(lambda t: "Sent, reply coming by" in t, 30); t_sent = time.time()
    check("overlay_inside_send_window_send_still_goes_once", ok and sb_requests(ASKS) == asks0 + 1 and len(ov_handled(mark)) == 2, f"asks +{sb_requests(ASKS) - asks0}")
    # 0.1.8: on the "Sent" screen an overlay leaves it untouched, cancels nothing, and it still goes dark at 8 s
    before = lens; mark = len(logs); canc0 = sb_requests(r"^POST /v1/(ack|cancel)")
    overlay(4, 5, settle=1.5)
    check("overlay_on_sent_screen_untouched_no_cancel", ok and len(ov_handled(mark)) == 2 and lens_changes(mark, before) == []
          and sb_requests(r"^POST /v1/(ack|cancel)") == canc0 and not any("aborted" in m for m in logs[mark:]), str(lens_changes(mark, before))[:120])
    ok, lens = wait_lens(lambda t: t.strip() == "", 12); dark_after = time.time() - t_sent
    check("sent_screen_dark_after_8s_despite_overlay", ok and dark_after <= 9.5, f"{dark_after:.1f}s")
    pend = []
    for _ in range(30):
        pend = tool("pending").get("pending", [])
        if pend: break
        time.sleep(1)
    rid = pend[0]["id"] if pend else "latest"
    j = tool("take", rid); check("overlay_recording_audio_heard", bool(j.get("transcript")), repr(j.get("transcript", j))[:80])
    j = tool("done", rid); check("overlay_request_cleared_by_tab", j.get("ok") is True, str(j)[:80])
    # the hint lit by a tap: not redrawn by an overlay, and it still clears by itself
    press("click"); ok, before = wait_lens(lambda t: "Triple-tap to listen" in t, 5); mark = len(logs)
    overlay(4, 5, settle=1.0)
    check("overlay_on_hint_no_redraw", ok and lens_changes(mark, before) == [], str(lens_changes(mark, before))[:80])
    ok, lens = wait_lens(lambda t: t.strip() == "", 10); check("hint_still_clears_after_overlay", ok, repr(lens)[:40])
    # a long overlay (open 4 s) during a recording, then triple-tap: sent once (0.1.13), then cancelled on the "Sent" screen
    asks0 = sb_requests(ASKS)
    tri(); ok, before = wait_lens(lambda t: "listening" in t, 10); time.sleep(1.0); mark = len(logs)
    overlay(4, settle=4.0); overlay(5, settle=1.0)
    check("long_overlay_during_recording_untouched", ok and lens_changes(mark, before) == [] and "listening" in (lens_now() or ""), str(lens_changes(mark, before))[:80])
    tri(); ok, lens = wait_lens(lambda t: "Sent, reply coming by" in t, 30); oks = ok and sb_requests(ASKS) == asks0 + 1
    time.sleep(0.5); tri(); ok, lens = wait_lens(lambda t: "Cancelled" in t, 10); time.sleep(2.0)
    check("long_overlay_then_triple_sends_once_then_triple_cancels", oks and ok and tool("pending").get("pending", None) == [], repr(lens)[:60])
    time.sleep(2.0)

    # ask from the glasses (0.1.13: triple-tap, speak, triple-tap), with a hold mid-recording that does nothing (a hold never cancels
    # anything); the Tab takes it, checks it is still live, and clears it before answering by message
    asks0 = sb_requests(ASKS)
    tri(); ok, lens = wait_lens(lambda t: "listening" in t, 10)
    time.sleep(1.5); mark = len(logs)
    press("long_press"); time.sleep(1.0); press("long_press_release"); time.sleep(1.5)
    pump(); held = logs[mark:]
    check("hold_during_recording_does_nothing", not any("exit dialog requested" in m for m in held)  # 0.1.15: hold not handled at all
          and not any("Cancelled" in t or "Sent" in t for t in lens_after(mark)) and sb_requests(ASKS) == asks0, str([m[:50] for m in held if "hold" in m])[:120])
    tri()
    ok, lens = wait_lens(lambda t: "Sent, reply coming by" in t, 30); check("app_sent_real_ask", ok and sb_requests(ASKS) == asks0 + 1, repr(lens)[:80])
    pend = []
    for _ in range(30):
        pend = tool("pending").get("pending", [])
        if pend: break
        time.sleep(1)
    check("relay_has_request", len(pend) == 1, str([p.get("id") for p in pend]))
    mails = sorted((RIG / "outbox").glob("*.eml")); check("wake_mail_sent_to_stub", len(mails) >= 1, str(len(mails)))
    if mails: check("wake_mail_has_no_audio", "Content-Disposition: attachment" not in mails[-1].read_text())
    rid = pend[0]["id"] if pend else "latest"
    mark = len(logs)
    j = tool("take", rid); heard = j.get("transcript", ""); check("tab_take_transcribed", bool(heard), repr(heard)[:80])
    j = tool("note", rid); check("tab_note_live_request_ok", j.get("ok") is True, str(j)[:80])
    j = tool("done", rid); check("tab_done", j.get("ok") is True, str(j)[:80])
    time.sleep(1.5); check("relay_empty_after_done", tool("pending").get("pending", None) == [])
    shown = [t for t in lens_after(mark) if t.strip()]
    check("take_note_done_put_nothing_on_lens", not any(heard[:12] in t or "> " in t or "thinking" in t for t in shown), str(shown)[:120])

    # 0.1.8: taps on the "Sent" screen: single taps do nothing (0.1.13: a double-tap exits, tested at the end); a triple-tap cancels the request on the
    # relay ("Cancelled.", then dark), and the Tab's done then says gone (it sends nothing)
    ok, _ = wait_lens(lambda t: t.strip() == "", 12)
    tri(); wait_lens(lambda t: "listening" in t, 10); time.sleep(3.0); tri()
    ok, before = wait_lens(lambda t: "Sent, reply coming by" in t, 30); mark = len(logs); canc0 = sb_requests(r"^POST /v1/(ack|cancel)")
    press("click"); time.sleep(1.2); press("click"); time.sleep(1.2)
    check("taps_on_sent_screen_do_nothing", ok and lens_changes(mark, before) == [] and sb_requests(r"^POST /v1/(ack|cancel)") == canc0
          and not any("listening" in t for t in lens_after(mark)), str(lens_changes(mark, before))[:120])
    pend = []
    for _ in range(20):
        pend = tool("pending").get("pending", [])
        if pend: break
        time.sleep(0.3)
    rid = pend[0]["id"] if pend else ""
    press("click"); time.sleep(0.12); press("double_click")
    ok, lens = wait_lens(lambda t: "Cancelled" in t, 5); check("sent_triple_tap_cancelled", ok and body(lens) == "Pull Tab\n\nCancelled.", repr(lens)[:60])
    time.sleep(1.5)
    check("sent_triple_tap_cancels_on_relay", sb_requests(r"^POST /v1/ack/") >= 1 and sb_requests(r"^POST /v1/(ack|cancel)") >= canc0 + 2
          and tool("pending").get("pending", None) == [], f"{sb_requests(r'^POST /v1/(ack|cancel)') - canc0} cancel calls")
    j = tool("done", rid) if rid else {}
    check("tab_done_after_cancel_is_gone_send_nothing", j.get("ok") is False and "gone" in j.get("error", "") and j.get("rc", 3) in (3, None), str(j)[:100])
    ok, lens = wait_lens(lambda t: t.strip() == "", 5); check("cancelled_then_dark", ok, repr(lens)[:40])
    # once "Sent" has gone dark, taps behave as idle (0.1.13: a triple-tap starts a new recording); the relay is not told
    # anything, so a request whose cancel window has closed can't be cancelled
    tri(); wait_lens(lambda t: "listening" in t, 10); time.sleep(3.0); tri()
    ok, _ = wait_lens(lambda t: "Sent, reply coming by" in t, 30)
    ok2, _ = wait_lens(lambda t: t.strip() == "", 12); canc0 = sb_requests(r"^POST /v1/(ack|cancel)"); mark = len(logs)
    tri(); ok3, lens = wait_lens(lambda t: "listening" in t, 10)
    check("dark_after_sent_triple_tap_records_again_cancels_nothing", ok and ok2 and ok3 and sb_requests(r"^POST /v1/(ack|cancel)") == canc0 and len(tool("pending").get("pending", [])) == 1
          and not any("Cancelled" in t for t in lens_after(mark)), str(lens_after(mark))[:80])
    time.sleep(0.2); tri(); wait_lens(lambda t: "too short" in t, 6)   # a send under 1 s sends nothing
    requests.post(f"{RELAY}/admin/purge", headers={"authorization": "Bearer " + st["admin_key"]}); time.sleep(3.0)
    requests.post(f"{RELAY}/admin/purge", headers={"authorization": "Bearer " + st["admin_key"]}); time.sleep(3.0)

    # 0.1.9: the relay queues up to 8 requests, first in, first out.
    # Other requests are queued straight from here, signed as the app signs them.
    qpcm = (RIG / "q.pcm").read_bytes()[:64000]
    def purge(): requests.post(f"{RELAY}/admin/purge", headers={"authorization": "Bearer " + st["admin_key"]})
    def qids(): return [x.get("id") for x in tool("pending").get("pending", [])]
    def direct_ask():
        ts = str(int(time.time() * 1000)); box = pt.seal(k["enc"], qpcm, f"pulltab/audio/16000/{ts}")
        r = requests.post(f"{RELAY}/v1/ask", data=box, headers={"x-pt-ts": ts, "x-pt-sig": pt.sign(k["auth"], "POST", "/v1/ask", ts, box)}, timeout=30)
        time.sleep(0.02); return r.json().get("id") if r.ok else None
    def glasses_ask(until, secs=30):
        tri(); wait_lens(lambda t: "listening" in t, 10); time.sleep(3.0); mark = len(logs); tri()
        ok, lens = wait_lens(until, secs); return ok, lens, mark
    # 3 queued requests (one from the glasses, then two more), taken in FIFO order by the Tab
    purge(); wait_lens(lambda t: t.strip() == "", 12)
    ok, _, _ = glasses_ask(lambda t: "Sent, reply coming by" in t)
    first = qids()
    q2, q3 = direct_ask(), direct_ask()
    queued = qids()
    check("queue_three_requests_all_kept", ok and len(first) == 1 and q2 and q3 and queued == first + [q2, q3], str(queued))
    order, heard_all = [], True
    for _ in range(3):
        j = tool("take", "next"); order.append(j.get("id")); heard_all = heard_all and bool(j.get("transcript"))
        tool("done", j.get("id", "x"))
    check("queue_tab_takes_oldest_first_fifo", order == queued and heard_all and qids() == [], str(order))
    wait_lens(lambda t: t.strip() == "", 12)
    # triple-tap on the "Sent" screen cancels only the request just sent; the two queued before it stay, in order
    purge(); a1, a2 = direct_ask(), direct_ask()
    ok, _, _ = glasses_ask(lambda t: "Sent, reply coming by" in t)
    mine = [x for x in qids() if x not in (a1, a2)]
    press("click"); time.sleep(0.12); press("double_click")
    okc, lens = wait_lens(lambda t: "Cancelled" in t, 5); time.sleep(1.5)
    check("queue_sent_triple_tap_cancels_only_its_own", ok and okc and len(mine) == 1 and qids() == [a1, a2], f"mine={mine} left={qids()}")
    j = tool("done", mine[0]) if mine else {}
    check("queue_cancelled_one_gone_others_live", j.get("ok") is False and "gone" in j.get("error", "") and tool("note", a1).get("ok") is True and tool("note", a2).get("ok") is True, str(j)[:100])
    wait_lens(lambda t: t.strip() == "", 6)
    # a 9th upload: the relay refuses it (signed "queue_full"); the lens says so for a few seconds, then goes dark;
    # nothing queued is dropped
    purge(); eight = [direct_ask() for _ in range(8)]
    asks0 = sb_requests(ASKS)
    ok, lens, mark = glasses_ask(lambda t: "questions waiting" in t, 30); t_full = time.time()
    check("queue_full_ninth_upload_refused_lens_message", ok and body(lens) == "Pull Tab\n\n8 questions waiting.\nTry again soon." and sb_requests(ASKS) == asks0 + 1
          and not any("Sent, reply coming by" in t for t in lens_after(mark)), repr(lens)[:80])
    snap("queue-full-0.1.9.png")
    okd, _ = wait_lens(lambda t: t.strip() == "", 10); dark_s = time.time() - t_full
    check("queue_full_message_then_dark", okd and 2.5 <= dark_s <= 6.5, f"{dark_s:.1f}s")
    check("queue_full_nothing_dropped", all(eight) and qids() == eight, str(qids())[:200])
    purge(); time.sleep(1.0)

    # the channel word, set by the Tab at install: re-running init with --reply-by text (same code) rebuilds the relay
    # with "text"; a relay that sends no usable word shows "message" (the default)
    for word, how in [("text", "text"), ("message", "other")]:
        if how == "text": j = tool("init", setup, "--to", "test+pulltab@example.invalid", "--reply-by", "text"); okinit = j.get("reply_by") == "text"
        else:
            w = RIG / "relayhome" / "site" / "worker.mjs"; w.write_text(w.read_text().replace('const REPLY_BY = "text";', 'const REPLY_BY = "Telegram";')); okinit = 'REPLY_BY = "Telegram"' in w.read_text()
        time.sleep(4.0); wait_http(RELAY + "/v1/hello", 30); time.sleep(2.0)
        tri(); wait_lens(lambda t: "listening" in t, 10); time.sleep(3.0); tri()
        ok, lens = wait_lens(lambda t: "Sent, reply coming by" in t, 30)
        check(f"sent_screen_channel_{word}", okinit and ok and body(lens) == f"Pull Tab\n\nSent, reply coming by {word}.\nTriple-tap to cancel.", repr(lens)[-70:])
        wait_lens(lambda t: t.strip() == "", 12)
        requests.post(f"{RELAY}/admin/purge", headers={"authorization": "Bearer " + st["admin_key"]})
    j = tool("init", setup, "--to", "test+pulltab@example.invalid", "--reply-by", "whatsapp"); time.sleep(4.0); wait_http(RELAY + "/v1/hello", 30); time.sleep(2.0)
    check("channel_back_to_whatsapp", j.get("reply_by") == "WhatsApp", str(j)[:80])
    # the 55 s cap throws a recording away (never sent); a single tap mid-recording is ignored (keeps recording; 0.1.7)
    time.sleep(2.0); asks0 = sb_requests(ASKS); mark = len(logs)
    tri(); ok, _ = wait_lens(lambda t: "listening" in t, 10); t0 = time.time()
    time.sleep(2.5); press("click"); time.sleep(1.5)
    check("single_tap_while_recording_keeps_recording", ok and not any("Cancelled" in t or "Sending" in t for t in lens_after(mark)) and any("single tap while recording: ignored" in m for m in logs[mark:]))
    ok, lens = wait_lens(lambda t: "Not sent" in t, 60); took = time.time() - t0
    check("cap_55s_discards_not_sent", ok and 53 <= took <= 59 and sb_requests(ASKS) == asks0, f"{took:.1f}s, asks +{sb_requests(ASKS) - asks0}")
    time.sleep(4.0); check("cap_then_dark_and_nothing_pending", (lens_now() or "x").strip() == "" and tool("pending").get("pending", None) == [], repr(lens_now())[:40])

    # signature checks straight on the relay (0.1.6: no switchboard): bad request signature refused, and that refusal
    # is itself signed by the relay; the Tab's API needs its key
    slug = json.loads((RIG / "relayhome" / "state.json").read_text())["slug"]
    r = requests.post(f"{RELAY}/v1/ask", data=b"x", headers={"x-pt-ts": str(int(time.time()*1000)), "x-pt-sig": "0"*64})
    check("relay_rejects_bad_sig", r.status_code == 401, r.text)
    # 0.1.13 (review L1): the refusal is signed, but bound to no request signature, since this one didn't verify
    check("relay_signs_its_refusal_bound_to_nothing", r.headers.get("x-pt-rsig") == pt.resp_sig(k["rkey"], 401, "", r.content)
          and r.headers.get("x-pt-rsig") != pt.resp_sig(k["rkey"], 401, "0" * 64, r.content), r.headers.get("x-pt-rsig", "none")[:12])
    r = requests.get(f"{RELAY}/v1/pending"); check("relay_v1_has_no_tab_api", r.status_code in (401, 404), f"{r.status_code} {r.text}")
    r = requests.get(f"{RELAY}/tab/pending"); check("relay_tab_api_needs_key", r.status_code == 401, f"{r.status_code} {r.text}")

    # protocol 2: replay refused, cancel is a tombstone by the app's clock, audio bound to its signed time
    def signed(method, path, body=b"", ts=None):
        ts = str(ts or int(time.time() * 1000)); sg = pt.sign(k["auth"], method, path, ts, body)
        r = requests.request(method, f"{RELAY}{path}", data=body or None, headers={"x-pt-ts": ts, "x-pt-sig": sg}, timeout=30)
        r.signed_ok = r.headers.get("x-pt-rsig") == pt.resp_sig(k["rkey"], r.status_code, sg, r.content)
        return r
    r = signed("GET", "/v1/hello"); check("hello_protocol_3_signed", r.ok and r.json().get("version") == "3" and r.signed_ok, r.text)
    pcm = (RIG / "q.pcm").read_bytes()[:64000]
    t1 = int(time.time() * 1000)
    box = pt.seal(k["enc"], pcm, f"pulltab/audio/16000/{t1}")
    hdr = {"x-pt-ts": str(t1), "x-pt-sig": pt.sign(k["auth"], "POST", "/v1/ask", str(t1), box)}
    r1 = requests.post(f"{RELAY}/v1/ask", data=box, headers=hdr); r2 = requests.post(f"{RELAY}/v1/ask", data=box, headers=hdr)
    check("ask_once", r1.ok and "id" in r1.json(), r1.text)
    check("replay_refusal_signed_for_that_request", r2.headers.get("x-pt-rsig") == pt.resp_sig(k["rkey"], 409, hdr["x-pt-sig"], r2.content), "")
    check("same_signed_ask_replayed_refused", r2.status_code == 409 and r2.json().get("error") == "replay", r2.text)
    j = tool("take", r1.json().get("id", "x")); check("take_protocol_2_audio", bool(j.get("transcript")), str(j)[:100])
    tool("done", r1.json().get("id", "x"))
    # the same signed time with different bytes (a swapped-in copy): take refuses it and tells the lens
    r = signed("POST", "/v1/ask", pt.seal(k["enc"], pcm, f"pulltab/audio/16000/{t1}"), ts=t1)
    j = tool("take", r.json().get("id", "x")) if r.ok else {"err": r.text}
    check("take_refuses_already_taken_time", j.get("ok") is False and "already taken" in j.get("error", ""), str(j)[:140])
    rr = requests.get(f"{RELAY}/tab/pending", headers={"authorization": "Bearer " + st["tab_key"]}).json().get("pending", [])
    check("refusal_clears_request", not any(x.get("id") == r.json().get("id") for x in rr), str(rr)[:120])
    # audio sealed for another time than the signed one: take can't decrypt it
    t2 = int(time.time() * 1000)
    r = signed("POST", "/v1/ask", pt.seal(k["enc"], pcm, f"pulltab/audio/16000/{t2 - 1}"), ts=t2)
    j = tool("take", r.json().get("id", "x")) if r.ok else {"err": r.text}
    check("take_refuses_audio_bound_to_other_time", j.get("ok") is False and "decrypt" in j.get("error", ""), str(j)[:140])
    # cancel reaches the relay BEFORE the ask it cancels: the ask is refused, no wake mail. 0.1.9: the cancel removes
    # only the ask it names, so the undecryptable request left above stays queued; clear it first.
    requests.post(f"{RELAY}/admin/purge", headers={"authorization": "Bearer " + st["admin_key"]})
    mails_before = len(list((RIG / "outbox").glob("*.eml")))
    ta = int(time.time() * 1000); tc = ta + 300
    rc = signed("POST", "/v1/cancel", str(ta).encode(), ts=tc)   # 0.1.9: the cancel names the ask it cancels
    ra = signed("POST", "/v1/ask", pt.seal(k["enc"], pcm, f"pulltab/audio/16000/{ta}"), ts=ta)
    check("cancel_before_ask_refuses_it", rc.ok and ra.status_code == 409 and ra.json().get("error") == "cancelled", f"{rc.status_code} {ra.status_code} {ra.text}")
    time.sleep(1.5); check("no_wake_mail_for_cancelled_ask", len(list((RIG / "outbox").glob("*.eml"))) == mails_before)
    check("nothing_pending_after_tombstone", tool("pending").get("pending", None) == [])
    rcr = signed("POST", "/v1/cancel", str(ta).encode(), ts=tc)
    check("replayed_cancel_signature_refused", rcr.status_code == 409, rcr.text)
    # 0.1.8: the Tab writes no words to the relay: note only checks the request is live, done clears it
    t3 = int(time.time() * 1000) + 1000
    r = signed("POST", "/v1/ask", pt.seal(k["enc"], pcm, f"pulltab/audio/16000/{t3}"), ts=t3)
    rid = r.json().get("id", "x")
    check("ask_ack_carries_reply_by_signed", r.ok and r.json().get("reply_by") == "WhatsApp" and r.signed_ok, r.text)
    rr = requests.post(f"{RELAY}/tab/reply/{rid}", json={"reply": "x"}, headers={"authorization": "Bearer " + st["tab_key"]})
    check("relay_takes_no_answer_text", rr.status_code == 404, rr.text)
    r = signed("GET", f"/v1/reply/{rid}"); check("relay_serves_no_answer", r.status_code == 404 and r.signed_ok, r.text)
    j = tool("note", rid, "sending..."); check("note_on_live_request_ok", j.get("ok") is True, str(j)[:100])
    requests.post(f"{RELAY}/admin/purge", headers={"authorization": "Bearer " + st["admin_key"]})
    j = tool("note", rid, "sending..."); check("note_on_gone_request_fails", j.get("ok") is False and "gone" in j.get("error", ""), str(j)[:100])
    # 0.1.9: a tombstone (even one from a phone clock that was fast) refuses only the ask it names, never another
    # (held 15 min, audit F12; the 15 min is tested with a moved clock in test/relayworker.sh)
    tf = int(time.time() * 1000) + 5 * 60_000; tn = int(time.time() * 1000); tx = tn - 2000
    signed("POST", "/v1/cancel", str(tx).encode(), ts=tf)
    r = signed("POST", "/v1/ask", pt.seal(k["enc"], pcm, f"pulltab/audio/16000/{tn}"), ts=tn)
    rx = signed("POST", "/v1/ask", pt.seal(k["enc"], pcm, f"pulltab/audio/16000/{tx}"), ts=tx)
    check("tombstone_refuses_only_the_ask_it_names", r.status_code == 200 and rx.status_code == 409 and rx.json().get("error") == "cancelled", f"{r.status_code} {rx.status_code}")
    requests.post(f"{RELAY}/admin/purge", headers={"authorization": "Bearer " + st["admin_key"]})
    pump(); dark_before = (lens_now() or "").strip() == ""; mark = len(logs); hello0 = sb_requests(r"^GET /v1/hello ")
    time.sleep(65); pump()
    # 0.1.10: no polling loop: with no open or return to the phone screen, the app never checks the connection
    check("phone_no_status_polling", sb_requests(r"^GET /v1/hello ") == hello0 and not any("status check on" in m for m in logs[mark:]), f"hellos +{sb_requests(r'^GET /v1/hello ') - hello0} in 65 s")
    # a dark lens stays dark: the clock never lights it (a minute boundary passes during this wait)
    check("dark_lens_not_redrawn_for_clock", dark_before and not lens_after(mark), f"dark={dark_before} writes={lens_after(mark)[:2]}")
    check("no_answer_gets_whole_run", sb_requests(r"^GET /v1/reply") == 0 and sb_requests(r"^GET ") == sb_requests(r"^GET /v1/hello "), f"{sb_requests(r'^GET ')} GETs, {sb_requests(r'^GET /v1/hello ')} hellos")
    requests.post(f"{RELAY}/admin/purge", headers={"authorization": "Bearer " + st["admin_key"]})
    shot = requests.get(f"{SIM}/api/screenshot/glasses", timeout=10)
    if shot.ok: (ROOT / "test" / "last-e2e-glasses.png").write_bytes(shot.content)
    # 0.1.10: "Reset pairing" is a small link at the bottom of the phone screen with the same F1 behaviour and wording as
    # 0.1.9's "Make a new pairing code": a first tap asks for a second within 6 s; the second makes a new code, unpairs
    # the app, and the screen asks for the new setup message (the Tab then retires the old relay: test/relayworker.sh)
    p0 = probe(); png = phone_shot("phone-connected-0.1.10.png"); w, dark = button_rows(png)
    check("phone_connected_screen_no_dark_buttons", dark == 0, f"dark rows {dark}")
    check("reset_link_shown", p0.get("reset") == "Reset pairing" and p0.get("setup") == "none", str({k: p0.get(k) for k in ("reset", "setup")}))
    check("discord_link_shown_when_connected", p0.get("discord") == "Get help on Discord" and p0.get("dvis") is True, str({k: p0.get(k) for k in ("discord", "dvis")}))
    check("join_invite_link_shown_when_connected", p0.get("join") == "Not a TAB member? Join here" and p0.get("jhref") == "https://tab.bot/r/F97BF7357521A088" and p0.get("jvis") is True,
          str({k: p0.get(k) for k in ("join", "jhref", "jvis")}))
    ARMED = "Tap again to replace the pairing code. Then send the new setup message to your Tab, so it shuts down the old code"
    check("reset_link_first_tap", phone_tap(p0.get("x", 0), p0.get("y", 0)) and (time.sleep(0.8) or True))
    p1 = probe(); check("reset_link_asks_to_confirm_f1_wording", p1.get("reset") == ARMED and p1.get("code") == p0.get("code") and p1.get("setup") == "none", str(p1.get("reset"))[:60])
    phone_shot("phone-reset-armed-0.1.10.png")
    time.sleep(6.5); p2 = probe(); check("reset_link_disarms_after_6s", p2.get("reset") == "Reset pairing" and p2.get("code") == p0.get("code"), str(p2.get("reset"))[:60])
    asks0, mark = sb_requests(ASKS), len(logs)
    phone_tap(p2.get("x", 0), p2.get("y", 0)); time.sleep(0.8); p3 = probe()
    check("reset_link_tap_again_armed", p3.get("reset") == ARMED, str(p3.get("reset"))[:60])
    phone_tap(p3.get("x", 0), p3.get("y", 0)); time.sleep(1.5); p4 = probe(); pump()
    check("reset_link_makes_new_code_f1", p4.get("code", "").startswith("PT1-") and p4.get("code") != p0.get("code") and p4.get("setup") == "block" and p4.get("reset") == "Reset pairing"
          and any("phone: New code made. Send the setup message below to your Tab: it shuts down the old code and relay, and sets up a new one." in m for m in logs[mark:]), str({k: p4.get(k) for k in ("setup", "state")})[:160])
    ok, lens = wait_lens(lambda t: "Not connected" in t, 10); check("reset_link_lens_unpaired", ok and sb_requests(ASKS) == asks0, repr(lens)[:60])
    # the old code still works on the old relay until the Tab retires it (the F1 wording says so); the new code doesn't
    ts = str(int(time.time() * 1000)); sg = pt.sign(k["auth"], "GET", "/v1/hello", ts)
    r = requests.get(f"{RELAY}/v1/hello", headers={"x-pt-ts": ts, "x-pt-sig": sg}); check("reset_old_code_still_on_old_relay_until_retired", r.ok, str(r.status_code))
    # (here the old relay answers the new code's check with the old relay key, so the app refuses it as not its own)
    hello0 = sb_requests(r"^GET /v1/hello "); mark = len(logs); phone_resume(); time.sleep(2.0); pump(); p5 = probe()
    said = [m for m in logs[mark:] if "phone:" in m]
    check("reset_new_code_not_connected_on_resume", sb_requests(r"^GET /v1/hello ") == hello0 + 1 and said and "Connected to your Tab" not in said[-1]
          and ("That relay didn't prove it's yours" in said[-1] or "doesn't recognise this pairing code" in said[-1]) and p5.get("setup") == "block", str([m[-60:] for m in said][-1:]))
    # last (the simulator closes the page on the exit call, so one exit per run).
    # 0.1.15: the hold gesture is gone. A hold on the root screen does nothing: no exit menu, no mic,
    # no lens change, nothing sent; the double-tap exit below still works after it.
    wait_lens(lambda t: "Not connected" in t or t.strip() == "", 15)
    asks0 = sb_requests(ASKS); mark = len(logs); before = lens_now()
    press("long_press"); time.sleep(1.0); press("long_press_release"); time.sleep(2.0); pump()
    check("hold_on_root_does_nothing", not any("exit dialog" in m for m in logs[mark:]) and not any("listening" in t for t in lens_after(mark))
          and lens_now() == before and sb_requests(ASKS) == asks0, str([m[:50] for m in logs[mark:]])[:160])
    # 0.1.13: a double-tap on the root screen exits (the system exit menu); here the app
    # is unpaired after the reset tests, so it also proves no mic opens and nothing is sent. The double-tap during a
    # recording (thrown away, then exit) runs in its own short pass: PT_E2E_EXIT_REC=1.
    wait_lens(lambda t: "Not connected" in t or t.strip() == "", 15)
    asks0 = sb_requests(ASKS); mark = len(logs)
    press("double_click"); time.sleep(3.0); pump(); seen = logs[mark:]
    check("double_tap_on_root_opens_exit_menu", any("exit dialog requested double-tap" in m for m in seen) and any("exit dialog call returned true" in m for m in seen)
          and not any("listening" in t for t in lens_after(mark)) and sb_requests(ASKS) == asks0, str([m[:50] for m in seen if "exit" in m])[:160])

if __name__ == "__main__":
    try: main()
    except Exception:
        import traceback; traceback.print_exc(); fails.append("exception")
    finally:
        if "--keep" not in sys.argv: sh("bash", str(RIG / "rig.sh"), "stop")
        (ROOT / "test" / "local-e2e-results.json").write_text(json.dumps({"when": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "failed": fails, "results": results}, indent=1))
        print(f"\n{len(results) - len(fails)}/{len(results)} passed" + (f"; FAILED: {fails}" if fails else ""))
        sys.exit(1 if fails else 0)
