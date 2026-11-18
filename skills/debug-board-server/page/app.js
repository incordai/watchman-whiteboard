// Whiteboard page. Shows the Excalidraw component, keeps the Board in step with the Server,
// and, on the Leader page, writes Answers, lays out Claude's drawings, and takes Screenshots (spec 3.6).
// Plain browser module: no build step. React and Excalidraw come from esm.sh (see the import map).

import React from "react";
import { createRoot } from "react-dom/client";
import {
  Excalidraw,
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  getCommonBounds,
  MainMenu,
  newElementWith,
  reconcileElements,
  restoreElements,
  WelcomeScreen,
} from "@excalidraw/excalidraw";
// Watchman Whiteboard: the page's own menu and welcome screen, no Excalidraw branding (see ../../../UPSTREAM).
import { HIDDEN_TEXTS, WELCOME, menuItems, rebrand, sendLabel, signalLabel } from "/brand.mjs";
// Watchman Whiteboard: Watchman's theme and glass, from the link's hash (see ../../../UPSTREAM).
import { canvasBackground, firstAppState, HAND_TOOL, lookAppState, lookFromHash } from "/look.mjs";
// Watchman Whiteboard: Watchman's voice character on the board (see ../../../UPSTREAM).
import { VOICE_LINGER_MS, voiceView } from "/voice.mjs";
// Watchman Whiteboard: the pure half of the drawing animation (see ../../../UPSTREAM).
import {
  ANIMATION_MARK, REVEAL, SAY_EVENT, animationSpeed, asLinear, isAnimationTemp, outlinePoints, polylineAt,
  progressAt, revealPlan, revealSchedule, revealTimeline, sayDetail, textAt,
} from "/reveal.mjs";

const h = React.createElement;
const FLUSH_MS = 150;
const RETRY_MS = 1000;
// The agent's ink: Watchman's clay (the owner, 2026-11-17; it was blue). The same as scripts/lib/agent-ink.js
// AGENT_INK, which this browser module cannot load: change both together.
const ANSWER_COLOR = "#d97757";
const ANSWER_FONT_SIZE = 20;
const ANSWER_MARK = "answer";
const CLAUDE_MARK = "claudeItem";
const SHOT_BOX = Object.freeze({ width: 1600, height: 1000 });
const SHOT_MAX_PX = 2000;
// A small board is drawn at up to twice its size, as before 0.5.2 (maxWidthOrHeight made it SHOT_MAX_PX wide).
const SHOT_MAX_SCALE = 2;
// Room around the drawing, so rough strokes and labels at the edge are not cut (FR-118).
const SHOT_PADDING_PX = 40;
// The fonts of Answers: Excalifont, and Xiaolai for Chinese and Japanese characters.
const ANSWER_FONT = `${ANSWER_FONT_SIZE}px Excalifont, Xiaolai`;
// The Server sends "ping" every 20 s. Without any message for this long, open the stream again (FR-023a).
const STREAM_STALE_MS = 50000;
const WATCH_STREAM_MS = 5000;
// Excalidraw lays out labels and bound arrows of new Elements again: at once, and after a font loads.
// For this long after the page shows Elements from the Server, such changes are not sent (see settleLayout).
const LAYOUT_SETTLE_MS = 2500;
// How long the first fit waits for the canvas to get a size (R-185).
const FIT_WAIT_MS = 3000;
// Time for Excalidraw to finish the text after the editor loses focus.
const BLUR_WAIT_MS = 50;
const BLUR_TRIES = 20;
// Every label is "<agent>: <verb> <object>", so it is clear who does what (the owner's rule); the agent is the one
// that sent the signal (status.agent), else a neutral word: brand.mjs signalLabel and sendLabel.
// The glyphs of the palette (0.7.2, R-058). They follow gr-scheduler FR-029: one viewBox for all, stroke 2,
// round caps and joins, no fill, currentColor. IC-53 (grip) and IC-75 (fold) are borrowed from gr-scheduler.
const GLYPH = Object.freeze({
  grip: '<g fill="currentColor" stroke="none"><circle cx="9" cy="7.5" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="9" cy="16.5" r="1.3"/><circle cx="15" cy="7.5" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="15" cy="16.5" r="1.3"/></g>',
  send: '<path d="M21 3 L10 14"/><path d="M21 3 L14.5 21 L10 14 L3 9.5 Z"/>',
  auto: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 10 V13.5 L14.5 15.5"/><path d="M9.5 2.5 H14.5"/><path d="M18.5 5.5 L20 4"/>',
  reading: '<path d="M2 12 C4.5 7 8 5 12 5 C16 5 19.5 7 22 12 C19.5 17 16 19 12 19 C8 19 4.5 17 2 12 Z"/><circle cx="12" cy="12" r="3"/>',
  working: '<path d="M21 12 A9 9 0 1 1 15.5 3.7"/>',
  waiting: '<path d="M4 9 V17 L6 19 H14 L16 17 V9 Z"/><path d="M16 11 H19 L20 12.5 L19 15 H16"/><path d="M8 3 V6"/><path d="M12 3 V6"/>',
  link: '<path d="M10 13.5 A4.5 4.5 0 0 0 16.8 14 L19.6 11.2 A4.5 4.5 0 0 0 13.2 4.8 L11.6 6.4"/><path d="M14 10.5 A4.5 4.5 0 0 0 7.2 10 L4.4 12.8 A4.5 4.5 0 0 0 10.8 19.2 L12.4 17.6"/>',
  unlink: '<path d="M13.2 4.8 A4.5 4.5 0 0 1 19.6 11.2 L18 12.8"/><path d="M10.8 19.2 A4.5 4.5 0 0 1 4.4 12.8 L6 11.2"/><path d="M3 3 L21 21"/>',
  qr: '<rect x="3.5" y="3.5" width="6" height="6" rx="1"/><rect x="14.5" y="3.5" width="6" height="6" rx="1"/><rect x="3.5" y="14.5" width="6" height="6" rx="1"/><path d="M14.5 14.5 H17 M20.5 14.5 V17 M14.5 20.5 H20.5 M17.5 17.5 H17.6"/>',
  fold: '<path d="M6 17 H18"/>',
  // The drawing tools' fold button (ToolsToggle): a pencil while folded, a chevron to fold them away.
  tools: '<path d="M15.5 4.5 L19.5 8.5 L8.5 19.5 H4.5 V15.5 Z"/><path d="M13 7 L17 11"/>',
  collapse: '<path d="M6 15 L12 9 L18 15"/>',
});
const CONNECTION_TEXT = Object.freeze({
  leader: "Watchman Whiteboard: connected (this page writes the agent's answers)",
  member: "Watchman Whiteboard: connected (another page writes the agent's answers)",
  off: "Watchman Whiteboard: not connected, trying again",
});

const token = new URLSearchParams(window.location.hash.slice(1)).get("t") || "";
const pageId = randomId();

let api = null;
let isLeader = false;
let firstHello = true;
let editingId = null;
let editingChanged = false;
let flushTimer = null;
let source = null;
let lastStreamMs = 0;
let reopenTimer = null;
let status = { online: false, leader: false, signal: "none", agent: null, voice: null, unsent: 0, autoSend: false, join: [], idleStopAtMs: null };
// A touch on the page keeps the Server running (0.6.1, FR-159): at most one report every ACTIVITY_MS,
// and at once while the idle warning is shown.
const ACTIVITY_MS = 20000;
let lastActivitySentMs = 0;
let sending = false;
let showStatus = () => {};
// id -> the version that the Server has (sent by us or received from it).
const known = new Map();
// id -> element changed here and not sent yet.
const pending = new Map();
// Ids of image files that the Server has (sent by us or received from it) (FR-081).
const knownFiles = new Set();
let filesRetryTimer = null;
// The last key or pointer press on this page, and id -> when the page showed it from the Server (see settleLayout).
let lastInputMs = 0;
const settling = new Map();

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomNonce() {
  return crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
}

