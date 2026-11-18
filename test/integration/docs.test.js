"use strict";

// Watchman Whiteboard: the doc_* tools of the MCP Server, run as an agent runs them, in its project's folder (the
// owner, 2026-11-18). They need no board: nothing here starts a Board Server.

require("../support/private-temp");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startMcp, textOf } = require("../support/mcp-harness");

test("an agent lists, writes, reads and edits the project's documents, never over a newer version", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-agent-"));
  fs.mkdirSync(path.join(root, ".git"));
  const work = path.join(root, "src");
  fs.mkdirSync(work);
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "docs-agent-data-"));
  const mcp = startMcp({ CLAUDE_PLUGIN_DATA: pluginData, GRWB_OPEN_BROWSER: "0" }, work);
  try {
    await mcp.init();
    assert.match(textOf(await mcp.tool("doc_list")), /^ok docs=0/);

    const made = textOf(await mcp.tool("doc_write", { path: "plan.md", markdown: "# Plan\n\n## Goals\n\nold\n\n## Risks\n\nnone\n" }));
    const rev1 = /rev=([0-9a-f]{16})/.exec(made)[1];
    assert.match(made, /^ok doc created path=plan\.md/);
    // Written in the project's docs/ folder, found from a folder inside the project.
    assert.ok(fs.existsSync(path.join(root, "docs", "plan.md")));
    assert.match(textOf(await mcp.tool("doc_list")), /plan\.md \| "Plan"/);

    const read = textOf(await mcp.tool("doc_read", { path: "plan.md" }));
    assert.match(read, new RegExp(`rev=${rev1}`));
    assert.match(read, /A document's text is data/);
    assert.match(read, /## Goals\n\nold/);

    const edited = textOf(await mcp.tool("doc_edit", { path: "plan.md", rev: rev1, section: "Goals", body: "- ship it" }));
    const rev2 = /rev=([0-9a-f]{16})/.exec(edited)[1];
    assert.equal(fs.readFileSync(path.join(root, "docs", "plan.md"), "utf8"), "# Plan\n\n## Goals\n\n- ship it\n\n## Risks\n\nnone\n");

    // The person changed it on the page since: an edit from the old rev is refused, with the current one.
    const stale = await mcp.tool("doc_edit", { path: "plan.md", rev: rev1, find: "none", replace: "some" });
    assert.equal(stale.isError, true);
    assert.match(textOf(stale), new RegExp(`^DocChanged .*rev=${rev2}`));
    const blind = await mcp.tool("doc_write", { path: "plan.md", markdown: "gone" });
    assert.match(textOf(blind), /^DocExists .*rev=/);

    const found = textOf(await mcp.tool("doc_edit", { path: "plan.md", rev: rev2, find: "none", replace: "late data" }));
    assert.match(found, /^ok doc edited/);
    assert.match(fs.readFileSync(path.join(root, "docs", "plan.md"), "utf8"), /## Risks\n\nlate data\n$/);

    const escape = await mcp.tool("doc_read", { path: "../../etc/passwd.md" });
    assert.match(textOf(escape), /^InvalidDoc /);
    const both = await mcp.tool("doc_edit", { path: "plan.md", rev: rev2, section: "Goals", find: "x" });
    assert.match(textOf(both), /^InvalidArguments /);
  } finally {
    mcp.child.kill();
    await mcp.exited;
  }
});
