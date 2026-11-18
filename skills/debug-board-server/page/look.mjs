// Watchman Whiteboard follows Watchman's look (see ../../../UPSTREAM; the owner, 2026-11-17: "when the app is dark
// it's dark, with the same transparency as Watchman's main app"). The pure half: what the hash params Watchman
// adds to the board link say. app.js applies it, again on every hash change; test/unit/look.test.js loads this file.
//
//   wm=1               opened in a Watchman tab (without it, nothing here applies: Excalidraw's own look)
//   theme=dark|light   Watchman's colour scheme
//   glass=1            Watchman's glass is on: the tab's page is see-through, so the canvas is too

export function lookFromHash(hash) {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  if (params.get("wm") !== "1") return { inWatchman: false, theme: null, glass: false };
  const theme = params.get("theme");
  return {
    inWatchman: true,
    theme: theme === "dark" || theme === "light" ? theme : null,
    glass: params.get("glass") === "1",
  };
}

// The canvas behind the drawing: see-through with glass; without it Excalidraw's own white, which its dark theme
// shows dark (it inverts the whole canvas, background included, so a dark colour here would show light).
// null outside Watchman: the board's canvas stays as it is.
export function canvasBackground(look) {
  if (!look.inWatchman) return null;
  return look.glass ? "transparent" : "#ffffff";
}

// The Hand tool, as Excalidraw's appState.activeTool names it (the owner, 2026-11-17: clicking or dragging selected
// things and opened the properties, because Excalidraw starts on the selection tool). With the Hand, dragging pans
// and nothing is selected or moved by accident. The agents' drawings do not depend on the tool.
export const HAND_TOOL = Object.freeze({ type: "hand", customType: null, locked: false, fromSelection: false, lastActiveTool: null });

// The first scene's appState: the Hand tool, and Watchman's canvas when the board is in a Watchman tab. app.js App
// passes it as initialData; after a new drawing clears the board (the `cleared` event) the page picks the Hand again.
// Nothing else sets the tool, so the one the owner picks stays while the page is open.
export function firstAppState(look) {
  const background = canvasBackground(look);
  return { activeTool: HAND_TOOL, ...(background !== null ? { viewBackgroundColor: background } : {}) };
}

// What a look change (a new hash from Watchman) changes in appState: the canvas only, never the tool. null: nothing.
export function lookAppState(look) {
  const background = canvasBackground(look);
  return background === null ? null : { viewBackgroundColor: background };
}
