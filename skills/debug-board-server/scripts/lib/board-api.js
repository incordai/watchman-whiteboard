"use strict";

// BoardApi (Adapter). Serves the page and talks with it. See spec 4.3.
//   GET  /                 the page (no Token needed: it holds no Board data)
//   GET  /app.js           the page script
//   GET  /reveal.mjs       the pure half of the drawing animation, imported by app.js (Watchman Whiteboard)
//   GET  /brand.mjs        the page's own menu items and labels, no Excalidraw branding (Watchman Whiteboard)
//   GET  /look.mjs         Watchman's theme and glass from the link's hash (Watchman Whiteboard)
//   GET  /voice.mjs        how the page shows Watchman's voice character (Watchman Whiteboard)
//   POST /api/voice        what Watchman's voice says, from Watchman's own window (Watchman Whiteboard, board-voice.js)
//   GET  /api/voice/character, /api/voice/clip/N   the voice character's files Watchman named, to a page with the
//                          Token (Watchman Whiteboard, board-voice.js voiceFile)
//   GET  /api/stream       Server-Sent Events to one page (Token in the query, as EventSource has no headers)
//                          events: hello, elements, files, role, job, signal, inbox, ping, bye
//   POST /api/elements     changed elements from a page
//   POST /api/job          the result of a Job from the Leader page
//   POST /api/send         the Person pressed Send (FR-072)
//   POST /api/auto-send    the Person turned automatic sending on or off (FR-074)
//   POST /api/files        new image files from a page (FR-081)
//   POST /api/visibility   the page was shown or hidden (FR-085)

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AppError } = require("./app-error");
const { sendJson, readBody, parseJsonBody, sameSecret, sendError } = require("./http-util");
const { checkVoice, voiceOrigin, corsHeaders, voiceModel, voiceFile } = require("./board-voice");

const PAGE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_ELEMENTS_BYTES = 8 * 1024 * 1024;
const MAX_JOB_BYTES = 32 * 1024 * 1024;
// A few images at a time; each one is checked again in board-files.js.
const MAX_FILES_BYTES = 40 * 1024 * 1024;
// Watchman Whiteboard: one sentence of Watchman's voice, with the character's picture at most (board-voice.js).
const MAX_VOICE_BYTES = 1024 * 1024;
const KEEP_ALIVE_MS = 20000;
// Watchman Whiteboard: a page that answered no ping for this long has gone (three pings missed).
const STALE_MS = 3 * KEEP_ALIVE_MS;
const PAGE_ORIGIN = "https://esm.sh";