function showNotice(text) {
  const notice = document.getElementById("notice");
  notice.textContent = text;
  notice.style.display = "flex";
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-board-token": token },
    body: JSON.stringify({ page: pageId, ...body }),
  });
  if (!res.ok) {
    const error = new Error(`${path}: HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

function scheduleFlush(delayMs) {
  if (flushTimer === null) flushTimer = setTimeout(flush, delayMs);
}

async function flush() {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  if (pending.size === 0 && !editingChanged) return;
  const list = [...pending.values()];
  pending.clear();
  editingChanged = false;
  for (const element of list) known.set(element.id, element.version);
  try {
    await post("/api/elements", { elements: list, editingId });
  } catch (error) {
    // Send them again later, unless they changed again in the meantime.
    for (const element of list) {
      if (known.get(element.id) === element.version) known.delete(element.id);
      if (!pending.has(element.id)) pending.set(element.id, element);
    }
    editingChanged = true;
    scheduleFlush(RETRY_MS);
  }
}

function collectChanges() {
  if (!api) return;
  for (const element of api.getSceneElementsIncludingDeleted()) {
    // Watchman Whiteboard: the frames of the drawing animation stay on this page (see revealDrawing).
    if (isAnimationTemp(element)) continue;
    if (known.get(element.id) === element.version) continue;
    if (known.has(element.id) && isLayoutOnly(element.id)) known.set(element.id, element.version);
    else pending.set(element.id, element);
  }
  if (pending.size > 0) scheduleFlush(FLUSH_MS);
}

// Sends the image files that the Server does not have yet (FR-081).
async function sendNewFiles() {
  if (!api) return;
  const list = Object.values(api.getFiles()).filter((file) => !knownFiles.has(file.id));
  if (list.length === 0) return;
  for (const file of list) knownFiles.add(file.id);
  const body = list.map((file) => ({ id: file.id, mimeType: file.mimeType, dataURL: file.dataURL, created: file.created }));
  try {
    await post("/api/files", { files: body });
  } catch (error) {
    for (const file of list) knownFiles.delete(file.id);
    if (filesRetryTimer === null) {
      filesRetryTimer = setTimeout(() => {
        filesRetryTimer = null;
        sendNewFiles();
      }, RETRY_MS);
    }
  }
}

function applyRemoteFiles(list) {
  if (!api || !Array.isArray(list) || list.length === 0) return;
  for (const file of list) knownFiles.add(file.id);
  api.addFiles(list);
}

function onChange(elements, appState) {
  const nowEditing = appState.editingTextElement ? appState.editingTextElement.id : null;
  if (nowEditing !== editingId) {
    editingId = nowEditing;
    editingChanged = true;
    scheduleFlush(FLUSH_MS);
  }
  collectChanges();
  sendNewFiles();
}

function isAnswer(element) {
  return Boolean(element.customData && element.customData.grwbKind === ANSWER_MARK);
}

// Scrolls only when the element (or box) is outside the visible part of the Board.
// `target` is what to scroll to: the element itself, or a list of elements.
function showIfHidden(element, target = element) {
  const state = api.getAppState();
  const zoom = state.zoom.value;
  const left = -state.scrollX;
  const top = -state.scrollY;
  const right = left + state.width / zoom;
  const bottom = top + state.height / zoom;
  const inside = element.x >= left && element.y >= top
    && element.x + element.width <= right && element.y + element.height <= bottom;
  if (!inside) api.scrollToContent(target, { animate: true });
  // Watchman Whiteboard: whether it scrolled (the drawing animation waits for the scroll).
  return !inside;
}

// The given Elements and what is bound to them or what they are bound to: labels, arrows, the shapes at arrow ends.
function relatedIds(ids) {
  const out = new Set(ids);
  for (const element of api.getSceneElementsIncludingDeleted()) {
    const start = element.startBinding && element.startBinding.elementId;
    const end = element.endBinding && element.endBinding.elementId;
    if (ids.has(element.containerId) || ids.has(start) || ids.has(end)) out.add(element.id);
    if (!ids.has(element.id)) continue;
    if (element.containerId) out.add(element.containerId);
    if (start) out.add(start);
    if (end) out.add(end);
    for (const bound of Array.isArray(element.boundElements) ? element.boundElements : []) out.add(bound.id);
  }
  return out;
}

// After the page shows Elements from the Server (or from its own Job), Excalidraw lays out their labels
// and bound arrows again and raises their versions. That is not a change by a Person: take it as known,
// do not send it. Sent, it would look like a Person's change (Send, UndoConflict); kept back silently,
// it would beat the next version from the Server, and an undo would not show on this page.
// A change after a key or pointer press on this page is a Person's; it is always sent.
function settleLayout(ids) {
  const sinceMs = Date.now();
  for (const id of relatedIds(ids)) settling.set(id, sinceMs);
}

// True when a new version of this Element is Excalidraw's own layout (see settleLayout).
function isLayoutOnly(id) {
  const sinceMs = settling.get(id);
  if (sinceMs === undefined) return false;
  if (Date.now() - sinceMs > LAYOUT_SETTLE_MS || lastInputMs >= sinceMs) {
    settling.delete(id);
    return false;
  }
  return true;
}

// `fromServer`: the Elements changed the Server's Board, so the Server's copy wins here, unless a Person
// changed the Element on this page and it is not sent yet (FR-021 then decides on the Server).
function applyRemote(list, fromServer = false) {
  if (!api || list.length === 0) return;
  const remote = restoreElements(list, null);
  const newAnswers = remote.filter((element) => isAnswer(element) && !element.isDeleted && !known.has(element.id));
  const newDrawing = remote.filter((element) => isClaudeItem(element) && !element.isDeleted && !known.has(element.id));
  let merged = reconcileElements(api.getSceneElementsIncludingDeleted(), remote, api.getAppState());
  if (fromServer) {
    const take = new Map(remote.filter((element) => !pending.has(element.id) && element.id !== editingId).map((element) => [element.id, element]));
    merged = merged.map((element) => take.get(element.id) || element);
  }
  const remoteVersion = new Map(remote.map((element) => [element.id, element.version]));
  for (const element of merged) {
    if (remoteVersion.get(element.id) === element.version) known.set(element.id, element.version);
  }
  api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
  settleLayout(new Set(remote.map((element) => element.id)));
  if (!firstHello && newAnswers.length > 0) showIfHidden(newAnswers[newAnswers.length - 1]);
  if (!firstHello && newDrawing.length > 0) showAllIfHidden(newDrawing);
}

// The first view shows the whole Board. Excalidraw takes the zoom from the canvas size and the bounds of
// the Items, so it waits until the canvas has a size; with no Item, or a zoom that is not finite, it
// keeps 100% (R-185: a fit at size 0 gave 10% or NaN%).
function fitWhenSized(startMs) {
  const state = api.getAppState();
  if (!(state.width > 0 && state.height > 0) && Date.now() - startMs < FIT_WAIT_MS) {
    requestAnimationFrame(() => fitWhenSized(startMs));
    return;
  }
  const live = api.getSceneElements();
  if (live.length > 0 && state.width > 0 && state.height > 0) api.scrollToContent(live, { fitToContent: true, animate: false });
  requestAnimationFrame(() => {
    const zoom = api.getAppState().zoom.value;
    if (Number.isFinite(zoom) && zoom > 0) return;
    api.updateScene({ appState: { zoom: { value: 1 } }, captureUpdate: CaptureUpdateAction.NEVER });
    if (live.length > 0) api.scrollToContent(live, { fitToContent: false, animate: false });
  });
}

function onHello(data) {
  isLeader = data.leader;
  // The Server may have restarted: it has exactly the files in this list.
  knownFiles.clear();
  applyRemoteFiles(data.files || []);
  applyRemote(data.elements);
  if (isLeader) fixAnswerSizes();
  // Elements and images made here while the Server was away go to the Server now.
  collectChanges();
  sendNewFiles();
  if (firstHello) fitWhenSized(Date.now());
  firstHello = false;
  applyLibrary(data.library || []);
  const inbox = data.inbox || { unsent: 0, autoSend: false };
  const join = Array.isArray(data.join) ? data.join.filter((target) => target && typeof target.url === "string") : [];
  const idleStopAtMs = Number.isFinite(data.idleStopAtMs) ? data.idleStopAtMs : null;
  setStatus({ ...status, online: true, leader: isLeader, signal: data.signal || "none", agent: data.agent || null, ...inbox, join, idleStopAtMs });
  setVoice(data.voice || null);
}

// Watchman Whiteboard: the board's Library is the board's, not this browser's (the Server keeps it in library.json and
// sends it in hello and in `library` events; a new drawing by another agent puts the old one there,
// scripts/lib/board-library.js). The page shows it as Excalidraw's library, and sends a person's own library changes
// back (POST /api/library) once it has the board's, never an empty one from before hello.
let libraryReady = false;
let shownLibrary = "";

function applyLibrary(items) {
  if (api === null || !Array.isArray(items)) return;
  shownLibrary = JSON.stringify(items);
  libraryReady = true;
  Promise.resolve(api.updateLibrary({ libraryItems: items, merge: false })).catch(() => {});
}

function onLibraryChange(items) {
  if (!libraryReady || !Array.isArray(items)) return;
  const json = JSON.stringify(items);
  if (json === shownLibrary) return;
  shownLibrary = json;
  post("/api/library", { items }).catch(() => {});
}

// A timer, not requestAnimationFrame: animation frames stop while the page is not drawn
// (a tab in the background), and Send would then wait for ever.
function shortWait() {
  return new Promise((resolve) => setTimeout(resolve, BLUR_WAIT_MS));
}

// Send: finish the text that is being typed, send the last changes, then tell the Server (FR-072).
async function sendToClaude() {
  if (sending) return;
  sending = true;
  try {
    // Escape in the text editor makes Excalidraw finish the text (its own "finish editing" key).
    const editor = document.querySelector("textarea.excalidraw-wysiwyg");
    if (editor) editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    for (let i = 0; i < BLUR_TRIES && api.getAppState().editingTextElement; i += 1) await shortWait();
    // The text is finished now: tell the Server that nothing is being typed here, or it holds the text back.
    if (editingId !== null) {
      editingId = null;
      editingChanged = true;
    }
    collectChanges();
    await flush();
    await post("/api/send", {});
  } catch (error) {
    setStatus({ ...status, online: false });
  } finally {
    sending = false;
  }
}

// Ctrl+Shift+Enter (Cmd+Shift+Enter on a Mac) sends, also while typing (FR-073).
// Neither Excalidraw 0.18.1 nor the browser uses it on a page; we catch it before Excalidraw sees Ctrl+Enter.
function onKeyDown(event) {
  if (event.key !== "Enter" || !event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey)) return;
  if (event.isComposing) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  sendToClaude();
}

async function setAutoSend(on) {
  try {
    await post("/api/auto-send", { on });
  } catch (error) {
    setStatus({ ...status, online: false });
  }
}

// Text is measured with the font that is loaded now. Excalifont loads late, so wait for it,
// or the width is too small and the end of the line is cut (FR-028).
async function loadAnswerFont(text) {
  try {
    await document.fonts.load(ANSWER_FONT, text);
  } catch (error) {
    // Measure with the fallback font; the text may then be cut.
  }
}

function measure(text, x, y) {
  const [made] = convertToExcalidrawElements([
    { type: "text", x, y, text, fontSize: ANSWER_FONT_SIZE, strokeColor: ANSWER_COLOR },
  ]);
  return made;
}

// Answers that were measured before the font was loaded are too narrow. The Leader fixes them once.
async function fixAnswerSizes() {
  const answers = api.getSceneElements().filter((element) => isAnswer(element) && element.type === "text");
  if (answers.length === 0) return;
  await loadAnswerFont(answers.map((element) => element.text).join(""));
  const fixed = [];
  for (const element of answers) {
    const size = measure(element.text, element.x, element.y);
    if (size.width > element.width + 0.5 || size.height > element.height + 0.5) {
      fixed.push(newElementWith(element, { width: size.width, height: size.height }));
    }
  }
  if (fixed.length === 0) return;
  const byId = new Map(fixed.map((element) => [element.id, element]));
  api.updateScene({
    elements: api.getSceneElementsIncludingDeleted().map((element) => byId.get(element.id) || element),
    captureUpdate: CaptureUpdateAction.NEVER,
  });
}

async function writeAnswer(job) {
  await loadAnswerFont(job.text);
  const made = measure(job.text, job.x, job.y);
  const element = { ...made, customData: { ...(made.customData || {}), grwbKind: ANSWER_MARK } };
  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted(), element],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  known.set(element.id, element.version);
  showIfHidden(element);
  return { elements: [element] };
}

// The box of an Element on the Board. Arrows and lines count by their points: their width and height can be old (FR-118).
function elementBox(element) {
  const [minX, minY, maxX, maxY] = getCommonBounds([element]);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function overlaps(element, box) {
  const own = elementBox(element);
  return own.x < box.x + box.width && own.x + own.width > box.x
    && own.y < box.y + box.height && own.y + own.height > box.y;
}

// The Elements in `box`, with the labels of their shapes and arrows and the shapes of their labels,
// so that no shape is shown without its label (FR-118).
function inShotBox(elements, box) {
  const ids = new Set(elements.filter((element) => overlaps(element, box)).map((element) => element.id));
  for (const element of elements) {
    if (element.type === "text" && element.containerId && ids.has(element.id)) ids.add(element.containerId);
  }
  for (const element of elements) {
    if (element.type === "text" && element.containerId && ids.has(element.containerId)) ids.add(element.id);
  }
  return elements.filter((element) => ids.has(element.id));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function takeShot(job) {
  let elements = api.getSceneElements();
  if (job.focusId) {
    const focus = elements.find((element) => element.id === job.focusId);
    if (!focus) throw new Error(`no item with id ${job.focusId}`);
    const own = elementBox(focus);
    const box = {
      x: own.x + own.width / 2 - SHOT_BOX.width / 2,
      y: own.y + own.height / 2 - SHOT_BOX.height / 2,
      ...SHOT_BOX,
    };
    elements = inShotBox(elements, box);
  }
  if (elements.length === 0) throw new Error("the board is empty");
  // A text whose font is not loaded yet is drawn with nothing (FR-118).
  await loadFonts(elements.filter((element) => element.type === "text").map((e) => ({ text: e.text, fontFamily: e.fontFamily, fontSize: e.fontSize })));
  // job.scale in (0, 1] makes the PNG smaller (FR-123); the Server checks it.
  const wanted = Number(job.scale) > 0 ? Number(job.scale) : 1;
  const blob = await exportToBlob({
    elements,
    appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff" },
    files: api.getFiles(),
    mimeType: "image/png",
    exportPadding: SHOT_PADDING_PX,
    getDimensions: (width, height) => {
      const scale = wanted * Math.min(SHOT_MAX_SCALE, SHOT_MAX_PX / Math.max(width, height, 1));
      return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
    },
  });
  return { png: await blobToBase64(blob) };
}

// Takes an Answer off this page again. The Server gave the Job to another page while this page
// was frozen, so the other page wrote the same Answer (FR-086).
function removeLocal(elements) {
  const ids = new Set(elements.map((element) => element.id));
  for (const id of ids) known.delete(id);
  api.updateScene({
    elements: api.getSceneElementsIncludingDeleted().filter((element) => !ids.has(element.id)),
    captureUpdate: CaptureUpdateAction.NEVER,
  });
}

// ---- Operations by Claude (0.5.0): draw, edit, and mermaid Jobs (spec 3.6, FR-090, FR-094, FR-095, FR-098) ----

// Excalidraw 0.18.1 font numbers (4.11.1). Xiaolai covers Chinese and Japanese characters.
const FONT_NAMES = Object.freeze({ 1: "Virgil", 2: "Helvetica", 3: "Cascadia", 5: "Excalifont", 6: "Nunito", 7: "Lilita One", 8: "Comic Shanns" });
const DEFAULT_FONT_FAMILY = 5;
const SHAPE_TYPES = Object.freeze(["rectangle", "ellipse", "diamond"]);
// securityLevel is set on purpose, so a new default cannot loosen it (FR-093a).
// Mermaid measures the labels with the fonts of the board, so a box fits its label (FR-115).
const MERMAID_FONTS = "Excalifont, Xiaolai, sans-serif";
const MERMAID_OPTIONS = Object.freeze({
  securityLevel: "strict", themeVariables: { fontSize: "20px", fontFamily: MERMAID_FONTS }, fontFamily: MERMAID_FONTS, maxTextSize: 20000,
});
// The default black of Mermaid lines and text becomes Claude's blue; a pie picture keeps its colors (FR-116, R-027).
const MERMAID_BLACKS = Object.freeze(["#000", "#000000", "black", "#1e1e1e"]);
// A line break in a Mermaid label ("A<br>B", "A<br/>B") is a new line on the board (FR-115).
const MERMAID_LINE_BREAK = /<br\s*\/?>/gi;
const MERMAID_PNG_MAX_PX = 2000;
// Draw the picture at up to twice its size, so it stays sharp when a Person zooms in.
const MERMAID_PNG_SCALE = 2;
let mermaidModule = null;

function isClaudeItem(element) {
  return Boolean(element.customData && element.customData.grwbKind === CLAUDE_MARK);
}

function jobError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Loads the fonts of every text, so text is measured right (as FR-028).
async function loadFonts(texts) {
  const byFont = new Map();
  for (const { text, fontFamily, fontSize } of texts) {
    const key = `${fontSize || ANSWER_FONT_SIZE}px ${FONT_NAMES[fontFamily || DEFAULT_FONT_FAMILY] || "Excalifont"}, Xiaolai`;
    byFont.set(key, (byFont.get(key) || "") + text);
  }
  for (const [font, text] of byFont) {
    try {
      await document.fonts.load(font, text);
    } catch (error) {
      // Measure with the fallback font.
    }
  }
}

// Excalidraw keeps the default width 100 and height 0 of an arrow or line made from a Skeleton with points;
// the box of its points is the true size (FR-119).
function sizeFromPoints(element) {
  if ((element.type !== "arrow" && element.type !== "line") || !Array.isArray(element.points) || element.points.length < 2) return element;
  const xs = element.points.map((p) => p[0]);
  const ys = element.points.map((p) => p[1]);
  return { ...element, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function marked(element) {
  return { ...element, link: null, customData: { ...(element.customData || {}), grwbKind: CLAUDE_MARK } };
}

// Puts `list` into the scene in place of the Elements with the same id, and marks them as known to the Server.
function putInScene(list) {
  const byId = new Map(list.map((element) => [element.id, element]));
  for (const element of list) known.set(element.id, element.version);
  const scene = api.getSceneElementsIncludingDeleted().filter((element) => !isAnimationTemp(element));
  const kept = scene.map((element) => byId.get(element.id) || element);
  const sceneIds = new Set(scene.map((element) => element.id));
  const added = list.filter((element) => !sceneIds.has(element.id));
  api.updateScene({ elements: [...kept, ...added], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  settleLayout(new Set(list.map((element) => element.id)));
}

// Scrolls to the whole drawing when a part of it is outside the visible area (FR-107).
function showAllIfHidden(list) {
  if (list.length === 0) return false;
  const [minX, minY, maxX, maxY] = getCommonBounds(list);
  return showIfHidden({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, list);
}

function toSkeleton(skeleton, origin) {
  const out = { ...skeleton, x: skeleton.x + origin.x, y: skeleton.y + origin.y };
  out.strokeColor = skeleton.strokeColor || ANSWER_COLOR;
  if (skeleton.label) out.label = { ...skeleton.label, strokeColor: skeleton.label.strokeColor || out.strokeColor };
  return out;
}

// ---- Watchman Whiteboard: the drawing animation (see ../../../UPSTREAM) ----
// A draw or mermaid Job shows its Elements like a person at a whiteboard: shapes traced, arrows growing, text
// written letter by letter. reveal.mjs plans and times it; here the frames go on screen as local Elements
// marked ANIMATION_MARK. collectChanges never sends them, they are locked (no Person can pick them), and at the
// end they go away and the Job's Elements go in exactly as before (putInScene). The Job's reply waits for the
// animation: it is kept below REVEAL.TIMEOUT_SHARE of the Job timeout, so the reply is always in time, and the
// Server, read_board, take_screenshot, undo and the other pages only ever see the finished drawing.
// The speed: REVEAL.DEFAULT_SPEED, or #anim=<speed> in the page link (0 = no animation).
const ANIMATION_PARAM = new URLSearchParams(window.location.hash.slice(1)).get("anim");
// Debug hook: every step as it starts to be drawn, {step, elementId, kind, at (ms from the start), jobId},
// so the real order can be checked in a browser (window.__wbRevealLog in the console). The newest entries only.
const REVEAL_LOG_MAX = 1000;
window.__wbRevealLog = [];

function logRevealStep(job, step, number, atMs) {
  const log = window.__wbRevealLog;
  log.push({ step: number, elementId: step.id, kind: step.kind, at: Math.round(atMs), jobId: job.jobId });
  if (log.length > REVEAL_LOG_MAX) log.splice(0, log.length - REVEAL_LOG_MAX);
}

// The next paint of the page, or a short time when the page paints nothing (hidden): never waits for ever.
function nextPaint() {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2 * REVEAL.FRAME_MS);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function animationSpeedNow() {
  let reducedMotion = false;
  try {
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (error) {
    reducedMotion = false;
  }
  return animationSpeed({ param: ANIMATION_PARAM, reducedMotion, hidden: document.visibilityState !== "visible" });
}

// One sentence of the narration: a DOM event on this window, and a message to the window that shows the board
// (Watchman's browser tab), which may speak it. The board itself never speaks.
function announceSay(detail) {
  window.dispatchEvent(new CustomEvent(SAY_EVENT, { detail }));
  const host = window.parent !== window ? window.parent : window.opener;
  if (!host) return;
  try {
    host.postMessage({ type: SAY_EVENT, ...detail }, "*");
  } catch (error) {
    // The other window is gone.
  }
}

// The frame of one step of the reveal at progress p (0..1): a local Element, or null for nothing yet.
function frameOf(step, element, p, tracers) {
  if (step.kind === "shape" && p < 1) {
    if (!tracers.has(element.id)) {
      const [line] = convertToExcalidrawElements([{
        type: "line", x: element.x, y: element.y, points: [[0, 0], [1, 0]], strokeColor: element.strokeColor,
        strokeWidth: element.strokeWidth, strokeStyle: element.strokeStyle, roughness: element.roughness, opacity: element.opacity,
      }]);
      tracers.set(element.id, line);
    }
    const path = polylineAt(outlinePoints(element), p);
    return { ...tracers.get(element.id), ...asLinear(element.x, element.y, path), id: `anim-trace-${element.id}` };
  }
  if (step.kind === "line") {
    return {
      ...element, ...asLinear(element.x, element.y, polylineAt(element.points, p)), id: `anim-${element.id}`,
      startBinding: null, endBinding: null, elbowed: false,
    };
  }
  if (step.kind === "text") {
    const text = textAt(element.text, p);
    if (text === "") return null;
    return { ...element, id: `anim-${element.id}`, text, originalText: text, containerId: null };
  }
  return { ...element, id: `anim-${element.id}` };
}

// Shows `fresh` (the Job's Elements, not yet in the scene) step by step, then takes the frames away.
// The narration (job.say) splits it into parts; each sentence is announced as its part starts.
async function revealDrawing(job, fresh) {
  const say = Array.isArray(job.say) ? job.say.filter((text) => typeof text === "string") : [];
  let announced = 0;
  const announceUpTo = (part) => {
    for (; announced <= part && announced < say.length; announced += 1) announceSay(sayDetail(say, announced, job.jobId));
  };
  const budgetMs = Number(job.timeoutMs) > 0 ? Math.min(REVEAL.MAX_TOTAL_MS, job.timeoutMs * REVEAL.TIMEOUT_SHARE) : REVEAL.MAX_TOTAL_MS;
  const plan = revealPlan(fresh, Math.max(1, say.length));
  const timing = revealSchedule(plan, { speed: animationSpeedNow(), maxTotalMs: budgetMs });
  if (!(timing.totalMs > 0)) {
    // No animation: the log still shows the order the steps would have had.
    timing.steps.forEach((step, index) => logRevealStep(job, step, index + 1, 0));
    announceUpTo(say.length - 1);
    return;
  }
  const byId = new Map(fresh.map((element) => [element.id, element]));
  const tracers = new Map();
  // Frames of finished steps do not change: the same object every frame, so Excalidraw keeps its drawing.
  const finished = new Map();
  const mark = { locked: true, link: null, groupIds: [], frameId: null, boundElements: null, customData: { [ANIMATION_MARK]: true } };
  // Live defect "your animation skips the first": the page scrolled to a new drawing with an animated scroll
  // while the clock already ran, so the first step was drawn during the scroll, off where the viewer looked.
  // Now the clock starts only after the scroll.
  if (showAllIfHidden(fresh)) await new Promise((resolve) => setTimeout(resolve, REVEAL.SCROLL_WAIT_MS));
  // Frames at the times of revealTimeline: every step, the first included, is seen part drawn. If the page
  // falls far behind (a slow machine), it finishes at once, so the Job's reply stays in time.
  const times = revealTimeline(timing, REVEAL.FRAME_MS);
  const startMs = Date.now();
  // At most 1.5 s late: with the scroll wait, a draw Job (15 s by default) still answers within about 8.1 s.
  const giveUpMs = startMs + timing.totalMs + 1500;
  const logged = new Set();
  let frame = 0;
  try {
    for (let index = 0; index < times.length; index += 1) {
      const t = times[index];
      // A hidden page gets slow timers: it finishes at once.
      const late = document.visibilityState !== "visible" || Date.now() > giveUpMs;
      const now = progressAt(timing, late ? Infinity : t);
      announceUpTo(now.part);
      for (const step of timing.steps) {
        if (now.progress.get(step.id) > 0 && !logged.has(step.id)) {
          logged.add(step.id);
          logRevealStep(job, step, logged.size, Date.now() - startMs);
        }
      }
      if (now.done) break;
      frame += 1;
      const frames = [];
      for (const step of timing.steps) {
        const p = now.progress.get(step.id);
        if (!(p > 0)) continue;
        if (finished.has(step.id)) {
          frames.push(finished.get(step.id));
          continue;
        }
        const made = frameOf(step, byId.get(step.id), p, tracers);
        if (!made) continue;
        const local = { ...made, ...mark, version: frame + 1, versionNonce: randomNonce() };
        if (p >= 1) finished.set(step.id, local);
        frames.push(local);
      }
      const scene = api.getSceneElementsIncludingDeleted().filter((element) => !isAnimationTemp(element));
      api.updateScene({ elements: [...scene, ...frames], captureUpdate: CaptureUpdateAction.NEVER });
      // Let the browser paint this frame, then wait for the time of the next one.
      await nextPaint();
      const nextAt = index + 1 < times.length ? startMs + times[index + 1] : Date.now();
      if (nextAt > Date.now()) await new Promise((resolve) => setTimeout(resolve, nextAt - Date.now()));
    }
  } finally {
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().filter((element) => !isAnimationTemp(element)),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }
}

async function drawSkeletons(job) {
  const origin = { x: job.x, y: job.y };
  const scene = new Map(api.getSceneElementsIncludingDeleted().map((element) => [element.id, element]));
  // Skeletons without an id get one here, so the reply can list one id per Skeleton.
  const skeletons = job.elements.map((skeleton) => toSkeleton({ ...skeleton, id: skeleton.id || randomId() }, origin));
  await loadFonts(skeletons.flatMap((s) => (s.type === "text" ? [s] : s.label ? [s.label] : [])));
  // Copies of the Board shapes that arrows bind to: Excalidraw binds only inside its list (FR-090).
  const targets = (job.boardIds || []).map((id) => scene.get(id)).filter(Boolean);
  const copies = targets.map((shape) => ({
    type: SHAPE_TYPES.includes(shape.type) ? shape.type : "rectangle",
    id: shape.id, x: shape.x, y: shape.y, width: shape.width, height: shape.height,
  }));
  const made = convertToExcalidrawElements([...copies, ...skeletons], { regenerateIds: false });
  const targetIds = new Set(targets.map((shape) => shape.id));
  const fresh = made.filter((element) => !targetIds.has(element.id)).map(sizeFromPoints).map(marked)
    .map((element) => aboveTombstone(element, scene.get(element.id), (job.reused || {})[element.id]));
  await revealDrawing(job, fresh);
  // Watchman Whiteboard: the Board shapes as they are after the animation (a Person may have changed one meanwhile).
  const latest = new Map(api.getSceneElementsIncludingDeleted().map((element) => [element.id, element]));
  const current = targets.map((shape) => latest.get(shape.id) || shape);
  const bound = current.map((shape) => {
    const copy = made.find((element) => element.id === shape.id);
    const old = Array.isArray(shape.boundElements) ? shape.boundElements : [];
    const extra = (copy.boundElements || []).filter((b) => !old.some((o) => o.id === b.id));
    return newElementWith(shape, { boundElements: [...old, ...extra] });
  });
  putInScene([...fresh, ...bound]);
  showAllIfHidden(fresh);
  return { elements: [...fresh, ...bound], ids: skeletons.map((skeleton) => skeleton.id), before: current };
}

// An Element that takes the id of a deleted one gets a higher version, so it wins the merge (FR-090).
function aboveTombstone(element, old, serverVersion) {
  const floor = Math.max(old && old.isDeleted ? old.version : 0, Number(serverVersion) || 0);
  if (floor === 0 || element.version > floor) return element;
  return { ...element, version: floor + 1, versionNonce: randomNonce() };
}

// The text of a container (its label), or null.
function labelOf(scene, containerId) {
  for (const element of scene.values()) {
    if (!element.isDeleted && element.type === "text" && element.containerId === containerId) return element;
  }
  return null;
}

// The size of a text with its font, measured by Excalidraw.
function measureText(text, style) {
  const [made] = convertToExcalidrawElements([{ type: "text", x: 0, y: 0, text, ...style }]);
  return made;
}

// Lays out a label in its shape again: Excalidraw centers it and makes the shape tall enough.
function layoutLabel(container, label, style) {
  if (container.type === "arrow" || container.type === "line") {
    const size = measureText(label.text, style);
    const points = container.points || [[0, 0]];
    const mid = points[Math.floor(points.length / 2)];
    const prev = points[Math.max(0, Math.floor(points.length / 2) - (points.length % 2 === 0 ? 1 : 0))];
    const cx = container.x + (mid[0] + prev[0]) / 2;
    const cy = container.y + (mid[1] + prev[1]) / 2;
    return { container: {}, label: { width: size.width, height: size.height, lineHeight: size.lineHeight, x: cx - size.width / 2, y: cy - size.height / 2 } };
  }
  const [shape, text] = convertToExcalidrawElements([{
    type: SHAPE_TYPES.includes(container.type) ? container.type : "rectangle",
    x: container.x, y: container.y, width: container.width, height: container.height,
    label: { text: label.text, ...style },
  }]);
  const grow = {};
  if (shape.height > container.height + 0.5) grow.height = shape.height;
  if (shape.width > container.width + 0.5) grow.width = shape.width;
  return { container: grow, label: { x: text.x, y: text.y, width: text.width, height: text.height, lineHeight: text.lineHeight } };
}

function boxOf(element) {
  return { x: element.x, y: element.y, width: element.width, height: element.height };
}

function sameBox(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// How far a point on the old box of a shape goes when the shape gets its new box.
function shiftOf(move, [px, py]) {
  if (!move) return [0, 0];
  const nx = move.to.x + (px - move.from.x) * (move.from.width > 0 ? move.to.width / move.from.width : 1);
  const ny = move.to.y + (py - move.from.y) * (move.from.height > 0 ? move.to.height / move.from.height : 1);
  return [nx - px, ny - py];
}

// A segment that changes x or y by less than this is level or upright.
const AXIS_PX = 1;

function isLevel(a, b) {
  return Math.abs(b[1] - a[1]) < AXIS_PX;
}

// True for three or more points joined only by level and upright segments.
function isRightAngled(points) {
  return points.length >= 3 && points.every((p, i) => i === 0 || isLevel(points[i - 1], p) || Math.abs(p[0] - points[i - 1][0]) < AXIS_PX);
}

// The new points (board coordinates) of an arrow whose start moves by atStart and whose end moves by atEnd (FR-117).
// Both ends by the same amount: the whole arrow moves. A right-angled arrow stays right-angled: the point next to
// a moved end follows it across its segment. Any other arrow: a point between the ends moves by its place along
// the arrow, so the arrow keeps its form and no segment runs far away.
function movePoints(old, atStart, atEnd) {
  const last = old.length - 1;
  const same = atStart[0] === atEnd[0] && atStart[1] === atEnd[1];
  if (!same && isRightAngled(old)) {
    const abs = old.map((p) => [...p]);
    const moveEnd = (end, next, by) => {
      abs[end] = [abs[end][0] + by[0], abs[end][1] + by[1]];
      if (isLevel(old[end], old[next])) abs[next][1] += by[1];
      else abs[next][0] += by[0];
    };
    moveEnd(0, 1, atStart);
    moveEnd(last, last - 1, atEnd);
    return abs;
  }
  const along = [0];
  for (let i = 1; i <= last; i += 1) along.push(along[i - 1] + Math.hypot(old[i][0] - old[i - 1][0], old[i][1] - old[i - 1][1]));
  return old.map(([px, py], i) => {
    const t = along[last] > 0 ? along[i] / along[last] : i / last;
    return [px + atStart[0] * (1 - t) + atEnd[0] * t, py + atStart[1] * (1 - t) + atEnd[1] * t];
  });
}

// Moves the arrows bound to shapes that moved or changed size, as Excalidraw does on a drag (FR-098).
// moves: Map shape id -> { from, to } (the old and the new box). skipIds: arrows that the Job moves itself,
// so they do not move twice (FR-117). An end goes with its shape; movePoints moves the points between.
function followShapes(scene, moves, skipIds = new Set()) {
  const changed = [];
  for (const arrow of [...scene.values()]) {
    if (arrow.isDeleted || skipIds.has(arrow.id) || !Array.isArray(arrow.points) || arrow.points.length < 2) continue;
    const startMove = arrow.startBinding ? moves.get(arrow.startBinding.elementId) : undefined;
    const endMove = arrow.endBinding ? moves.get(arrow.endBinding.elementId) : undefined;
    if (!startMove && !endMove) continue;
    const old = arrow.points.map((p) => [arrow.x + p[0], arrow.y + p[1]]);
    const last = old.length - 1;
    const abs = movePoints(old, shiftOf(startMove, old[0]), shiftOf(endMove, old[last]));
    const [x0, y0] = abs[0];
    const points = abs.map(([px, py]) => [px - x0, py - y0]);
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const moved = newElementWith(arrow, {
      x: x0, y: y0, points, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
    });
    scene.set(moved.id, moved);
    changed.push(moved);
    const label = labelOf(scene, arrow.id);
    if (label) {
      const placed = layoutLabel(moved, label, { fontSize: label.fontSize, fontFamily: label.fontFamily });
      const next = newElementWith(label, placed.label);
      scene.set(next.id, next);
      changed.push(next);
    }
  }
  return changed;
}

const EDIT_STYLE_FIELDS = Object.freeze(["strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "angle"]);
const EDIT_TEXT_FIELDS = Object.freeze(["text", "fontSize", "fontFamily", "textAlign"]);

async function editElements(job) {
  const original = new Map(api.getSceneElementsIncludingDeleted().map((element) => [element.id, element]));
  const scene = new Map(original);
  // Arrows and lines that a change moves itself: their bound shapes do not move them again (FR-117).
  const movedLines = new Set(job.changes
    .filter((change) => ["x", "y", "dx", "dy"].some((field) => change[field] !== undefined))
    .map((change) => change.id)
    .filter((id) => original.has(id) && ["arrow", "line"].includes(original.get(id).type)));
  const shapeIds = new Set();
  const texts = [];
  for (const change of job.changes) {
    const element = scene.get(change.id);
    const label = element && element.type !== "text" ? labelOf(scene, element.id) : element;
    if (label && label.type === "text") {
      texts.push({ text: change.text || label.text, fontFamily: change.fontFamily || label.fontFamily, fontSize: change.fontSize || label.fontSize });
    }
  }
  await loadFonts(texts);
  // Watchman Whiteboard: a math step's new LaTeX, or a molecule's new SMILES (drawn by the server, as in drawMath),
  // becomes its new picture.
  const files = [];
  const pictures = new Map();
  for (const change of job.changes) {
    if (change.tex === undefined && change.smiles === undefined) continue;
    const picture = await mathPicture(change);
    files.push(picture.file);
    pictures.set(change.id, {
      fileId: picture.file.id, width: picture.width, height: picture.height, status: "saved",
      customData: {
        ...((scene.get(change.id) || {}).customData || {}),
        ...(change.smiles !== undefined ? { smiles: change.smiles } : { mathTex: change.tex }),
      },
    });
  }
  if (files.length > 0) {
    for (const file of files) knownFiles.add(file.id);
    api.addFiles(files);
  }
  const touched = new Map();
  const put = (element) => {
    scene.set(element.id, element);
    touched.set(element.id, element);
    return element;
  };
  for (const change of job.changes) {
    let element = scene.get(change.id);
    if (!element) throw new Error(`no item with id ${change.id}`);
    // A label of a shape is changed through its shape.
    const container = element.type === "text" && element.containerId ? scene.get(element.containerId) : null;
    const patch = {};
    for (const field of EDIT_STYLE_FIELDS) if (change[field] !== undefined) patch[field] = change[field];
    if (change.x !== undefined) patch.x = change.x;
    if (change.y !== undefined) patch.y = change.y;
    if (change.dx !== undefined) patch.x = element.x + change.dx;
    if (change.dy !== undefined) patch.y = element.y + change.dy;
    if (pictures.has(change.id)) Object.assign(patch, pictures.get(change.id));
    if (change.width !== undefined && !pictures.has(change.id)) patch.width = change.width;
    if (change.height !== undefined && !pictures.has(change.id)) patch.height = change.height;
    const textPatch = {};
    for (const field of EDIT_TEXT_FIELDS) if (change[field] !== undefined) textPatch[field] = change[field];
    if (element.type === "text" && !container) {
      Object.assign(patch, textPatch);
      if (Object.keys(textPatch).length > 0) {
        const text = textPatch.text !== undefined ? textPatch.text : element.text;
        const size = measureText(text, { fontSize: patch.fontSize || element.fontSize, fontFamily: patch.fontFamily || element.fontFamily, textAlign: patch.textAlign || element.textAlign });
        Object.assign(patch, { originalText: text, width: size.width, height: size.height, lineHeight: size.lineHeight });
      }
      put(newElementWith(element, patch));
      continue;
    }
    // A shape or arrow (or the label of one): change the shape, then lay out its label again.
    const shape = container || element;
    const shapePatch = container ? {} : patch;
    const labelStylePatch = container ? patch : {};
    let nextShape = Object.keys(shapePatch).length > 0 ? put(newElementWith(shape, shapePatch)) : shape;
    const label = labelOf(scene, shape.id);
    if (label) {
      const style = {
        fontSize: textPatch.fontSize || label.fontSize,
        fontFamily: textPatch.fontFamily || label.fontFamily,
        textAlign: textPatch.textAlign || label.textAlign,
      };
      const text = textPatch.text !== undefined ? textPatch.text : label.text;
      const placed = layoutLabel(nextShape, { text }, style);
      if (Object.keys(placed.container).length > 0) nextShape = put(newElementWith(nextShape, placed.container));
      const colors = {};
      for (const field of ["strokeColor", "opacity"]) if (labelStylePatch[field] !== undefined) colors[field] = labelStylePatch[field];
      put(newElementWith(label, { ...style, ...colors, text, originalText: text, ...placed.label }));
    }
    shapeIds.add(shape.id);
  }
  // Every shape moves its arrows once, from its box before the Job to its box after all changes.
  const moves = new Map();
  for (const id of shapeIds) {
    const from = boxOf(original.get(id));
    const to = boxOf(scene.get(id));
    if (!sameBox(from, to)) moves.set(id, { from, to });
  }
  for (const arrow of followShapes(scene, moves, movedLines)) touched.set(arrow.id, arrow);
  const list = [...touched.values()];
  putInScene(list);
  return { elements: list, files, before: list.map((element) => original.get(element.id)).filter(Boolean) };
}

// Mermaid sizes a node with its own font; Excalifont is wider, so a short label can wrap ("DB" became "D", "B").
// Makes such a shape wider (about its center) until its label is on as many lines as in the source,
// and moves the bound arrow ends with it. `made`: the Elements of one diagram, not yet on the Board.
const FIT_LABEL_TRIES = 8;
const FIT_LABEL_GROW = 1.2;
const FIT_LABEL_PADDING_PX = 20;

function lineCount(text) {
  return String(text || "").split("\n").length;
}

function fitLabels(made) {
  const scene = new Map(made.map((element) => [element.id, element]));
  const moves = new Map();
  for (const label of made) {
    if (label.type !== "text" || !label.containerId || lineCount(label.text) <= lineCount(label.originalText)) continue;
    const shape = scene.get(label.containerId);
    if (!shape || !SHAPE_TYPES.includes(shape.type)) continue;
    const style = { fontSize: label.fontSize, fontFamily: label.fontFamily, textAlign: label.textAlign };
    const textWidth = measureText(label.originalText, style).width;
    let width = Math.max(shape.width, textWidth + FIT_LABEL_PADDING_PX);
    let wider = null;
    for (let i = 0; i < FIT_LABEL_TRIES; i += 1) {
      const candidate = { ...shape, x: shape.x - (width - shape.width) / 2, width };
      const [, text] = convertToExcalidrawElements([{
        type: shape.type, x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height,
        label: { text: label.originalText, ...style },
      }]);
      if (lineCount(text.text) <= lineCount(label.originalText)) {
        wider = candidate;
        break;
      }
      width *= FIT_LABEL_GROW;
    }
    if (!wider) continue;
    const placed = layoutLabel(wider, { text: label.originalText }, style);
    const nextShape = { ...wider, ...placed.container };
    scene.set(shape.id, nextShape);
    scene.set(label.id, { ...label, text: label.originalText, ...placed.label });
    moves.set(shape.id, { from: boxOf(shape), to: boxOf(nextShape) });
  }
  followShapes(scene, moves);
  return made.map((element) => scene.get(element.id));
}

// Loads @excalidraw/mermaid-to-excalidraw once, at the first mermaid Job (spec 3.6, NFR-009).
function loadMermaid() {
  if (mermaidModule === null) {
    mermaidModule = import("@excalidraw/mermaid-to-excalidraw").catch((error) => {
      mermaidModule = null;
      throw error;
    });
  }
  return mermaidModule;
}

async function sha1Hex(text) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The Server refuses SVG files (FR-083), so a Mermaid picture becomes a PNG file (FR-095).
async function svgToPng(svgDataURL, width, height) {
  try {
    const image = new Image();
    image.src = svgDataURL;
    await image.decode();
    const w = width || image.naturalWidth || 800;
    const h = height || image.naturalHeight || 600;
    const scale = Math.min(MERMAID_PNG_SCALE, MERMAID_PNG_MAX_PX / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataURL = canvas.toDataURL("image/png");
    if (!dataURL.startsWith("data:image/png;base64,")) throw new Error("no PNG");
    return dataURL;
  } catch (error) {
    throw jobError("MermaidUnsupported", `this Mermaid type gives a picture, and the browser could not make a PNG of it (${error && error.message})`);
  }
}

function isDefaultBlack(color) {
  return color === undefined || color === null || MERMAID_BLACKS.includes(String(color).toLowerCase());
}

// A Skeleton from Mermaid with real line breaks and with Claude's blue in place of the default black (FR-115).
function boardSkeleton(skeleton) {
  if (skeleton.type === "image") return skeleton;
  const out = { ...skeleton };
  if (typeof out.text === "string") out.text = out.text.replace(MERMAID_LINE_BREAK, "\n");
  if (isDefaultBlack(out.strokeColor)) out.strokeColor = ANSWER_COLOR;
  if (out.label) {
    const label = { ...out.label };
    if (typeof label.text === "string") label.text = label.text.replace(MERMAID_LINE_BREAK, "\n");
    if (isDefaultBlack(label.strokeColor)) label.strokeColor = ANSWER_COLOR;
    out.label = label;
  }
  return out;
}

async function drawMermaid(job) {
  let lib;
  try {
    lib = await loadMermaid();
  } catch (error) {
    throw new Error(`cannot load Mermaid from esm.sh: ${error && error.message}`);
  }
  // Mermaid measures with these fonts, so they must be there first (FR-115).
  await loadFonts([{ text: job.source, fontFamily: DEFAULT_FONT_FAMILY, fontSize: ANSWER_FONT_SIZE }]);
  let parsed;
  try {
    parsed = await lib.parseMermaidToExcalidraw(job.source, MERMAID_OPTIONS);
  } catch (error) {
    throw jobError("MermaidError", String((error && (error.message || error.str)) || error));
  }
  const skeletons = (parsed.elements || []).filter((s) => s.type !== "frame" && s.type !== "magicframe").map(boardSkeleton);
  const files = [];
  for (const skeleton of skeletons) {
    if (skeleton.type !== "image") continue;
    const file = parsed.files && parsed.files[skeleton.fileId];
    if (!file) throw jobError("MermaidUnsupported", "the picture of the diagram is missing");
    const dataURL = file.mimeType === "image/png" ? file.dataURL : await svgToPng(file.dataURL, skeleton.width, skeleton.height);
    const id = await sha1Hex(dataURL);
    files.push({ id, mimeType: "image/png", dataURL, created: Date.now() });
    skeleton.fileId = id;
  }
  // Measure once to learn the fonts, load them, then measure with them (as FR-028).
  const firstTry = convertToExcalidrawElements(skeletons, { regenerateIds: true });
  await loadFonts(firstTry.filter((e) => e.type === "text").map((e) => ({ text: e.text, fontFamily: e.fontFamily, fontSize: e.fontSize })));
  const made = fitLabels(convertToExcalidrawElements(skeletons, { regenerateIds: true }));
  if (made.length === 0) throw jobError("MermaidError", "the diagram has no elements");
  // Move the drawing so that its top left corner is at the Origin (4.11.4).
  const [minX, minY] = getCommonBounds(made);
  const dx = job.x - minX;
  const dy = job.y - minY;
  const fresh = made.map((element) => marked({ ...element, x: element.x + dx, y: element.y + dy, frameId: null, ...(element.type === "image" ? { status: "saved" } : {}) }));
  if (files.length > 0) {
    for (const file of files) knownFiles.add(file.id);
    api.addFiles(files);
  }
  await revealDrawing(job, fresh);
  putInScene(fresh);
  showAllIfHidden(fresh);
  return { elements: fresh, files, before: [] };
}

// ---- Watchman Whiteboard: math steps (draw_math; the board server's lib/board-math.js) ----
// The server checked each step's LaTeX (KaTeX) and drew it with MathJax as an SVG of paths, sized in px and colored.
// Here each SVG becomes a PNG on a canvas (the board keeps no SVG files), an image element with the step's id and
// its LaTeX in customData.mathTex, one under the other, with the step's note as a text at its right. When the server
// had no MathJax, a step comes as KaTeX's HTML instead, drawn in an SVG foreignObject with KaTeX's stylesheet and
// fonts inlined (from /vendor/katex); a browser that will not make a PNG of that fails the Job with MathUnavailable.
const MATH_GAP_PX = 18;
const MATH_NOTE_GAP_PX = 36;
const MATH_PNG_SCALE = 2;
const MATH_PNG_MAX_PX = 4000;
const MATH_EM_PX = 26;
const MATH_NOTE_FONT_SIZE = ANSWER_FONT_SIZE;
let katexStyle = null;

// A PNG data URL of the picture at `src` drawn at width x height (px), twice as sharp, on a clear background.
async function rasterize(src, width, height) {
  const image = new Image();
  image.src = src;
  await image.decode();
  const w = width || image.naturalWidth || 100;
  const h = height || image.naturalHeight || 40;
  const scale = Math.min(MATH_PNG_SCALE, MATH_PNG_MAX_PX / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  const dataURL = canvas.toDataURL("image/png");
  if (!dataURL.startsWith("data:image/png;base64,")) throw new Error("no PNG");
  return dataURL;
}

async function asDataUrl(url) {
  const reply = await fetch(url);
  if (!reply.ok) throw new Error(`${url}: HTTP ${reply.status}`);
  const blob = await reply.blob();
  return `data:${blob.type || "application/octet-stream"};base64,${await blobToBase64(blob)}`;
}

// KaTeX's stylesheet with its woff2 fonts inlined (a picture loads nothing), once.
function loadKatexStyle() {
  if (katexStyle === null) {
    katexStyle = (async () => {
      const reply = await fetch("/vendor/katex/katex.min.css");
      if (!reply.ok) throw new Error(`KaTeX's stylesheet is not staged (HTTP ${reply.status})`);
      const css = await reply.text();
      const fonts = new Map();
      for (const match of css.matchAll(/url\((fonts\/[A-Za-z0-9_-]+\.woff2)\)/g)) fonts.set(match[1], null);
      for (const name of fonts.keys()) fonts.set(name, await asDataUrl(`/vendor/katex/${name}`));
      const inlined = css.replace(/src:[^;}]*/g, (declaration) => {
        const woff2 = /url\((fonts\/[A-Za-z0-9_-]+\.woff2)\)/.exec(declaration);
        return woff2 ? `src:url(${fonts.get(woff2[1])}) format("woff2")` : declaration;
      });
      // A step is one picture: no room above and below it, as with MathJax's.
      return `${inlined}.katex-display{margin:0 !important}`;
    })().catch((error) => {
      katexStyle = null;
      throw error;
    });
  }
  return katexStyle;
}

