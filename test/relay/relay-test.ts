// 0.1.6 unit tests: the relay address check (relayOrigin) and the relay key pin (respOk). Run: test/relay.sh
import { keysFrom, relayOrigin, defaultRelay, respSig, respOk, sign, hex } from "../../app/src/pt";
const TE = new TextEncoder();
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });

// ---- relay address: only https://<one label>.sites.tab.bot, nothing after it ----
const good: [string, string][] = [
  ["https://pt-3n44qqjm4rkb2efcai3m.sites.tab.bot", "https://pt-3n44qqjm4rkb2efcai3m.sites.tab.bot"],
  ["https://pt-3n44qqjm4rkb2efcai3m.sites.tab.bot/", "https://pt-3n44qqjm4rkb2efcai3m.sites.tab.bot"],
  ["  https://My-Relay.Sites.Tab.Bot/  ", "https://my-relay.sites.tab.bot"],
  ["HTTPS://abc.sites.tab.bot", "https://abc.sites.tab.bot"],
  ["https://abc.sites.tab.bot:443/", "https://abc.sites.tab.bot"],          // the default port is the same origin
  ["https://a.sites.tab.bot", "https://a.sites.tab.bot"],
  ["https://" + "a".repeat(63) + ".sites.tab.bot", "https://" + "a".repeat(63) + ".sites.tab.bot"],
];
for (const [inp, want] of good) check("accepts " + JSON.stringify(inp), relayOrigin(inp) === want, String(relayOrigin(inp)));
const bad = [
  "", "   ", "pt-abc.sites.tab.bot", "http://pt-abc.sites.tab.bot", "ftp://pt-abc.sites.tab.bot", "//pt-abc.sites.tab.bot",
  "https://sites.tab.bot", "https://.sites.tab.bot", "https://a.b.sites.tab.bot", "https://pt-abc.sites.tab.bot.evil.com",
  "https://pt-abc.sites.tab.bot.", "https://pt-abcsites.tab.bot", "https://evil.com/.sites.tab.bot", "https://evil.com?.sites.tab.bot",
  "https://evil.com#.sites.tab.bot", "https://evil.com\\.sites.tab.bot", "https://user@pt-abc.sites.tab.bot", "https://evil.com@pt-abc.sites.tab.bot",
  "https://pt-abc.sites.tab.bot@evil.com", "https://user:pw@pt-abc.sites.tab.bot", "https://pt-abc.sites.tab.bot:8443",
  "https://pt-abc.sites.tab.bot/v1/hello", "https://pt-abc.sites.tab.bot/?x=1", "https://pt-abc.sites.tab.bot/#x",
  "https://-abc.sites.tab.bot", "https://abc-.sites.tab.bot", "https://a_b.sites.tab.bot", "https://" + "a".repeat(64) + ".sites.tab.bot",
  "https://pt abc.sites.tab.bot", "https://pt-abc%2esites.tab.bot", "https://evil.com%2f.sites.tab.bot", "javascript:alert(1)//.sites.tab.bot",
  "https://sites.tab.bot.evil.com", "https://xsites.tab.bot", "https://pt-abc.sites.tab.bot.\u200b", "https://pt-abc.sitеs.tab.bot",   // Cyrillic е
  "https://127.0.0.1", "https://localhost", "https://pulltab.pulltab.workers.dev", "https://pt-abc.sites.tab.bot\n.evil.com",
];
for (const inp of bad) check("refuses " + JSON.stringify(inp), relayOrigin(inp) === null, String(relayOrigin(inp)));
const k = keysFrom(Uint8Array.from({ length: 32 }, (_, i) => i));
check("default relay is the derived name, and passes the check", defaultRelay(k) === "https://pt-3n44qqjm4rkb2efcai3m.sites.tab.bot" && relayOrigin(defaultRelay(k)) === defaultRelay(k), defaultRelay(k));

// ---- key pin: the relay key comes from the pairing code; any answer not signed with it is refused ----
const other = keysFrom(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));
check("relay key differs from the request and encryption keys", hex(k.rkey) !== hex(k.auth) && hex(k.rkey) !== hex(k.enc));
const reqSig = sign(k, "GET", "/v1/hello", "1760000000000", new Uint8Array(0));
const body = TE.encode('{"ok":true,"version":"3","mail":true}');
const good1 = respSig(k.rkey, 200, reqSig, body);
check("pin: the paired relay's answer is accepted", respOk(k, 200, reqSig, body, good1));
check("pin: upper-case hex accepted", respOk(k, 200, reqSig, body, good1.toUpperCase()));
check("pin: no signature refused", !respOk(k, 200, reqSig, body, null) && !respOk(k, 200, reqSig, body, ""));
check("pin: malformed signature refused", !respOk(k, 200, reqSig, body, "zz" + good1.slice(2)) && !respOk(k, 200, reqSig, body, good1.slice(0, 63)) && !respOk(k, 200, reqSig, body, good1 + "0"));
check("pin: a relay from another pairing code refused", !respOk(k, 200, reqSig, body, respSig(other.rkey, 200, reqSig, body)));
check("pin: signed with the request key instead refused", !respOk(k, 200, reqSig, body, respSig(k.auth, 200, reqSig, body)));
check("pin: changed body refused", !respOk(k, 200, reqSig, TE.encode('{"ok":true,"version":"3","mail":false}'), good1));
check("pin: changed status refused", !respOk(k, 404, reqSig, body, good1));
const reqSig2 = sign(k, "GET", "/v1/hello", "1760000000001", new Uint8Array(0));
check("pin: an old answer replayed for a new request refused", !respOk(k, 200, reqSig2, body, good1));
check("pin: the vector matches pulltab.py", respSig(k.rkey, 200, sign(k, "POST", "/v1/ask", "1760000000000", TE.encode("hello")), TE.encode('{"ok":true}')) === "178639ff520c6d86ddd733c7c97ceb75ce422cf788dae609f625c96d3827ffaf");

const fails = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? "PASS " : "FAIL ") + r.name + (r.ok ? "" : "  (" + r.detail + ")"));
console.log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
