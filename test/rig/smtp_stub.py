#!/usr/bin/env python3
"""Stub SMTP server for local tests: speaks EHLO/AUTH PLAIN/MAIL/RCPT/DATA/QUIT,
accepts one fixed test credential, writes each message to OUTDIR/<n>.eml. Sends nothing anywhere."""
# Used by the e2e rig so the relay's wake mail can be checked without a real mail server. One handler per connection.
import asyncio, base64, os, sys, json
PORT=int(sys.argv[1]); OUT=sys.argv[2]; USER=sys.argv[3]; PASS=sys.argv[4]
os.makedirs(OUT, exist_ok=True); n=[0]
# One SMTP session: answers each command line by line; only AUTH PLAIN is offered, and MAIL FROM needs a successful AUTH.
async def h(r, w):
    s=lambda x: (w.write((x+"\r\n").encode()))
    s("220 stub.local ESMTP test"); await w.drain(); authed=False; mf=None; rc=[]
    while True:
        l=await r.readline()
        if not l: break
        l=l.decode().rstrip("\r\n"); u=l.upper()
        if u.startswith("EHLO"): s("250-stub.local"); s("250 AUTH PLAIN")
        elif u.startswith("AUTH PLAIN "):
            _,user,pw=base64.b64decode(l[11:]).decode().split("\0")
            if user==USER and pw==PASS: authed=True; s("235 2.7.0 Accepted")
            else: s("535 5.7.8 Username and Password not accepted")
        elif u.startswith("MAIL FROM:"):
            if not authed: s("530 5.7.0 Authentication Required")
            else: mf=l[10:]; s("250 OK")
        elif u.startswith("RCPT TO:"): rc.append(l[8:]); s("250 OK")
        elif u=="DATA":
            s("354 go"); await w.drain(); body=[]
            while True:
                x=(await r.readline()).decode()
                if x in (".\r\n",".\n"): break
                body.append(x[1:] if x.startswith("..") else x)
            n[0]+=1; open(f"{OUT}/{n[0]}.eml","w").write(f"X-Envelope-From: {mf}\nX-Envelope-To: {','.join(rc)}\n"+"".join(body))
            s("250 2.0.0 OK queued"); rc=[]
        elif u=="QUIT": s("221 bye"); await w.drain(); break
        else: s("502 unknown")
        await w.drain()
    w.close()
async def main():
    srv=await asyncio.start_server(h,"127.0.0.1",PORT)
    async with srv: await srv.serve_forever()
asyncio.run(main())