// KaTeX's HTML of a step as a PNG: measured in the page, then drawn in a foreignObject.
async function katexPicture(html) {
  const css = await loadKatexStyle();
  const holder = document.createElement("div");
  holder.setAttribute("style", `position:fixed;left:-100000px;top:0;font-size:${MATH_EM_PX}px;color:${ANSWER_COLOR};white-space:nowrap`);
  holder.innerHTML = `<style>${css}</style>${html}`;
  document.body.appendChild(holder);
  try {
    const box = holder.getBoundingClientRect();
    const width = Math.ceil(box.width) + 4;
    const height = Math.ceil(box.height) + 4;
    const xhtml = new XMLSerializer().serializeToString(holder);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml.replace("left:-100000px", "left:0")}</foreignObject></svg>`;
    return { dataURL: await rasterize(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width, height), width, height };
  } finally {
    holder.remove();
  }
}

// The PNG file of one step (or of an edit's new LaTeX): { file, width, height }.
async function mathPicture(step) {
  let picture;
  try {
    picture = step.svg
      ? { dataURL: await rasterize(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(step.svg)}`, step.width, step.height), width: step.width, height: step.height }
      : await katexPicture(String(step.html || ""));
  } catch (error) {
    throw jobError("MathUnavailable", `this browser could not draw the step as a picture (${error && error.message})`);
  }
  const id = await sha1Hex(picture.dataURL);
  return { file: { id, mimeType: "image/png", dataURL: picture.dataURL, created: Date.now() }, width: picture.width, height: picture.height };
}

