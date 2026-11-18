"use strict";

// Watchman Whiteboard: open_board shows the board in a Watchman tab (the owner, 2026-11-17: "in the UI it
// should open in tabs like the browser opens"), through the agent turn's own Watchman app endpoint, the
// same one `watchman app browser.open` uses (Watchman src-tauri/src/control_cli.rs `send`). Outside an agent
// turn, through the running Watchman's runtime (runtime.json, the method browser.openLocal), as
// `watchman-cli call` finds and calls it (src-tauri/src/runtime/cli.rs, client.rs, discovery.rs).

require("../support/private-temp");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const {
  watchmanEndpoint, openInWatchman, runtimeDataDir, findRunningWatchman, openInRunningWatchman, showBoard, localPage,
  watchmanLink,
} = require("../../skills/talk-on-board/scripts/lib/watchman-tab");

test("the endpoint comes from the agent turn's env, on this computer only", () => {
  assert.deepEqual(watchmanEndpoint({ WATCHMAN_APP_ENDPOINT: "127.0.0.1:5123", WATCHMAN_APP_TOKEN: "tok" }), { host: "127.0.0.1", port: 5123, token: "tok" });
  assert.deepEqual(watchmanEndpoint({ WATCHMAN_APP_ENDPOINT: "[::1]:5123", WATCHMAN_APP_TOKEN: "tok" }), { host: "::1", port: 5123, token: "tok" });
  assert.equal(watchmanEndpoint({}), null, "outside Watchman: no endpoint");
  assert.equal(watchmanEndpoint({ WATCHMAN_APP_ENDPOINT: "127.0.0.1:5123" }), null, "no token");
  assert.equal(watchmanEndpoint({ WATCHMAN_APP_ENDPOINT: "10.0.0.2:5123", WATCHMAN_APP_TOKEN: "tok" }), null, "never another machine");
  assert.equal(watchmanEndpoint({ WATCHMAN_APP_ENDPOINT: "localhost:5123", WATCHMAN_APP_TOKEN: "tok" }), null, "an address, not a name");
  assert.equal(watchmanEndpoint({ WATCHMAN_APP_ENDPOINT: "127.0.0.1:99999", WATCHMAN_APP_TOKEN: "tok" }), null, "a real port");
});

// A stand-in for Watchman's app endpoint: reads one JSON line, answers with `reply`.
function fakeWatchman(reply) {
  return new Promise((resolve) => {
    const seen = [];
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        seen.push(JSON.parse(buffer.slice(0, end)));
        if (reply !== null) socket.end(`${JSON.stringify(reply)}\n`);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port }));
  });
}

test("open_board asks Watchman to open the board in a tab, with the turn's token", async () => {
  const { server, seen, port } = await fakeWatchman({ ok: true, result: { id: "t1" } });
  try {
    const env = { WATCHMAN_APP_ENDPOINT: `127.0.0.1:${port}`, WATCHMAN_APP_TOKEN: "secret" };
    const result = await openInWatchman("http://127.0.0.1:47830/#t=TOK", env);
    assert.deepEqual(result, { ok: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].token, "secret");
    assert.equal(seen[0].namespace, "app");
    assert.equal(seen[0].action, "browser.open");
    assert.deepEqual(seen[0].input, { url: "http://127.0.0.1:47830/#t=TOK" });
    assert.match(seen[0].requestId, /^whiteboard-/);
  } finally {
    server.close();
  }
});

test("a refusal, a silent Watchman and no Watchman each come back as a reason, never a throw", async () => {
  const refused = await fakeWatchman({ ok: false, error: "browser is closed" });
  try {
    const env = { WATCHMAN_APP_ENDPOINT: `127.0.0.1:${refused.port}`, WATCHMAN_APP_TOKEN: "t" };
    assert.deepEqual(await openInWatchman("http://127.0.0.1:47830/", env), { ok: false, error: "browser is closed" });
  } finally {
    refused.server.close();
  }
  const silent = await fakeWatchman(null);
  try {
    const env = { WATCHMAN_APP_ENDPOINT: `127.0.0.1:${silent.port}`, WATCHMAN_APP_TOKEN: "t" };
    const result = await openInWatchman("http://127.0.0.1:47830/", env, { timeoutMs: 200 });
    assert.equal(result.ok, false);
    assert.match(result.error, /no reply/);
  } finally {
    silent.server.close();
  }
  assert.deepEqual(await openInWatchman("http://127.0.0.1:47830/", {}), { ok: false, error: "not in a Watchman agent turn" });
});

