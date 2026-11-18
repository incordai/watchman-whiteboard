"use strict";

// WatchmanTab (Adapter, Watchman Whiteboard). Opens the Board in a tab of Watchman's own browser instead of the
// browser of the OS (the owner, 2026-11-17: "in the UI it should open in tabs like the browser opens"; links and
// the board open in Watchman's browser whenever Watchman runs, the system browser only when it does not).
// Two ways in, tried in this order by showBoard (called by mcp.js openBoard):
// 1. An agent turn that Watchman started carries WATCHMAN_APP_ENDPOINT (an address on this computer) and
//    WATCHMAN_APP_TOKEN; Watchman answers one JSON line {token, action, input, requestId, namespace: "app"} on it
//    with one JSON line {ok, result | error}, as `watchman app browser.open` sends it (Watchman
//    src-tauri/src/control_cli.rs `send`).
// 2. Any other agent (a plain terminal, a test over SSH) finds the running Watchman as `watchman-cli` does:
//    runtime.json in Watchman's app-data folder (WATCHMAN_DATA_DIR first), holding the loopback endpoint, the
//    owner token and the process id (src-tauri/src/runtime/discovery.rs, client.rs). It sends one JSON line
//    {id, token, method: "browser.openLocal", params: {url}} and reads {id, ok, result | error, meta: {runtimeId}}
//    (runtime/rpc.rs); browser.openLocal takes only a page on this computer (runtime/browser_tab.rs).
// Only when neither shows it does the system browser open the board, and the reply says why.
// A token goes only to a loopback address, and the owner token only with a page on this computer.
// Tests: test/unit/watchman-tab.test.js, test/integration/mcp.test.js.

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { quoted, cut } = require("./brief");

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_REPLY_BYTES = 65536;
// Tauri's app identifier, the app-data folder's name (discovery.rs IDENTIFIER).
const IDENTIFIER = "ai.incord.watchman";
const RUNTIME_FILE = "runtime.json";
const RUNTIME_SCHEMA = 1;
const OPEN_LOCAL = "browser.openLocal";

// {host, port} of an "ip:port" on this computer ("127.0.0.1:5000", "[::1]:5000"), or null. Only an address, never
// a name, so nothing resolves it to another machine.
// @purity pure
function loopbackAddress(raw) {
  const match = /^(?:\[([0-9a-fA-F:]+)\]|(\d{1,3}(?:\.\d{1,3}){3})):(\d{1,5})$/.exec(String(raw || ""));
  if (!match) return null;
  const host = match[1] || match[2];
  const port = Number(match[3]);
  const loopback = host === "::1" || /^127\./.test(host);
  if (!loopback || port < 1 || port > 65535) return null;
  return { host, port };
}

// The endpoint of this agent turn's Watchman, or null outside Watchman. Only a loopback address is
// accepted, as Watchman's own CLI does, so a changed env never sends the token to another machine.
// @purity pure
function watchmanEndpoint(env) {
  const token = String(env.WATCHMAN_APP_TOKEN || "");
  const address = loopbackAddress(env.WATCHMAN_APP_ENDPOINT);
  if (!address || !token) return null;
  return { ...address, token };
}

// Whether `text` is an http(s) page on this computer (localhost, 127.0.0.0/8, [::1]) with no login in it: what
// browser.openLocal takes (runtime/browser_tab.rs local_page). A LAN board (https://192.168...) is not one.
// @purity pure
function localPage(text) {
  const raw = String(text || "").trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    return false;
  }
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

// Watchman's app-data folder, worked out as `watchman-cli` does (discovery.rs default_data_dir): WATCHMAN_DATA_DIR
// when set; else Windows %APPDATA%\ai.incord.watchman, macOS $HOME/Library/Application Support/ai.incord.watchman,
// Linux $XDG_DATA_HOME (absolute only) or $HOME/.local/share, then ai.incord.watchman. Null when none can be.
// @purity pure
function runtimeDataDir(env, platform = process.platform) {
  if (env.WATCHMAN_DATA_DIR) return env.WATCHMAN_DATA_DIR;
  if (platform === "win32") return env.APPDATA ? path.win32.join(env.APPDATA, IDENTIFIER) : null;
  if (platform === "darwin") return env.HOME ? path.posix.join(env.HOME, "Library/Application Support", IDENTIFIER) : null;
  if (env.XDG_DATA_HOME && path.posix.isAbsolute(env.XDG_DATA_HOME)) return path.posix.join(env.XDG_DATA_HOME, IDENTIFIER);
  return env.HOME ? path.posix.join(env.HOME, ".local/share", IDENTIFIER) : null;
}