async function drawMath(job) {
  const scene = new Map(api.getSceneElementsIncludingDeleted().map((element) => [element.id, element]));
  const files = [];
  const skeletons = [];
  // What each picture was drawn from: a step's LaTeX, or a molecule's SMILES (draw_molecule rides on this Job).
  const dataById = new Map();
  let y = 0;
  for (const step of job.steps) {
    const picture = await mathPicture(step);
    files.push(picture.file);
    dataById.set(step.id, typeof step.smiles === "string" ? { smiles: step.smiles } : { mathTex: step.tex });
    skeletons.push({ type: "image", id: step.id, x: 0, y, width: picture.width, height: picture.height, fileId: picture.file.id });
    if (step.note) {
      const noteY = y + Math.max(0, (picture.height - MATH_NOTE_FONT_SIZE * 1.25) / 2);
      skeletons.push({
        type: "text", id: `${step.id}-note`, x: picture.width + MATH_NOTE_GAP_PX, y: noteY, text: step.note,
        fontSize: MATH_NOTE_FONT_SIZE, fontFamily: DEFAULT_FONT_FAMILY, strokeColor: ANSWER_COLOR,
      });
    }
    y += picture.height + MATH_GAP_PX;
  }
  await loadFonts(skeletons.filter((s) => s.type === "text"));
  const made = convertToExcalidrawElements(skeletons, { regenerateIds: false });
  const fresh = made.map((element) => {
    const placed = marked({ ...element, x: element.x + job.x, y: element.y + job.y, frameId: null });
    const withData = dataById.has(element.id) && element.type === "image"
      ? { ...placed, status: "saved", customData: { ...placed.customData, ...dataById.get(element.id) } }
      : placed;
    return aboveTombstone(withData, scene.get(element.id), undefined);
  });
  for (const file of files) knownFiles.add(file.id);
  api.addFiles(files);
  await revealDrawing(job, fresh);
  putInScene(fresh);
  showAllIfHidden(fresh);
  return { elements: fresh, files, before: [] };
}

