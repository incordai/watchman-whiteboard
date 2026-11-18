#!/usr/bin/env node
"use strict";

// Board Server: serves the whiteboard page, keeps the Board, saves it to a JSON file,
// tells Claude Code about new Messages (JSON lines on stdout and in <data>/server.log),
// and takes Answers on a local HTTP API.
// Start it with board.js (it runs this file in the background). See docs/spec-en.md.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");

const { parseConfig } = require("./lib/config");
const { createEventSink, redact } = require("./lib/event-sink");
const { createTrackerState, trackMessages } = require("./lib/message-tracker");
const { summarize, summarizeBoard, diffBoards, countOf, toSentEvent } = require("./lib/board-diff");
const { toItems, pruneDeleted } = require("./lib/board-store");
const {
  checkDraw, checkMermaid, checkSay, checkEdit, checkDeleteBody, planDelete, changedList, boxOf, filterDrawResult, filterEditResult,
} = require("./lib/board-ops");
const { checkMathBody, renderSteps, renderTex } = require("./lib/board-math");
const { checkMoleculeBody, renderMolecules } = require("./lib/board-chem");
const { checkFigure } = require("./lib/board-plot3d");
const { createOperationLog } = require("./lib/operation-log");
const { createBoardHub } = require("./lib/board-hub");
const { createBoardApi } = require("./lib/board-api");
const { createControlApi } = require("./lib/control-api");
const {
  dataPaths, loadBoard, saveBoard, loadOrCreateToken, writeFileAtomic, readJsonOrNull, loadFiles, saveFile, createSnapshotStore,
} = require("./lib/data-files");
const { addFiles, checkFile } = require("./lib/board-files");
const { createIdleTimer, warnTimeOf } = require("./lib/idle-timer");
const { toExcalidrawFile, exportFileName } = require("./lib/excalidraw-file");
const { lanAddresses, lanInterfaces, boardUrls, joinTargets } = require("./lib/lan");
const { createCaHttpServer, defaultRouteAddress } = require("./lib/ca-http");
const { AppError } = require("./lib/app-error");
const {
  newDrawingDue, libraryItemOf, addToLibrary, checkLibrary, checkDrawer, loadLibrary, saveLibrary,
} = require("./lib/board-library");

const SKILL_DIR = path.resolve(__dirname, "..");
const PAGE_DIR = path.join(SKILL_DIR, "page");
const PACKAGE_VERSION = require("../package.json").version;
// Text last changed this long before the Server started is old, even if a page sends it later (FR-009a).
const OLD_TEXT_MARGIN_MS = 30000;
const DELETED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// say waits this long for the Leader page; after that it answers 202 and the Answer stays queued.
const SAY_WAIT_MS = 8000;
// The Pages show the idle warning this long before the Server stops (R-039).
const IDLE_WARN_MS = 5 * 60000;
const PNG_BASE64_HEAD = "iVBORw0KGgo";
// Watchman Whiteboard: how long a probe waits for the pages to answer its ping, by default and at most. A page that
// is there answers in milliseconds; one in a hidden browser tab may take a second.
const PROBE_WAIT_MS = 1500;
const PROBE_MAX_MS = 5000;
const STARTED_AT_MS = Date.now();
const EXIT_CODE = Object.freeze({ ok: 0, InvalidConfig: 2, CertMissing: 3, PortInUse: 4, Internal: 6 });

// A random versionNonce, as Excalidraw makes them (FR-021).
// @purity non-pure
function newNonce() {
  return crypto.randomInt(1, 2 ** 31 - 1);
}

// @purity semi-pure-b
function readCert(paths) {
  try {
    return { cert: fs.readFileSync(paths.cert), key: fs.readFileSync(paths.key) };
  } catch (error) {
    return null;
  }
}

// @purity non-pure
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

