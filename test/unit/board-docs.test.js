"use strict";

// Watchman Whiteboard: the project's documents (lib/board-docs.js; the owner, 2026-11-18: a doc creator every agent
// can use, saving in the project's docs folder). Paths stay under docs/, a document is changed only from the version
// it was read at, and section and find edits change only what they name.

require("../support/private-temp");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const docs = require("../../skills/debug-board-server/scripts/lib/board-docs");

// @purity non-pure
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-project-"));
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

// @purity pure
function code(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return "no error";
}

test("a document's path stays under docs/ and is a Markdown file", () => {
  const root = project();
  assert.equal(docs.docPath(root, "plan.md").rel, "plan.md");
  assert.equal(docs.docPath(root, "docs/guides\\setup.md").rel, "guides/setup.md");
  assert.equal(docs.docPath(root, "notes.markdown").abs, path.join(root, "docs", "notes.markdown"));
  for (const bad of ["", "../secret.md", "guides/../../x.md", "/etc/passwd", "plan.txt", ".hidden.md", "a/./b.md", "C:/x.md", "x".repeat(250) + ".md"]) {
    assert.equal(code(() => docs.docPath(root, bad)), "InvalidDoc", JSON.stringify(bad));
  }
});

test("a link inside docs/ cannot lead out of it", (t) => {
  const root = project();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  fs.mkdirSync(path.join(root, "docs"));
  try {
    fs.symlinkSync(outside, path.join(root, "docs", "away"), "junction");
  } catch {
    t.skip("this system does not let the test make a link");
    return;
  }
  assert.equal(code(() => docs.docPath(root, "away/x.md")), "InvalidDoc");
});

test("the project is the nearest folder with .git", () => {
  const root = project();
  const deep = path.join(root, "src", "app");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(docs.projectRoot(deep), root);
});

test("a new document is written, read back with its rev, listed with its title", () => {
  const root = project();
  const made = docs.writeDoc(root, "guides/setup.md", "# Setup guide\n\nInstall it.\n");
  assert.deepEqual(made, { path: "guides/setup.md", rev: docs.revOf("# Setup guide\n\nInstall it.\n"), created: true });
  const read = docs.readDoc(root, "guides/setup.md");
  assert.equal(read.markdown, "# Setup guide\n\nInstall it.\n");
  assert.equal(read.rev, made.rev);
  docs.writeDoc(root, "plan.md", "no heading here\n");
  assert.deepEqual(docs.listDocs(root).map((d) => [d.path, d.title]), [["guides/setup.md", "Setup guide"], ["plan.md", "plan"]]);
  // No leftover temp file from the write.
  assert.deepEqual(fs.readdirSync(path.join(root, "docs", "guides")), ["setup.md"]);
});

test("an existing document changes only from the version it was read at", () => {
  const root = project();
  const first = docs.writeDoc(root, "plan.md", "# Plan\n\nv1\n");
  assert.equal(code(() => docs.writeDoc(root, "plan.md", "# Plan\n\nblind\n")), "DocExists");
  const second = docs.writeDoc(root, "plan.md", "# Plan\n\nv2\n", first.rev);
  assert.equal(second.created, false);
  // A person changed it on the page since the agent read v1: refused, with the current rev.
  let refused;
  try {
    docs.writeDoc(root, "plan.md", "# Plan\n\nstale\n", first.rev);
  } catch (error) {
    refused = error;
  }
  assert.equal(refused.code, "DocChanged");
  assert.equal(refused.details.rev, second.rev);
  assert.equal(docs.readDoc(root, "plan.md").markdown, "# Plan\n\nv2\n");
  assert.equal(code(() => docs.writeDoc(root, "other.md", "x", first.rev)), "DocNotFound");
  assert.equal(code(() => docs.readDoc(root, "missing.md")), "DocNotFound");
  assert.equal(code(() => docs.writeDoc(root, "big.md", "x".repeat(docs.MAX_DOC_BYTES + 1))), "DocTooLarge");
});

test("a section edit replaces only what is under that heading, not inside code", () => {
  const md = "# Doc\n\nintro\n\n## Goals\n\nold goals\n\n### Detail\n\nkept? no\n\n## Risks\n\nrisky\n\n```\n## Goals\n```\n";
  const out = docs.replaceSection(md, "goals", "- ship it\n- test it");
  assert.equal(out, "# Doc\n\nintro\n\n## Goals\n\n- ship it\n- test it\n\n## Risks\n\nrisky\n\n```\n## Goals\n```\n");
  assert.equal(code(() => docs.replaceSection(md, "Nope", "x")), "SectionNotFound");
  assert.equal(code(() => docs.replaceSection("## A\n\nx\n\n## A\n\ny\n", "A", "z")), "SectionAmbiguous");
});

test("a find edit changes the one occurrence it names", () => {
  assert.equal(docs.findReplace("a b a", "b", "c"), "a c a");
  assert.equal(code(() => docs.findReplace("a b a", "a", "c")), "TextAmbiguous");
  assert.equal(docs.findReplace("a b a", "a", "c", 2), "a b c");
  assert.equal(code(() => docs.findReplace("a b a", "z", "c")), "TextNotFound");
  assert.equal(code(() => docs.findReplace("a b a", "a", "c", 3)), "TextNotFound");
});
