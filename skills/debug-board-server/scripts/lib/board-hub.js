"use strict";

// BoardHub (Use Case). Connects the open pages, keeps the Board in step between them,
// and gives Jobs (write an Answer, take a Screenshot) to the Leader page. See spec 3.5.
//
// The Leader is the first page that is shown on screen; with no page on screen, the first page (FR-034, FR-085).
// A browser may freeze a page in a hidden tab, so a hidden page is a poor Leader.
// Only the Leader writes Answers, because only a browser can measure text (ADR-003).
// A Job that times out goes once to another page (FR-086).
// Jobs run one at a time, in arrival order (FR-027).
// The Signal ("reading", "working", "waiting", or "none") tells every page what Claude is doing (FR-038).
// From 0.5.0, the Leader also lays out Operations by Claude: draw, edit, and mermaid Jobs (ADR-009).
// With no page open, these fail at once with NoPage (FR-087); they do not wait in the queue.

const { AppError } = require("./app-error");
const { mergeElements, toItems, isElement, ANSWER_MARK } = require("./board-store");
const { placeAnswer, clearOfItems, estimateSize } = require("./answer-placement");
const { addFiles } = require("./board-files");
const { chooseOrigin } = require("./board-ops");

// The font size that the page uses for Answers (page/app.js).
const ANSWER_FONT_SIZE_PX = 20;

const SIGNALS = Object.freeze(["none", "reading", "working", "waiting"]);
// Watchman Whiteboard: an agent's name in the page's labels (Claude, Codex, agy, ...).
const AGENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 ._-]{0,23}$/;
// Jobs that change the Board for the Agent (Operations, FR-087 to FR-099).
// Watchman Whiteboard: math, the steps of draw_math (lib/board-math.js), each drawn by the page as a PNG image.
// picture: a 3D chart the page draws with its staged Plotly (lib/board-plot3d.js), one PNG image.
const OPERATION_KINDS = Object.freeze(["draw", "edit", "mermaid", "math", "picture"]);
// The page may say why a mermaid Job failed (FR-094, FR-095), or that it could not draw a math step or a picture.
const PAGE_CODES = Object.freeze({
  mermaid: ["MermaidError", "MermaidUnsupported"], math: ["MathUnavailable"], edit: ["MathUnavailable"], picture: ["PictureUnavailable"],
});
// The Jobs whose result may bring image files.
const IMAGE_KINDS = Object.freeze(["mermaid", "math", "edit", "picture"]);
const MERMAID_MESSAGE_CHARS = 300;
// The first mermaid Job on a page loads Mermaid (about 3 MB), so it gets twice the time (FR-096).
const MERMAID_TIME_FACTOR = 2;

// On an empty Board, (0, 0) is under the menu of a new page. Start a little inside.
const EMPTY_BOARD_POINT = Object.freeze({ x: 100, y: 100 });

// @purity pure
function isAnswerElement(element) {
  return isElement(element) && element.customData && element.customData.grwbKind === ANSWER_MARK;
}

