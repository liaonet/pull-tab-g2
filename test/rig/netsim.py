#!/usr/bin/env python3
"""Test-only stand-in for the network between the app (simulator) and the person's relay. Local, sends nothing out.

  python3 netsim.py <listen-port> <relay-origin> <mode-file> <log-file>

It forwards every request to the local relay unchanged and logs "METHOD PATH" per request, so the e2e test can count
what the app sent. The mode file (one word, re-read on every request) lets the test stand in for the bad cases:
  pass      forward unchanged (the normal case)
  impostor  another *.sites.tab.bot site: the relay's answer, re-signed with a key that isn't the paired relay's
  strip     an answer with no relay signature at all
  down      no relay published yet: a 404 without CORS headers, as sites.tab.bot answers for an unknown name
This is not a switchboard: Pull Tab 0.1.6 has none; the real app calls https://<name>.sites.tab.bot directly.
"""
import hashlib, hmac, os, secrets, sys, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import requests
PORT, UPSTREAM, MODE, LOG = int(sys.argv[1]), sys.argv[2].rstrip("/"), sys.argv[3], sys.argv[4]
# The impostor's signing key: random per run, so its answers can never carry the paired relay's signature.
FAKE_KEY = secrets.token_bytes(32)
lock = threading.Lock()
# Hop-by-hop and per-connection headers, not copied in either direction (each side sets its own).
HOP = {"connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "host", "date", "server"}
def mode():
    try: return open(MODE).read().strip() or "pass"
    except FileNotFoundError: return "pass"
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def handle_any(self):
        m = mode()
        with lock:
            with open(LOG, "a") as f: f.write(f"{self.command} {self.path} [{m}]\n")
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n) if n else b""
        if m == "down":
            out = b"<html>No site is published here</html>"
            self.send_response(404); self.send_header("content-type", "text/html"); self.send_header("content-length", str(len(out))); self.end_headers(); self.wfile.write(out); return
        hdr = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        try: r = requests.request(self.command, UPSTREAM + self.path, headers=hdr, data=body or None, timeout=60, allow_redirects=False)
        except Exception:
            out = b"bad gateway"; self.send_response(502); self.send_header("content-length", str(len(out))); self.end_headers(); self.wfile.write(out); return
        out = r.content
        self.send_response(r.status_code)
        for k, v in r.headers.items():
            if k.lower() in HOP: continue
            if k.lower() == "x-pt-rsig":
                if m == "strip": continue
                if m == "impostor":
                    rs = (self.headers.get("x-pt-sig") or "").lower()
                    v = hmac.new(FAKE_KEY, f"pulltab/resp\n{r.status_code}\n{rs}\n{hashlib.sha256(out).hexdigest()}".encode(), hashlib.sha256).hexdigest()
            self.send_header(k, v)
        self.send_header("content-length", str(len(out))); self.end_headers(); self.wfile.write(out)
    do_GET = do_POST = do_OPTIONS = do_PUT = do_DELETE = handle_any
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
