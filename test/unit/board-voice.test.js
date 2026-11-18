"use strict";

require("../support/private-temp");

// Watchman Whiteboard: the voice character on the board (the owner, 2026-11-17: "the character with voice in
// hands-free is also visible on the whiteboard"). Watchman posts what its voice says to /api/voice (lib/board-voice.js
// checks it); the hub passes it to every page; the page draws the character with the words (page/voice.mjs).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");
const { AppError } = require("../../skills/debug-board-server/scripts/lib/app-error");
const { checkVoice, voiceOrigin, corsHeaders, VOICE_LIMITS } = require("../../skills/debug-board-server/scripts/lib/board-voice");
const { createBoardHub } = require("../../skills/debug-board-server/scripts/lib/board-hub");

const PAGE = path.join(__dirname, "..", "..", "skills", "debug-board-server", "page");
const PICTURE = "data:image/webp;base64,UklGRg==";

test("only Watchman's own origins may post the voice", () => {
  for (const origin of ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"]) {
    assert.equal(voiceOrigin(origin), origin);
  }
  for (const origin of [undefined, "", "https://evil.example", "http://localhost:1421", "http://127.0.0.1:47830", "null"]) {
    assert.equal(voiceOrigin(origin), null, String(origin));
  }
  assert.deepEqual(corsHeaders("tauri://localhost"), {
    "access-control-allow-origin": "tauri://localhost",
    "access-control-allow-methods": "POST",
    "access-control-allow-headers": "content-type, x-board-token",
    "access-control-max-age": "600",
    vary: "Origin",
  });
});

test("checkVoice keeps what the page draws and refuses the rest", () => {
  assert.deepEqual(checkVoice({ speaking: true, text: " Two and three. ", name: "Rin", picture: PICTURE }), { speaking: true, text: "Two and three.", name: "Rin", picture: PICTURE });
  assert.deepEqual(checkVoice({ speaking: false }), { speaking: false, text: "", name: "" });
  assert.equal(checkVoice({ speaking: true, text: "x".repeat(VOICE_LIMITS.text + 50) }).text.length, VOICE_LIMITS.text);
  const refused = (body) => assert.throws(() => checkVoice(body), (error) => error instanceof AppError && error.code === "InvalidVoice");
  refused({});
  refused({ speaking: "yes" });
  refused({ speaking: true, name: "<script>" });
  refused({ speaking: true, picture: "https://example.com/a.png" });
  refused({ speaking: true, picture: "data:image/svg+xml;base64,PHN2Zz4=" });
  refused({ speaking: true, picture: `data:image/png;base64,${"A".repeat(VOICE_LIMITS.pictureChars)}` });
});

test("the hub tells every page, keeps the picture for the next sentences, and gives a new page the last voice", () => {
  const sent = [];
  const hub = createBoardHub({
    elements: new Map(), events: { emit() {} }, clock: { setTimeout, clearTimeout, now: Date.now }, jobTimeoutMs: 1000, gapPx: 10, onBoardChanged() {},
  });
  hub.addPage("pageAAAAAAAA", (type, data) => sent.push({ type, data }), true);
  assert.deepEqual(sent.find((m) => m.type === "hello").data.voice, { speaking: false, text: "", name: "", picture: null, model: null });
  hub.setVoice({ speaking: true, text: "One.", name: "Rin", picture: PICTURE });
  hub.setVoice({ speaking: true, text: "Two.", name: "Rin" });
  assert.deepEqual(sent.filter((m) => m.type === "voice").map((m) => m.data), [
    { speaking: true, text: "One.", name: "Rin", picture: PICTURE, model: null },
    { speaking: true, text: "Two.", name: "Rin", picture: PICTURE, model: null },
  ]);
  const late = [];
  hub.addPage("pageBBBBBBBB", (type, data) => late.push({ type, data }), true);
  assert.deepEqual(late.find((m) => m.type === "hello").data.voice, { speaking: true, text: "Two.", name: "Rin", picture: PICTURE, model: null });
  hub.close();
});

test("the page shows the character while it speaks, its words as a subtitle, and a plain mark with no picture", async () => {
  const { voiceView } = await import(pathToFileURL(path.join(PAGE, "voice.mjs")).href);
  assert.deepEqual(voiceView({ speaking: true, text: "The roots are two and three.", name: "Rin", picture: PICTURE }), {
    shown: true, picture: PICTURE, name: "Rin", subtitle: "The roots are two and three.", label: "Rin is speaking", model: null,
  });
  assert.deepEqual(voiceView({ speaking: true, text: "Hello.", name: "", picture: null }), {
    shown: true, picture: null, name: "", subtitle: "Hello.", label: "Speaking", model: null,
  });
  assert.equal(voiceView({ speaking: false, text: "", name: "Rin", picture: PICTURE }).shown, false);
  assert.equal(voiceView(null).shown, false);
});

// ---- The same 3-D character as Watchman (the owner, 2026-11-17): Watchman names the .vrm and the clips its voice
// mode draws; the board serves those files to its pages, which never see where they are. ----

const fs = require("fs");
const os = require("os");
const { voiceModel, voiceFile, VOICE_FILE_LIMITS } = require("../../skills/debug-board-server/scripts/lib/board-voice");