// ---- Watchman Whiteboard: a 3D chart (draw_chart3d; the board server's lib/board-plot3d.js) ----
// The server sends a checked Plotly figure (numbers and plain texts). Plotly, staged in /vendor and loaded at the first
// such Job, draws it off screen and gives a PNG; it becomes one image element with the Job's id.
let plotlyModule = null;

function loadPlotly() {
  if (plotlyModule === null) {
    plotlyModule = import("plotly.js-dist-min").catch((error) => {
      plotlyModule = null;
      throw error;
    });
  }
  return plotlyModule;
}

async function drawPicture(job) {
  let Plotly;
  try {
    const module = await loadPlotly();
    Plotly = module.default || module;
  } catch (error) {
    throw jobError("PictureUnavailable", `Plotly did not load (${error && error.message})`);
  }
  const holder = document.createElement("div");
  holder.setAttribute("style", `position:fixed;left:-100000px;top:0;width:${job.width}px;height:${job.height}px`);
  document.body.appendChild(holder);
  let dataURL;
  try {
    const layout = { ...job.figure.layout, width: job.width, height: job.height };
    await Plotly.newPlot(holder, job.figure.data, layout, { staticPlot: true, displayModeBar: false });
    dataURL = await Plotly.toImage(holder, { format: "png", width: job.width, height: job.height, scale: 2 });
  } catch (error) {
    throw jobError("PictureUnavailable", `this browser could not draw the 3D chart (${error && error.message})`);
  } finally {
    try {
      Plotly.purge(holder);
    } catch (error) {
      // Nothing was drawn.
    }
    holder.remove();
  }
  if (typeof dataURL !== "string" || !dataURL.startsWith("data:image/png;base64,")) throw jobError("PictureUnavailable", "Plotly gave no PNG");
  const file = { id: await sha1Hex(dataURL), mimeType: "image/png", dataURL, created: Date.now() };
  const scene = new Map(api.getSceneElementsIncludingDeleted().map((element) => [element.id, element]));
  const [made] = convertToExcalidrawElements([{ type: "image", id: job.elementId, x: 0, y: 0, width: job.width, height: job.height, fileId: file.id }], { regenerateIds: false });
  const placed = marked({ ...made, x: job.x, y: job.y, frameId: null, status: "saved" });
  const element = aboveTombstone({ ...placed, customData: { ...placed.customData, pictureOf: job.summary } }, scene.get(job.elementId), undefined);
  knownFiles.add(file.id);
  api.addFiles([file]);
  await revealDrawing(job, [element]);
  putInScene([element]);
  showAllIfHidden([element]);
  return { elements: [element], files: [file], before: [] };
}

