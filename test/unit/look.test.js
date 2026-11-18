"use strict";

// Watchman Whiteboard follows Watchman's look (the owner, 2026-11-17: "when the app is dark it's dark, with the
// same transparency as Watchman's main app"). Watchman opens the board with hash params (wm=1, theme, glass);
// page/look.mjs reads them, and the page applies them live on every hash change. Elsewhere (the system browser)
// nothing changes: Excalidraw's own theme and canvas.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const PAGE = path.join(__dirname, "..", "..", "skills", "debug-board-server", "page");
const load = () => import(pathToFileURL(path.join(PAGE, "look.mjs")).href);

test("outside Watchman the page keeps Excalidraw's own look", async () => {
  const { lookFromHash } = await load();
  for (const hash of ["", "#t=abc", "#t=abc&anim=1", "#theme=dark&glass=1"]) {
    assert.deepEqual(lookFromHash(hash), { inWatchman: false, theme: null, glass: false }, hash);
  }
});

test("in Watchman the page takes Watchman's theme and glass", async () => {
  const { lookFromHash } = await load();
  assert.deepEqual(lookFromHash("#t=abc&wm=1&theme=dark&glass=1"), { inWatchman: true, theme: "dark", glass: true });
  assert.deepEqual(lookFromHash("#wm=1&theme=light&glass=0"), { inWatchman: true, theme: "light", glass: false });
  assert.deepEqual(lookFromHash("wm=1&theme=light"), { inWatchman: true, theme: "light", glass: false }, "no leading #");
});

test("only known values are taken: a wrong theme or glass is ignored", async () => {
  const { lookFromHash } = await load();
  assert.equal(lookFromHash("#wm=1&theme=purple").theme, null);
  assert.equal(lookFromHash("#wm=1&glass=yes").glass, false, "glass only with 1");
});

test("the canvas behind the drawing: see-through with glass, Excalidraw's own without", async () => {
  const { canvasBackground } = await load();
  assert.equal(canvasBackground({ inWatchman: true, theme: "dark", glass: true }), "transparent");
  assert.equal(canvasBackground({ inWatchman: true, theme: "dark", glass: false }), "#ffffff", "its dark theme shows it dark");
  assert.equal(canvasBackground({ inWatchman: true, theme: "light", glass: false }), "#ffffff");
  assert.equal(canvasBackground({ inWatchman: false, theme: null, glass: false }), null, "outside Watchman: untouched");
});

// The owner, 2026-11-17: clicking or dragging on the board selected things and opened the properties, because
// Excalidraw starts on the selection tool. The board starts on the Hand (dragging pans, nothing is selected or
// moved by accident), again after a new drawing clears the board, and never otherwise: the tool the owner picks
// stays while the page is open. Fails if the first scene is not on the Hand, or a look change touches the tool.
test("the board starts on the Hand tool, with Watchman's canvas, and a look change never touches the tool", async () => {
  const { firstAppState, lookAppState, HAND_TOOL } = await load();
  const inWatchman = { inWatchman: true, theme: "dark", glass: true };
  assert.deepEqual(firstAppState(inWatchman), { activeTool: HAND_TOOL, viewBackgroundColor: "transparent" });
  assert.deepEqual(firstAppState({ inWatchman: false, theme: null, glass: false }), { activeTool: HAND_TOOL }, "outside Watchman too");
  assert.equal(HAND_TOOL.type, "hand");
  assert.equal(HAND_TOOL.locked, false);
  assert.deepEqual(lookAppState(inWatchman), { viewBackgroundColor: "transparent" });
  assert.equal(lookAppState({ inWatchman: false, theme: null, glass: false }), null);
  for (const look of [inWatchman, { inWatchman: true, theme: "light", glass: false }]) {
    assert.equal("activeTool" in (lookAppState(look) || {}), false, "the owner's tool stays");
  }
});