// @purity non-pure
function characterFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-voice-"));
  fs.writeFileSync(path.join(dir, "rin.vrm"), "vrm bytes");
  fs.mkdirSync(path.join(dir, "clips"));
  fs.writeFileSync(path.join(dir, "clips", "idle_relaxed.vrma"), "clip one");
  fs.writeFileSync(path.join(dir, "clips", "wave_hello.vrma"), "clip two");
  return dir;
}

test("checkVoice takes the character's .vrm and its .vrma clips by absolute path, and refuses anything else", () => {
  const dir = characterFolder();
  const character = path.join(dir, "rin.vrm");
  const clips = [path.join(dir, "clips", "idle_relaxed.vrma"), path.join(dir, "clips", "wave_hello.vrma")];
  assert.deepEqual(checkVoice({ speaking: true, text: "Hi.", name: "Rin", character, clips }), { speaking: true, text: "Hi.", name: "Rin", character, clips });
  assert.deepEqual(checkVoice({ speaking: true, character }), { speaking: true, text: "", name: "", character, clips: [] });
  const refused = (body) => assert.throws(() => checkVoice({ speaking: true, ...body }), (error) => error instanceof AppError && error.code === "InvalidVoice");
  refused({ character: "rin.vrm" });
  refused({ character: path.join(dir, "rin.glb") });
  refused({ character: `${character}\u0000.vrm` });
  refused({ character, clips: "all" });
  refused({ character, clips: ["idle.vrma"] });
  refused({ character, clips: [path.join(dir, "x.vrm")] });
  refused({ character, clips: Array.from({ length: VOICE_FILE_LIMITS.clips + 1 }, (_, i) => path.join(dir, `c${i}.vrma`)) });
  refused({ clips });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("voiceModel tells the pages which character and clips, never where they are", () => {
  const dir = characterFolder();
  const files = { character: path.join(dir, "rin.vrm"), clips: [path.join(dir, "clips", "idle_relaxed.vrma"), path.join(dir, "clips", "wave_hello.vrma")] };
  const model = voiceModel(files);
  assert.match(model.id, /^[0-9a-f]{16}$/);
  assert.deepEqual(model.clips, ["idle_relaxed.vrma", "wave_hello.vrma"]);
  assert.doesNotMatch(JSON.stringify(model), new RegExp(path.basename(dir)));
  assert.equal(voiceModel(files).id, model.id, "the same files, the same id");
  assert.notEqual(voiceModel({ ...files, character: path.join(dir, "other.vrm") }).id, model.id);
  assert.equal(voiceModel(null), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("voiceFile serves the named character and clips only: by index, existing, plain files, under the size limit", () => {
  const dir = characterFolder();
  const files = { character: path.join(dir, "rin.vrm"), clips: [path.join(dir, "clips", "idle_relaxed.vrma"), path.join(dir, "missing.vrma"), path.join(dir, "clips")] };
  assert.deepEqual(voiceFile(files, "character"), { path: files.character, size: 9 });
  assert.deepEqual(voiceFile(files, "clip/0"), { path: files.clips[0], size: 8 });
  for (const part of ["clip/1", "clip/2", "clip/3", "clip/-1", "clip/x", "clip/../rin.vrm", "rin.vrm", ""]) {
    assert.equal(voiceFile(files, part), null, part);
  }
  assert.equal(voiceFile(null, "character"), null);
  assert.equal(voiceFile(files, "character", { character: 4, clip: 4 }), null, "a file over the limit is not served");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the hub keeps the character for the next sentences, as the picture", () => {
  const sent = [];
  const hub = createBoardHub({
    elements: new Map(), events: { emit() {} }, clock: { setTimeout, clearTimeout, now: Date.now }, jobTimeoutMs: 1000, gapPx: 10, onBoardChanged() {},
  });
  hub.addPage("pageAAAAAAAA", (type, data) => sent.push({ type, data }), true);
  const model = { id: "0123456789abcdef", clips: ["idle_relaxed.vrma"] };
  hub.setVoice({ speaking: true, text: "One.", name: "Rin", model });
  hub.setVoice({ speaking: false, text: "", name: "Rin" });
  assert.deepEqual(sent.filter((m) => m.type === "voice").map((m) => m.data.model), [model, model]);
  hub.close();
});

test("the page draws the 3-D character when the board has one, else the picture", async () => {
  const { voiceView } = await import(pathToFileURL(path.join(PAGE, "voice.mjs")).href);
  const model = { id: "0123456789abcdef", clips: ["idle_relaxed.vrma"] };
  assert.deepEqual(voiceView({ speaking: true, text: "Hi.", name: "Rin", picture: PICTURE, model }).model, model);
  assert.equal(voiceView({ speaking: true, text: "Hi.", name: "Rin", picture: PICTURE, model: null }).model, null);
  assert.equal(voiceView({ speaking: true, text: "Hi.", model: { id: "../x", clips: [] } }).model, null);
  assert.equal(voiceView({ speaking: true, text: "Hi.", model: { id: "0123456789abcdef", clips: "x" } }).model, null);
  assert.equal(voiceView({ speaking: false, model }).model, null);
});
