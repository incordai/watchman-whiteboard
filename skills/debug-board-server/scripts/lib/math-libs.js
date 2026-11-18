"use strict";

// MathLibs (Adapter), Watchman Whiteboard. Loads the board's math libraries in Node, each once and only when first
// asked for, with no network. A library is one ES module: lib/math/<name>.mjs, which imports its npm package by name
// (a development checkout, where node_modules has it), or the bundle scripts/stage-whiteboard.mjs made of that same
// file in ../../math-vendor/<name>.mjs (a built Watchman, which has no node_modules). The staged bundle comes first.
// Python (Pyodide with SymPy and mpmath) is staged in ../../math-vendor/pyodide, wheels included, and loads only from
// there. Used by lib/board-math.js (the board server) and by talk-on-board's mcp.js (check_math, draw_plot, ...).

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { AppError } = require("./app-error");

const ENTRY_DIR = path.join(__dirname, "math");
const STAGED_DIR = path.join(__dirname, "..", "..", "math-vendor");
const PYTHON_DIR = path.join(STAGED_DIR, "pyodide");
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;
// The packages Python loads; each wheel is in PYTHON_DIR (scripts/stage-whiteboard.mjs PYTHON_PACKAGES).
const PYTHON_PACKAGES = Object.freeze(["sympy"]);

const loaded = new Map();
let python = null;

// The file of library `name`: the staged bundle when there is one, else the entry file. Throws MathUnavailable.
// @purity semi-pure-b
function mathLibFile(name, dirs = { staged: STAGED_DIR, entry: ENTRY_DIR }) {
  if (typeof name === "string" && NAME_PATTERN.test(name)) {
    for (const dir of [dirs.staged, dirs.entry]) {
      const file = path.join(dir, `${name}.mjs`);
      if (fs.existsSync(file)) return file;
    }
  }
  throw new AppError("MathUnavailable", 503, `no math library ${JSON.stringify(String(name)).slice(0, 60)}`);
}

// The module of library `name` (a promise, shared by every caller). A failed load is not kept, so a later call tries
// again. Rejects with MathUnavailable.
// @purity non-pure
function loadMathLib(name) {
  if (!loaded.has(name)) {
    const file = mathLibFile(name);
    const done = import(pathToFileURL(file).href).catch((error) => {
      loaded.delete(name);
      throw new AppError("MathUnavailable", 503, `the math library ${name} did not load: ${error && error.message}`);
    });
    loaded.set(name, done);
  }
  return loaded.get(name);
}

// Whether the build staged Python with its packages.
// @purity semi-pure-b
function pythonStaged(dir = PYTHON_DIR) {
  try {
    if (!fs.existsSync(path.join(dir, "pyodide.mjs"))) return false;
    const lock = JSON.parse(fs.readFileSync(path.join(dir, "pyodide-lock.json"), "utf8"));
    const wanted = new Set();
    const add = (name) => {
      if (wanted.has(name) || !lock.packages[name]) return;
      wanted.add(name);
      for (const dep of lock.packages[name].depends || []) add(dep);
    };
    for (const name of PYTHON_PACKAGES) add(name);
    return wanted.size > 0 && [...wanted].every((name) => fs.existsSync(path.join(dir, lock.packages[name].file_name)));
  } catch (error) {
    return false;
  }
}

// Pyodide with SymPy loaded, from PYTHON_DIR only (a promise, shared). Its output never reaches standard output,
// which is the MCP server's JSON-RPC channel. Rejects with MathUnavailable.
// @purity non-pure
function loadPython() {
  if (python === null) {
    python = (async () => {
      if (!pythonStaged()) throw new AppError("MathUnavailable", 503, "Python (SymPy) is not staged with this board");
      const quiet = () => {};
      const { loadPyodide } = await import(pathToFileURL(path.join(PYTHON_DIR, "pyodide.mjs")).href);
      const py = await loadPyodide({ indexURL: `${PYTHON_DIR}${path.sep}`, packageCacheDir: `${PYTHON_DIR}${path.sep}`, stdout: quiet, stderr: quiet });
      await py.loadPackage([...PYTHON_PACKAGES], { messageCallback: quiet, errorCallback: quiet, checkIntegrity: true });
      return py;
    })().catch((error) => {
      python = null;
      throw error instanceof AppError ? error : new AppError("MathUnavailable", 503, `Python did not load: ${error && error.message}`);
    });
  }
  return python;
}

// ---- Python in a worker thread (lib/python-worker.js) ----
const PYTHON_TIMEOUT_MS = 60000;
let worker = null;
let nextCall = 1;
const calls = new Map();

// @purity non-pure
function endWorker(error) {
  if (worker === null) return;
  const old = worker;
  worker = null;
  old.terminate().catch(() => {});
  for (const call of calls.values()) call.reject(error);
  calls.clear();
}

// @purity non-pure
function pythonWorker() {
  if (worker === null) {
    const { Worker } = require("worker_threads");
    worker = new Worker(path.join(__dirname, "python-worker.js"));
    worker.on("message", (reply) => {
      const call = calls.get(reply.id);
      if (!call) return;
      calls.delete(reply.id);
      clearTimeout(call.timer);
      if (reply.ok) call.resolve(reply.value);
      else if (reply.code === "MathUnavailable") call.reject(new AppError("MathUnavailable", 503, reply.message));
      else call.reject(new AppError("InvalidMath", 400, `SymPy: ${reply.message}`));
    });
    worker.on("error", (error) => endWorker(new AppError("MathUnavailable", 503, `Python stopped: ${error && error.message}`)));
    // The worker never keeps the process (the MCP server) alive by itself: unref after the listeners, which ref it.
    worker.unref();
  }
  return worker;
}

// Ends the Python worker, if one runs (a process that is done with Python; tests).
// @purity non-pure
function stopPython() {
  endWorker(new AppError("MathUnavailable", 503, "Python was stopped"));
}

// Runs `code` (a fixed program; its last expression is the answer) with the dict wb_in = `inputs`, in the Python
// worker. Rejects with InvalidMath for a Python error, MathUnavailable when Python is not staged, or MathTimeout after
// `timeoutMs`, which also ends the worker (the next call starts a new one and loads Python again).
// @purity non-pure
function runPython(code, inputs, timeoutMs = PYTHON_TIMEOUT_MS) {
  if (!pythonStaged()) return Promise.reject(new AppError("MathUnavailable", 503, "Python (SymPy) is not staged with this board"));
  const id = nextCall;
  nextCall += 1;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      calls.delete(id);
      endWorker(new AppError("MathTimeout", 504, "Python was stopped"));
      reject(new AppError("MathTimeout", 504, `SymPy did not finish within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    calls.set(id, { resolve, reject, timer });
    pythonWorker().postMessage({ id, code, inputs });
  });
}

module.exports = {
  loadMathLib, loadPython, runPython, stopPython, pythonStaged, mathLibFile, ENTRY_DIR, STAGED_DIR, PYTHON_DIR, PYTHON_PACKAGES, PYTHON_TIMEOUT_MS,
};