// After a 409 (the Job is gone, or SnapshotFailed), only the Server's Board counts (spec 3.6):
// take new Elements off, and put changed ones back as they were.
function undoLocal(result) {
  const beforeById = new Map((result.before || []).map((element) => [element.id, element]));
  const ids = new Set(result.elements.map((element) => element.id));
  for (const id of ids) {
    if (beforeById.has(id)) known.set(id, beforeById.get(id).version);
    else known.delete(id);
  }
  api.updateScene({
    elements: api.getSceneElementsIncludingDeleted()
      .filter((element) => !ids.has(element.id) || beforeById.has(element.id))
      .map((element) => beforeById.get(element.id) || element),
    captureUpdate: CaptureUpdateAction.NEVER,
  });
}

const JOB_RUNNERS = Object.freeze({
  answer: writeAnswer,
  shot: takeShot,
  draw: drawSkeletons,
  edit: editElements,
  mermaid: drawMermaid,
  math: drawMath,
  picture: drawPicture,
});

async function runJob(job) {
  let result = null;
  try {
    const runner = JOB_RUNNERS[job.kind];
    if (!runner) throw new Error(`unknown job kind ${job.kind}`);
    result = await runner(job);
  } catch (error) {
    const failure = { jobId: job.jobId, ok: false, error: String(error && error.message) };
    if (error && error.code) failure.code = error.code;
    await post("/api/job", failure).catch(() => {});
    return;
  }
  const { before, ...reply } = result;
  try {
    await post("/api/job", { jobId: job.jobId, ok: true, ...reply });
  } catch (error) {
    if (error.status !== 409 || !result.elements) return;
    if (job.kind === "answer") removeLocal(result.elements);
    else undoLocal(result);
  }
}

function reportVisibility() {
  post("/api/visibility", { visible: document.visibilityState === "visible" }).catch(() => {});
}

function offline() {
  setStatus({ ...status, online: false, leader: false });
}

function reopenLater() {
  if (reopenTimer === null) reopenTimer = setTimeout(openStream, RETRY_MS);
}

// The browser opens a broken stream again by itself, but not always: some browsers give up
// (readyState CLOSED), and a stream can stop without an error. Then we open a new one (FR-023a).
function openStream() {
  reopenTimer = null;
  if (source) source.close();
  const query = new URLSearchParams({ t: token, page: pageId, visible: document.visibilityState === "visible" ? "1" : "0" });
  const current = new EventSource(`/api/stream?${query}`);
  source = current;
  lastStreamMs = Date.now();
  const on = (type, handler) => current.addEventListener(type, (event) => {
    lastStreamMs = Date.now();
    handler(JSON.parse(event.data));
  });
  on("hello", onHello);
  // Watchman Whiteboard: answer each ping, so the board knows this page is still here (a page that answers none
  // stops counting, and the agents open the board again instead of drawing for no one).
  on("ping", () => post("/api/pong", {}).catch(() => {}));
  on("elements", (data) => applyRemote(data.elements, true));
  on("library", (data) => applyLibrary(data.items));
  on("cleared", onBoardCleared);
  on("files", (data) => applyRemoteFiles(data.files));
  on("role", (data) => {
    isLeader = data.leader;
    setStatus({ ...status, online: true, leader: isLeader });
    if (isLeader) fixAnswerSizes();
  });
  on("signal", (data) => setStatus({ ...status, signal: data.state, agent: data.agent || null }));
  on("voice", setVoice);
  on("idle", (data) => setStatus({ ...status, idleStopAtMs: Number.isFinite(data.stopAtMs) ? data.stopAtMs : null }));
  on("inbox", (data) => setStatus({ ...status, unsent: data.unsent, autoSend: data.autoSend }));
  on("job", runJob);
  on("bye", offline);
  current.onerror = () => {
    offline();
    if (current.readyState === EventSource.CLOSED) reopenLater();
  };
}

function connect() {
  openStream();
  setInterval(() => {
    if (source && Date.now() - lastStreamMs > STREAM_STALE_MS) {
      offline();
      openStream();
    }
  }, WATCH_STREAM_MS);
}

function setStatus(next) {
  status = next;
  showStatus(next);
}

// ---- Join from another device (0.6.0, FR-154) ----
// In LAN mode the Server sends the LAN Board URLs in hello. The page draws a QR code of each one itself, with
// qrcode-generator from esm.sh (pinned in the import map). The URL never leaves the page.
const QR_CELL_PX = 4;
const QR_MARGIN_CELLS = 4;
let qrModule = null;

