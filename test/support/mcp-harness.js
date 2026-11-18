"use strict";

// Watchman Whiteboard: the MCP server as a child process with a small JSON-RPC client, and a fake page that answers
// the board's Jobs, so the tools can be tested end to end with no browser and no AI (the same helpers as
// test/integration/mcp.test.js, shared by the math and science tool tests).

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const MCP = path.join(__dirname, "..", "..", "skills", "talk-on-board", "scripts", "mcp.js");
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// @purity non-pure
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// @purity non-pure
async function until(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(25);
  }
}

// @purity non-pure
function post(port, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port, method: "POST", path: urlPath,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

// A fake page: reads Server-Sent Events, answers pings, and answers Jobs with `answer(kind, make)`.
// @purity non-pure
function openPage(token, pageId, port) {
  const received = [];
  const send = (urlPath, body) => post(port, urlPath, { page: pageId, ...body }, { "x-board-token": token });
  const req = http.get({ host: "127.0.0.1", port, path: `/api/stream?t=${token}&page=${pageId}` }, (res) => {
    let buffer = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buffer += chunk;
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop();
      for (const block of blocks) {
        const type = /^event: (.*)$/m.exec(block);
        const data = /^data: (.*)$/m.exec(block);
        if (!type || !data) continue;
        received.push({ type: type[1], data: JSON.parse(data[1]) });
        if (type[1] === "ping") send("/api/pong", {}).catch(() => {});
      }
    });
  });
  req.on("error", () => {});
  return {
    received,
    find: (type) => received.find((m) => m.type === type),
    jobs: (kind) => received.filter((m) => m.type === "job" && m.data.kind === kind).map((m) => m.data),
    send,
    // Answers the next Job of `kind` with `make(job)` (a list of elements, or a whole reply); returns the Job.
    async answer(kind, make) {
      const job = await until(() => received.find((m) => m.type === "job" && m.data.kind === kind && !m.done), 15000, `${kind} job`);
      job.done = true;
      const made = make(job.data);
      await send("/api/job", { jobId: job.data.jobId, ...(Array.isArray(made) ? { ok: true, elements: made } : made) });
      return job.data;
    },
    close: () => req.destroy(),
  };
}

// An element as a page makes it.
// @purity pure
function el(id, extra = {}) {
  return {
    id, type: "rectangle", version: 1, versionNonce: 7, isDeleted: false, x: 0, y: 0, width: 100, height: 50,
    updated: Date.now(), strokeColor: "#1971c2", backgroundColor: "transparent", customData: { grwbKind: "claudeItem" }, ...extra,
  };
}

// A PNG image file as a page sends it, and an image element that shows it.
// @purity pure
function pngFile(id) {
  return { id, mimeType: "image/png", dataURL: `data:image/png;base64,${TINY_PNG_BASE64}`, created: 1 };
}

// `cwd` (Watchman Whiteboard): the folder the MCP Server runs in, as an agent's project; the doc_* tools act on it.
// @purity non-pure
function startMcp(env, cwd = undefined) {
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, ...env }, cwd, stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map();
  const stdoutLines = [];
  let stderr = "";
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      stdoutLines.push(line);
      const message = JSON.parse(line);
      replies.set(message.id, message);
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  let nextId = 1;
  const rpc = async (method, params) => {
    const id = nextId;
    nextId += 1;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\r\n`);
    return until(() => replies.get(id), 120000, method);
  };
  const tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  const init = () => rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  return { child, rpc, tool, init, exited, stdoutLines, stderr: () => stderr };
}

// @purity pure
function textOf(result) {
  return result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

// A data folder with an empty board and a known Token, so a fake page can open the stream.
// @purity non-pure
function boardData(prefix, token) {
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(pluginData, "board"));
  fs.writeFileSync(path.join(pluginData, "board", "board.json"), JSON.stringify({ v: 1, elements: [] }));
  fs.writeFileSync(path.join(pluginData, "board", "token.txt"), `${token}\n`);
  return pluginData;
}

// An MCP server on its own ports with an open board and one fake page; `close` stops them all.
// @purity non-pure
async function boardWithPage(name, port) {
  const token = `${name.toUpperCase()}TOKENabcdefghijklmnop`.slice(0, 24);
  const mcp = startMcp({
    CLAUDE_PLUGIN_DATA: boardData(`wbc-${name}-`, token), GRWB_OPEN_BROWSER: "0",
    GRWB_CONTROL_PORT: String(port + 1), GRWB_BOARD_PORT: String(port),
  });
  await mcp.init();
  const opened = textOf(await mcp.tool("open_board"));
  if (!opened.startsWith("ok open")) throw new Error(`open_board: ${opened}`);
  const page = openPage(token, `page${name.replace(/[^A-Za-z0-9]/g, "")}0001`.padEnd(12, "0"), port);
  await until(() => page.find("hello"), 5000, "hello");
  return {
    mcp,
    page,
    token,
    async close() {
      page.close();
      await mcp.tool("close_board").catch(() => {});
      mcp.child.stdin.end();
      return mcp.exited;
    },
  };
}

module.exports = { MCP, TINY_PNG_BASE64, delay, until, post, openPage, el, pngFile, startMcp, textOf, boardData, boardWithPage };