// ---- Outside an agent turn: the running Watchman's runtime (the owner, 2026-11-17: an agent started in a
// plain terminal while Watchman was running opened the board in the system browser). ----

const BOARD = "http://127.0.0.1:47830/#t=TOK";

test("Watchman's app-data folder is found as watchman-cli finds it, per OS (discovery.rs default_data_dir)", () => {
  const id = "ai.incord.watchman";
  assert.equal(runtimeDataDir({ WATCHMAN_DATA_DIR: "/elsewhere", APPDATA: "C:\\R", HOME: "/h" }, "win32"), "/elsewhere");
  assert.equal(runtimeDataDir({ WATCHMAN_DATA_DIR: "/elsewhere" }, "linux"), "/elsewhere");
  assert.equal(runtimeDataDir({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32"), `C:\\Users\\a\\AppData\\Roaming\\${id}`);
  assert.equal(runtimeDataDir({ WATCHMAN_DATA_DIR: "", APPDATA: "C:\\R" }, "win32"), `C:\\R\\${id}`, "an empty override is none");
  assert.equal(runtimeDataDir({ HOME: "/Users/a" }, "darwin"), `/Users/a/Library/Application Support/${id}`);
  assert.equal(runtimeDataDir({ HOME: "/home/a" }, "linux"), `/home/a/.local/share/${id}`);
  assert.equal(runtimeDataDir({ HOME: "/home/a", XDG_DATA_HOME: "/xdg" }, "linux"), `/xdg/${id}`);
  assert.equal(runtimeDataDir({ HOME: "/home/a", XDG_DATA_HOME: "rel" }, "linux"), `/home/a/.local/share/${id}`, "a relative XDG_DATA_HOME is ignored");
  assert.equal(runtimeDataDir({}, "win32"), null);
  assert.equal(runtimeDataDir({}, "darwin"), null);
  assert.equal(runtimeDataDir({}, "linux"), null);
});

test("only a page on this computer is offered to Watchman (runtime/browser_tab.rs local_page)", () => {
  for (const ok of [BOARD, "http://localhost:5173/", "https://127.0.0.1:47831/", "https://[::1]:8443/"]) assert.equal(localPage(ok), true, ok);
  for (const refused of ["", "127.0.0.1:47830", "https://192.168.1.5:47831/#t=TOK", "http://example.com/", "http://user:pw@127.0.0.1:1/", "file:///etc/passwd", "http://0.0.0.0:1/"]) {
    assert.equal(localPage(refused), false, refused);
  }
});

// A folder holding runtime.json as a running Watchman writes it (discovery.rs Discovery).
function runtimeDir(fields) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbrt-"));
  const file = { schema: 1, runtimeId: "rt-1", pid: process.pid, endpoint: "127.0.0.1:9", token: "owner-token", startedAt: 1, version: "1.0.0", ...fields };
  fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify(file));
  return dir;
}

// A stand-in for the runtime's loopback socket (runtime/server.rs): one request line in, one response out,
// carrying the runtime id as a real one does (rpc.rs response).
function fakeRuntime(answer) {
  return new Promise((resolve) => {
    const seen = [];
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        const request = JSON.parse(buffer.slice(0, end));
        seen.push(request);
        socket.end(`${JSON.stringify(answer(request))}\n`);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, endpoint: `127.0.0.1:${server.address().port}` }));
  });
}

const opened = (runtimeId = "rt-1") => (request) => ({ id: request.id, ok: true, result: { shownIn: "tab" }, meta: { runtimeId } });

// A port nothing listens on.
async function closedEndpoint() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `127.0.0.1:${port}`;
}

test("a running Watchman is found through runtime.json; no file, a damaged one, a gone process or another machine is not one", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wbrt-"));
  assert.match(findRunningWatchman({ WATCHMAN_DATA_DIR: empty }).error, /not running/);
  assert.match(findRunningWatchman({}, { platform: "linux" }).error, /app-data folder/);
  const damaged = fs.mkdtempSync(path.join(os.tmpdir(), "wbrt-"));
  fs.writeFileSync(path.join(damaged, "runtime.json"), "{ half");
  assert.equal(findRunningWatchman({ WATCHMAN_DATA_DIR: damaged }).ok, false);
  assert.equal(findRunningWatchman({ WATCHMAN_DATA_DIR: runtimeDir({ schema: 2 }) }).ok, false, "another schema");
  const stale = findRunningWatchman({ WATCHMAN_DATA_DIR: runtimeDir({ pid: 424242 }) }, { pidAlive: () => false });
  assert.match(stale.error, /process 424242 is gone/);
  for (const endpoint of ["10.0.0.2:5000", "localhost:5000", "example.com:5000"]) {
    assert.equal(findRunningWatchman({ WATCHMAN_DATA_DIR: runtimeDir({ endpoint }) }).ok, false, endpoint);
  }
  assert.equal(findRunningWatchman({ WATCHMAN_DATA_DIR: runtimeDir({ token: "" }) }).ok, false, "no token");
  const found = findRunningWatchman({ WATCHMAN_DATA_DIR: runtimeDir({ endpoint: "[::1]:5000" }) });
  assert.deepEqual(found, { ok: true, host: "::1", port: 5000, token: "owner-token", runtimeId: "rt-1" });
});

