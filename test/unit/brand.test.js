"use strict";

// Watchman Whiteboard: the board page shows only Watchman, none of Excalidraw's own branding (the owner's choice).
// Excalidraw 0.18.1 shows by default: a main menu with an "Excalidraw links" group (Socials: Excalidraw's GitHub,
// X and Discord), a Help dialog whose header links to docs.excalidraw.com, plus.excalidraw.com/blog, Excalidraw's
// GitHub issues and YouTube, a "Browse libraries" button to libraries.excalidraw.com, a "Publish" library menu
// item (uploads to libraries.excalidraw.com) and the label "Mermaid to Excalidraw" (More tools, command palette,
// the Mermaid dialog title). These tests check what can be checked without a browser: the pure text map, the
// menu items the page renders, and the page sources. How it looks needs the browser check.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const PAGE = path.join(__dirname, "..", "..", "skills", "debug-board-server", "page");
const load = () => import(pathToFileURL(path.join(PAGE, "brand.mjs")).href);
// MainMenu.DefaultItems of Excalidraw 0.18.1 (dist/types/excalidraw/components/main-menu/DefaultItems.d.ts).
const DEFAULT_ITEMS_0_18_1 = [
  "LoadScene", "SaveToActiveFile", "SaveAsImage", "CommandPalette", "SearchMenu", "Help", "ClearCanvas",
  "ToggleTheme", "ChangeCanvasBackground", "Export", "Socials", "LiveCollaborationTrigger",
];

test("the menu has only useful board actions: no Socials, no collaboration, no file-handle items", async () => {
  const { MENU_ITEMS } = await load();
  assert.deepEqual(MENU_ITEMS, ["Export", "SaveAsImage", "SearchMenu", "Help", "ClearCanvas", "ToggleTheme", "ChangeCanvasBackground"]);
  for (const name of MENU_ITEMS) assert.ok(DEFAULT_ITEMS_0_18_1.includes(name), `${name} is an item of Excalidraw 0.18.1`);
  for (const name of ["Socials", "LiveCollaborationTrigger", "LoadScene", "SaveToActiveFile", "CommandPalette"]) {
    assert.equal(MENU_ITEMS.includes(name), false, name);
  }
});

test("inside Watchman the menu has no theme or canvas colour items: Watchman decides the look", async () => {
  const { MENU_ITEMS, menuItems } = await load();
  assert.deepEqual(menuItems({ inWatchman: false }), MENU_ITEMS);
  assert.deepEqual(menuItems({ inWatchman: true }), ["Export", "SaveAsImage", "SearchMenu", "Help", "ClearCanvas"]);
});

test("the welcome screen never names the palette's Send, which the page no longer shows", async () => {
  const { WELCOME } = await load();
  assert.doesNotMatch(WELCOME.heading, /\bSend\b/);
});

test("the right-hand palette is not rendered: its Send reaches only an agent watching with Claude's Monitor", () => {
  const app = fs.readFileSync(path.join(PAGE, "app.js"), "utf8");
  assert.doesNotMatch(app, /renderTopRightUI/);
});

test("rebrand changes only the known Excalidraw labels", async () => {
  const { rebrand, HIDDEN_TEXTS, WELCOME } = await load();
  assert.equal(rebrand("Mermaid to Excalidraw"), "Mermaid to diagram");
  assert.equal(rebrand("Mermaid to Excalidraw..."), "Mermaid to diagram...");
  assert.equal(rebrand("Export image..."), null, "anything else stays");
  assert.equal(rebrand("I like Excalidraw"), null, "a Person's text is never changed");
  assert.deepEqual(HIDDEN_TEXTS, ["Publish"]);
  assert.equal(WELCOME.title, "Watchman Whiteboard");
  assert.doesNotMatch(JSON.stringify(WELCOME), /excalidraw/i);
});

test("the page renders its own main menu and welcome screen and hides Excalidraw's links", () => {
  const app = fs.readFileSync(path.join(PAGE, "app.js"), "utf8");
  const html = fs.readFileSync(path.join(PAGE, "index.html"), "utf8");
  const block = /import\s*\{([^}]*)\}\s*from\s*"@excalidraw\/excalidraw"/.exec(app)[1];
  assert.match(block, /\bMainMenu\b/);
  assert.match(block, /\bWelcomeScreen\b/);
  assert.match(app, /h\(Excalidraw, \{[\s\S]*?\}, h\(BoardMenu\), h\(BoardWelcome\)\)/, "Excalidraw gets our menu and welcome screen as children");
  assert.match(app, /menuItems\(look\)\.map\(\(name\) => h\(MainMenu\.DefaultItems\[name\]/);
  assert.match(app, /h\(WelcomeScreen\.Center\.Logo, null, WELCOME\.title\)/, "our name in place of the Excalidraw logo");
  assert.match(app, /new MutationObserver\(/);
  for (const source of [app, html]) assert.doesNotMatch(source, /excalidraw\.com/);
  for (const selector of [".library-menu-browse-button", ".HelpDialog__header"]) {
    assert.ok(html.includes(`${selector} { display: none !important; }`), selector);
  }
});
