"use strict";

require("../support/private-temp");

// Watchman Whiteboard (the owner, 2026-11-17): when the person says a step or a part is wrong, the agent can erase it
// or change it in place, for every kind of drawing. Through the MCP server, the real board server and a fake page that
// draws as the real one does (a box's words are its own bound text): for each draw tool, one part is changed with
// edit_items, one part is erased with delete_items, and the whole drawing is drawn again from corrected data with
// replace=PREFIX, in the same place with the same ids. A redraw that fails leaves the old drawing as it was.

const test = require("node:test");
const assert = require("node:assert/strict");
const { boardWithPage, textOf, pngFile } = require("../support/mcp-harness");

const PORT = 48700 + Math.floor(Math.random() * 300) * 2;

// Each draw tool: its first data, its corrected data, a part to change (its id after the prefix, and whether it is a
// box whose words are a bound text), and a part to erase.
const TOOLS = [
  { tool: "draw_plot", args: { functions: [{ expr: "x^2" }], x: [-2, 2] }, fixed: { functions: [{ expr: "x^3" }], x: [-2, 2] }, part: "-f1-label", erase: "-f1-1" },
  {
    tool: "draw_chart",
    args: { kind: "bar", categories: ["A", "B"], series: [{ name: "S", values: [1, 2] }], explain: "B is bigger." },
    fixed: { kind: "bar", categories: ["A", "B"], series: [{ name: "S", values: [1, 3] }], explain: "B is three times A." },
    part: "-explain", erase: "-s1-v1",
  },
  {
    tool: "draw_geometry",
    args: { objects: [{ type: "point", name: "A", x: 0, y: 0 }, { type: "point", name: "B", x: 4, y: 0 }, { type: "segment", name: "AB", from: "A", to: "B", label: "length" }] },
    fixed: { objects: [{ type: "point", name: "A", x: 0, y: 0 }, { type: "point", name: "B", x: 5, y: 0 }, { type: "segment", name: "AB", from: "A", to: "B", label: "length" }] },
    part: "-A-label", erase: "-AB",
  },
  {
    tool: "draw_timeline",
    args: { events: [{ when: 1947, label: "Independence" }, { when: 1951, label: "Republic" }] },
    fixed: { events: [{ when: 1947, label: "Independence" }, { when: 1950, label: "Republic" }] },
    part: "-e1-label", erase: "-e2-dot",
  },
  {
    tool: "draw_cycle",
    args: { steps: [{ label: "Evaporation" }, { label: "Rain" }, { label: "Collection" }] },
    fixed: { steps: [{ label: "Evaporation" }, { label: "Condensation" }, { label: "Rain" }, { label: "Collection" }] },
    part: "-s2", box: true, erase: "-a3",
  },
  {
    tool: "draw_parts",
    args: { subject: "Plant cell", parts: [{ label: "Nucleus" }, { label: "Cell wal" }] },
    fixed: { subject: "Plant cell", parts: [{ label: "Nucleus" }, { label: "Cell wall" }] },
    part: "-p2", box: true, erase: "-p2-leader",
  },
  {
    tool: "draw_circuit",
    args: { source: { type: "battery", value: "9 V" }, branches: [[{ type: "resistor", label: "R1", value: "100 Ω" }], [{ type: "bulb", label: "L1" }]] },
    fixed: { source: { type: "battery", value: "9 V" }, branches: [[{ type: "resistor", label: "R1", value: "220 Ω" }], [{ type: "bulb", label: "L1" }]] },
    part: "-b1-c1-label", erase: "-b2-c1",
  },
  {
    tool: "draw_map",
    args: { highlight: [{ country: "India", label: "India" }], markers: [{ lon: 72.9, lat: 19.1, label: "New Delhi" }] },
    fixed: { highlight: [{ country: "India", label: "India" }], markers: [{ lon: 77.2, lat: 28.6, label: "New Delhi" }] },
    part: "-m1-label", erase: "-m1",
  },
  {
    tool: "draw_music",
    args: { notes: [{ pitch: "C4", duration: 4, lyric: "Twin" }, { pitch: "D4", duration: 4, lyric: "kle" }] },
    fixed: { notes: [{ pitch: "C4", duration: 4, lyric: "Twin" }, { pitch: "C4", duration: 4, lyric: "kle" }] },
    part: "-n1-lyric", erase: "-n2",
  },
  { tool: "draw_table", args: { rows: [["verb", "I"], ["être", "es"]] }, fixed: { rows: [["verb", "I"], ["être", "suis"]] }, part: "-r2c2", box: true, erase: "-r2c1" },
];

