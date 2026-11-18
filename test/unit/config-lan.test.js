"use strict";

require("../support/private-temp");

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { parseConfig, readFlags } = require("../../skills/debug-board-server/scripts/lib/config");
const { lanAddresses, boardUrls } = require("../../skills/debug-board-server/scripts/lib/lan");
const { contentSecurityPolicy, importMapOf, isSameOrigin, vendorFile, localPage } = require("../../skills/debug-board-server/scripts/lib/board-api");
const { validateAnswer, isLocalTool } = require("../../skills/debug-board-server/scripts/lib/control-api");
const { certIsUsable } = require("../../skills/debug-board-server/scripts/lib/cert");

const SKILL = path.resolve("skill");
const TEMP = path.resolve("temp");

test("defaults: this computer only, ports 47830 and 47831, data in <skill>/.data", () => {
  const { ok, config } = parseConfig([], TEMP, SKILL);
  assert.equal(ok, true);
  assert.equal(config.lan, false);
  assert.equal(config.port, 47830);
  assert.equal(config.controlPort, 47831);
  assert.equal(config.dataDir, path.join(SKILL, ".data"));
  assert.equal(config.logPath, path.join(SKILL, ".data", "server.log"));
  assert.equal(config.shotDir, path.join(TEMP, "watchman-whiteboard"));
});

test("--lan is a switch and does not eat the next flag", () => {
  const { config } = parseConfig(["--lan", "--port", "5000"], TEMP, SKILL);
  assert.equal(config.lan, true);
  assert.equal(config.port, 5000);
  assert.equal(readFlags(["--check", "--data", "d"]).get("--data"), "d");
});

test("bad numbers and equal ports are InvalidConfig", () => {
  assert.equal(parseConfig(["--port", "80"], TEMP, SKILL).reason, "InvalidConfig");
  assert.equal(parseConfig(["--settle-ms=x"], TEMP, SKILL).reason, "InvalidConfig");
  assert.equal(parseConfig(["--port", "5000", "--control-port", "5000"], TEMP, SKILL).reason, "InvalidConfig");
});

test("lanAddresses keeps external IPv4 only", () => {
  const interfaces = {
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    eth: [{ family: "IPv4", address: "192.168.1.5", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }],
    wifi: [{ family: 4, address: "10.0.0.2", internal: false }, { family: "IPv4", address: "169.254.3.4", internal: false }],
  };
  assert.deepEqual(lanAddresses(interfaces), ["10.0.0.2", "192.168.1.5"]);
});

test("Board URLs: http on 127.0.0.1, https in LAN mode, Token after # (FR-044 to FR-046)", () => {
  assert.deepEqual(boardUrls({ lan: false, port: 47830, token: "TOK", addresses: ["10.0.0.2"] }), {
    local: "http://127.0.0.1:47830/#t=TOK", lan: [],
  });
  assert.deepEqual(boardUrls({ lan: true, port: 47830, token: "TOK", addresses: ["10.0.0.2"] }), {
    local: "https://localhost:47830/#t=TOK", lan: ["https://10.0.0.2:47830/#t=TOK"],
  });
});

