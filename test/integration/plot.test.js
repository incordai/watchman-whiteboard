"use strict";

require("../support/private-temp");

// Watchman Whiteboard: draw_plot and draw_chart through the MCP server, the real board server and a fake page (no
// browser, no AI). Both reach the page as an ordinary draw Job of the board's own elements, with ids PREFIX-...

const test = require("node:test");
const assert = require("node:assert/strict");
const { boardWithPage, textOf, el, pngFile, until } = require("../support/mcp-harness");

const PORT = 46200 + Math.floor(Math.random() * 600) * 2;

// The fake page draws each Skeleton as an element of the same id.
// @purity pure
const drawn = (job) => job.elements.map((s) => el(s.id, { type: s.type, x: job.x + s.x, y: job.y + s.y, ...(s.text ? { text: s.text } : {}) }));

test("draw_plot and draw_chart draw the board's own elements, with ids an agent can edit, and say the summary", async () => {
  const { mcp, page, close } = await boardWithPage("plot", PORT);
  try {
    // The page's labels name the agent the MCP server serves (its client's name at initialize), never a fixed one.
    await mcp.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "codex-mcp-client", version: "1" } });
    await mcp.tool("show_activity", { state: "working" });
    const signal = await until(() => page.received.find((m) => m.type === "signal" && m.data.state === "working"), 5000, "signal");
    assert.deepEqual(signal.data, { state: "working", agent: "Codex" });

    const tools = (await mcp.rpc("tools/list", {})).result.tools;
    for (const name of ["draw_plot", "draw_chart"]) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} is listed`);
      assert.doesNotMatch(tool.description, /Claude|Codex|Gemini/);
    }

    const plotting = mcp.tool("draw_plot", { functions: [{ expr: "sin(x)" }, { expr: "x^2/4", color: "red", label: "parabola" }], x: [-6, 6], title: "Two curves" });
    const plotJob = await page.answer("draw", drawn);
    const ids = plotJob.elements.map((s) => s.id);
    for (const id of ["p1-axis-x", "p1-axis-y", "p1-title", "p1-f1-1", "p1-f1-label", "p1-f2-1", "p1-f2-label"]) assert.ok(ids.includes(id), id);
    assert.equal(plotJob.elements.find((s) => s.id === "p1-f2-label").text, "parabola");
    assert.match(textOf(await plotting), /^ok op=\d+ kind=plot n=\d+ box=[-\d,]+ prefix=p1 x=-6\.\.6 y=-?[\d.]+\.\.[\d.]+$/);

    const badPlot = await mcp.tool("draw_plot", { functions: [{ expr: "sin(x" }] });
    assert.match(textOf(badPlot), /^InvalidPlot message="functions\[0\]: [^"]+"\nnext: fix the field/);
    assert.equal(page.jobs("draw").length, 1, "a bad plot sends no Job");

    const charting = mcp.tool("draw_chart", {
      kind: "bar", categories: ["Mon", "Tue", "Wed"], series: [{ name: "Cups", values: [3, 6, 0] }], explain: "Tuesday was the busiest.",
    });
    const chartJob = await page.answer("draw", drawn);
    assert.ok(chartJob.elements.find((s) => s.id === "c1-s1-b2" && s.type === "rectangle"));
    assert.equal(chartJob.elements.find((s) => s.id === "c1-explain").text, "Tuesday was the busiest.");
    assert.match(textOf(await charting), /^ok op=\d+ kind=chart n=\d+ box=[-\d,]+ prefix=c1\nsummary: Cups: n = 3, mean = 3, median = 3, sd = 3, min = 0 \(Wed\), max = 6 \(Tue\)$/);

    // read_board finds the parts by id, so one can be changed.
    assert.match(textOf(await mcp.tool("read_board", { limit: 200 })), /\nc1-explain\ttext\tTuesday was the busiest\.(\n|$)/);

    // draw_geometry: the construction's elements by name, and its measures in the reply.
    const geometry = tools.find((t) => t.name === "draw_geometry");
    assert.ok(geometry, "draw_geometry is listed");
    assert.doesNotMatch(geometry.description, /Claude|Codex|Gemini/);
    const constructing = mcp.tool("draw_geometry", {
      objects: [
        { type: "point", name: "A", x: 0, y: 0 }, { type: "point", name: "B", x: 4, y: 0 }, { type: "point", name: "C", x: 0, y: 3 },
        { type: "polygon", name: "T", points: ["A", "B", "C"] }, { type: "angle", name: "atA", points: ["B", "A", "C"], label: "degrees" },
      ],
    });
    const geometryJob = await page.answer("draw", drawn);
    for (const id of ["g1-A", "g1-A-label", "g1-T", "g1-atA-mark", "g1-atA-label"]) assert.ok(geometryJob.elements.some((s) => s.id === id), id);
    assert.match(textOf(await constructing), /^ok op=\d+ kind=geometry n=\d+ box=[-\d,]+ prefix=g1\nmeasures: A = \(0, 0\); B = \(4, 0\); C = \(0, 3\); T: area 6, perimeter 12; angle BAC = 90°$/);
    const badGeometry = await mcp.tool("draw_geometry", { objects: [{ type: "segment", from: "P", to: "Q" }] });
    assert.match(textOf(badGeometry), /^InvalidGeometry message="objects\[0\]: P is not defined above"\nnext: fix that object/);

    // draw_chart3d: the page gets a checked Plotly figure of numbers, and answers with one PNG image.
    assert.doesNotMatch(tools.find((t) => t.name === "draw_chart3d").description, /Claude|Codex|Gemini/);
    const surface = mcp.tool("draw_chart3d", { kind: "surface", expr: "sin(x) * cos(y)", x: [-3, 3], y: [-3, 3], title: "Waves" });
    const pictureJob = await page.answer("picture", (j) => ({
      ok: true,
      elements: [el(j.elementId, { type: "image", fileId: "chart3dfile01", x: j.x, y: j.y, width: j.width, height: j.height, status: "saved", customData: { grwbKind: "claudeItem" } })],
      files: [pngFile("chart3dfile01")],
    }));
    assert.equal(pictureJob.elementId, "d1-3d");
    assert.equal(pictureJob.figure.data[0].type, "surface");
    assert.equal(pictureJob.figure.layout.title.text, "Waves");
    assert.deepEqual([pictureJob.width, pictureJob.height], [720, 540]);
    assert.match(textOf(await surface), /^ok op=\d+ kind=chart3d n=1 box=[-\d,]+ image=true prefix=d1 ids=d1-3d\nshows: surface z = sin\(x\) \* cos\(y\), x in \[-3, 3\], y in \[-3, 3\], z from -0\.99\d* to 0\.99\d*$/);
    assert.match(textOf(await mcp.tool("read_board", { limit: 200 })), /\nd1-3d\timage\t3D surface z = sin\(x\) \* cos\(y\)/);
    const badSurface = await mcp.tool("draw_chart3d", { kind: "surface", expr: "sin(x" });
    assert.match(textOf(badSurface), /^InvalidPlot message="expr: [^"]+"\nnext: fix the field/);
    assert.equal(page.jobs("picture").length, 1, "a bad chart sends no Job");
  } finally {
    assert.equal(await close(), 0);
  }
});