// Each draw tool's default prefix letter: all different (molecules keep k, 3D charts d, math m, music u).
const FIRST_LETTER = Object.freeze({
  draw_plot: "p", draw_chart: "c", draw_geometry: "g", draw_timeline: "h", draw_cycle: "y", draw_parts: "l",
  draw_circuit: "e", draw_map: "w", draw_music: "u", draw_table: "t",
});
test("every draw tool's default prefix letter is its own", () => {
  const letters = [...Object.values(FIRST_LETTER), "m", "k", "d"];
  assert.equal(new Set(letters).size, letters.length);
});

// The fake page: draws each Skeleton as the real page does, a box's words as a text bound to it, every element above
// any deleted one of the same id; changes a text or a box's words for an edit Job.
function fakePage(page) {
  const drawn = new Map();
  const deletedVersion = (id) => {
    let version = 0;
    for (const m of page.received) {
      if (m.type !== "elements") continue;
      for (const e of m.data.elements) if (e.id === id) version = Math.max(version, e.version);
    }
    return version;
  };
  const element = (props) => {
    const made = {
      versionNonce: 7, isDeleted: false, width: 100, height: 40, updated: Date.now(), strokeColor: "#1971c2",
      backgroundColor: "transparent", customData: { grwbKind: "claudeItem" }, ...props, version: Math.max(deletedVersion(props.id), drawn.get(props.id)?.version || 0) + 1,
    };
    drawn.set(made.id, made);
    return made;
  };
  return {
    draw: (job) => job.elements.flatMap((s) => {
      const shape = element({ id: s.id, type: s.type, x: job.x + s.x, y: job.y + s.y, ...(s.points ? { points: s.points } : {}), ...(s.text !== undefined ? { text: s.text } : {}) });
      if (!s.label) return [shape];
      const words = element({ id: `${s.id}-words`, type: "text", text: s.label.text, containerId: s.id, x: shape.x, y: shape.y });
      shape.boundElements = [{ id: words.id, type: "text" }];
      return [shape, words];
    }),
    edit: (job) => job.changes.map((change) => {
      const target = drawn.get(change.id).type === "text" ? drawn.get(change.id) : drawn.get(`${change.id}-words`);
      return element({ ...target, text: change.text });
    }),
    // The board point where a drawing starts: its elements' top left, lines by their points.
    topLeft: (job) => {
      const xs = [];
      const ys = [];
      for (const s of job.elements) {
        for (const [px, py] of s.points || [[0, 0]]) {
          xs.push(job.x + s.x + px);
          ys.push(job.y + s.y + py);
        }
      }
      return [Math.min(...xs), Math.min(...ys)];
    },
  };
}

// The rows of read_board: id -> text.
async function boardTexts(mcp) {
  const rows = textOf(await mcp.tool("read_board", { limit: 200, fields: ["id", "text"] })).split("\n").slice(2);
  return new Map(rows.map((row) => row.split("\t")).map(([id, text]) => [id, text]));
}