test("the page may load scripts only from itself, esm.sh, and its own import map", () => {
  const html = '<script type="importmap">{"imports":{}}</script>';
  assert.equal(importMapOf(html), '{"imports":{}}');
  const csp = contentSecurityPolicy("HASH", "https://esm.sh");
  assert.match(csp, /script-src 'self' https:\/\/esm\.sh 'sha256-HASH'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

// Watchman Whiteboard: with the libraries staged in page/vendor the page works offline and may load
// nothing from another site.
test("with the libraries staged locally the page loads nothing from another site", () => {
  const csp = contentSecurityPolicy("HASH", "");
  assert.match(csp, /script-src 'self' 'sha256-HASH'/);
  assert.doesNotMatch(csp, /https?:\/\//);
});

// Watchman Whiteboard: the voice character's textures (seen in headless Chrome, 2026-11-17, as in Watchman's own window
// on 2026-10-30, src/features/voice/ui/avatar/vrmCsp.test.ts): GLTFLoader hands a .vrm's embedded textures to
// ImageBitmapLoader as blob: URLs, read with fetch(), which falls under connect-src; refused, three-vrm fails with
// "Cannot set properties of undefined (setting 'colorSpace')". A blob: URL addresses only data already in the page.
test("the page may read its own blob: URLs, so the voice character's textures load, and nothing wider", () => {
  for (const outside of ["", "https://esm.sh"]) {
    const connect = contentSecurityPolicy("HASH", outside).split(";").map((part) => part.trim()).find((part) => part.startsWith("connect-src "));
    assert.ok(connect.split(/\s+/).includes("blob:"), connect);
    assert.doesNotMatch(connect, /\*|data:|https: /);
  }
});

test("a staged page swaps its import map and the Excalidraw stylesheet for the local ones", () => {
  const html = [
    '<link rel="stylesheet" href="https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/index.css">',
    '<script type="importmap">{"imports":{"react":"https://esm.sh/react@19.2.8"}}</script>',
  ].join("\n");
  const local = '{"imports":{"react":"/vendor/react.js"}}';
  const page = localPage(html, local);
  assert.equal(importMapOf(page), local);
  assert.match(page, /<link rel="stylesheet" href="\/vendor\/excalidraw\.css">/);
  assert.doesNotMatch(page, /esm\.sh/);
  assert.equal(localPage("<p>no map</p>", local), null, "a page without an import map is not served half-local");
});

test("the vendor route serves known file types from page/vendor only", () => {
  const fs = require("fs");
  const os = require("os");
  const page = fs.mkdtempSync(path.join(os.tmpdir(), "wb-vendor-"));
  try {
    fs.mkdirSync(path.join(page, "vendor", "fonts", "Excalifont"), { recursive: true });
    fs.writeFileSync(path.join(page, "vendor", "react.js"), "export default 1;");
    fs.writeFileSync(path.join(page, "vendor", "fonts", "Excalifont", "a.woff2"), "x");
    fs.writeFileSync(path.join(page, "secret.txt"), "no");
    assert.equal(vendorFile(page, "react.js").type, "text/javascript");
    assert.equal(vendorFile(page, "fonts/Excalifont/a.woff2").type, "font/woff2");
    assert.equal(vendorFile(page, "missing.js"), null);
    assert.equal(vendorFile(page, "../secret.txt"), null);
    assert.equal(vendorFile(page, "..%2Fsecret.txt"), null);
    assert.equal(vendorFile(page, "fonts/../../secret.txt"), null);
    assert.equal(vendorFile(page, "/etc/passwd"), null);
    assert.equal(vendorFile(page, "react.js\\..\\x"), null);
    fs.writeFileSync(path.join(page, "vendor", "run.exe"), "x");
    assert.equal(vendorFile(page, "run.exe"), null, "an unknown type is never served");
  } finally {
    fs.rmSync(page, { recursive: true, force: true });
  }
});

test("Board API refuses requests from other sites (FR-048)", () => {
  assert.equal(isSameOrigin({ headers: { host: "127.0.0.1:47830" } }), true);
  assert.equal(isSameOrigin({ headers: { host: "127.0.0.1:47830", origin: "http://127.0.0.1:47830" } }), true);
  assert.equal(isSameOrigin({ headers: { host: "127.0.0.1:47830", origin: "https://evil.example" } }), false);
  assert.equal(isSameOrigin({ headers: { host: "127.0.0.1:47830", origin: "null" } }), false);
});

test("Control API is for local tools only (FR-049)", () => {
  assert.equal(isLocalTool({ headers: { host: "127.0.0.1:47831" } }, 47831), true);
  assert.equal(isLocalTool({ headers: { host: "localhost:47831" } }, 47831), true);
  assert.equal(isLocalTool({ headers: { host: "127.0.0.1:47831", origin: "http://127.0.0.1:47830" } }, 47831), false);
  assert.equal(isLocalTool({ headers: { host: "evil.example:47831" } }, 47831), false);
});

test("validateAnswer checks text and at", () => {
  assert.equal(validateAnswer({ text: "hi" }, 10), null);
  assert.equal(validateAnswer({ text: "  " }, 10).code, "InvalidText");
  assert.equal(validateAnswer({ text: "x".repeat(11) }, 10).code, "InvalidText");
  assert.equal(validateAnswer({ text: "hi", at: { x: 1 } }, 10).code, "InvalidAt");
  assert.equal(validateAnswer({ text: "hi", at: { x: 1, y: 2 } }, 10), null);
});

test("a certificate is usable only if it names every LAN address and is not about to expire", () => {
  const day = 24 * 60 * 60 * 1000;
  const info = { addresses: ["10.0.0.2"], notAfterMs: 100 * day };
  assert.equal(certIsUsable(info, ["10.0.0.2"], 0), true);
  assert.equal(certIsUsable(info, ["10.0.0.3"], 0), false);
  assert.equal(certIsUsable(info, ["10.0.0.2"], 95 * day), false);
  assert.equal(certIsUsable(null, [], 0), false);
});