test("outside an agent turn the board goes to the running Watchman's browser.openLocal with the owner token", async () => {
  const runtime = await fakeRuntime(opened());
  try {
    const env = { WATCHMAN_DATA_DIR: runtimeDir({ endpoint: runtime.endpoint }) };
    assert.deepEqual(await openInRunningWatchman(BOARD, env), { ok: true });
    assert.equal(runtime.seen.length, 1);
    assert.equal(runtime.seen[0].method, "browser.openLocal");
    // The agent's working folder goes with it, so Watchman opens the board in that folder's project, else in the
    // Chat page's tabs, never as a standalone page (runtime/browser_tab.rs, App.tsx boardPlacement).
    assert.deepEqual(runtime.seen[0].params, { url: BOARD, cwd: process.cwd() });
    assert.equal(runtime.seen[0].token, "owner-token");
    assert.match(runtime.seen[0].id, /^whiteboard-/);
  } finally {
    runtime.server.close();
  }
});

// The owner, 2026-11-17: the board opened as a standalone page, in no project and not in the Chat page. The folder
// is the agent's own, absolute only; an older Watchman that refuses the field still shows the board (asked again
// without it). Fails if a relative folder is sent, or an older Watchman's refusal loses the board.
test("the agent's folder goes with the board, and an older Watchman is asked again without it", async () => {
  const folder = path.resolve(os.tmpdir(), "some-project");
  const runtime = await fakeRuntime(opened());
  const older = await fakeRuntime((request) => (request.params && request.params.cwd !== undefined
    ? { id: request.id, ok: false, error: { code: "invalid_params", message: "unknown field `cwd`, expected `url`" }, meta: { runtimeId: "rt-1" } }
    : { id: request.id, ok: true, result: { shownIn: "tab" }, meta: { runtimeId: "rt-1" } }));
  try {
    const env = { WATCHMAN_DATA_DIR: runtimeDir({ endpoint: runtime.endpoint }) };
    assert.deepEqual(await openInRunningWatchman(BOARD, env, { cwd: folder }), { ok: true });
    assert.deepEqual(runtime.seen[0].params, { url: BOARD, cwd: folder });
    assert.deepEqual(await openInRunningWatchman(BOARD, env, { cwd: "relative/dir" }), { ok: true });
    assert.deepEqual(runtime.seen[1].params, { url: BOARD }, "a relative folder is not sent");
    const old = { WATCHMAN_DATA_DIR: runtimeDir({ endpoint: older.endpoint }) };
    assert.deepEqual(await openInRunningWatchman(BOARD, old, { cwd: folder }), { ok: true });
    assert.deepEqual(older.seen.map((r) => r.params), [{ url: BOARD, cwd: folder }, { url: BOARD }]);
  } finally {
    runtime.server.close();
    older.server.close();
  }
});

test("a refusal, another Watchman answering, or no answer is a reason, never a throw", async () => {
  const refusing = await fakeRuntime((request) => ({
    id: request.id, ok: false, error: { code: "method_not_found", message: "no method browser.openLocal" }, meta: { runtimeId: "rt-1" },
  }));
  const other = await fakeRuntime(opened("rt-other"));
  try {
    const refused = await openInRunningWatchman(BOARD, { WATCHMAN_DATA_DIR: runtimeDir({ endpoint: refusing.endpoint }) });
    assert.equal(refused.ok, false);
    assert.equal(refused.running, true);
    assert.match(refused.error, /method_not_found/);
    const restarted = await openInRunningWatchman(BOARD, { WATCHMAN_DATA_DIR: runtimeDir({ endpoint: other.endpoint }) });
    assert.equal(restarted.ok, false);
    assert.match(restarted.error, /different Watchman/);
  } finally {
    refusing.server.close();
    other.server.close();
  }
  const silent = await openInRunningWatchman(BOARD, { WATCHMAN_DATA_DIR: runtimeDir({ endpoint: await closedEndpoint() }) });
  assert.equal(silent.ok, false);
  assert.equal(silent.running, false, "a Watchman that does not answer is not running");
  const none = await openInRunningWatchman(BOARD, { WATCHMAN_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "wbrt-")) });
  assert.deepEqual([none.ok, none.running], [false, false]);
});

