// vec.ts: prints the published protocol test vector from the app's own code (app/src/pt.ts) as one JSON line.
// test/vectors.sh runs it and compares every value with what the Tab's CLI (site/files/pulltab.py) derives from the same
// fixed secret (bytes 0..31), so the app and the Tab are proven to agree on keys, the pairing code, request signing,
// sealing and the relay's answer signature.
import { keysFrom, sign, seal, open, parseCode, hex, b64u, respSig, respOk } from "../../app/src/pt";
const S = Uint8Array.from({length:32},(_, i)=>i);
const k = keysFrom(S);
const box = seal(k, new TextEncoder().encode("hi"), "pulltab/reply/x");
console.log(JSON.stringify({slug:k.slug, code:k.code, auth:hex(k.auth), enc:hex(k.enc), sig: sign(k,"POST","/v1/ask","1760000000000",new TextEncoder().encode("hello")), rt: new TextDecoder().decode(open(k, box, "pulltab/reply/x")), parse: parseCode("x "+k.code+" y") && hex(parseCode(k.code)!)===hex(S), box: b64u(box),
  rsig: respSig(k.rkey, 200, sign(k,"POST","/v1/ask","1760000000000",new TextEncoder().encode("hello")), new TextEncoder().encode('{"ok":true}')),
  rkey: hex(k.rkey)}));
