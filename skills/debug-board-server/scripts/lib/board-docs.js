"use strict";

// BoardDocs (Entity + Adapter), Watchman Whiteboard. The project's documents: plain Markdown files under
// <project>/docs, the folder the agent works in, so agents, memory and git all see the same files (the owner,
// 2026-11-18: "our own doc creator that every AI can use and save in the docs folder").
//
// Every name is checked before it touches the disk (docPath: a .md or .markdown file under docs/, plain parts, no "..",
// never through a link out of the folder). A document is changed only from the version it was read at: a write or an
// edit of an existing document carries that version (`rev`), and a document changed since then is refused with
// DocChanged, so a person's edit on the page and an agent's edit never overwrite each other silently. Writes go to a
// temp file in the same folder and are renamed into place, so a reader never sees half a document.
//
// Called by talk-on-board's mcp.js (doc_list, doc_read, doc_write, doc_edit), which runs in the agent's own process
// and folder. The pure halves (revOf, titleOf, replaceSection, findReplace) are tested in test/unit/board-docs.test.js.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AppError } = require("./app-error");

const DOCS_DIR = "docs";
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const MAX_LIST = 500;
const MAX_PATH_CHARS = 240;
// One part of a document's path: a plain file or folder name.
const PART = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;
const DOC_FILE = /\.(md|markdown)$/i;
// Folders a listing never walks into.
const SKIP_DIRS = new Set(["node_modules", ".git"]);

// The project a folder belongs to: the nearest folder at or above `cwd` holding .git, else `cwd` itself.
// @purity semi-pure-b
function projectRoot(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(cwd);
    dir = up;
  }
}

// The version of a document's text: the first 16 hex digits of its SHA-256.
// @purity pure
function revOf(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

// The title of a document: its first "# " heading, else its file name without the extension.
// @purity pure
function titleOf(markdown, file) {
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);
  return match ? match[1].trim() : path.basename(file).replace(DOC_FILE, "");
}

// The checked path of `name` (relative to <root>/docs, "/" or "\" between parts) as {abs, rel}, or AppError InvalidDoc.
// @purity semi-pure-b
function docPath(root, name) {
  if (typeof name !== "string" || !name.trim() || name.length > MAX_PATH_CHARS) {
    throw new AppError("InvalidDoc", 400, "a document path is a short relative path such as plan.md or guides/setup.md");
  }
  const parts = name.trim().replace(/\\/g, "/").replace(/^docs\//i, "").split("/").filter(Boolean);
  if (!parts.length || !parts.every((p) => PART.test(p) && p !== "." && p !== "..")) {
    throw new AppError("InvalidDoc", 400, `"${name}" is not a plain path under docs/ (letters, digits, space, _ . - in each part)`);
  }
  if (!DOC_FILE.test(parts[parts.length - 1])) throw new AppError("InvalidDoc", 400, `"${name}" is not a .md or .markdown file`);
  const base = path.join(root, DOCS_DIR);
  const abs = path.join(base, ...parts);
  // A link inside docs/ must not lead out of it: the deepest folder that exists is checked by its real path.
  let probe = path.dirname(abs);
  while (!fs.existsSync(probe) && probe.length > base.length) probe = path.dirname(probe);
  if (fs.existsSync(base) && fs.existsSync(probe)) {
    const realBase = fs.realpathSync(base);
    const real = fs.realpathSync(probe);
    if (real !== realBase && !real.startsWith(realBase + path.sep)) {
      throw new AppError("InvalidDoc", 400, `"${name}" leads out of the docs folder`);
    }
  }
  return { abs, rel: parts.join("/") };
}

// Every document under <root>/docs, by path: {path, title, bytes, modifiedMs}, at most MAX_LIST.
// @purity non-pure
function listDocs(root) {
  const base = path.join(root, DOCS_DIR);
  const found = [];
  const walk = (dir, rel) => {
    if (found.length >= MAX_LIST) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= MAX_LIST || entry.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(child, childRel);
      } else if (entry.isFile() && DOC_FILE.test(entry.name)) {
        const stat = fs.statSync(child);
        if (stat.size > MAX_DOC_BYTES) continue;
        found.push({ path: childRel, title: titleOf(fs.readFileSync(child, "utf8"), entry.name), bytes: stat.size, modifiedMs: Math.round(stat.mtimeMs) });
      }
    }
  };
  walk(base, "");
  return found;
}

