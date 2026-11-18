"use strict";

// PythonWorker (Adapter), Watchman Whiteboard. Runs Python (Pyodide with SymPy, lib/math-libs.js loadPython) in a worker
// thread, so a long computation can be stopped (math-libs.js runPython ends the worker) and never blocks the MCP server
// that every agent's tool calls go through. Gets { id, code, inputs }: `inputs` is the Python global wb_in (a dict);
// `code` is a fixed program whose last expression is the answer. Answers { id, ok, value } or { id, ok: false, message }.

const { parentPort } = require("worker_threads");
const { loadPython } = require("./math-libs");

// A worker's standard output is its process's, which is the MCP server's JSON-RPC channel: nothing printed here may
// reach it.
console.log = console.error;
console.info = console.error;

parentPort.on("message", async ({ id, code, inputs }) => {
  try {
    const py = await loadPython();
    const given = py.toPy(inputs);
    py.globals.set("wb_in", given);
    const out = py.runPython(code);
    given.destroy();
    const value = out && typeof out.toJs === "function" ? out.toJs({ dict_converter: Object.fromEntries }) : out;
    if (out && typeof out.destroy === "function") out.destroy();
    parentPort.postMessage({ id, ok: true, value });
  } catch (error) {
    // A Python error's message is its traceback; the last line says what went wrong.
    const lines = String(error && error.message).trim().split("\n");
    parentPort.postMessage({ id, ok: false, code: error && error.code, message: lines[lines.length - 1] });
  }
});
