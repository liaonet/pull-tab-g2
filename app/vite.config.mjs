// vite.config.mjs: build configuration for the Pull Tab app (run with `npm run build` in app/, output in app/dist).
// Inputs: app.json (version, network whitelist), the three files under site/ that a Tab downloads, and environment
// variables (PT_DOCS, PT_OUT, PT_DEBUG, and for test builds PT_TEST_RELAY and PT_TEST_AUDIO).
// Output: a static page (index.html plus one JS bundle) that the Even Hub CLI packs into a .ehpk for upload.
// The `define` block below turns build-time values into literal constants in the bundle (see main.ts).
import { defineConfig } from "vite";
import fs from "node:fs";
import crypto from "node:crypto";
// No user keys or relay URLs are built in. Build-time values: where the setup guide lives (PT_DOCS; the guide, privacy
// notice and the two files a Tab downloads are the site/ folder, served at https://pulltab.sites.tab.bot), and the
// fingerprints of the files a Tab downloads. Test builds only: PT_TEST_RELAY (a local relay) and PT_TEST_AUDIO.
// Console logging is compiled out of store builds; PT_DEBUG=1 (or a test build) keeps it, and like a test relay it may
// only go into a separate output folder (PT_OUT), never into dist/.
// app.json is the Even Hub manifest; its version is shown on the lens and its whitelist limits where the app may connect.
const APP = JSON.parse(fs.readFileSync(new URL("./app.json", import.meta.url), "utf8"));
const WL = APP.permissions.find((p) => p.name === "network").whitelist;
// Guard: the build fails if the network whitelist drifts from the list approved for the Even Hub listing, so a change cannot slip through.
if (JSON.stringify(WL) !== JSON.stringify(["https://*.sites.tab.bot","https://pulltab.sites.tab.bot","https://discord.gg","https://tab.bot"])) throw new Error("app.json network whitelist must be exactly the 0.1.11 list (relays + help links)");
const DOCS = process.env.PT_DOCS || "https://pulltab.sites.tab.bot";
const TEST_RELAY = process.env.PT_TEST_RELAY || "";
// Guard: a test relay may only go into a separate test output folder, never into dist/ (the store build).
if (TEST_RELAY && !process.env.PT_OUT) throw new Error("PT_TEST_RELAY is for test builds only (set PT_OUT to a test folder)");
if (process.env.PT_DEBUG === "1" && !process.env.PT_OUT) throw new Error("PT_DEBUG is for test builds only (set PT_OUT to a test folder)");
// SHA-256 of every file a Tab downloads to build its relay, carried in the setup message.
const PUB = new URL("../site/", import.meta.url);
const FILES = { "setup.md": "setup.md", "pulltab.py": "files/pulltab.py", "relay-worker.template.mjs": "files/relay-worker.template.mjs" };
// Important: these hashes are baked into the app, so ANY edit to site/setup.md, site/files/pulltab.py or
// site/files/relay-worker.template.mjs (even a comment) changes the built app, and the live site must serve the same
// bytes or a Tab will refuse to set up. Change those files only together with a new app release and a site deploy.
const SHA = Object.fromEntries(Object.entries(FILES).map(([name, p]) => [name, crypto.createHash("sha256").update(fs.readFileSync(new URL(p, PUB))).digest("hex")]));
export default defineConfig({
  base: "./",
  define: { __DOCS__: JSON.stringify(DOCS), __TEST_RELAY__: JSON.stringify(TEST_RELAY), __TEST_AUDIO__: JSON.stringify(process.env.PT_TEST_AUDIO || ""), __VERSION__: JSON.stringify(APP.version), __DEBUG__: JSON.stringify(process.env.PT_DEBUG === "1"), __FILE_SHA256__: JSON.stringify(SHA) },
  // es2019 is the language level targeted for the Even app's WebView; assetsInlineLimit 0 keeps assets as files rather than inlined data URLs.
  build: { outDir: process.env.PT_OUT || "dist", emptyOutDir: true, target: "es2019", assetsInlineLimit: 0 },
});
