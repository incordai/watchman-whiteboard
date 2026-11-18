"use strict";

// Watchman Whiteboard: the board's Library, and when a drawing is a new one (the owner, 2026-11-17: one board; a new
// drawing first saves the drawing on the board into the board's Library, named with its date and a short title from
// its text, then clears the board and draws on a clean one).
//
// THE RULE (newDrawingDue). An MCP Server names itself on every draw and mermaid request (`drawer`: one id per agent
// session, talk-on-board/scripts/mcp.js). A drawing by another agent than the one who made the board's drawing is new;
// the same agent's next drawing adds to its own (a table under its diagram). `fresh: true` starts anew even for the
// same agent, `fresh: false` adds even for another. A draw whose arrows bind to shapes already on the board builds on
// them and adds. A request that names no drawer (client.js, an older MCP Server) adds, as before.
//
// THE LIBRARY is kept by the board, not by one browser (Excalidraw keeps a page's library only in that page): in
// <data>/library.json, sent to every page in hello and in a `library` event, and changed by a page through POST
// /api/library (a person's own library edits). Wired in server.js (startNewDrawing, the Library routes) and
// board-hub.js (setLibrary, hello); the page applies it in page/app.js (applyLibrary, onLibraryChange).

const fs = require("fs");
const { AppError } = require("./app-error");
const { writeFileAtomic } = require("./data-files");

const LIBRARY_FILE_VERSION = 1;
// The Library keeps the newest items, at most this many.
const MAX_LIBRARY_ITEMS = 100;
const MAX_ITEM_ID_CHARS = 128;
const MAX_NAME_CHARS = 200;
const TITLE_CHARS = 40;
const DRAWER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Whether a drawing starts anew (see THE RULE above).
// @purity pure
function newDrawingDue({ drawer = null, currentDrawer = null, fresh = null, buildsOnBoard = false }) {
  if (fresh === true) return true;
  if (fresh === false || buildsOnBoard || !drawer) return false;
  return drawer !== currentDrawer;
}

// A short title from the drawing's text: the first text from the top left, its spaces made one, at most TITLE_CHARS.
// @purity pure
function drawingTitle(elements) {
  const texts = elements
    .filter((e) => !e.isDeleted && e.type === "text" && typeof e.text === "string" && e.text.trim() !== "")
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  if (texts.length === 0) return "drawing";
  return texts[0].text.replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS);
}

// "YYYY-MM-DD HH:MM" of `nowMs`, in UTC (the same on every computer the board runs on).
// @purity pure
function stamp(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 16).replace("T", " ");
}

// The drawing on the board as an Excalidraw Library item: its live elements (copies), named with its date and title.
// @purity pure
function libraryItemOf(elements, nowMs) {
  const live = elements.filter((e) => !e.isDeleted).map((e) => JSON.parse(JSON.stringify(e)));
  return {
    id: `board-${nowMs}-${Math.random().toString(36).slice(2, 10)}`,
    status: "unpublished",
    created: nowMs,
    name: `${stamp(nowMs)} ${drawingTitle(live)}`.slice(0, MAX_NAME_CHARS),
    elements: live,
  };
}

// `items` with `item` first, at most MAX_LIBRARY_ITEMS (the oldest go).
// @purity pure
function addToLibrary(items, item) {
  return [item, ...items].slice(0, MAX_LIBRARY_ITEMS);
}

// A Library a page sent (POST /api/library): a list of at most MAX_LIBRARY_ITEMS items, each with an id and a list of
// elements. Throws InvalidLibrary otherwise.
// @purity pure
function checkLibrary(items) {
  const bad = (why) => new AppError("InvalidLibrary", 400, `library ${why}`);
  if (!Array.isArray(items)) throw bad("must be a list");
  if (items.length > MAX_LIBRARY_ITEMS) throw bad(`holds at most ${MAX_LIBRARY_ITEMS} items`);
  items.forEach((item, index) => {
    if (!item || typeof item !== "object") throw bad(`item ${index} is not an object`);
    if (typeof item.id !== "string" || item.id === "" || item.id.length > MAX_ITEM_ID_CHARS) throw bad(`item ${index} needs an id`);
    if (!Array.isArray(item.elements)) throw bad(`item ${index} needs elements`);
    if (item.name !== undefined && (typeof item.name !== "string" || item.name.length > MAX_NAME_CHARS)) throw bad(`item ${index} has a bad name`);
  });
  return items;
}

// The drawer a request names (see THE RULE), or null for none. Throws InvalidArguments for anything else.
// @purity pure
function checkDrawer(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !DRAWER_PATTERN.test(value)) {
    throw new AppError("InvalidArguments", 400, "drawer must be 1 to 64 letters, digits, - or _", { field: "drawer" });
  }
  return value;
}

// The Library kept in `filePath`, or [] when there is none or it cannot be read.
// @purity non-pure
function loadLibrary(filePath) {
  try {
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return checkLibrary(stored && stored.items);
  } catch (error) {
    return [];
  }
}

// @purity non-pure
function saveLibrary(filePath, items) {
  writeFileAtomic(filePath, JSON.stringify({ v: LIBRARY_FILE_VERSION, items }));
}

module.exports = {
  newDrawingDue, drawingTitle, libraryItemOf, addToLibrary, checkLibrary, checkDrawer, loadLibrary, saveLibrary,
  MAX_LIBRARY_ITEMS,
};
