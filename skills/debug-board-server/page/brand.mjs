// Watchman Whiteboard: the board page shows only Watchman, none of Excalidraw's own branding (see ../../../UPSTREAM).
// The pure half: which main menu items the page renders, its welcome screen texts, and the Excalidraw labels it
// renames or hides. app.js renders them; test/unit/brand.test.js loads this same file. Excalidraw's MIT credit
// stays in NOTICE.

// MainMenu.DefaultItems of Excalidraw 0.18.1 that the page shows. Left out: Socials (Excalidraw's GitHub, X and
// Discord), LiveCollaborationTrigger (excalidraw.com rooms), LoadScene and SaveToActiveFile (they replace or tie
// the shared board to a file), CommandPalette (it lists Excalidraw's own tools).
export const MENU_ITEMS = Object.freeze(["Export", "SaveAsImage", "SearchMenu", "Help", "ClearCanvas", "ToggleTheme", "ChangeCanvasBackground"]);

// In a Watchman tab, Watchman decides the theme and the canvas colour (look.mjs), so those two items go.
const WATCHMAN_DECIDES = Object.freeze(["ToggleTheme", "ChangeCanvasBackground"]);

export function menuItems(look) {
  return look && look.inWatchman ? MENU_ITEMS.filter((name) => !WATCHMAN_DECIDES.includes(name)) : MENU_ITEMS;
}

// The welcome screen of an empty board, in place of Excalidraw's logo and texts.
export const WELCOME = Object.freeze({
  title: "Watchman Whiteboard",
  heading: "The agent draws and explains here. Draw or write with it.",
});

// Labels of Excalidraw's own UI that name it, and what the page shows instead. Only these exact phrases change.
const RENAMED = Object.freeze([["Mermaid to Excalidraw", "Mermaid to diagram"]]);

// Items of the library menu (.library-menu-dropdown-container) that the page hides: "Publish" uploads library
// items to Excalidraw's public library site.
export const HIDDEN_TEXTS = Object.freeze(["Publish"]);

// Who works on the board, in the page's labels (the owner's rule: nothing names one agent): the agent's own name when
// the board knows it (the MCP server learns it from its client: board-hub.js setSignal), else this word.
export const AGENT_FALLBACK = "Agent";

const SIGNAL_WORDS = Object.freeze({ reading: "reading your text", working: "working on it", waiting: "waiting for you" });

// "<agent>: <what it does>" for a signal, or null for none. Every label says who does what.
export function signalLabel(state, agent) {
  return SIGNAL_WORDS[state] ? `${agent || AGENT_FALLBACK}: ${SIGNAL_WORDS[state]}` : null;
}

// The Send button's tooltip.
export function sendLabel(unsent, agent) {
  const to = agent || "the agent";
  return unsent > 0 ? `Send your text and drawings to ${to} (Ctrl+Shift+Enter): ${unsent} unsent` : `Send to ${to} (Ctrl+Shift+Enter): nothing new to send`;
}

// The text with Excalidraw's labels renamed, or null when nothing changes.
export function rebrand(text) {
  let out = String(text);
  for (const [from, to] of RENAMED) out = out.split(from).join(to);
  return out === text ? null : out;
}