function loadQr() {
  if (qrModule === null) {
    qrModule = import("qrcode-generator").catch((error) => {
      qrModule = null;
      throw error;
    });
  }
  return qrModule;
}

function QrCode({ text }) {
  const ref = React.useRef(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    loadQr().then((lib) => {
      if (!live || !ref.current) return;
      const make = lib.default || lib.qrcode;
      const qr = make(0, "M");
      qr.addData(text);
      qr.make();
      const count = qr.getModuleCount();
      const size = (count + 2 * QR_MARGIN_CELLS) * QR_CELL_PX;
      const canvas = ref.current;
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, size, size);
      context.fillStyle = "#000000";
      for (let row = 0; row < count; row += 1) {
        for (let col = 0; col < count; col += 1) {
          if (qr.isDark(row, col)) context.fillRect((col + QR_MARGIN_CELLS) * QR_CELL_PX, (row + QR_MARGIN_CELLS) * QR_CELL_PX, QR_CELL_PX, QR_CELL_PX);
        }
      }
    }).catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [text]);
  return failed ? h("div", null, "The QR code could not be made. Type the link instead.") : h("canvas", { ref, "aria-label": "QR code of the link" });
}

// The steps to trust the CA of this board on an iPad (0.6.1, FR-158; 0.7.1, FR-165, FR-167). Once per device.
const IPAD_STEPS = Object.freeze([
  "Scan the code of step 1 with the iPad camera and open it in Safari. Tap \"Allow\" to download the profile.",
  "Settings > General > VPN & Device Management: tap the profile \"Watchman Whiteboard local CA\", then \"Install\".",
  "Settings > General > About > Certificate Trust Settings: turn on \"Watchman Whiteboard local CA\".",
]);
const IPAD_FALLBACK = "If no profile appears: open the CA link on this computer, save the file to iCloud Drive or OneDrive, "
  + "open it on the iPad in the Files app (tap the file), then do steps 2 and 3.";

function caUrlOf(url) {
  try {
    return `${new URL(url).origin}/ca.crt`;
  } catch (error) {
    return null;
  }
}

// Copies a URL to the clipboard of this device (FR-164). The URL stays on this device: nothing is sent anywhere.
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (ok) resolve();
    else reject(new Error("copy failed"));
  });
}

function CopyButton({ text }) {
  const [state, setState] = React.useState("Copy");
  const onClick = () => copyText(text).then(() => setState("Copied")).catch(() => setState("Select and copy"));
  return h("button", { type: "button", className: "wbc-send wbc-copy", title: "Copy the link to the clipboard of this device", onClick }, state);
}

// One address: what it is, its QR code, the link, and a copy button (FR-163, FR-164).
function JoinTarget({ target, showQr }) {
  const name = target.recommended ? `${target.label} - recommended` : target.label;
  return h("div", { className: target.recommended ? "wbc-join-target wbc-recommended" : "wbc-join-target" },
    h("div", { className: "wbc-join-name" }, `${name} (${target.name}, ${target.address})`),
    showQr ? h(QrCode, { text: target.url }) : null,
    h("div", { className: "wbc-join-row" }, h("div", { className: "wbc-join-url" }, target.url), h(CopyButton, { text: target.url })));
}

// The "Join" dialog (FR-165): step 1 trusts the CA of the board (once per device), step 2 opens the board.
// The recommended address comes first; the others wait under "Other addresses" (FR-163).
function JoinDialog({ targets, onClose }) {
  const first = targets[0];
  const caUrl = first.caUrl || caUrlOf(first.url);
  const others = targets.slice(1);
  return h("div", { className: "wbc-join-dialog", onClick: onClose },
    h("div", { className: "wbc-join-box", onClick: (event) => event.stopPropagation() },
      h("strong", null, "Join from another device (same network)"),
      h("div", null, "Anyone with the board link can see and change the board."),
      caUrl ? h("div", { className: "wbc-join-step" },
        h("strong", null, "Step 1 (once per device): trust the CA of this board"),
        h("div", { className: "wbc-join-target" },
          h(QrCode, { text: caUrl }),
          h("div", { className: "wbc-join-row" }, h("div", { className: "wbc-join-url" }, h("a", { href: caUrl, download: "watchman-whiteboard-ca.crt" }, caUrl)), h(CopyButton, { text: caUrl }))),
        h("ol", null, ...IPAD_STEPS.map((step) => h("li", { key: step }, step))),
        h("div", { className: "wbc-join-note" }, IPAD_FALLBACK),
        h("div", { className: "wbc-join-note" }, "Another computer: download the CA with the link and add it to the trusted root certificates once.")) : null,
      h("div", { className: "wbc-join-step" },
        h("strong", null, "Step 2: open the board"),
        h(JoinTarget, { target: first, showQr: true }),
        others.length > 0 ? h("details", null,
          h("summary", null, `Other addresses (${others.length}) - use them only when the recommended one does not work`),
          ...others.map((target) => h(JoinTarget, { key: target.url, target, showQr: true }))) : null),
      h("button", { type: "button", className: "wbc-send", onClick: onClose }, "Close")));
}

// The idle warning (0.6.1, FR-160): the Server stops soon because nobody uses the board.
function IdleBanner({ stopAtMs }) {
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 15000);
    return () => clearInterval(timer);
  }, []);
  const minutes = Math.max(0, Math.ceil((stopAtMs - Date.now()) / 60000));
  const at = new Date(stopAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return h("div", { className: "wbc-idle", role: "status" },
    `Nobody used this board for a while. It stops at ${at} (in about ${minutes} min) and saves a copy. Touch the board to keep it open.`);
}

// One glyph. The markup comes only from GLYPH above, never from the board or the Server.
// Only the Leader chain has stroke 3: the shape, not the color, tells the Leader (R-058).
function Glyph({ name, width = 2 }) {
  return h("svg", {
    viewBox: "0.8 1.5 22.7 21", fill: "none", stroke: "currentColor", strokeWidth: width,
    strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", dangerouslySetInnerHTML: { __html: GLYPH[name] },
  });
}

// Watchman Whiteboard: what Watchman's voice says now (hello, the `voice` event), for VoiceLayer. The palette, which
// shows the rest of the status, is not rendered (see App), so the voice has its own listeners.
const voiceListeners = new Set();
function setVoice(voice) {
  status = { ...status, voice };
  for (const listener of voiceListeners) listener(voice);
}

// Rendered beside the board by App: the voice character while Watchman's voice speaks.
function VoiceLayer() {
  const [voice, update] = React.useState(status.voice);
  React.useEffect(() => {
    voiceListeners.add(update);
    update(status.voice);
    return () => voiceListeners.delete(update);
  }, []);
  return h(VoiceCharacter, { voice });
}

// Watchman Whiteboard: the voice character in 3-D, the same as Watchman's voice mode (the owner, 2026-11-17), drawn by
// Watchman's own code (vendor/character.js, src/features/whiteboard/board/boardCharacter.ts) from the files the board
// serves (/api/voice/character, /api/voice/clip/N; lib/board-voice.js). One stage per character, kept while the voice
// pauses between sentences, so the character loads once; drawn only while shown. Without the staged bundle (the page
// served from esm.sh) or WebGL, or when its files will not load, the picture stands instead.
let characterModule = null;
function loadCharacterModule() {
  if (characterModule === null) {
    characterModule = import("watchman-character").catch((error) => {
      console.warn("[board] the voice character's code did not load", error);
      return null;
    });
  }
  return characterModule;
}
const figure = { id: "", canvas: null, stage: null, ready: false, failed: "", listeners: new Set() };
function figureChanged() {
  for (const listener of figure.listeners) listener(figure.ready ? figure.id : "");
}
// @purity non-pure
async function voiceFileBytes(part) {
  const reply = await fetch(`/api/voice/${part}`, { headers: { "x-board-token": token }, cache: "no-store" });
  if (!reply.ok) throw new Error(`/api/voice/${part}: HTTP ${reply.status}`);
  return reply.arrayBuffer();
}
// @purity non-pure
async function startFigure(model) {
  if (!model || figure.id === model.id || figure.failed === model.id) return;
  if (figure.stage) figure.stage.dispose();
  Object.assign(figure, { id: model.id, canvas: null, stage: null, ready: false });
  figureChanged();
  const lib = await loadCharacterModule();
  if (figure.id !== model.id) return;
  const failed = (why) => {
    console.warn("[board] the voice character did not load:", why);
    if (figure.stage) figure.stage.dispose();
    Object.assign(figure, { failed: model.id, canvas: null, stage: null, ready: false });
    figureChanged();
  };
  if (!lib) return failed("no vendor/character.js");
  const canvas = document.createElement("canvas");
  canvas.className = "wbv-figure";
  canvas.setAttribute("aria-hidden", "true");
  try {
    figure.canvas = canvas;
    figure.stage = lib.mountBoardCharacter(canvas, {
      character: () => voiceFileBytes("character"),
      clips: model.clips.map((name, index) => `${index}/${name}`),
      clip: (key) => voiceFileBytes(`clip/${key.split("/")[0]}`),
    }, {
      onReady: () => {
        if (figure.id !== model.id) return;
        figure.ready = true;
        figureChanged();
      },
      onError: failed,
    });
  } catch (error) {
    failed(error && error.message ? error.message : String(error));
  }
}

// The id of the character ready to show, "" while none is.
function useFigure() {
  const [ready, setReady] = React.useState(figure.ready ? figure.id : "");
  React.useEffect(() => {
    figure.listeners.add(setReady);
    return () => figure.listeners.delete(setReady);
  }, []);
  return ready;
}

// Watchman Whiteboard: Watchman's voice character over the board's corner while it speaks (voice.mjs voiceView). It
// stays VOICE_LINGER_MS after the voice stops, so it does not blink out between sentences.
function VoiceCharacter({ voice }) {
  const [view, setView] = React.useState(() => voiceView(voice));
  const slot = React.useRef(null);
  const ready = useFigure();
  React.useEffect(() => {
    const next = voiceView(voice);
    if (next.model) void startFigure(next.model);
    // The mouth moves only while the voice speaks; the character stays through the linger.
    if (figure.stage) figure.stage.speaking(next.shown);
    if (next.shown) {
      setView(next);
      return undefined;
    }
    const timer = setTimeout(() => setView(next), VOICE_LINGER_MS);
    return () => clearTimeout(timer);
  }, [voice]);
  const figureShown = view.shown && view.model !== null && ready === view.model.id;
  React.useEffect(() => {
    if (!figure.stage) return undefined;
    figure.stage.show(figureShown);
    if (figureShown && slot.current && figure.canvas && figure.canvas.parentNode !== slot.current) slot.current.appendChild(figure.canvas);
    return undefined;
  }, [figureShown, ready]);
  if (!view.shown) return null;
  const face = figureShown
    ? h("div", { className: "wbv-stand", ref: slot })
    : view.picture ? h("img", { className: "wbv-face", src: view.picture, alt: "" }) : h("div", { className: "wbv-face wbv-mark" });
  return h("div", { className: "wbv", role: "status", "aria-live": "polite", "aria-label": view.label },
    face,
    h("div", { className: "wbv-words" },
      view.name ? h("div", { className: "wbv-name" }, view.name) : null,
      view.subtitle ? h("div", { className: "wbv-text" }, view.subtitle) : null));
}