// One document as {path, markdown, rev}; AppError DocNotFound when there is none.
// @purity non-pure
function readDoc(root, name) {
  const { abs, rel } = docPath(root, name);
  if (!fs.existsSync(abs)) throw new AppError("DocNotFound", 404, `no document docs/${rel}; doc_list shows the ones there`);
  const stat = fs.statSync(abs);
  if (stat.size > MAX_DOC_BYTES) throw new AppError("DocTooLarge", 413, `docs/${rel} is over ${MAX_DOC_BYTES} bytes`);
  const markdown = fs.readFileSync(abs, "utf8");
  return { path: rel, markdown, rev: revOf(markdown) };
}

// Writes a document whole: a new one with no `rev`, an existing one only from the version `rev` names.
// Returns {path, rev, created}.
// @purity non-pure
function writeDoc(root, name, markdown, rev) {
  if (typeof markdown !== "string") throw new AppError("InvalidDoc", 400, "markdown is the document's whole text");
  if (Buffer.byteLength(markdown, "utf8") > MAX_DOC_BYTES) throw new AppError("DocTooLarge", 413, `a document is at most ${MAX_DOC_BYTES} bytes`);
  const { abs, rel } = docPath(root, name);
  const exists = fs.existsSync(abs);
  if (exists) {
    const now = revOf(fs.readFileSync(abs, "utf8"));
    if (!rev) throw new AppError("DocExists", 409, `docs/${rel} exists: read it first (doc_read) and send its rev`, { rev: now });
    if (rev !== now) throw new AppError("DocChanged", 409, `docs/${rel} changed since rev ${rev}: read it again`, { rev: now });
  } else if (rev) {
    throw new AppError("DocNotFound", 404, `no document docs/${rel} to change; leave rev out to create it`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, markdown, "utf8");
  fs.renameSync(temp, abs);
  return { path: rel, rev: revOf(markdown), created: !exists };
}

// The heading lines of `markdown` outside fenced code: {index, level, text}.
// @purity pure
function headings(lines) {
  const found = [];
  let fence = null;
  lines.forEach((line, index) => {
    const open = /^\s*(```|~~~)/.exec(line);
    if (open) {
      if (!fence) fence = open[1];
      else if (line.trim().startsWith(fence)) fence = null;
      return;
    }
    if (fence) return;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) found.push({ index, level: match[1].length, text: match[2].trim() });
  });
  return found;
}

// `markdown` with the body of the section under `heading` (any level, matched without case) replaced by `body`,
// up to the next heading of the same or a higher level. AppError SectionNotFound, or SectionAmbiguous when two match.
// @purity pure
function replaceSection(markdown, heading, body) {
  const lines = markdown.split("\n");
  const all = headings(lines);
  const want = String(heading).replace(/^#+\s*/, "").trim().toLowerCase();
  const hits = all.filter((h) => h.text.toLowerCase() === want);
  if (!hits.length) throw new AppError("SectionNotFound", 404, `no heading "${heading}"; the headings are: ${all.map((h) => h.text).slice(0, 30).join(" | ") || "(none)"}`);
  if (hits.length > 1) throw new AppError("SectionAmbiguous", 409, `${hits.length} headings read "${heading}": use find and replace instead`);
  const at = hits[0];
  const next = all.find((h) => h.index > at.index && h.level <= at.level);
  const end = next ? next.index : lines.length;
  const text = String(body).replace(/\s+$/, "");
  const middle = text ? ["", ...text.split("\n"), ""] : [""];
  return [...lines.slice(0, at.index + 1), ...middle, ...lines.slice(end)].join("\n");
}

// `markdown` with the `nth` (1 = first) occurrence of `find` replaced; without `nth`, `find` must occur once.
// AppError TextNotFound, or TextAmbiguous with the count.
// @purity pure
function findReplace(markdown, find, replace, nth) {
  if (typeof find !== "string" || !find) throw new AppError("InvalidDoc", 400, "find is the exact text to change");
  const at = [];
  for (let i = markdown.indexOf(find); i !== -1; i = markdown.indexOf(find, i + find.length)) at.push(i);
  if (!at.length) throw new AppError("TextNotFound", 404, "find is not in the document: read it again and quote it exactly");
  if (nth === undefined && at.length > 1) throw new AppError("TextAmbiguous", 409, `find occurs ${at.length} times: add nth (1 to ${at.length})`);
  const index = at[(nth || 1) - 1];
  if (index === undefined) throw new AppError("TextNotFound", 404, `find occurs ${at.length} times, not ${nth}`);
  return markdown.slice(0, index) + String(replace) + markdown.slice(index + find.length);
}

module.exports = {
  DOCS_DIR,
  MAX_DOC_BYTES,
  MAX_LIST,
  projectRoot,
  revOf,
  titleOf,
  docPath,
  listDocs,
  readDoc,
  writeDoc,
  replaceSection,
  findReplace,
};
