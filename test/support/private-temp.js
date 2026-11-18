"use strict";

// Watchman Whiteboard: a test file that requires this first runs in a private temp folder, removed when
// the file's process ends, so the suite leaves nothing behind. os.tmpdir() reads these variables, and
// every Board Server and client a test starts inherits them, screenshots included (see UPSTREAM).
// `node --test` also runs this file on its own: it then makes the folder, has no tests, and removes it.

const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wbtest-"));
for (const key of ["TMPDIR", "TEMP", "TMP"]) process.env[key] = root;
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

module.exports = { root };