// The palette (0.7.2, R-052 to R-058): one vertical column of glyph buttons at the right, under the Library
// button (under the right column in the phone layout). It folds into one button and does not move.
// Each full text is a tooltip at the left (data-tip) and the accessible name.
function Palette() {
  const [shown, update] = React.useState(status);
  const [joinOpen, setJoinOpen] = React.useState(false);
  const [folded, setFolded] = React.useState(false);
  React.useEffect(() => {
    showStatus = update;
    update(status);
  }, []);
  const tip = (text) => ({ "data-tip": text, "aria-label": text });
  const count = shown.unsent > 0 && !shown.autoSend ? h("span", { className: "wbp-count" }, String(Math.min(shown.unsent, 99))) : null;
  const overlays = [
    shown.idleStopAtMs ? h(IdleBanner, { key: "idle", stopAtMs: shown.idleStopAtMs }) : null,
    joinOpen ? h(JoinDialog, { key: "join", targets: shown.join, onClose: () => setJoinOpen(false) }) : null,
  ];
  if (folded) {
    return h("div", { className: "wbp", role: "toolbar", "aria-orientation": "vertical", "aria-label": "Watchman Whiteboard" },
      ...overlays,
      h("button", { type: "button", className: "wbp-btn", ...tip("Show the Watchman Whiteboard palette (same button)"), onClick: () => setFolded(false) },
        h(Glyph, { name: "fold" }), count));
  }
  // R-054: while auto send is on, Send stays in its place, pale, and cannot be pressed.
  const sendTip = shown.autoSend
    ? "Send: off while auto send is on"
    : sendLabel(shown.unsent, shown.agent);
  const autoTip = shown.autoSend
    ? "Auto send: on. Each text goes by itself, 1.5 s after you stop typing"
    : "Auto send: off. Press to send each text by itself, 1.5 s after you stop typing";
  const connection = shown.online ? (shown.leader ? "leader" : "member") : "off";
  // R-060 (0.7.3): while not connected, the Signal is old news; only the broken chain stays.
  const activityText = signalLabel(shown.signal, shown.agent);
  const activity = shown.online && activityText
    ? h("div", { className: `wbp-btn wbp-${shown.signal}`, role: "status", tabIndex: 0, ...tip(activityText) },
      h(Glyph, { name: shown.signal }))
    : null;
  return h("div", { className: "wbp", role: "toolbar", "aria-orientation": "vertical", "aria-label": "Watchman Whiteboard" },
    ...overlays,
    h("div", { className: "wbp-btn wbp-grip", "aria-hidden": "true" }, h(Glyph, { name: "grip" })),
    h("button", {
      type: "button",
      className: `wbp-btn wbp-send${shown.autoSend ? " wbp-dim" : shown.unsent > 0 ? " wbp-primary" : ""}`,
      disabled: shown.autoSend,
      ...tip(sendTip),
      onClick: sendToClaude,
    }, h(Glyph, { name: "send" }), count),
    h("button", {
      type: "button", className: shown.autoSend ? "wbp-btn wbp-auto wbp-on" : "wbp-btn wbp-auto", "aria-pressed": shown.autoSend,
      ...tip(autoTip), onClick: () => setAutoSend(!shown.autoSend),
    }, h(Glyph, { name: "auto" })),
    h("div", { className: "wbp-sep" }),
    activity,
    h("div", { className: `wbp-btn wbp-conn wbp-${connection}`, role: "status", tabIndex: 0, ...tip(CONNECTION_TEXT[connection]) },
      h(Glyph, { name: connection === "off" ? "unlink" : "link", width: connection === "leader" ? 3 : 2 })),
    shown.join && shown.join.length > 0
      ? h("button", { type: "button", className: "wbp-btn wbp-join", ...tip("Join from another device: links and QR codes for a phone or tablet"), onClick: () => setJoinOpen(true) },
        h(Glyph, { name: "qr" }))
      : null,
    h("div", { className: "wbp-sep" }),
    h("button", { type: "button", className: "wbp-btn wbp-fold", ...tip("Fold the palette (press again to show it)"), onClick: () => setFolded(true) },
      h(Glyph, { name: "fold" })));
}

// ---- Watchman Whiteboard: the drawing tools at the right, folded (the owner, 2026-11-17) ----
// Excalidraw's toolbar (hand, select, shapes, pen, text…) left the top of the board: it is a column at the right,
// under the Library button, where the palette was, and starts folded, since an agent draws most boards. This button,
// under Library, shows and folds it; index.html places the toolbar under the button (`.App-toolbar-container`) and
// hides it while `html.wb-tools-folded` is set. Rendered by App. The keyboard shortcuts work either way. A folded or
// open choice is remembered per viewer (browser storage, a convenience only: it may be missing, and folded is the
// default then). The phone layout keeps Excalidraw's own toolbar at the bottom (index.html), so no button there.
const TOOLS_FOLDED_KEY = "watchman-whiteboard.toolsFolded";

function readToolsFolded() {
  try {
    return window.localStorage.getItem(TOOLS_FOLDED_KEY) !== "0";
  } catch {
    return true;
  }
}

function ToolsToggle() {
  const [folded, setFolded] = React.useState(readToolsFolded);
  React.useEffect(() => {
    document.documentElement.classList.toggle("wb-tools-folded", folded);
    try {
      window.localStorage.setItem(TOOLS_FOLDED_KEY, folded ? "1" : "0");
    } catch {
      // No storage here (a private window): the choice lasts until the page closes.
    }
  }, [folded]);
  const text = folded ? "Show the drawing tools" : "Fold the drawing tools";
  return h("button", {
    type: "button", className: folded ? "wbt" : "wbt wbt-open", title: text, "aria-label": text,
    "aria-expanded": !folded, onClick: () => setFolded(!folded),
  }, h(Glyph, { name: folded ? "tools" : "collapse" }));
}

// ---- Watchman Whiteboard: only Watchman on the page, none of Excalidraw's branding (brand.mjs, ../../../UPSTREAM) ----
// Our own main menu (Excalidraw's default one has an "Excalidraw links" group) with the useful board actions only.
function BoardMenu() {
  return h(MainMenu, null, ...menuItems(look).map((name) => h(MainMenu.DefaultItems[name], { key: name })));
}

// ---- Watchman Whiteboard: Watchman's look (look.mjs, ../../../UPSTREAM) ----
// In a Watchman tab the link's hash says Watchman's theme and glass; Watchman sends a new hash when either
// changes (no reload). The theme goes to Excalidraw (App), the glass makes the page and the canvas see-through,
// and the canvas colour is set on this page only: the Server never receives appState.
let look = lookFromHash(window.location.hash);
const lookListeners = new Set();

function applyLook() {
  document.documentElement.classList.toggle("wm-glass", look.inWatchman && look.glass);
  // The canvas only (lookAppState): never the tool, which stays the one the owner picked.
  const change = lookAppState(look);
  if (api !== null && change !== null && api.getAppState().viewBackgroundColor !== change.viewBackgroundColor) {
    api.updateScene({ appState: change, captureUpdate: CaptureUpdateAction.NEVER });
  }
}

// Watchman Whiteboard: a new drawing cleared the board (the Server's `cleared` event): back to the Hand tool, so the
// owner's next drag pans instead of selecting the new drawing.
function onBoardCleared() {
  if (api !== null) api.setActiveTool({ type: HAND_TOOL.type });
}

window.addEventListener("hashchange", () => {
  look = lookFromHash(window.location.hash);
  applyLook();
  for (const listener of lookListeners) listener(look);
});
applyLook();

// Our own welcome screen of an empty board: our name in place of Excalidraw's logo.
function BoardWelcome() {
  return h(WelcomeScreen, null,
    h(WelcomeScreen.Center, null,
      h(WelcomeScreen.Center.Logo, null, WELCOME.title),
      h(WelcomeScreen.Center.Heading, null, WELCOME.heading)));
}

// Excalidraw's labels that name it (rebrand) are renamed, and the library's Publish item (an upload to
// Excalidraw's site) is hidden, wherever Excalidraw shows them. Text a Person types is never touched.
function rebrandNode(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest("textarea, input, [contenteditable]")) continue;
    const renamed = rebrand(node.nodeValue);
    if (renamed !== null) node.nodeValue = renamed;
  }
  if (root.querySelectorAll) {
    for (const item of root.querySelectorAll(".library-menu-dropdown-container .dropdown-menu-item")) {
      if (HIDDEN_TEXTS.includes(item.textContent.trim())) item.style.display = "none";
    }
  }
}

function watchBranding() {
  rebrandNode(document.body);
  new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === "characterData" && change.target.parentElement) rebrandNode(change.target.parentElement);
      for (const added of change.addedNodes || []) {
        if (added.nodeType === Node.ELEMENT_NODE) rebrandNode(added);
        else if (added.nodeType === Node.TEXT_NODE && added.parentElement) rebrandNode(added.parentElement);
      }
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}

// The right-hand palette (Send, Auto-send, the agent's signal, the connection, Join) is not rendered (the owner,
// 2026-11-17: "if it's not usable, why show it"): its Send reaches only an agent that watches the board with
// Claude's Monitor tool, so no agent in Watchman today. Palette stays in this file for board replies later.
function App() {
  const [shownLook, setShownLook] = React.useState(look);
  React.useEffect(() => {
    lookListeners.add(setShownLook);
    return () => lookListeners.delete(setShownLook);
  }, []);
  // The canvas colour goes in the first scene too: Excalidraw calls excalidrawAPI before it loads its first scene,
  // and that load set the colour back to white (seen on the Mac: a see-through board painted solid white, which the
  // dark theme shows near-black). onChange then keeps it, so nothing later puts it back either.
  // Watchman Whiteboard: beside the board, Watchman's voice character while it speaks (VoiceLayer).
  return h(React.Fragment, null, h(Excalidraw, {
    excalidrawAPI: (value) => {
      if (api !== null) return;
      api = value;
      connect();
      applyLook();
    },
    // Watchman Whiteboard: the first scene starts on the Hand tool (look.mjs firstAppState), with the canvas colour.
    initialData: { appState: firstAppState(look) },
    onChange: (elements, appState, files) => {
      onChange(elements, appState, files);
      const background = canvasBackground(look);
      if (api !== null && background !== null && appState.viewBackgroundColor !== background) applyLook();
    },
    name: "Watchman Whiteboard",
    onLibraryChange,
    ...(shownLook.theme ? { theme: shownLook.theme } : {}),
  }, h(BoardMenu), h(BoardWelcome)), h(ToolsToggle), h(VoiceLayer));
}

window.addEventListener("keydown", onKeyDown, true);
// Tells the Server that a Person uses the page (FR-159).
function reportActivity() {
  const now = Date.now();
  if (!token || (now - lastActivitySentMs < ACTIVITY_MS && status.idleStopAtMs === null)) return;
  lastActivitySentMs = now;
  post("/api/activity", {}).catch(() => {
    lastActivitySentMs = 0;
  });
}

for (const type of ["keydown", "pointerdown", "paste", "drop"]) {
  window.addEventListener(type, () => {
    lastInputMs = Date.now();
    reportActivity();
  }, true);
}
window.addEventListener("wheel", reportActivity, { capture: true, passive: true });
// A hidden page gives the Leader role to a page on screen (FR-085).
document.addEventListener("visibilitychange", reportVisibility);

if (!token) {
  showNotice("This page needs the full link that Watchman showed you. It ends with #t= and a code.");
} else {
  createRoot(document.getElementById("root")).render(h(App));
  watchBranding();
}