// elements: Map of id -> element (the Board). events: EventPort (emit).
// clock: { setTimeout, clearTimeout }. onBoardChanged(changed): called with the Elements that changed the Board.
// onAnswerWritten(elements): called with the Answer Elements that the Leader wrote.
// files: Map of id -> image file (FR-081). onFilesAdded(files): called with the new files, to save them.
// applyOperation(job, reply): checks the result of a draw, edit, or mermaid Job, writes the Snapshot, and merges it
// into the Board; returns { changed, result } or throws AppError (server.js, FR-099, FR-102, FR-106).
// @purity non-pure
function createBoardHub({
  elements, events, clock, jobTimeoutMs, gapPx, indentPx = 0, onBoardChanged, onAnswerWritten = () => {},
  files = new Map(), onFilesAdded = () => {}, applyOperation = null, joinTargets = () => [], idleStopAtMs = () => null,
  library = () => [],
}) {
  // pageId -> { send(type, data), editingId, visible, seenAtMs }. A Map keeps the order in which pages joined.
  const pages = new Map();
  // Watchman Whiteboard: when each page last showed it is there (it joined, answered a ping, or posted).
  // @purity semi-pure-b
  const now = () => (clock.now ? clock.now() : Date.now());
  // The probes waiting for pages to answer (see probe).
  const probes = new Set();
  let nextProbeId = 1;
  // A Job goes to at most this many pages before it fails.
  const JOB_TRIES = 2;
  const jobs = [];
  let current = null;
  let nextJobId = 1;
  let signal = "none";
  // Watchman Whiteboard: the agent that sent the signal (setSignal), or null.
  let signalAgent = null;
  // Watchman Whiteboard: what Watchman's voice is saying (setVoice, lib/board-voice.js); the picture is kept for the
  // sentences that come without it.
  let voice = Object.freeze({ speaking: false, text: "", name: "", picture: null, model: null });
  // What the Send button shows on every page (FR-071, FR-074).
  let inbox = Object.freeze({ unsent: 0, autoSend: false });

  // The first page on screen, else the first page, leaving out the pages in `skip`.
  // @purity semi-pure-b
  function pickPage(skip = new Set()) {
    let fallback = null;
    for (const [pageId, page] of pages) {
      if (skip.has(pageId)) continue;
      if (page.visible) return pageId;
      if (fallback === null) fallback = pageId;
    }
    return fallback;
  }

  // @purity semi-pure-b
  function leaderId() {
    return pickPage();
  }

  // Tells the old and the new Leader when the Leader changed. `toldId` already knows (it got hello).
  // @purity non-pure
  function announceLeader(before, toldId = null) {
    const after = leaderId();
    if (after === before) return;
    if (before !== null && pages.has(before)) sendTo(before, "role", { leader: false });
    if (after !== null && after !== toldId) sendTo(after, "role", { leader: true });
  }

  // @purity non-pure
  function sendTo(pageId, type, data) {
    const page = pages.get(pageId);
    if (page) page.send(type, data);
  }

  // @purity non-pure
  function broadcast(type, data, exceptId) {
    for (const [pageId, page] of pages) {
      if (pageId !== exceptId) page.send(type, data);
    }
  }

  // Answers and Claude Items are Claude's own; they are not Messages to answer (4.6).
  // @purity pure
  function ownIdsOf(items) {
    return new Set(items.filter((item) => item.byClaude).map((item) => item.id));
  }

  // @purity semi-pure-b
  function answerPoint(job) {
    const items = toItems(elements);
    const size = estimateSize(job.text, ANSWER_FONT_SIZE_PX);
    if (job.at) return clearOfItems(job.at, items, gapPx, size);
    if (items.length === 0) return EMPTY_BOARD_POINT;
    return placeAnswer(items, ownIdsOf(items), gapPx, indentPx, size);
  }

  // The SSE `job` data for the Leader (spec 4.3).
  // @purity semi-pure-b
  function jobPayload(job) {
    const payload = { jobId: job.id, kind: job.kind };
    if (job.kind === "answer") {
      const point = answerPoint(job);
      job.point = { x: Math.round(point.x), y: Math.round(point.y) };
      return Object.assign(payload, { text: job.text, x: job.point.x, y: job.point.y });
    }
    if (job.kind === "shot") return Object.assign(payload, { focusId: job.focusId, scale: job.scale });
    if (job.kind === "edit") return Object.assign(payload, { opId: job.opId, changes: job.changes });
    // draw and mermaid: the Origin (4.11.4).
    const items = toItems(elements);
    job.origin = chooseOrigin(items, job.at, ownIdsOf(items), indentPx);
    const bodies = {
      draw: () => ({ elements: job.elements, boardIds: job.boardTargets, reused: job.reused || {} }),
      math: () => ({ steps: job.steps }),
      picture: () => ({ elementId: job.elementId, figure: job.figure, width: job.width, height: job.height, summary: job.summary }),
    };
    const body = bodies[job.kind] ? bodies[job.kind]() : { source: job.source };
    // Watchman Whiteboard: the narration, and the time the page has, so its drawing animation ends well before it.
    const reveal = { timeoutMs: timeoutOf(job), ...(job.say ? { say: job.say } : {}) };
    return Object.assign(payload, { opId: job.opId, ...body, x: job.origin.x, y: job.origin.y, ...reveal });
  }

  // @purity pure
  function timeoutOf(job) {
    // A picture's first Job loads Plotly (about 4.5 MB), as a mermaid Job loads Mermaid.
    return job.kind === "mermaid" || job.kind === "picture" ? MERMAID_TIME_FACTOR * jobTimeoutMs : jobTimeoutMs;
  }

  // @purity non-pure
  function pump() {
    if (current !== null || jobs.length === 0) return;
    const pageId = pickPage(jobs[0].tried);
    if (pageId === null) return;
    current = jobs.shift();
    current.pageId = pageId;
    current.tried.add(pageId);
    const payload = jobPayload(current);
    const timeoutMs = timeoutOf(current);
    current.timer = clock.setTimeout(() => timeOut(payload.jobId), timeoutMs);
    sendTo(pageId, "job", payload);
  }

  // A page did not finish the Job in time: give it once to another page (FR-086), else fail.
  // @purity non-pure
  function timeOut(jobId) {
    const job = current;
    if (job === null || job.id !== jobId) return;
    if (job.tried.size < JOB_TRIES && pickPage(job.tried) !== null) {
      events.emit({ event: "JobRetried", jobId, kind: job.kind });
      current = null;
      jobs.unshift(job);
      pump();
      return;
    }
    endJob(new AppError("JobTimeout", 504, `the page did not finish job ${jobId}`));
  }

  // @purity non-pure
  function endJob(error, result) {
    const job = current;
    if (job === null) return;
    clock.clearTimeout(job.timer);
    current = null;
    if (error) {
      if (job.kind === "answer") events.emit({ event: "AnswerFailed", jobId: job.id, error: error.code, message: error.message });
      if (OPERATION_KINDS.includes(job.kind)) {
        events.emit({ event: "OperationFailed", kind: job.kind, jobId: job.id, error: error.code, message: error.message });
      }
      job.reject(error);
    } else {
      job.resolve(result);
    }
    pump();
  }

  // @purity non-pure
  function addJob(job) {
    job.id = nextJobId;
    nextJobId += 1;
    job.tried = new Set();
    const done = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    // A caller may stop waiting (say answers 202 after a while); a later failure must not crash the Server.
    done.catch(() => {});
    jobs.push(job);
    pump();
    return { jobId: job.id, done };
  }

  // @purity non-pure
  // visible: whether the page is shown on screen now (a page that does not say counts as shown).
  // @purity non-pure
  function addPage(pageId, send, visible = true) {
    const before = leaderId();
    pages.set(pageId, { send, editingId: null, visible: visible !== false, seenAtMs: now() });
    const isLeader = leaderId() === pageId;
    // Watchman Whiteboard: `library` is the board's Library (board-library.js), which the page shows as its own.
    send("hello", { pageId, leader: isLeader, signal, agent: signalAgent, voice, inbox, elements: [...elements.values()], files: [...files.values()], join: joinTargets(), idleStopAtMs: idleStopAtMs(), library: library() });
    events.emit({ event: "PageJoined", pageCount: pages.size });
    announceLeader(before, pageId);
    pump();
  }

  // @purity non-pure
  function removePage(pageId) {
    const before = leaderId();
    if (!pages.delete(pageId)) return;
    events.emit({ event: "PageLeft", pageCount: pages.size });
    // A probe waits for no page that has left.
    for (const waiting of [...probes]) waiting.answered(pageId);
    if (current !== null && current.pageId === pageId) {
      // The page left in the middle of a Job: give the Job to the next page.
      clock.clearTimeout(current.timer);
      current.tried.delete(pageId);
      jobs.unshift(current);
      current = null;
    }
    announceLeader(before === pageId ? null : before);
    pump();
  }

  // Watchman Whiteboard (Mac, 2026-11-17: a page that had gone still counted, so open_board opened no tab and the
  // next draw failed with NoPage). A page shows it is there by answering a ping (POST /api/pong) or by any post;
  // board-api.js calls this for each. It ends the probes that waited only for this page.
  // @purity non-pure
  function touchPage(pageId) {
    const page = pages.get(pageId);
    if (!page) return;
    page.seenAtMs = now();
    for (const probe of [...probes]) probe.answered(pageId);
  }

  // Whether page `pageId` has shown no sign of being there for longer than `staleMs` (a page that is not there is not
  // stale: it is gone). board-api.js drops a stale page at its next ping.
  // @purity semi-pure-b
  function isStale(pageId, staleMs) {
    const page = pages.get(pageId);
    return Boolean(page) && now() - page.seenAtMs > staleMs;
  }

  // Pings every page and waits until each has answered or `waitMs` passed; resolves with the ids of the pages that
  // did not answer, for the board to drop (board-api.js dropPages). No page: nothing to wait for.
  // @purity non-pure
  function probe(waitMs) {
    const waiting = new Set(pages.keys());
    if (waiting.size === 0) return Promise.resolve([]);
    const id = nextProbeId;
    nextProbeId += 1;
    return new Promise((resolve) => {
      const entry = {
        answered(pageId) {
          waiting.delete(pageId);
          if (waiting.size === 0) finish();
        },
      };
      const timer = clock.setTimeout(() => finish(), waitMs);
      function finish() {
        if (!probes.delete(entry)) return;
        clock.clearTimeout(timer);
        resolve([...waiting].filter((pageId) => pages.has(pageId)));
      }
      probes.add(entry);
      for (const pageId of waiting) sendTo(pageId, "ping", { probe: id });
    });
  }

  // A page was shown or hidden (FR-085). The Leader may change.
  // @purity non-pure
  function setVisible(pageId, visible) {
    const page = pages.get(pageId);
    if (!page) return;
    const before = leaderId();
    page.visible = visible === true;
    announceLeader(before);
    pump();
  }

  // @purity non-pure
  function receiveElements(pageId, list, editingId) {
    const page = pages.get(pageId);
    if (page && editingId !== undefined) page.editingId = typeof editingId === "string" ? editingId : null;
    const changed = mergeElements(elements, Array.isArray(list) ? list : []);
    if (changed.length > 0) {
      broadcast("elements", { elements: changed }, pageId);
      onBoardChanged(changed);
    }
    return changed.length;
  }

  // New image files from a page go to the other pages (FR-081). Returns { added, rejected }.
  // @purity non-pure
  function receiveFiles(pageId, list) {
    const result = addFiles(files, list);
    if (result.added.length > 0) {
      broadcast("files", { files: result.added }, pageId);
      onFilesAdded(result.added);
    }
    for (const bad of result.rejected) events.emit({ event: "FileRejected", id: bad.id, reason: bad.reason });
    return { added: result.added.length, rejected: result.rejected };
  }

  // @purity semi-pure-b
  function editingIds() {
    const ids = new Set();
    for (const page of pages.values()) {
      if (page.editingId) ids.add(page.editingId);
    }
    return ids;
  }

  // @purity non-pure
  function queueAnswer(text, at) {
    const queued = addJob({ kind: "answer", text, at });
    if (current === null || current.id !== queued.jobId) {
      events.emit({ event: "AnswerQueued", jobId: queued.jobId, pageCount: pages.size });
    }
    return queued;
  }

  // @purity non-pure
  function requestShot(focusId, scale = 1) {
    if (pages.size === 0) throw new AppError("NoPage", 503, "no page is open; open the Board URL in a browser");
    return addJob({ kind: "shot", focusId: focusId || null, scale });
  }

  // Adds a draw, edit, or mermaid Job (FR-087, FR-093, FR-097). `job`: { kind, ... } checked by the caller.
  // `reserveOpId()` gives the opId only when the Job is taken, so a refused request uses none.
  // @purity non-pure
  function queueOperation(job, reserveOpId) {
    if (!OPERATION_KINDS.includes(job.kind)) throw new AppError("Internal", 500, `unknown operation ${job.kind}`);
    if (pages.size === 0) throw new AppError("NoPage", 503, "no page is open; open the Board URL in a browser");
    return addJob({ ...job, opId: reserveOpId() });
  }

  // A draw, edit, or mermaid result: the Server checks it and writes the Snapshot first (FR-099, FR-102).
  // If that fails, the Agent gets the error, and the page gets 409 and takes its Elements off (FR-106).
  // @purity non-pure
  function finishOperation(pageId, reply) {
    const job = current;
    let applied;
    try {
      applied = applyOperation(job, reply);
    } catch (error) {
      const failure = error instanceof AppError ? error : new AppError("Internal", 500, String(error && error.message));
      endJob(failure);
      throw new AppError(failure.code, 409, failure.message);
    }
    if (applied.changed.length > 0) {
      broadcast("elements", { elements: applied.changed }, pageId);
      onBoardChanged(applied.changed);
    }
    if (IMAGE_KINDS.includes(job.kind) && Array.isArray(reply.files) && reply.files.length > 0) receiveFiles(pageId, reply.files);
    if (applied.result.opId !== null) {
      events.emit({ event: "OperationApplied", opId: applied.result.opId, kind: job.kind, count: applied.changed.length });
    }
    endJob(null, { jobId: job.id, ...applied.result });
  }

  // Changes that the Server itself makes (delete, undo; FR-100, FR-103) go to every page.
  // @purity non-pure
  function applyServerChanges(list) {
    const changed = mergeElements(elements, list);
    if (changed.length > 0) {
      broadcast("elements", { elements: changed });
      onBoardChanged(changed);
    }
    return changed;
  }

  // reply: { jobId, ok, elements, files, png, error, code } from the Leader page.
  // @purity non-pure
  function finishJob(pageId, reply) {
    if (current === null || !reply || reply.jobId !== current.id || pageId !== current.pageId) {
      throw new AppError("UnknownJob", 409, "this job is not running on this page");
    }
    if (!reply.ok) {
      const message = String(reply.error || "the page could not do the job");
      if ((PAGE_CODES[current.kind] || []).includes(reply.code)) {
        endJob(new AppError(reply.code, 422, message.slice(0, MERMAID_MESSAGE_CHARS)));
      } else {
        endJob(new AppError("JobFailed", 502, message));
      }
      return;
    }
    if (current.kind === "shot") {
      endJob(null, { png: String(reply.png || "") });
      return;
    }
    if (OPERATION_KINDS.includes(current.kind)) {
      finishOperation(pageId, reply);
      return;
    }
    const written = (Array.isArray(reply.elements) ? reply.elements : []).filter(isAnswerElement);
    const changed = mergeElements(elements, written);
    if (changed.length > 0) {
      broadcast("elements", { elements: changed }, pageId);
      onBoardChanged(changed);
    }
    onAnswerWritten(written);
    const result = { jobId: current.id, ids: written.map((element) => element.id), x: current.point.x, y: current.point.y };
    // The Agent asked for a place that an Item covers, so the Answer went lower (FR-120).
    if (current.at) {
      const requested = { x: Math.round(current.at.x), y: Math.round(current.at.y) };
      Object.assign(result, { requested, moved: requested.x !== result.x || requested.y !== result.y });
    }
    events.emit({ event: "AnswerPosted", ...result });
    // An Answer ends Claude's turn (FR-039).
    setSignal("waiting");
    endJob(null, result);
  }

  // @purity non-pure
  function setInbox(unsent, autoSend) {
    if (unsent === inbox.unsent && autoSend === inbox.autoSend) return;
    inbox = Object.freeze({ unsent, autoSend });
    broadcast("inbox", inbox);
  }

  // Watchman Whiteboard: the board's Library changed (server.js: a new drawing kept the old one, or a page changed it);
  // every page but `exceptId` (the page that sent it) gets the whole list.
  // @purity non-pure
  function setLibrary(items, exceptId = null) {
    broadcast("library", { items }, exceptId);
  }

  // Watchman Whiteboard: a new drawing cleared the board (server.js startNewDrawing); every page goes back to the
  // Hand tool (page/app.js onBoardCleared).
  // @purity non-pure
  function boardCleared() {
    broadcast("cleared", {});
  }

  // The idle warning (0.6.1, FR-160): stopAtMs, or null when a touch ended it. Every Page shows it.
  // @purity non-pure
  function setIdleWarning(stopAtMs) {
    broadcast("idle", { stopAtMs });
  }

  // Watchman Whiteboard: `agent` is the name of the agent that sent the signal (the MCP server's client: Claude,
  // Codex, agy), which the page puts in its labels; anything that is not a short name is dropped.
  // @purity non-pure
  function setSignal(state, agent = signalAgent) {
    if (!SIGNALS.includes(state)) throw new AppError("InvalidSignal", 400, `signal must be one of ${SIGNALS.join(", ")}`);
    const name = typeof agent === "string" && AGENT_NAME_PATTERN.test(agent) ? agent : null;
    if (state === signal && name === signalAgent) return;
    signal = state;
    signalAgent = name;
    broadcast("signal", { state, agent: name });
  }

  // Watchman Whiteboard: Watchman's voice is saying `next.text` (checked by board-voice.js checkVoice); every page
  // draws its character (page/voice.mjs).
  // @purity non-pure
  function setVoice(next) {
    // The character's model ({ id, clips }, board-voice.js voiceModel) is kept for the next sentences, as the picture.
    voice = Object.freeze({
      speaking: next.speaking, text: next.text, name: next.name, picture: next.picture !== undefined ? next.picture : voice.picture,
      model: next.model !== undefined ? next.model : voice.model,
    });
    broadcast("voice", voice);
  }

  // @purity non-pure
  function close() {
    if (current !== null) clock.clearTimeout(current.timer);
    for (const job of current ? [current, ...jobs] : jobs) job.reject(new AppError("Stopping", 503, "the Server is stopping"));
    jobs.length = 0;
    current = null;
    broadcast("bye", {});
  }

  return Object.freeze({
    addPage,
    removePage,
    touchPage,
    isStale,
    probe,
    setVisible,
    receiveElements,
    receiveFiles,
    editingIds,
    queueAnswer,
    requestShot,
    queueOperation,
    applyServerChanges,
    finishJob,
    setSignal,
    setVoice,
    setIdleWarning,
    setLibrary,
    boardCleared,
    signal: () => signal,
    setInbox,
    inbox: () => inbox,
    close,
    pageCount: () => pages.size,
    queueLength: () => jobs.length + (current ? 1 : 0),
  });
}

module.exports = { createBoardHub };