test("every draw tool's drawing can be changed in place, have one part erased, and be drawn again corrected in its place", async () => {
  const { mcp, page, close } = await boardWithPage("correct", PORT);
  const fake = fakePage(page);
  try {
    const tools = (await mcp.rpc("tools/list", {})).result.tools;
    for (const spec of TOOLS) {
      const description = tools.find((t) => t.name === spec.tool).description;
      assert.match(description, /replace=PREFIX/, `${spec.tool} says how to redraw it corrected`);
      assert.match(description, /edit_items/, `${spec.tool} says how to change one part`);
      assert.match(description, /delete_items/, `${spec.tool} says how to erase one part`);
      assert.ok(tools.find((t) => t.name === spec.tool).inputSchema.properties.replace, `${spec.tool} takes replace`);

      // Drawn.
      const drawing = mcp.tool(spec.tool, spec.args);
      const first = await page.answer("draw", fake.draw);
      const reply = textOf(await drawing);
      const prefix = /prefix=([A-Za-z0-9_]+)/.exec(reply)[1];
      // Each tool has a letter of its own, so on one board every first drawing is <letter>1 and a prefix names one tool.
      assert.equal(prefix, `${FIRST_LETTER[spec.tool]}1`, `${spec.tool} default prefix`);
      const where = fake.topLeft(first);

      // One part changed in place: a text, or a box's words.
      const partId = `${prefix}${spec.part}`;
      const editing = mcp.tool("edit_items", { changes: [{ id: partId, text: "corrected" }] });
      await page.answer("edit", fake.edit);
      assert.match(textOf(await editing), /^ok op=\d+ kind=edit ids=[1-9]/, `${spec.tool} edit`);
      assert.equal((await boardTexts(mcp)).get(spec.box ? `${partId}-words` : partId), "corrected", `${spec.tool} part changed`);

      // One part erased.
      const eraseId = `${prefix}${spec.erase}`;
      assert.match(textOf(await mcp.tool("delete_items", { ids: [eraseId] })), /^ok op=\d+ kind=delete count=1$/, `${spec.tool} erase`);
      assert.equal((await boardTexts(mcp)).has(eraseId), false, `${spec.tool} part erased`);

      // The whole drawing again, from corrected data, in its place, with its prefix.
      const redrawing = mcp.tool(spec.tool, { ...spec.fixed, replace: prefix });
      const second = await page.answer("draw", fake.draw);
      const redrawn = textOf(await redrawing);
      assert.match(redrawn, new RegExp(`^ok op=\\d+ kind=\\w+ n=\\d+ .*prefix=${prefix}\\b`), `${spec.tool} replace: ${redrawn}`);
      for (const s of second.elements) assert.ok(s.id.startsWith(`${prefix}-`), `${spec.tool}: ${s.id} keeps the prefix`);
      const [x, y] = fake.topLeft(second);
      assert.ok(Math.abs(x - where[0]) <= 1 && Math.abs(y - where[1]) <= 1, `${spec.tool} redrawn in place: ${[x, y]} vs ${where}`);
      const live = [...(await boardTexts(mcp)).keys()].filter((id) => id.startsWith(`${prefix}-`));
      const fresh = new Set(second.elements.flatMap((s) => (s.label ? [s.id, `${s.id}-words`] : [s.id])));
      assert.deepEqual(live.filter((id) => !fresh.has(id)), [], `${spec.tool}: nothing of the old drawing is left`);
    }
  } finally {
    assert.equal(await close(), 0);
  }
});

