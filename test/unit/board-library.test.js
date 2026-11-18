"use strict";

// Watchman Whiteboard: the board's Library and when a drawing is a new one (the owner, 2026-11-17: before a new
// drawing, the old one goes into the board's Library, named with its date and a short title, and the board is
// cleared, so each drawing starts on a clean board).

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  newDrawingDue, libraryItemOf, drawingTitle, addToLibrary, checkLibrary, checkDrawer, MAX_LIBRARY_ITEMS,
} = require("../../skills/debug-board-server/scripts/lib/board-library");

// @purity pure
function el(id, extra = {}) {
  return { id, type: "rectangle", version: 1, versionNonce: 1, isDeleted: false, x: 0, y: 0, width: 10, height: 10, ...extra };
}

test("a drawing is new for another agent, and adds to the same agent's own drawing", () => {
  assert.equal(newDrawingDue({ drawer: "agent-b", currentDrawer: "agent-a" }), true, "another agent: new");
  assert.equal(newDrawingDue({ drawer: "agent-a", currentDrawer: "agent-a" }), false, "the same agent adds");
  assert.equal(newDrawingDue({ drawer: "agent-a", currentDrawer: null }), true, "nobody's drawing yet: new");
  // A caller that names no drawer (client.js, an older MCP Server) adds, as before.
  assert.equal(newDrawingDue({ drawer: null, currentDrawer: "agent-a" }), false);
  // fresh says it outright; arrows bound to shapes already on the board build on them.
  assert.equal(newDrawingDue({ drawer: "agent-a", currentDrawer: "agent-a", fresh: true }), true);
  assert.equal(newDrawingDue({ drawer: "agent-b", currentDrawer: "agent-a", fresh: false }), false);
  assert.equal(newDrawingDue({ drawer: "agent-b", currentDrawer: "agent-a", buildsOnBoard: true }), false);
  assert.equal(newDrawingDue({ drawer: "agent-b", currentDrawer: "agent-a", buildsOnBoard: true, fresh: true }), true);
});

test("the old drawing becomes a Library item named with its date and a short title from its text", () => {
  const nowMs = Date.UTC(2026, 10, 17, 14, 5);
  const elements = [
    el("box", { x: 0, y: 100 }),
    el("t2", { type: "text", text: "second", x: 0, y: 200 }),
    el("t1", { type: "text", text: "  Login   flow:\nsign in  ", x: 50, y: 10 }),
    el("gone", { type: "text", text: "deleted", y: 0, isDeleted: true }),
  ];
  const item = libraryItemOf(elements, nowMs);
  assert.equal(item.status, "unpublished");
  assert.equal(item.created, nowMs);
  assert.equal(item.name, "2026-11-17 14:05 Login flow: sign in");
  assert.match(item.id, /^board-\d+-[a-z0-9]+$/);
  assert.deepEqual(item.elements.map((e) => e.id).sort(), ["box", "t1", "t2"], "deleted elements are left out");
  assert.notEqual(item.elements[0], elements[0], "a copy, not the board's own objects");
  assert.equal(drawingTitle([el("a")]), "drawing", "no text: a plain title");
  assert.equal(drawingTitle([el("t", { type: "text", text: "x".repeat(80) })]).length, 40);
});

test("the Library keeps the newest items first, at most MAX_LIBRARY_ITEMS", () => {
  const items = Array.from({ length: MAX_LIBRARY_ITEMS }, (_, i) => ({ id: `old${i}`, status: "unpublished", created: i, elements: [] }));
  const next = addToLibrary(items, { id: "new", status: "unpublished", created: 999, elements: [] });
  assert.equal(next.length, MAX_LIBRARY_ITEMS);
  assert.equal(next[0].id, "new");
  assert.equal(next.some((item) => item.id === `old${MAX_LIBRARY_ITEMS - 1}`), false, "the oldest went");
  assert.equal(items.length, MAX_LIBRARY_ITEMS, "the old list is not changed");
});

test("a Library a page sends is a list of items with an id and elements; anything else is refused", () => {
  const good = [{ id: "a1", status: "unpublished", created: 1, elements: [el("x")], name: "n" }];
  assert.deepEqual(checkLibrary(good), good);
  assert.deepEqual(checkLibrary([]), []);
  for (const bad of [null, {}, [{}], [{ id: "", elements: [] }], [{ id: "a", elements: "x" }], [{ id: "a".repeat(200), elements: [] }]]) {
    assert.throws(() => checkLibrary(bad), { code: "InvalidLibrary" }, JSON.stringify(bad).slice(0, 60));
  }
  assert.throws(() => checkLibrary(Array.from({ length: MAX_LIBRARY_ITEMS + 1 }, (_, i) => ({ id: `i${i}`, elements: [] }))), { code: "InvalidLibrary" });
});

test("a drawer is a short plain id, or none", () => {
  assert.equal(checkDrawer(undefined), null);
  assert.equal(checkDrawer("mcp-1a2B_c"), "mcp-1a2B_c");
  for (const bad of ["", "a b", "x".repeat(65), 5, "a\nb"]) assert.throws(() => checkDrawer(bad), { code: "InvalidArguments" });
});
