"use strict";

require("../support/private-temp");

// Watchman Whiteboard: draw_math through the MCP server, the real board server and a fake page (no browser, no AI).
// Every agent gets the same tool. A bad step is refused with KaTeX's message and position before the page sees
// anything; good steps reach the page as MathJax SVG, come back as PNG image elements with step ids, read_board shows
// each step's LaTeX, and edit_items with {id, tex} redraws one step in place.

const test = require("node:test");
const assert = require("node:assert/strict");
const { boardWithPage, textOf, pngFile, startMcp } = require("../support/mcp-harness");

// Far from the other test files' ports (they run at the same time) and below 47830.
const PORT = 40000 + Math.floor(Math.random() * 3000) * 2;

// The elements a page makes for a math Job: one image per step (its LaTeX in customData), a text per note.
// @purity pure
function mathElements(job, fileIds) {
  let y = job.y;
  return job.steps.flatMap((step, index) => {
    const image = {
      id: step.id, type: "image", version: 2, versionNonce: 5, isDeleted: false, x: job.x, y, width: step.width, height: step.height,
      fileId: fileIds[index], status: "saved", updated: Date.now(), customData: { grwbKind: "claudeItem", mathTex: step.tex },
    };
    const out = [image];
    if (step.note) {
      out.push({
        id: `${step.id}-note`, type: "text", text: step.note, version: 2, versionNonce: 5, isDeleted: false,
        x: job.x + step.width + 40, y, width: 80, height: 25, updated: Date.now(), customData: { grwbKind: "claudeItem" },
      });
    }
    y += step.height + 20;
    return out;
  });
}

test("check_math answers with no board, says which engine answered, and keeps errors on two lines", async () => {
  const mcp = startMcp({ GRWB_OPEN_BROWSER: "0", GRWB_CONTROL_PORT: String(PORT + 101), GRWB_BOARD_PORT: String(PORT + 100) });
  try {
    await mcp.init();
    const tool = (await mcp.rpc("tools/list", {})).result.tools.find((t) => t.name === "check_math");
    assert.ok(tool, "check_math is listed");
    assert.doesNotMatch(tool.description, /Claude|Codex|Gemini/);
    assert.match(textOf(await mcp.tool("check_math", { task: "solve", expr: "x^2-5x+6=0" })), /^ok check task=solve engine=compute-engine\nresult=2, 3\nlatex=2, 3$/);
    assert.match(textOf(await mcp.tool("check_math", { task: "steps", exprs: ["2x+3=7", "2x=10"] })), /\nstep 1->2 WRONG solutions \{2\} vs \{5\}\nall=wrong first=2$/);
    assert.match(textOf(await mcp.tool("check_math", { task: "evaluate", expr: "9.81 m/s^2 * 2 kg to N" })), /\nresult=19\.62 N$/);
    const bad = await mcp.tool("check_math", { task: "simplify", expr: "\\frac{1}{" });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /^InvalidMath message="Compute Engine: [^"]+"\nnext: fix /);
    assert.equal(textOf(bad).split("\n").length, 2);
    const wrongPair = await mcp.tool("check_math", { task: "limit", expr: "x", engine: "mathjs" });
    assert.match(textOf(wrongPair), /^InvalidArguments message="mathjs does not do limit; it does [^"]+"\nnext: fix that argument/);
    // Nothing but JSON-RPC on standard output.
    for (const line of mcp.stdoutLines) assert.doesNotThrow(() => JSON.parse(line), line);
  } finally {
    mcp.child.stdin.end();
    await mcp.exited;
  }
});