// Whether process `pid` runs (discovery.rs pid_alive): signal 0 sends nothing, and EPERM still means it exists.
// @purity non-pure
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// The running Watchman from its runtime.json: {ok: true, host, port, token, runtimeId}, or {ok: false, error}
// when there is no file, it is damaged, it names no loopback endpoint, or its process is gone (a crash leaves the
// file; another program may hold that port now, so the token is not sent there).
// @purity non-pure
function findRunningWatchman(env, { platform = process.platform, pidAlive: alive = pidAlive } = {}) {
  const dir = runtimeDataDir(env, platform);
  if (!dir) return { ok: false, error: "couldn't work out Watchman's app-data folder; set WATCHMAN_DATA_DIR" };
  let text;
  try {
    text = fs.readFileSync(path.join(dir, RUNTIME_FILE), "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { ok: false, error: "Watchman is not running (no runtime.json)" };
    return { ok: false, error: `cannot read runtime.json: ${error.code || error.message}` };
  }
  let file;
  try {
    file = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: "runtime.json is not a Watchman runtime file" };
  }
  if (!file || typeof file !== "object" || file.schema !== RUNTIME_SCHEMA) {
    return { ok: false, error: `runtime.json is not schema ${RUNTIME_SCHEMA}` };
  }
  const address = loopbackAddress(file.endpoint);
  if (!address) return { ok: false, error: "runtime.json names no endpoint on this computer" };
  if (typeof file.token !== "string" || !file.token) return { ok: false, error: "runtime.json has no token" };
  if (typeof file.runtimeId !== "string" || !file.runtimeId) return { ok: false, error: "runtime.json has no runtime id" };
  if (!alive(file.pid)) return { ok: false, error: `Watchman is not running (process ${file.pid} is gone)` };
  return { ok: true, host: address.host, port: address.port, token: file.token, runtimeId: file.runtimeId };
}

// Sends `request` as one JSON line to {host, port} and reads one line back: {reply} or {error}. Never rejects.
// @purity non-pure
function askLine({ host, port }, request, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = net.connect({ host, port });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish({ error: "no reply from Watchman in time" }));
    socket.on("error", (error) => finish({ error: `cannot reach Watchman: ${error.code || error.message}` }));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_REPLY_BYTES) return finish({ error: "Watchman's reply is too large" });
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        finish({ reply: JSON.parse(buffer.slice(0, end)) });
      } catch (error) {
        finish({ error: "Watchman's reply is not JSON" });
      }
    });
    socket.on("end", () => finish({ error: "no reply from Watchman" }));
  });
}

// Asks this agent turn's Watchman to open `url` in one of its browser tabs. Resolves {ok: true} or
// {ok: false, error}; never rejects, so open_board can say what happened.
// @purity non-pure
async function openInWatchman(url, env, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const endpoint = watchmanEndpoint(env);
  if (!endpoint) return { ok: false, error: "not in a Watchman agent turn" };
  const request = {
    token: endpoint.token,
    action: "browser.open",
    input: { url },
    requestId: `whiteboard-${crypto.randomUUID()}`,
    namespace: "app",
  };
  const answer = await askLine(endpoint, request, timeoutMs);
  if (answer.error) return { ok: false, error: answer.error };
  const reply = answer.reply;
  return reply && reply.ok === true ? { ok: true } : { ok: false, error: String((reply && reply.error) || "Watchman refused") };
}