test("a page that is not on this computer is never sent, so the token never goes with it", async () => {
  const runtime = await fakeRuntime(opened());
  try {
    const env = { WATCHMAN_DATA_DIR: runtimeDir({ endpoint: runtime.endpoint }) };
    const lan = await openInRunningWatchman("https://192.168.1.5:47831/#t=TOK", env);
    assert.equal(lan.ok, false);
    assert.equal(runtime.seen.length, 0);
  } finally {
    runtime.server.close();
  }
});

test("showBoard: the agent turn's Watchman, else the running Watchman, else the system browser, and says which", async () => {
  const systemOpened = [];
  const openSystem = (url) => systemOpened.push(url);
  // In an agent turn: that turn's endpoint, as before.
  const app = await fakeWatchman({ ok: true, result: { id: "t1" } });
  const runtime = await fakeRuntime(opened());
  try {
    const turn = { WATCHMAN_APP_ENDPOINT: `127.0.0.1:${app.port}`, WATCHMAN_APP_TOKEN: "turn", WATCHMAN_DATA_DIR: runtimeDir({ endpoint: runtime.endpoint }) };
    assert.equal(await showBoard(BOARD, turn, { openSystem }), "watchman-tab");
    assert.equal(app.seen.length, 1);
    assert.equal(runtime.seen.length, 0, "the turn's own endpoint first");
    // Watchman is told it is the board (wm=1), so it opens it with its own theme and glass.
    assert.equal(app.seen[0].input.url, watchmanLink(BOARD));
    // A plain terminal while Watchman runs: a Watchman tab, not the system browser.
    assert.equal(await showBoard(BOARD, { WATCHMAN_DATA_DIR: runtimeDir({ endpoint: runtime.endpoint }) }, { openSystem }), "watchman-tab");
    assert.equal(runtime.seen.length, 1);
    assert.equal(runtime.seen[0].params.url, watchmanLink(BOARD));
    assert.deepEqual(systemOpened, []);
  } finally {
    app.server.close();
    runtime.server.close();
  }
  // Watchman is not running: the system browser, with the reason.
  const notRunning = await showBoard(BOARD, { WATCHMAN_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "wbrt-")) }, { openSystem });
  assert.match(notRunning, /^opened reason="Watchman is not running/);
  const silent = await showBoard(BOARD, { WATCHMAN_DATA_DIR: runtimeDir({ endpoint: await closedEndpoint() }) }, { openSystem });
  assert.match(silent, /^opened reason=/);
  assert.deepEqual(systemOpened, [BOARD, BOARD], "the system browser gets the plain link");
});

test("watchmanLink marks the board link for Watchman and keeps the token and the rest of the hash", () => {
  assert.equal(watchmanLink("http://127.0.0.1:47830/#t=TOK"), "http://127.0.0.1:47830/#t=TOK&wm=1");
  assert.equal(watchmanLink("http://127.0.0.1:47830/#t=TOK&anim=2"), "http://127.0.0.1:47830/#t=TOK&anim=2&wm=1");
  assert.equal(watchmanLink("http://127.0.0.1:47830/"), "http://127.0.0.1:47830/#wm=1");
  assert.equal(watchmanLink("http://127.0.0.1:47830/#t=TOK&wm=1"), "http://127.0.0.1:47830/#t=TOK&wm=1", "once only");
});

test("showBoard: a Watchman that cannot show it (an older one) still lets the board open, in the system browser", async () => {
  const systemOpened = [];
  const older = await fakeRuntime((request) => ({
    id: request.id, ok: false, error: { code: "method_not_found", message: "no method browser.openLocal" }, meta: { runtimeId: "rt-1" },
  }));
  try {
    const said = await showBoard(BOARD, { WATCHMAN_DATA_DIR: runtimeDir({ endpoint: older.endpoint }) }, { openSystem: (url) => systemOpened.push(url) });
    assert.match(said, /^opened reason=".*method_not_found/);
    assert.doesNotMatch(said, /TOK/, "the reply never has the link");
    assert.deepEqual(systemOpened, [BOARD]);
  } finally {
    older.server.close();
  }
});