// The page loads React and Excalidraw from esm.sh (R-005), or, in Watchman Whiteboard, from its own
// page/vendor folder when the build staged it there: then `outside` is "" and the page may load
// nothing from another site. Nothing else may be loaded or called.
// @purity pure
function contentSecurityPolicy(importMapHash, outside = PAGE_ORIGIN) {
  const from = outside ? ` ${outside}` : "";
  return [
    "default-src 'self'",
    `script-src 'self'${from} 'sha256-${importMapHash}'`,
    `style-src 'self' 'unsafe-inline'${from}`,
    `font-src 'self' data:${from}`,
    "img-src 'self' data: blob:",
    // blob: (Watchman Whiteboard): the voice character's textures are read from blob: URLs with fetch() (config-lan.test.js).
    `connect-src 'self' blob:${from}`,
    `worker-src 'self' blob:${from}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

// The types the vendor route serves; any other file is never served.
const VENDOR_TYPES = Object.freeze({
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".json": "application/json",
  ".wasm": "application/wasm",
});
const VENDOR_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Watchman Whiteboard: the file `name` asks for under <pageDir>/vendor, as {path, type}, or null.
// Each part of `name` is a plain file or folder name (no "..", no slash or backslash inside one, no
// drive), the file must be of a VENDOR_TYPES type, and it must exist under the folder.
// Called by the /vendor/ route below; the folder is staged by Watchman's scripts/stage-whiteboard.mjs.
// @purity semi-pure-b
function vendorFile(pageDir, name) {
  const parts = String(name).split("/");
  if (!parts.length || !parts.every((part) => VENDOR_PART.test(part) && !part.includes(".."))) return null;
  const type = VENDOR_TYPES[path.extname(parts[parts.length - 1]).toLowerCase()];
  if (!type) return null;
  const root = path.resolve(pageDir, "vendor");
  const file = path.resolve(root, ...parts);
  if (!file.startsWith(root + path.sep)) return null;
  try {
    if (!fs.statSync(file).isFile()) return null;
  } catch (error) {
    return null;
  }
  return Object.freeze({ path: file, type });
}

// Whether the build staged the page's libraries in page/vendor (Watchman Whiteboard).
// @purity semi-pure-b
function hasVendor(pageDir) {
  return fs.existsSync(path.join(pageDir, "vendor", "manifest.json"));
}

// @purity pure
function importMapOf(html) {
  const match = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  return match ? match[1] : "";
}

const EXCALIDRAW_CSS = /<link rel="stylesheet" href="https:\/\/esm\.sh\/@excalidraw\/excalidraw@[^"]*\/index\.css">/;

// Watchman Whiteboard: `html` with its import map replaced by `importMap` (the staged
// vendor/importmap.json) and the Excalidraw stylesheet by /vendor/excalidraw.css; null when the page
// has no import map, so it is never served half from esm.sh and half from here.
// @purity pure
function localPage(html, importMap) {
  if (!importMapOf(html)) return null;
  return html
    .replace(/<script type="importmap">[\s\S]*?<\/script>/, () => `<script type="importmap">${importMap}</script>`)
    .replace(EXCALIDRAW_CSS, '<link rel="stylesheet" href="/vendor/excalidraw.css">');
}

// The page as served: local when the build staged page/vendor (Watchman Whiteboard), else from esm.sh.
// @purity semi-pure-b
function loadPageFiles(pageDir) {
  const original = fs.readFileSync(path.join(pageDir, "index.html"), "utf8");
  const script = fs.readFileSync(path.join(pageDir, "app.js"), "utf8");
  const reveal = fs.readFileSync(path.join(pageDir, "reveal.mjs"), "utf8");
  const brand = fs.readFileSync(path.join(pageDir, "brand.mjs"), "utf8");
  const look = fs.readFileSync(path.join(pageDir, "look.mjs"), "utf8");
  const voice = fs.readFileSync(path.join(pageDir, "voice.mjs"), "utf8");
  const local = hasVendor(pageDir) ? localPage(original, fs.readFileSync(path.join(pageDir, "vendor", "importmap.json"), "utf8").trim()) : null;
  const html = local || original;
  const hash = crypto.createHash("sha256").update(importMapOf(html)).digest("base64");
  return Object.freeze({ html, script, reveal, brand, look, voice, csp: contentSecurityPolicy(hash, local ? "" : PAGE_ORIGIN) });
}

// A request from another web site has another Origin. Pages of this Server send their own.
// @purity pure
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch (error) {
    return false;
  }
}

// hub: BoardHub. token: the Token. redact(text) hides secrets.
// inbox: { send(pageId) -> { sent }, setAutoSend(on) } (the Send handling in server.js).
// @purity non-pure
function createBoardApi({
  hub, inbox, token, pageDir, redact, clock, caDer = null, onActivity = () => {}, onPageStale = () => {}, onLibrary = () => {},
}) {
  const files = loadPageFiles(pageDir);
  // Watchman Whiteboard: the voice character's files Watchman named last ({ character, clips }, board-voice.js), or null.
  let voiceFiles = null;
  // pageId -> the open stream of that page. A page that connects again replaces its old stream.
  const streams = new Map();

  // @purity non-pure
  function sendFile(res, type, body) {
    res.writeHead(200, {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": "no-store",
      "content-security-policy": files.csp,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(body);
  }

  // @purity non-pure
  function openStream(req, res, url) {
    if (!sameSecret(url.searchParams.get("t"), token)) throw new AppError("BadToken", 403, "wrong or missing token");
    const pageId = url.searchParams.get("page") || "";
    if (!PAGE_ID_PATTERN.test(pageId)) throw new AppError("BadPageId", 400, "page id is missing or wrong");
    // A Page that opens is a touch too (FR-159).
    onActivity();
    const old = streams.get(pageId);
    if (old) endStream(pageId, old);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    // @purity non-pure
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    // A real event (not a comment), so the page can see that the stream is alive (FR-023a). Watchman Whiteboard: the
    // page answers each ping (POST /api/pong); a page that answered none of the last few pings has gone without its
    // stream closing (a tab closed with its connection left open), so it is dropped, and counts no more.
    const keepAlive = clock.setInterval(() => {
      if (hub.isStale(pageId, STALE_MS)) {
        dropPages([pageId]);
        return;
      }
      send("ping", {});
    }, KEEP_ALIVE_MS);
    const stream = { res, keepAlive };
    streams.set(pageId, stream);
    req.on("close", () => {
      if (streams.get(pageId) === stream) endStream(pageId, stream);
    });
    hub.addPage(pageId, send, url.searchParams.get("visible") !== "0");
  }

  // @purity non-pure
  function endStream(pageId, stream) {
    clock.clearInterval(stream.keepAlive);
    streams.delete(pageId);
    hub.removePage(pageId);
    stream.res.end();
  }

  // Watchman Whiteboard: ends the streams of pages that did not answer (hub.probe, a stale ping). A page that is in
  // fact still there opens its stream again by itself (app.js openStream) and counts again.
  // @purity non-pure
  function dropPages(pageIds) {
    for (const pageId of pageIds) {
      const stream = streams.get(pageId);
      if (!stream) continue;
      endStream(pageId, stream);
      onPageStale(pageId);
    }
  }

  // @purity non-pure
  async function readPost(req, maxBytes) {
    if (!sameSecret(req.headers["x-board-token"], token)) throw new AppError("BadToken", 403, "wrong or missing token");
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
      throw new AppError("BadContentType", 415, "content-type must be application/json");
    }
    const body = parseJsonBody(await readBody(req, maxBytes), false);
    // Watchman Whiteboard: a page that posts anything is there (hub.touchPage).
    if (body && typeof body.page === "string") hub.touchPage(body.page);
    return body;
  }

  // @purity non-pure
  async function route(req, res) {
    const url = new URL(req.url, "http://localhost");
    const key = `${req.method} ${url.pathname}`;
    // Watchman Whiteboard: what Watchman's voice says (lib/board-voice.js). Watchman's own window is another origin,
    // so it alone gets a CORS answer; it posts with the board's Token, as a page does.
    if (url.pathname === "/api/voice") {
      const allowed = voiceOrigin(req.headers.origin);
      if (allowed) for (const [name, value] of Object.entries(corsHeaders(allowed))) res.setHeader(name, value);
      if (req.method === "OPTIONS") {
        res.writeHead(allowed ? 204 : 403);
        return res.end();
      }
      if (req.method !== "POST" || (!allowed && !isSameOrigin(req))) throw new AppError("BadOrigin", 403, "request from another site");
      const { character, clips, ...voice } = checkVoice(await readPost(req, MAX_VOICE_BYTES));
      onActivity();
      // The character's files stay here; the pages hear only which character it is (board-voice.js voiceModel).
      if (character) {
        voiceFiles = Object.freeze({ character, clips: Object.freeze(clips) });
        voice.model = voiceModel(voiceFiles);
      }
      hub.setVoice(voice);
      return sendJson(res, 200, {});
    }
    if (!isSameOrigin(req)) throw new AppError("BadOrigin", 403, "request from another site");
    // Watchman Whiteboard: the voice character's .vrm and clips Watchman named (board-voice.js voiceFile), for a page
    // of this board with the Token; the page draws them (app.js startFigure).
    if (req.method === "GET" && url.pathname.startsWith("/api/voice/")) {
      if (!sameSecret(req.headers["x-board-token"], token)) throw new AppError("BadToken", 403, "wrong or missing token");
      const file = voiceFile(voiceFiles, url.pathname.slice("/api/voice/".length));
      if (!file) throw new AppError("NotFound", 404, "no such voice file");
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": file.size,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      return fs.createReadStream(file.path).on("error", () => res.destroy()).pipe(res);
    }
    // Watchman Whiteboard: the libraries the page loads, staged in page/vendor (see vendorFile).
    if (req.method === "GET" && url.pathname.startsWith("/vendor/")) {
      const file = vendorFile(pageDir, decodeURIComponent(url.pathname.slice("/vendor/".length)));
      if (!file) throw new AppError("NotFound", 404, "no such file");
      res.writeHead(200, {
        "content-type": file.type,
        "cache-control": "max-age=86400",
        "x-content-type-options": "nosniff",
      });
      // A file that goes away mid-read ends the reply instead of the server.
      return fs.createReadStream(file.path).on("error", () => res.destroy()).pipe(res);
    }
    switch (key) {
      case "GET /":
      case "GET /index.html":
        return sendFile(res, "text/html", files.html);
      case "GET /app.js":
        return sendFile(res, "text/javascript", files.script);
      case "GET /reveal.mjs":
        return sendFile(res, "text/javascript", files.reveal);
      case "GET /brand.mjs":
        return sendFile(res, "text/javascript", files.brand);
      case "GET /look.mjs":
        return sendFile(res, "text/javascript", files.look);
      case "GET /voice.mjs":
        return sendFile(res, "text/javascript", files.voice);
      case "GET /favicon.ico":
        res.writeHead(204);
        return res.end();
      // The CA of this board, for an iPad or another computer to trust (0.6.1, FR-156). It is a public
      // certificate (no key), so it needs no Token; it exists only in LAN mode.
      case "GET /ca.crt":
        if (!caDer) throw new AppError("NotFound", 404, "no CA certificate (LAN mode only)");
        res.writeHead(200, {
          "content-type": "application/x-x509-ca-cert",
          "content-disposition": "attachment; filename=\"watchman-whiteboard-ca.crt\"",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        return res.end(caDer);
      case "GET /api/stream":
        return openStream(req, res, url);
      // Watchman Whiteboard: the page's answer to a ping; reading it marks the page as there (readPost).
      case "POST /api/pong":
        await readPost(req, MAX_ELEMENTS_BYTES);
        return sendJson(res, 200, {});
      // Watchman Whiteboard: a person changed the board's Library on this page (server.js setLibrary keeps it and
      // sends it to the other pages; lib/board-library.js checkLibrary refuses a bad list with 400).
      case "POST /api/library": {
        const body = await readPost(req, MAX_ELEMENTS_BYTES);
        onActivity();
        onLibrary(String(body.page || ""), body.items);
        return sendJson(res, 200, {});
      }
      // A Person touched the Page (keys, pointer); the Page sends this at most every 20 s (FR-159).
      case "POST /api/activity": {
        await readPost(req, MAX_ELEMENTS_BYTES);
        onActivity();
        return sendJson(res, 200, {});
      }
      case "POST /api/elements": {
        const body = await readPost(req, MAX_ELEMENTS_BYTES);
        onActivity();
        const changed = hub.receiveElements(String(body.page || ""), body.elements, body.editingId);
        return sendJson(res, 200, { changed });
      }
      case "POST /api/visibility": {
        const body = await readPost(req, MAX_ELEMENTS_BYTES);
        hub.setVisible(String(body.page || ""), body.visible === true);
        return sendJson(res, 200, {});
      }
      case "POST /api/files": {
        const body = await readPost(req, MAX_FILES_BYTES);
        onActivity();
        return sendJson(res, 200, hub.receiveFiles(String(body.page || ""), body.files));
      }
      case "POST /api/job": {
        const body = await readPost(req, MAX_JOB_BYTES);
        hub.finishJob(String(body.page || ""), body);
        return sendJson(res, 200, {});
      }
      case "POST /api/send": {
        const body = await readPost(req, MAX_ELEMENTS_BYTES);
        onActivity();
        return sendJson(res, 200, inbox.send(String(body.page || "")));
      }
      case "POST /api/auto-send": {
        const body = await readPost(req, MAX_ELEMENTS_BYTES);
        onActivity();
        inbox.setAutoSend(body.on === true);
        return sendJson(res, 200, { autoSend: body.on === true });
      }
      default:
        throw new AppError("NotFound", 404, `no route for ${key}`);
    }
  }

  // @purity non-pure
  async function handle(req, res) {
    try {
      await route(req, res);
    } catch (error) {
      if (!res.headersSent) sendError(res, error, redact);
      else res.end();
    }
  }

  // @purity non-pure
  function closeStreams() {
    for (const [pageId, stream] of [...streams]) endStream(pageId, stream);
  }

  return Object.freeze({ handle, closeStreams, dropPages });
}

module.exports = { createBoardApi, contentSecurityPolicy, importMapOf, isSameOrigin, vendorFile, localPage };