test("draw_math checks each step, draws PNG steps with ids, read_board shows their LaTeX, edit_items corrects one", async () => {
  const { mcp, page, close } = await boardWithPage("math", PORT);
  try {
    const tools = (await mcp.rpc("tools/list", {})).result.tools;
    const drawMath = tools.find((t) => t.name === "draw_math");
    assert.ok(drawMath, "draw_math is listed");
    assert.doesNotMatch(drawMath.description, /Claude|Codex|Gemini/, "the description names no one agent");
    assert.match(drawMath.description, /\\ce/);
    assert.match(tools.find((t) => t.name === "edit_items").description, /\btex\b/);

    // A bad step: KaTeX's message and position, and no Job reaches the page.
    const bad = await mcp.tool("draw_math", { steps: [{ tex: "x+1=3" }, { tex: "\\frac{1}{" }] });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /^InvalidMath index=1 field=tex position=9 message="KaTeX parse error: [^"]*\(step 2, position 9\)"\nnext: fix /);
    assert.equal(page.jobs("math").length, 0);

    // Good steps: the page gets MathJax SVG per step, with ids PREFIX-sN, notes and the narration.
    const fileIds = ["mathfile0001", "mathfile0002", "mathfile0003"];
    const drawing = mcp.tool("draw_math", {
      steps: [{ tex: "2x+3=7", note: "start" }, { tex: "2x=4" }, { tex: "x=2" }], say: ["Start.", "Take three.", "Halve it."],
    });
    const job = await page.answer("math", (j) => ({ ok: true, elements: mathElements(j, fileIds), files: fileIds.map(pngFile) }));
    assert.deepEqual(job.steps.map((s) => s.id), ["m1-s1", "m1-s2", "m1-s3"]);
    // In the agent's ink, Watchman's clay (scripts/lib/agent-ink.js).
    for (const step of job.steps) {
      assert.match(step.svg, /^<svg color="#d97757"/);
      assert.ok(step.width > 0 && step.height > 0);
    }
    assert.deepEqual(job.steps.map((s) => s.note), ["start", null, null]);
    assert.deepEqual(job.say, ["Start.", "Take three.", "Halve it."]);
    assert.match(textOf(await drawing), /^ok op=\d+ kind=math n=4 box=-?\d+,-?\d+,\d+,\d+ image=true prefix=m1 ids=m1-s1,m1-s2,m1-s3$/);

    // read_board: a step's text is its LaTeX.
    const read = textOf(await mcp.tool("read_board", {}));
    assert.match(read, /\nm1-s2\timage\t2x=4(\n|$)/, read);
    assert.match(read, /\nm1-s1-note\ttext\tstart(\n|$)/, read);

    // edit_items {id, tex}: the step is drawn again from its new LaTeX, and keeps its id and place.
    const editing = mcp.tool("edit_items", { changes: [{ id: "m1-s2", tex: "2x = 7 - 3" }] });
    const edit = await page.answer("edit", (j) => {
      const change = j.changes[0];
      const old = mathElements(job, fileIds).find((e) => e.id === change.id);
      const element = { ...old, fileId: "mathfile0009", version: 3, width: change.width, height: change.height };
      return { ok: true, elements: [element], files: [pngFile("mathfile0009")] };
    });
    assert.equal(edit.changes[0].tex, "2x = 7 - 3");
    assert.match(edit.changes[0].svg, /^<svg color="#d97757"/);
    assert.match(textOf(await editing), /^ok op=\d+ kind=edit ids=1$/);
    assert.match(textOf(await mcp.tool("read_board", {})), /\nm1-s2\timage\t2x = 7 - 3(\n|$)/);

    // A bad correction, and tex on an item that is not a math step, are refused before the page.
    const badEdit = await mcp.tool("edit_items", { changes: [{ id: "m1-s3", tex: "x=\\frac{" }] });
    assert.match(textOf(badEdit), /^InvalidMath index=0 field=tex /);
    const notMath = await mcp.tool("edit_items", { changes: [{ id: "m1-s1-note", tex: "x" }] });
    assert.match(textOf(notMath), /^InvalidChanges index=0 field=tex message="m1-s1-note is not a math step/);
    assert.equal(page.jobs("edit").length, 1);

    // draw_molecule: structural formulas ride on the same page Job; read_board shows the SMILES; the reply the formulas.
    const tool = tools.find((t) => t.name === "draw_molecule");
    assert.ok(tool, "draw_molecule is listed");
    assert.doesNotMatch(tool.description, /Claude|Codex|Gemini/);
    const badMolecule = await mcp.tool("draw_molecule", { molecules: [{ smiles: "CCO" }, { smiles: "C1CC(" }] });
    assert.match(textOf(badMolecule), /^InvalidChemistry index=1 field=smiles message="molecules\[1\]: SmilesParser: [^"]+"\nnext: fix that molecule/);
    const molecules = mcp.tool("draw_molecule", { molecules: [{ smiles: "CCO", name: "ethanol" }, { smiles: "O" }] });
    const moleculeJob = await page.answer("math", (j) => ({ ok: true, elements: mathElements(j, ["molfile00001", "molfile00002"]), files: ["molfile00001", "molfile00002"].map(pngFile) }));
    assert.deepEqual(moleculeJob.steps.map((s) => [s.id, s.smiles, s.note]), [["k1-m1", "CCO", "ethanol, C2H6O, 46.069 g/mol"], ["k1-m2", "O", "H2O, 18.015 g/mol"]]);
    for (const step of moleculeJob.steps) assert.match(step.svg, /^<svg /);
    assert.match(textOf(await molecules), /^ok op=\d+ kind=molecule n=4 .* prefix=k1 ids=k1-m1,k1-m2\nmolecules: k1-m1 "ethanol" C2H6O 46\.069 g\/mol; k1-m2 H2O 18\.015 g\/mol$/);
    assert.match(textOf(await mcp.tool("read_board", { limit: 100 })), /\nk1-m1\timage\tSMILES CCO(\n|$)/);
    const editMolecule = await mcp.tool("edit_items", { changes: [{ id: "k1-m1", tex: "x" }] });
    assert.match(textOf(editMolecule), /^InvalidChanges index=0 field=tex message="k1-m1 is not a math step/);

    // The next drawing takes the next free prefix.
    const second = mcp.tool("draw_math", { steps: [{ tex: "\\ce{2H2 + O2 -> 2H2O}" }] });
    const secondJob = await page.answer("math", (j) => ({ ok: true, elements: mathElements(j, ["mathfile0010"]), files: [pngFile("mathfile0010")] }));
    assert.deepEqual(secondJob.steps.map((s) => s.id), ["m2-s1"]);
    assert.match(textOf(await second), /^ok op=\d+ kind=math n=1 .* prefix=m2 ids=m2-s1$/);
  } finally {
    assert.equal(await close(), 0);
  }
});