// @purity non-pure
async function main() {
  const parsed = parseConfig(process.argv.slice(2), os.tmpdir(), SKILL_DIR);
  const logPath = parsed.ok ? parsed.config.logPath : parsed.logPath;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  // The Server writes the log itself, so it is UTF-8 in every shell (PowerShell redirection is not).
  const logFd = fs.openSync(logPath, "w");
  const secrets = [];
  // @purity non-pure
  const write = (line) => {
    process.stdout.write(line);
    fs.writeSync(logFd, line);
  };
  const events = createEventSink({ write, nowMs: Date.now, secrets });
  const hide = (text) => redact(text, secrets);

  if (!parsed.ok) {
    events.emit({ event: "ServerFailed", reason: parsed.reason, message: parsed.message });
    process.exit(EXIT_CODE[parsed.reason]);
  }
  const config = parsed.config;
  const paths = dataPaths(config.dataDir);
  const token = loadOrCreateToken(paths.token);
  secrets.push(token);

  let tls = null;
  // The CA certificate in DER form, for GET /ca.crt in LAN mode (FR-156); null without a CA.
  let caDer = null;
  if (config.lan) {
    tls = readCert(paths);
    try {
      caDer = new crypto.X509Certificate(fs.readFileSync(paths.ca)).raw;
    } catch (error) {
      caDer = null;
    }
    if (!tls) {
      events.emit({ event: "ServerFailed", reason: "CertMissing", message: "no certificate; run setup.js --lan first" });
      process.exit(EXIT_CODE.CertMissing);
    }
  }

  const loaded = loadBoard(paths.board, Date.now());
  if (loaded.warning) events.emit({ event: "BoardWarning", message: loaded.warning });
  const elements = new Map();
  for (const element of pruneDeleted(loaded.elements, Date.now(), DELETED_KEEP_MS)) {
    if (element && typeof element.id === "string") elements.set(element.id, element);
  }

  // The image files of the Board (FR-082). Files that fail the check are left out.
  const files = new Map();
  const loadedFiles = addFiles(files, loadFiles(paths.files));
  for (const bad of loadedFiles.rejected) events.emit({ event: "FileRejected", id: bad.id, reason: bad.reason });

  // Watchman Whiteboard: the board's Library (lib/board-library.js), and the agent whose drawing is on the board now
  // (the `drawer` of the last draw or mermaid that named one; null after a restart or a clear).
  const libraryPath = path.join(config.dataDir, "library.json");
  let library = loadLibrary(libraryPath);
  let currentDrawer = null;

  // When the Server first got each Element, so added texts can be listed in the order they were written.
  const firstSeenMs = new Map();
  // The Board at the last Send (FR-076). Kept on disk, so a restart does not lose what is not sent yet.
  const savedBaseline = readJsonOrNull(paths.baseline);
  let baseline = savedBaseline && Array.isArray(savedBaseline.items)
    ? new Map(savedBaseline.items.map((item) => [item.id, item]))
    : summarizeBoard(elements.values());

  // Claude's own work goes into the Baseline at once, so Send does not list it (FR-076, FR-092).
  // @purity non-pure
  function takeIntoBaseline(list) {
    for (const element of list) {
      if (element.isDeleted) baseline.delete(element.id);
      else baseline.set(element.id, summarize(element));
    }
    saveBaseline();
  }

  // @purity non-pure
  function saveBaseline() {
    try {
      writeFileAtomic(paths.baseline, JSON.stringify({ v: 1, items: [...baseline.values()] }));
    } catch (error) {
      events.emit({ event: "SaveFailed", message: String(error && error.message) });
    }
  }

  let dirty = false;
  let stopping = false;
  const clock = { setTimeout, clearTimeout, setInterval, clearInterval, now: Date.now };
  // 0.6.1 (R-039): stop after the idle time, with a warning on the Pages before it (FR-159 to FR-162).
  const idleMs = config.idleStopMs > 0 ? config.idleStopMs : config.idleStopMin * 60000;
  // `stopForIdle` and `hub` are set below; the timer calls them only later.
  const idle = createIdleTimer({
    clock, idleMs, warnMs: warnTimeOf(idleMs, IDLE_WARN_MS),
    onWarn: (stopAtMs) => {
      events.emit({ event: "IdleWarning", stopAtMs });
      hub.setIdleWarning(stopAtMs);
    },
    onClear: () => hub.setIdleWarning(null),
    onIdle: () => stopForIdle(),
  });
  const hub = createBoardHub({
    elements, events, clock, jobTimeoutMs: config.jobTimeoutMs, gapPx: config.answerGapPx, indentPx: config.answerIndentPx,
    idleStopAtMs: () => idle.warningStopAtMs(),
    // Watchman Whiteboard: the board's Library, in every page's hello.
    library: () => library,
    // The LAN Board URLs for the "Join from another device" button (FR-154). `urls` is set before any page joins.
    joinTargets: () => join,
    onBoardChanged: (changed) => {
      dirty = true;
      const now = Date.now();
      for (const element of changed) {
        if (!firstSeenMs.has(element.id)) firstSeenMs.set(element.id, now);
      }
    },
    // Claude's own Answers are not news for Claude.
    onAnswerWritten: takeIntoBaseline,
    applyOperation: (job, reply) => applyJobResult(job, reply),
    files,
    onFilesAdded: (added) => {
      for (const file of added) {
        try {
          saveFile(paths.files, file);
        } catch (error) {
          events.emit({ event: "SaveFailed", message: String(error && error.message) });
        }
      }
    },
  });

  // Snapshots and undo (FR-102 to FR-106).
  const operationLog = createOperationLog({ store: createSnapshotStore(paths.snapshots, Date.now), undoDepth: config.undoDepth });
  for (const warning of operationLog.load()) events.emit({ event: "BoardWarning", message: warning });

  // Writes the Snapshot, then merges `list` into the Board and the Baseline (FR-092, FR-102).
  // Returns the Elements that changed the Board. Throws SnapshotFailed and changes nothing (FR-106).
  // @purity non-pure
  function applyOperationElements(opId, kind, list, viaHub) {
    const fresh = list.filter((element) => {
      const current = elements.get(element.id);
      return !current || element.version > current.version
        || (element.version === current.version && element.versionNonce < current.versionNonce);
    });
    if (fresh.length === 0) return [];
    operationLog.record({ opId, kind, atMs: Date.now(), boardBefore: [...elements.values()], changed: changedList(fresh) });
    const changed = viaHub ? hub.applyServerChanges(fresh) : mergeInto(fresh);
    takeIntoBaseline(changed);
    return changed;
  }

  // For Job results: the hub sends them to the other pages itself.
  // @purity non-pure
  function mergeInto(list) {
    const changed = [];
    for (const element of list) {
      elements.set(element.id, element);
      changed.push(element);
    }
    return changed;
  }

  // The result of a draw, edit, or mermaid Job (FR-090, FR-094, FR-095, FR-099).
  // @purity non-pure
  function applyJobResult(job, reply) {
    if (job.kind === "edit") {
      // Watchman Whiteboard: a math step changed with tex keeps the server's LaTeX, and its new picture must pass.
      // A molecule changed with smiles keeps the server's SMILES the same way.
      const dataOf = new Map(job.changes.flatMap((change) => (change.tex !== undefined ? [[change.id, { mathTex: change.tex }]]
        : change.smiles !== undefined ? [[change.id, { smiles: change.smiles }]] : [])));
      const list = filterEditResult(reply.elements, elements, job.changes.map((change) => change.id))
        .map((element) => (dataOf.has(element.id) ? { ...element, customData: { ...element.customData, ...dataOf.get(element.id) } } : element));
      checkJobFiles(list, reply.files);
      const changed = applyOperationElements(job.opId, job.kind, list, false);
      return { changed, result: { opId: changed.length > 0 ? job.opId : null, ids: changed.map((element) => element.id) } };
    }
    const withImages = job.kind === "mermaid" || job.kind === "math" || job.kind === "picture";
    const drawn = filterDrawResult(reply.elements, elements, job.boardTargets || [], withImages);
    const { targets } = drawn;
    // Watchman Whiteboard: each math step carries the LaTeX the server checked, and each molecule its SMILES, whatever
    // the page sent.
    const dataOf = new Map((job.kind === "math" ? job.steps : [])
      .map((step) => [step.id, step.smiles !== undefined ? { smiles: step.smiles } : { mathTex: step.tex }]));
    // A 3D chart's picture carries what it shows, for read_board.
    if (job.kind === "picture") dataOf.set(job.elementId, { pictureOf: job.summary });
    const added = drawn.added.map((element) => (dataOf.has(element.id) && element.type === "image"
      ? { ...element, customData: { ...element.customData, ...dataOf.get(element.id) } } : element));
    const image = added.some((element) => element.type === "image");
    if (withImages) checkJobFiles(added, reply.files);
    const changed = applyOperationElements(job.opId, job.kind, [...added, ...targets], false);
    const box = boxOf(added);
    const addedIds = added.map((element) => element.id);
    let ids = addedIds;
    if (job.kind === "draw") {
      // One ID per Skeleton, in order (4.4); the page tells the IDs of Skeletons without an id.
      const fromPage = Array.isArray(reply.ids) && reply.ids.length === job.elements.length ? reply.ids : null;
      ids = job.elements.map((skeleton, index) => skeleton.id || (fromPage ? String(fromPage[index]) : null));
    }
    if (job.kind === "math") ids = job.steps.map((step) => step.id);
    if (job.kind === "picture") ids = [job.elementId];
    const result = { opId: changed.length > 0 ? job.opId : null, ids, count: added.length, ...box };
    // Watchman Whiteboard: what the server worked out for each picture (a molecule's formula and molar mass).
    if (job.kind === "math" && job.steps.some((step) => step.formula)) {
      result.details = job.steps.map((step) => ({ id: step.id, name: step.name || null, formula: step.formula, molarMass: step.molarMass }));
    }
    if (withImages) result.image = image;
    return { changed, result };
  }

  // An image from a Mermaid picture must pass the image check (FR-083, FR-095).
  // @purity non-pure
  function checkJobFiles(added, list) {
    const needed = added.filter((element) => element.type === "image").map((element) => element.fileId);
    for (const fileId of needed) {
      if (files.has(fileId)) continue;
      const file = (Array.isArray(list) ? list : []).find((candidate) => candidate && candidate.id === fileId);
      const checked = checkFile(file);
      if (!checked.file) {
        events.emit({ event: "FileRejected", id: String(fileId).slice(0, 128), reason: checked.reason || "missing" });
        throw new AppError("JobFailed", 502, `the image of the diagram was refused: ${checked.reason || "missing"}`);
      }
    }
  }

  // @purity non-pure
  async function runOperation(job) {
    const { done } = hub.queueOperation(job, operationLog.reserveOpId);
    return done;
  }

  // @purity non-pure
  function draw(body) {
    const checked = checkDraw(body, elements, config.maxTextChars);
    const drawer = startNewDrawing(body, checked.boardTargets.length > 0);
    const job = { kind: "draw", elements: checked.skeletons, at: checked.at, boardTargets: checked.boardTargets, reused: checked.reused };
    return drawnBy(drawer, runOperation(withSay(job, body)));
  }

  // @purity non-pure
  function mermaid(body) {
    const checked = checkMermaid(body);
    const drawer = startNewDrawing(body, false);
    return drawnBy(drawer, runOperation(withSay({ kind: "mermaid", source: checked.source, at: checked.at }, body)));
  }

  // Watchman Whiteboard: math steps (draw_math). Every step is checked (KaTeX) and drawn (MathJax SVG) before the Job,
  // so a bad step changes nothing; the page turns each SVG into a PNG image (lib/board-math.js, page/app.js drawMath).
  // @purity non-pure
  async function math(body) {
    const checked = checkMathBody(body, elements);
    const steps = await renderSteps(checked.steps);
    const drawer = startNewDrawing(body, false);
    return drawnBy(drawer, runOperation(withSay({ kind: "math", steps, at: checked.at }, body)));
  }

  // Watchman Whiteboard: structural formulas (draw_molecule). OpenChemLib reads each SMILES and draws it as an SVG
  // before the Job (lib/board-chem.js); the page makes each a PNG image, as it does a math step.
  // @purity non-pure
  async function molecule(body) {
    const checked = checkMoleculeBody(body, elements);
    const steps = await renderMolecules(checked.molecules);
    const drawer = startNewDrawing(body, false);
    return drawnBy(drawer, runOperation(withSay({ kind: "math", steps, at: checked.at }, body)));
  }

  // Watchman Whiteboard: a 3D chart (draw_chart3d). Its figure (numbers and plain texts, lib/board-plot3d.js) is
  // checked here; the page draws it with its staged Plotly and sends one PNG image back.
  // @purity non-pure
  function chart3d(body) {
    const id = body && body.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new AppError("InvalidPlot", 400, "id must be 1 to 64 letters, digits, - or _");
    if (elements.has(id) && !elements.get(id).isDeleted) throw new AppError("DuplicateId", 409, `ids already on the Board: ${id}`, { ids: [id] });
    checkFigure(body.figure);
    const size = (value, fallback) => (Number.isInteger(value) && value >= 200 && value <= 1600 ? value : fallback);
    const summary = typeof body.summary === "string" ? body.summary.slice(0, 300) : "3D chart";
    const at = body.at && Number.isFinite(body.at.x) && Number.isFinite(body.at.y) ? { x: body.at.x, y: body.at.y } : null;
    const drawer = startNewDrawing(body, false);
    // elementId: the hub numbers its Jobs in job.id.
    const job = { kind: "picture", elementId: id, figure: body.figure, width: size(body.width, 720), height: size(body.height, 540), summary, at };
    return drawnBy(drawer, runOperation(withSay(job, body)));
  }

  // Watchman Whiteboard (the owner, 2026-11-17): before a NEW drawing (lib/board-library.js newDrawingDue: another
  // agent's, or fresh=true), the drawing on the board goes into the board's Library and the board is cleared, as one
  // Operation that undo takes back; a board with nothing on it has nothing to keep. A page must be there first (the
  // drawing needs it), so a NoPage changes nothing. Returns the request's drawer. Called by draw and mermaid.
  // @purity non-pure
  function startNewDrawing(body, buildsOnBoard) {
    const drawer = checkDrawer(body && body.drawer);
    const fresh = body && typeof body.fresh === "boolean" ? body.fresh : null;
    if (!newDrawingDue({ drawer, currentDrawer, fresh, buildsOnBoard })) return drawer;
    const live = [...elements.values()].filter((element) => !element.isDeleted);
    if (live.length === 0) return drawer;
    if (hub.pageCount() === 0) throw new AppError("NoPage", 503, "no page is open; open the Board URL in a browser");
    const item = libraryItemOf(live, Date.now());
    setLibrary(addToLibrary(library, item), null);
    const plan = planDelete(elements, { all: true, confirm: true }, hub.editingIds(), Date.now(), newNonce);
    const opId = operationLog.reserveOpId();
    applyOperationElements(opId, "clear", plan.changed, true);
    events.emit({ event: "BoardCleared", opId, count: plan.count, libraryItem: item.id });
    hub.boardCleared();
    currentDrawer = null;
    return drawer;
  }

  // The drawing of `drawer` is on the board once its Job is done (THE RULE in lib/board-library.js).
  // @purity non-pure
  function drawnBy(drawer, done) {
    return done.then((result) => {
      if (drawer) currentDrawer = drawer;
      return result;
    });
  }

  // Watchman Whiteboard: the board's Library is now `items`: kept in library.json and sent to every page but
  // `exceptPageId` (the page that sent it). Called by startNewDrawing and the page's POST /api/library (board-api.js).
  // @purity non-pure
  function setLibrary(items, exceptPageId) {
    library = items;
    try {
      saveLibrary(libraryPath, library);
    } catch (error) {
      events.emit({ event: "SaveFailed", message: hide(`cannot save the library: ${error && error.message}`) });
    }
    hub.setLibrary(library, exceptPageId);
  }

  // Watchman Whiteboard: the narration (say) of a drawing goes with its Job to the page.
  // @purity pure
  function withSay(job, body) {
    const say = checkSay(body && body.say);
    return say ? { ...job, say } : job;
  }

  // @purity non-pure
  // The picture of a molecule change's SMILES: { svg, width, height }; a bad SMILES is InvalidChemistry for change `index`.
  // @purity non-pure
  async function renderSmiles(change, index) {
    try {
      const [drawn] = await renderMolecules([{ id: change.id, smiles: change.smiles.trim(), name: null, note: null }]);
      return { smiles: drawn.smiles, svg: drawn.svg, width: drawn.width, height: drawn.height };
    } catch (error) {
      if (error && error.code === "InvalidChemistry") {
        throw new AppError("InvalidChemistry", 400, String(error.message).replace(/^molecules\[0\]/, `changes[${index}]`), { index, field: "smiles" });
      }
      throw error;
    }
  }

  async function edit(body) {
    const checked = checkEdit(body, elements, hub.editingIds(), config.maxTextChars);
    // Watchman Whiteboard: a math step's new LaTeX is checked and drawn first, as a step of draw_math is.
    // A molecule's new SMILES is drawn first too, as draw_molecule draws one (lib/board-chem.js).
    const changes = [];
    for (const [index, change] of checked.entries()) {
      if (change.tex !== undefined) {
        changes.push({ ...change, ...(await renderTex(change.tex, index)) });
      } else if (change.smiles !== undefined) {
        changes.push({ ...change, ...(await renderSmiles(change, index)) });
      } else {
        changes.push(change);
      }
    }
    return runOperation({ kind: "edit", changes });
  }

  // delete runs on the Server, with no Page (FR-100, FR-101).
  // @purity non-pure
  function deleteItems(body) {
    const request = checkDeleteBody(body);
    const plan = planDelete(elements, request, hub.editingIds(), Date.now(), newNonce);
    if (plan.changed.length === 0) return { opId: null, ids: [], count: 0 };
    const opId = operationLog.reserveOpId();
    try {
      applyOperationElements(opId, "delete", plan.changed, true);
    } catch (error) {
      events.emit({ event: "OperationFailed", kind: "delete", jobId: null, error: error.code || "Internal", message: String(error && error.message) });
      throw error;
    }
    events.emit({ event: "OperationApplied", opId, kind: "delete", count: plan.count });
    return { opId, ids: plan.ids, count: plan.count };
  }

  // undo runs on the Server, with no Page (FR-103, FR-104).
  // @purity non-pure
  function undo(body) {
    const force = Boolean(body && body.force === true);
    const plan = operationLog.planLastUndo(elements, force, Date.now(), newNonce);
    const changed = hub.applyServerChanges(plan.restored);
    takeIntoBaseline(changed);
    operationLog.forget(plan.operation.opId, plan.rebase);
    events.emit({
      event: "OperationUndone", opId: plan.operation.opId, kind: plan.operation.kind, restored: plan.restoredCount, forced: plan.forced,
    });
    return { opId: plan.operation.opId, kind: plan.operation.kind, restored: plan.restoredCount };
  }

  // Answers and Claude Items are never Messages, and Claude Items are not new Drawings (FR-014, FR-091).
  // @purity semi-pure-b
  const messageItems = () => toItems(elements).filter((item) => !item.byClaude);
  let trackerState = createTrackerState(messageItems(), STARTED_AT_MS - OLD_TEXT_MARGIN_MS);
  // By default, nothing goes to the Agent until the Person presses Send; then the Agent gets every change
  // since the last Send (FR-070). With autoSend on, each Message goes when it is Settled, as before (FR-074).
  let autoSend = false;

  // @purity semi-pure-b
  function currentDiff() {
    return diffBoards(baseline, summarizeBoard(elements.values()), firstSeenMs, hub.editingIds());
  }

  // @purity non-pure
  function tick() {
    if (!autoSend) {
      hub.setInbox(countOf(currentDiff()), autoSend);
      return;
    }
    const result = trackMessages(trackerState, { items: messageItems(), editingIds: hub.editingIds() }, Date.now(), config.settleMs);
    trackerState = result.trackerState;
    for (const event of result.messageEvents) events.emit(event);
  }

  // The new Baseline is the Board now, except the texts that someone is still typing (FR-076).
  // @purity non-pure
  function moveBaseline() {
    const next = summarizeBoard(elements.values());
    for (const id of hub.editingIds()) {
      if (baseline.has(id)) next.set(id, baseline.get(id));
      else next.delete(id);
    }
    baseline = next;
    saveBaseline();
  }

  // Sends every change since the last Send as one MessagesSent (FR-072).
  // @purity non-pure
  function sendChanges() {
    const diff = currentDiff();
    const sent = countOf(diff);
    if (sent > 0) events.emit(toSentEvent(diff));
    moveBaseline();
    hub.setInbox(0, autoSend);
    return { sent };
  }

  // @purity non-pure
  function setAutoSend(on) {
    if (on === autoSend) return;
    if (on) {
      sendChanges();
      trackerState = createTrackerState(messageItems(), Date.now());
    } else {
      moveBaseline();
    }
    autoSend = on;
    hub.setInbox(on ? 0 : countOf(currentDiff()), autoSend);
  }

  const tickTimer = setInterval(tick, config.tickMs);

  // @purity non-pure
  function saveNow() {
    if (!dirty) return;
    dirty = false;
    try {
      saveBoard(paths.board, [...elements.values()]);
    } catch (error) {
      dirty = true;
      events.emit({ event: "SaveFailed", message: String(error && error.message) });
    }
  }
  const saveTimer = setInterval(saveNow, config.saveMs);

  const addresses = config.lan ? lanAddresses(os.networkInterfaces()) : [];
  const urls = boardUrls({ lan: config.lan, port: config.port, token, addresses });
  // The "Join" dialog (0.7.1, FR-163, FR-166): set after the CA port listens; read only when a Page joins.
  let join = [];

  // @purity non-pure
  async function takeShot(focusId, scale) {
    const { done } = hub.requestShot(focusId, scale);
    const { png } = await done;
    if (!png.startsWith(PNG_BASE64_HEAD)) throw new AppError("JobFailed", 502, "the page did not send a PNG image");
    fs.mkdirSync(config.shotDir, { recursive: true });
    const filePath = path.join(config.shotDir, `shot-${Date.now()}.png`);
    fs.writeFileSync(filePath, Buffer.from(png, "base64"));
    return { path: filePath };
  }

  const boardApi = createBoardApi({
    hub, inbox: { send: sendChanges, setAutoSend }, token, pageDir: PAGE_DIR, redact: hide, clock, caDer,
    onActivity: () => idle.touch(),
    // Watchman Whiteboard: a page dropped because it stopped answering pings.
    onPageStale: () => events.emit({ event: "PageStale", pageCount: hub.pageCount() }),
    // Watchman Whiteboard: a person changed the board's Library on a page (POST /api/library).
    onLibrary: (pageId, items) => setLibrary(checkLibrary(items), pageId),
  });

  // Watchman Whiteboard (Mac, 2026-11-17: open_board counted a page that had gone): pings every page, drops the ones
  // that do not answer within `waitMs` (default PROBE_WAIT_MS, at most PROBE_MAX_MS), and answers how many are left.
  // POST /v1/pages/probe; the MCP Server asks it before it opens the board or draws.
  // @purity non-pure
  async function probePages(body) {
    const asked = body && Number.isFinite(body.waitMs) ? body.waitMs : PROBE_WAIT_MS;
    const stale = await hub.probe(Math.min(Math.max(asked, 50), PROBE_MAX_MS));
    boardApi.dropPages(stale);
    return { pageCount: hub.pageCount(), dropped: stale.length };
  }
  const boardServer = tls
    ? https.createServer({ cert: tls.cert, key: tls.key }, boardApi.handle)
    : http.createServer(boardApi.handle);
  let controlApi = null;

  // Writes the Board as an .excalidraw file into <data>/exports and returns its path, or null (FR-161).
  // @purity non-pure
  function exportBoard() {
    try {
      const dir = path.join(config.dataDir, "exports");
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, exportFileName(new Date()));
      writeFileAtomic(filePath, JSON.stringify(toExcalidrawFile(elements, files)));
      return filePath;
    } catch (error) {
      events.emit({ event: "SaveFailed", message: hide(`cannot export the board: ${error && error.message}`) });
      return null;
    }
  }

  // The idle time is over: export the Board, then stop; ServerStopped says why and where the file is (FR-161, FR-162).
  // @purity non-pure
  function stopForIdle() {
    if (stopping) return;
    stop({ reason: "idle", idleMinutes: Math.round(idleMs / 60000), exportPath: exportBoard() });
  }

  // `why`: { reason, ... } for ServerStopped; a signal name or nothing means a stop on request.
  // @purity non-pure
  async function stop(why) {
    if (stopping) return;
    stopping = true;
    idle.stop();
    clearInterval(tickTimer);
    clearInterval(saveTimer);
    hub.close();
    boardApi.closeStreams();
    saveNow();
    boardServer.closeAllConnections();
    await new Promise((resolve) => boardServer.close(() => resolve()));
    if (controlApi) await controlApi.close();
    const detail = why && typeof why === "object" ? why : { reason: "request" };
    events.emit({ event: "ServerStopped", ...detail });
    process.exit(EXIT_CODE.ok);
  }

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // @purity semi-pure-b
  function status() {
    return {
      state: stopping ? "Stopping" : "Ready",
      version: PACKAGE_VERSION,
      lan: config.lan,
      port: config.port,
      controlPort: config.controlPort,
      url: urls.local,
      lanUrls: urls.lan,
      pageCount: hub.pageCount(),
      queueLength: hub.queueLength(),
      signal: hub.signal(),
      autoSend,
      unsent: autoSend ? 0 : countOf(currentDiff()),
      itemCount: toItems(elements).length,
      dataDir: config.dataDir,
      logPath: config.logPath,
      shotDir: config.shotDir,
      undoCount: operationLog.count(),
    };
  }

  controlApi = createControlApi({
    handlers: {
      status,
      board: () => ({ items: toItems(elements), pageCount: hub.pageCount() }),
      say: (text, at) => hub.queueAnswer(text, at),
      shot: takeShot,
      signal: (state, agent) => hub.setSignal(state, agent),
      stop,
      draw,
      mermaid,
      math,
      molecule,
      chart3d,
      edit,
      delete: deleteItems,
      undo,
      probe: probePages,
    },
    maxTextChars: config.maxTextChars,
    sayWaitMs: SAY_WAIT_MS,
    redact: hide,
    clock,
    onRequest: () => idle.touch(),
  });

  try {
    await listen(boardServer, config.port, config.lan ? "0.0.0.0" : "127.0.0.1");
    await controlApi.listen(config.controlPort);
  } catch (error) {
    const inUse = error && error.code === "EADDRINUSE";
    events.emit({
      event: "ServerFailed",
      reason: inUse ? "PortInUse" : "Internal",
      message: hide(`cannot listen: ${error && error.message}`),
    });
    process.exit(inUse ? EXIT_CODE.PortInUse : EXIT_CODE.Internal);
  }

  events.emit({
    event: "ServerReady",
    version: PACKAGE_VERSION,
    lan: config.lan,
    port: config.port,
    controlPort: config.controlPort,
    itemCount: toItems(elements).length,
    lanAddressCount: addresses.length,
  });
  // LAN mode: the CA file over http on its own port (FR-166), and what the "Join" dialog shows (FR-163).
  if (config.lan) {
    let caPort = null;
    if (caDer) {
      try {
        await listen(createCaHttpServer(caDer), config.caPort, "0.0.0.0");
        caPort = config.caPort;
      } catch (error) {
        events.emit({ event: "BoardWarning", message: hide(`cannot serve the CA file on port ${config.caPort}: ${error && error.message}`) });
      }
    }
    join = joinTargets({ interfaces: lanInterfaces(os.networkInterfaces()), port: config.port, caPort, token, routeAddress: await defaultRouteAddress() });
  }
  // The idle time starts now (FR-159).
  idle.touch();
}

main().catch((error) => {
  const line = JSON.stringify({ v: 1, event: "ServerFailed", reason: "Internal", message: String(error && error.stack), atMs: Date.now() });
  process.stdout.write(line + "\n");
  process.exit(EXIT_CODE.Internal);
});
