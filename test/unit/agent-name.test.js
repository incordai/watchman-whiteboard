"use strict";

// Watchman Whiteboard (the owner's rule): nothing on the board page names one agent. The page says who works with the
// agent's own name when it knows it (the MCP client's name at initialize: Claude Code, Codex, agy), else "Agent".

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { agentNameOf } = require("../../skills/talk-on-board/scripts/mcp");
const { createBoardHub } = require("../../skills/debug-board-server/scripts/lib/board-hub");

const PAGE = path.join(__dirname, "..", "..", "skills", "debug-board-server", "page");
const loadBrand = () => import(pathToFileURL(path.join(PAGE, "brand.mjs")).href);

test("the MCP client's name gives the agent's own name, and nothing else does", () => {
  assert.equal(agentNameOf({ name: "claude-code", version: "2.1.0" }), "Claude");
  assert.equal(agentNameOf({ name: "codex-mcp-client", version: "0.80" }), "Codex");
  assert.equal(agentNameOf({ name: "Codex" }), "Codex");
  assert.equal(agentNameOf({ name: "antigravity" }), "agy");
  assert.equal(agentNameOf({ name: "agy" }), "agy");
  assert.equal(agentNameOf({ name: "gemini-cli-mcp-client" }), "agy");
  assert.equal(agentNameOf({ name: "some-other-client" }), null);
  assert.equal(agentNameOf(undefined), null);
});

test("the page's labels use the agent's name, or a neutral word, and never a fixed agent", async () => {
  const { signalLabel, sendLabel } = await loadBrand();
  assert.equal(signalLabel("reading", "Codex"), "Codex: reading your text");
  assert.equal(signalLabel("working", null), "Agent: working on it");
  assert.equal(signalLabel("waiting", "agy"), "agy: waiting for you");
  assert.equal(signalLabel("none", "Claude"), null);
  assert.equal(sendLabel(3, "Codex"), "Send your text and drawings to Codex (Ctrl+Shift+Enter): 3 unsent");
  assert.equal(sendLabel(0, null), "Send to the agent (Ctrl+Shift+Enter): nothing new to send");
});

test("the page source names no agent in what it shows", () => {
  const app = fs.readFileSync(path.join(PAGE, "app.js"), "utf8");
  // Strings the page shows: the double-quoted and template literals outside comments.
  const shown = app.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n").match(/"[^"\n]*"|`[^`]*`/g) || [];
  for (const text of shown) assert.doesNotMatch(text, /\b(Claude|Codex|Gemini)\b/, text);
});

test("the hub keeps who sent the signal and tells every page, and a new page learns it in hello", () => {
  const sent = [];
  const hub = createBoardHub({
    elements: new Map(), events: { emit() {} }, clock: { setTimeout, clearTimeout, now: Date.now }, jobTimeoutMs: 1000, gapPx: 10,
    onBoardChanged() {},
  });
  hub.addPage("pageAAAAAAAA", (type, data) => sent.push({ type, data }), true);
  hub.setSignal("reading", "Codex");
  assert.deepEqual(sent.filter((m) => m.type === "signal").map((m) => m.data), [{ state: "reading", agent: "Codex" }]);
  hub.setSignal("working", "Codex");
  hub.setSignal("working", "agy");
  assert.deepEqual(sent.filter((m) => m.type === "signal").map((m) => m.data).slice(-2), [{ state: "working", agent: "Codex" }, { state: "working", agent: "agy" }]);
  const late = [];
  hub.addPage("pageBBBBBBBB", (type, data) => late.push({ type, data }), true);
  assert.equal(late.find((m) => m.type === "hello").data.agent, "agy");
  hub.setSignal("none", "not a name!");
  assert.equal(sent.filter((m) => m.type === "signal").pop().data.agent, null, "a name that is not a name is dropped");
  hub.close();
});