// Asks the running Watchman (runtime.json) to show `url`, a page on this computer, in a browser tab. With `cwd`, the
// agent's own working folder (absolute only; process.cwd() by default), Watchman opens it in that folder's project,
// else in the Chat page's tabs, never as a standalone page (the owner, 2026-11-17; Watchman's runtime/browser_tab.rs
// and App.tsx boardPlacement). An older Watchman that refuses the field is asked again without it. Resolves
// {ok: true} or {ok: false, running, error}: running is false when Watchman is not running or does not answer, true
// when it answered but did not show it (an older Watchman without browser.openLocal).
// @purity non-pure
async function openInRunningWatchman(url, env, { timeoutMs = DEFAULT_TIMEOUT_MS, cwd = process.cwd(), ...find } = {}) {
  if (!localPage(url)) return { ok: false, running: null, error: "the board is not on this computer, so no Watchman tab is asked for" };
  const found = findRunningWatchman(env, find);
  if (!found.ok) return { ok: false, running: false, error: found.error };
  const folder = typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : null;
  const first = await askOpenLocal(found, url, folder, timeoutMs);
  const unknownField = !first.ok && first.running && /unknown field `?cwd/i.test(first.error);
  return folder && unknownField ? askOpenLocal(found, url, null, timeoutMs) : first;
}

// One browser.openLocal request to the running Watchman `found`, with the folder when there is one.
// @purity non-pure
async function askOpenLocal(found, url, folder, timeoutMs) {
  const id = `whiteboard-${crypto.randomUUID()}`;
  const params = folder ? { url, cwd: folder } : { url };
  const answer = await askLine(found, { id, token: found.token, method: OPEN_LOCAL, params }, timeoutMs);
  if (answer.error) return { ok: false, running: false, error: answer.error };
  const reply = answer.reply && typeof answer.reply === "object" ? answer.reply : {};
  const runtimeId = reply.meta && reply.meta.runtimeId;
  if (runtimeId !== found.runtimeId) {
    return { ok: false, running: true, error: `a different Watchman answered (runtime ${runtimeId || "?"}); it restarted` };
  }
  if (reply.ok === true && reply.id === id) return { ok: true };
  if (reply.ok === true) return { ok: false, running: true, error: "Watchman's reply answers another request" };
  const error = reply.error && typeof reply.error === "object" ? reply.error : {};
  return { ok: false, running: true, error: `${error.code || "refused"}: ${error.message || "Watchman refused"}` };
}

// A reason fit for the reply: never the board link or its token.
// @purity pure
function reasonOf(error, url) {
  return quoted(cut(String(error).split(url).join("(the board link)").replace(/#t=[^\s"]*/g, "#t=..."), 120));
}

// Shows the board: in this agent turn's Watchman tab; else in the running Watchman's tab; else, when Watchman is
// not running, does not answer or cannot show it, with `openSystem` (the browser of the OS). Answers the word for
// the reply's browser=: "watchman-tab", "watchman-tab-failed reason=..." (the turn's Watchman refused, as before)
// or "opened reason=..." (the system browser, and why). `systemBrowser: false` (mcp.js openBoard, when a live page
// already shows the board elsewhere): Watchman may still show its tab, but no system browser opens ("skipped").
// Watchman keeps ONE board tab: asked again, it brings that tab forward (src/app/App.tsx openBrowserTab).
// @purity non-pure
async function showBoard(url, env, { openSystem, log = () => {}, systemBrowser = true, ...options } = {}) {
  const marked = watchmanLink(url);
  if (watchmanEndpoint(env)) {
    const shown = await openInWatchman(marked, env, options);
    if (shown.ok) return "watchman-tab";
    log(`the Watchman tab did not open: ${shown.error}`);
    return `watchman-tab-failed reason=${reasonOf(shown.error, marked)}`;
  }
  const shown = await openInRunningWatchman(marked, env, options);
  if (shown.ok) return "watchman-tab";
  if (!systemBrowser) return "skipped";
  log(`Watchman did not show the board (${reasonOf(shown.error, marked)}); the system browser opens it`);
  openSystem(url);
  return `opened reason=${reasonOf(shown.error, marked)}`;
}

// The board link as Watchman gets it: `wm=1` added to its hash, so Watchman knows the page is this board and opens
// it with its own theme and glass (page/look.mjs reads the params Watchman adds). The system browser gets the
// plain link. A hash is never sent to the Server, so the token stays where it was.
// @purity pure
function watchmanLink(url) {
  const at = url.indexOf("#");
  const base = at < 0 ? url : url.slice(0, at);
  const params = new URLSearchParams(at < 0 ? "" : url.slice(at + 1));
  if (params.get("wm") === "1") return url;
  const hash = at < 0 || at === url.length - 1 ? "" : url.slice(at + 1);
  return `${base}#${hash ? `${hash}&` : ""}wm=1`;
}

module.exports = {
  watchmanEndpoint, openInWatchman, localPage, runtimeDataDir, findRunningWatchman, openInRunningWatchman, showBoard,
  watchmanLink,
};