test("math steps, molecules and 3D charts are corrected in place too; a failed redraw keeps the old drawing", async () => {
  const { mcp, page, close } = await boardWithPage("correct2", PORT + 400);
  const picture = (j, ids) => {
    let y = j.y;
    return j.steps.map((step, i) => {
      const e = {
        id: step.id, type: "image", version: 9 + i, versionNonce: 5, isDeleted: false, x: j.x, y, width: step.width, height: step.height,
        fileId: ids[i], status: "saved", updated: Date.now(), customData: { grwbKind: "claudeItem" },
      };
      y += step.height + 18;
      return e;
    });
  };
  try {
    // Math: replace keeps the place and the step ids.
    const steps = mcp.tool("draw_math", { steps: [{ tex: "2x = 6" }, { tex: "x = 4" }] });
    const job = await page.answer("math", (j) => ({ ok: true, elements: picture(j, ["fixfile00001", "fixfile00002"]), files: ["fixfile00001", "fixfile00002"].map(pngFile) }));
    assert.match(textOf(await steps), /prefix=m1/);
    const again = mcp.tool("draw_math", { steps: [{ tex: "2x = 6" }, { tex: "x = 3" }], replace: "m1" });
    const fixed = await page.answer("math", (j) => ({
      ok: true, elements: picture(j, ["fixfile00003", "fixfile00004"]).map((e) => ({ ...e, version: e.version + 10 })), files: ["fixfile00003", "fixfile00004"].map(pngFile),
    }));
    assert.deepEqual(fixed.steps.map((s) => s.id), ["m1-s1", "m1-s2"]);
    assert.deepEqual([fixed.x, fixed.y], [job.x, job.y], "redrawn where it was");
    assert.match(textOf(await again), /prefix=m1 ids=m1-s1,m1-s2$/);
    assert.equal((await boardTexts(mcp)).get("m1-s2"), "x = 3");

    // A redraw the board refuses (bad LaTeX) leaves the old steps as they were.
    const bad = await mcp.tool("draw_math", { steps: [{ tex: "x = \\frac{" }], replace: "m1" });
    assert.match(textOf(bad), /^InvalidMath /);
    const texts = await boardTexts(mcp);
    assert.equal(texts.get("m1-s1"), "2x = 6");
    assert.equal(texts.get("m1-s2"), "x = 3");

    // Molecules: edit_items {id, smiles} redraws one in place.
    const molecules = mcp.tool("draw_molecule", { molecules: [{ smiles: "CCO", name: "ethanol" }] });
    await page.answer("math", (j) => ({ ok: true, elements: picture(j, ["fixfile00005"]), files: [pngFile("fixfile00005")] }));
    assert.match(textOf(await molecules), /ids=k1-m1/);
    const swapping = mcp.tool("edit_items", { changes: [{ id: "k1-m1", smiles: "CCCO" }] });
    const edit = await page.answer("edit", (j) => ({
      ok: true,
      elements: [{ ...picture({ x: 0, y: 0, steps: [{ id: "k1-m1", width: j.changes[0].width, height: j.changes[0].height }] }, ["fixfile00006"])[0], version: 30 }],
      files: [pngFile("fixfile00006")],
    }));
    assert.equal(edit.changes[0].smiles, "CCCO");
    assert.match(edit.changes[0].svg, /^<svg /);
    assert.match(textOf(await swapping), /^ok op=\d+ kind=edit ids=1$/);
    assert.equal((await boardTexts(mcp)).get("k1-m1"), "SMILES CCCO");
    assert.match(textOf(await mcp.tool("edit_items", { changes: [{ id: "k1-m1", smiles: "C1CC(" }] })), /^InvalidChemistry /);

    // A 3D chart: replace draws it again with the same id.
    const surface = mcp.tool("draw_chart3d", { kind: "surface", expr: "x*y" });
    const first = await page.answer("picture", (j) => ({ ok: true, elements: [{ id: j.elementId, type: "image", version: 1, versionNonce: 3, isDeleted: false, x: j.x, y: j.y, width: j.width, height: j.height, fileId: "fixfile00007", status: "saved", updated: Date.now(), customData: { grwbKind: "claudeItem" } }], files: [pngFile("fixfile00007")] }));
    assert.match(textOf(await surface), /ids=d1-3d/);
    const surface2 = mcp.tool("draw_chart3d", { kind: "surface", expr: "x^2 - y^2", replace: "d1" });
    const second = await page.answer("picture", (j) => ({ ok: true, elements: [{ id: j.elementId, type: "image", version: 5, versionNonce: 3, isDeleted: false, x: j.x, y: j.y, width: j.width, height: j.height, fileId: "fixfile00008", status: "saved", updated: Date.now(), customData: { grwbKind: "claudeItem" } }], files: [pngFile("fixfile00008")] }));
    assert.equal(second.elementId, "d1-3d");
    assert.deepEqual([second.x, second.y], [first.x, first.y]);
    assert.match(textOf(await surface2), /ids=d1-3d/);
    assert.match((await boardTexts(mcp)).get("d1-3d"), /x\^2 - y\^2/);

    // A prefix with nothing of the agent's on the board is refused.
    assert.match(textOf(await mcp.tool("draw_plot", { functions: [{ expr: "x" }], replace: "zz9" })), /^UnknownItem /);
  } finally {
    assert.equal(await close(), 0);
  }
});
