"use strict";

require("../support/private-temp");

// Watchman Whiteboard: POST /api/voice on the real board server. Watchman's own origin with the board's token gets in
// (with its CORS answer, and the preflight answered); any other site, or no token, is refused; a page hears the voice.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { boardWithPage, until } = require("../support/mcp-harness");

// Above the live board's 47830 and clear of the other test files' ports.
const PORT = 48000 + Math.floor(Math.random() * 300) * 2;

// @purity non-pure
function request(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? "" : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: urlPath, headers: { ...headers, "content-length": Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("Watchman posts the voice to the board, and only Watchman with the board's token can", async () => {
  const { page, token, close } = await boardWithPage("voice", PORT);
  try {
    const json = { "content-type": "application/json" };
    const preflight = await request("OPTIONS", "/api/voice", { origin: "tauri://localhost", "access-control-request-method": "POST" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], "tauri://localhost");
    assert.match(preflight.headers["access-control-allow-headers"], /x-board-token/);

    const posted = await request("POST", "/api/voice", { ...json, origin: "tauri://localhost", "x-board-token": token }, { speaking: true, text: "Two and three.", name: "Rin" });
    assert.equal(posted.status, 200, posted.text);
    assert.equal(posted.headers["access-control-allow-origin"], "tauri://localhost");
    const heard = await until(() => page.received.find((m) => m.type === "voice"), 5000, "voice event");
    assert.deepEqual(heard.data, { speaking: true, text: "Two and three.", name: "Rin", picture: null, model: null });

    const otherSite = await request("POST", "/api/voice", { ...json, origin: "https://evil.example", "x-board-token": token }, { speaking: true, text: "x" });
    assert.equal(otherSite.status, 403);
    assert.equal(otherSite.headers["access-control-allow-origin"], undefined);
    const noPreflight = await request("OPTIONS", "/api/voice", { origin: "https://evil.example" });
    assert.equal(noPreflight.headers["access-control-allow-origin"], undefined);
    const noToken = await request("POST", "/api/voice", { ...json, origin: "tauri://localhost" }, { speaking: true, text: "x" });
    assert.equal(noToken.status, 403);
    const bad = await request("POST", "/api/voice", { ...json, origin: "tauri://localhost", "x-board-token": token }, { speaking: "loud" });
    assert.equal(bad.status, 400);
    assert.equal(page.received.filter((m) => m.type === "voice").length, 1, "nothing refused reached the page");
  } finally {
    assert.equal(await close(), 0);
  }
});

// The same 3-D character as Watchman (the owner, 2026-11-17): Watchman names its .vrm and clips; the page hears which
// character it is, never where its files are, and fetches them from the board with the Token.
test("the board serves the character Watchman names to its pages, with the token, and nothing else", async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-character-"));
  const character = path.join(dir, "rin.vrm");
  const clip = path.join(dir, "idle_relaxed.vrma");
  fs.writeFileSync(character, "the character's bytes");
  fs.writeFileSync(clip, "the clip's bytes");
  // Its own ports: the board on PORT + 2, its control on PORT + 3 (the test above has PORT and PORT + 1).
  const { page, token, close } = await boardWithPage("voice-character", PORT + 2);
  const at = (method, urlPath, headers, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? "" : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: PORT + 2, method, path: urlPath, headers: { ...headers, "content-length": Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(data);
  });
  try {
    const page_ = { "x-board-token": token };
    assert.equal((await at("GET", "/api/voice/character", page_)).status, 404, "no character before Watchman names one");
    const posted = await at("POST", "/api/voice", { "content-type": "application/json", origin: "tauri://localhost", "x-board-token": token }, {
      speaking: true, text: "Hello.", name: "Rin", character, clips: [clip],
    });
    assert.equal(posted.status, 200, posted.text);
    const heard = await until(() => page.received.find((m) => m.type === "voice"), 5000, "voice event");
    assert.match(heard.data.model.id, /^[0-9a-f]{16}$/);
    assert.deepEqual(heard.data.model.clips, ["idle_relaxed.vrma"]);
    assert.doesNotMatch(JSON.stringify(heard.data), /wb-character-/, "no path reaches the page");

    const got = await at("GET", "/api/voice/character", page_);
    assert.equal(got.status, 200);
    assert.equal(got.text, "the character's bytes");
    assert.equal(got.headers["content-type"], "application/octet-stream");
    assert.equal((await at("GET", "/api/voice/clip/0", page_)).text, "the clip's bytes");
    assert.equal((await at("GET", "/api/voice/clip/1", page_)).status, 404);
    assert.equal((await at("GET", "/api/voice/character", {})).status, 403, "no token");
    assert.equal((await at("GET", "/api/voice/character", { ...page_, origin: "https://evil.example" })).status, 403, "another site");
    // The next sentence comes without the files: the page keeps the character.
    await at("POST", "/api/voice", { "content-type": "application/json", origin: "tauri://localhost", "x-board-token": token }, { speaking: true, text: "Again." });
    const again = await until(() => page.received.filter((m) => m.type === "voice")[1], 5000, "second voice event");
    assert.equal(again.data.model.id, heard.data.model.id);
  } finally {
    assert.equal(await close(), 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
