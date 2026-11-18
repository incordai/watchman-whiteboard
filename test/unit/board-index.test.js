"use strict";

// Watchman Whiteboard: the board's "what can I draw" index (lib/board-index.js, the board_index tool): one short line
// per subject naming its tool, so any agent picks the right one. Every draw tool is in it, every tool it names exists,
// it says how to correct a drawing, and it names no one agent.

const test = require("node:test");
const assert = require("node:assert/strict");
const { BOARD_INDEX, boardIndexText } = require("../../skills/talk-on-board/scripts/lib/board-index");
const { TOOLS, INSTRUCTIONS } = require("../../skills/talk-on-board/scripts/mcp");

const names = TOOLS.map((tool) => tool.name);

test("every draw tool and check_math is in the index, and every tool the index names exists", () => {
  const indexed = new Set(BOARD_INDEX.flatMap((row) => row.tools));
  for (const name of names.filter((n) => n.startsWith("draw_") || n === "check_math")) assert.ok(indexed.has(name), `${name} is in the index`);
  for (const name of indexed) assert.ok(names.includes(name), `${name} is a tool`);
});

test("the index covers every school and university subject the owner named", () => {
  const text = boardIndexText();
  for (const subject of ["Mathematics", "Statistics", "Geometry", "Physics", "Chemistry", "Biology", "Geography", "History", "Music", "Computer science", "Languages", "Economics"]) {
    assert.match(text, new RegExp(`^${subject}\\b`, "m"), subject);
  }
  assert.match(text, /replace=PREFIX/);
  assert.match(text, /edit_items/);
  assert.doesNotMatch(text, /Claude|Codex|Gemini|\bagy\b/);
  assert.ok(text.split("\n").every((line) => line.length <= 160), "short lines");
});

test("the board_index tool gives the index, and the instructions point to it", () => {
  const tool = TOOLS.find((t) => t.name === "board_index");
  assert.ok(tool);
  assert.doesNotMatch(tool.description, /Claude|Codex|Gemini/);
  assert.match(INSTRUCTIONS, /board_index/);
  assert.match(INSTRUCTIONS, /replace=PREFIX/);
});
