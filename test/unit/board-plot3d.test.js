"use strict";

// Watchman Whiteboard: BoardPlot3d (lib/board-plot3d.js). A 3D chart's numbers are worked out in Node (mathjs), and
// the page only draws the finished figure with Plotly: a surface z = f(x, y), a curve (x, y, z)(t), or points.

const test = require("node:test");
const assert = require("node:assert/strict");
const { AppError } = require("../../skills/debug-board-server/scripts/lib/app-error");
const { loadMathLib } = require("../../skills/debug-board-server/scripts/lib/math-libs");
const { buildChart3d, checkFigure, GRID } = require("../../skills/debug-board-server/scripts/lib/board-plot3d");

let math = null;
test.before(async () => {
  math = await loadMathLib("mathjs");
});

const refused = (pattern) => (error) => {
  assert.ok(error instanceof AppError, String(error));
  assert.equal(error.code, "InvalidPlot");
  assert.match(error.message, pattern);
  return true;
};

test("a surface z = f(x, y) on a grid, with axis titles and a title", () => {
  const { figure, summary } = buildChart3d({ kind: "surface", expr: "x^2 - y^2", x: [-2, 2], y: [-2, 2], title: "Saddle" }, math);
  const [trace] = figure.data;
  assert.equal(trace.type, "surface");
  assert.equal(trace.x.length, GRID);
  assert.equal(trace.z.length, GRID);
  assert.equal(trace.z[0].length, GRID);
  // Plotly's surface: z[i][j] is at y[i], x[j]. GRID is odd, so the middle index is 0.
  const mid = (GRID - 1) / 2;
  assert.equal(trace.z[0][0], 0, "z(x=-2, y=-2) = 0");
  assert.equal(trace.z[mid][0], 4, "z(x=-2, y=0) = 4");
  assert.equal(trace.z[0][mid], -4, "z(x=0, y=-2) = -4");
  assert.equal(figure.layout.title.text, "Saddle");
  assert.equal(figure.layout.scene.xaxis.title.text, "x");
  assert.match(summary, /^surface z = x\^2 - y\^2, x in \[-2, 2\], y in \[-2, 2\], z from -4 to 4$/);
  assert.doesNotThrow(() => checkFigure(figure));
});

test("a curve in space and a cloud of points", () => {
  const helix = buildChart3d({ kind: "curve", x: "cos(t)", y: "sin(t)", z: "t/5", t: [0, 12.57] }, math);
  assert.equal(helix.figure.data[0].type, "scatter3d");
  assert.equal(helix.figure.data[0].mode, "lines");
  assert.ok(helix.figure.data[0].x.length >= 100);
  const cloud = buildChart3d({ kind: "points", points: { x: [1, 2, 3], y: [3, 1, 2], z: [2, 3, 1] }, labels: ["a", "b", "c"] }, math);
  assert.equal(cloud.figure.data[0].mode, "markers+text");
  assert.deepEqual(cloud.figure.data[0].text, ["a", "b", "c"]);
});

test("bad input is refused before anything is drawn, and a figure carries numbers and plain texts only", () => {
  assert.throws(() => buildChart3d({ kind: "surface", expr: "x^2 +" }, math), refused(/^expr: /));
  assert.throws(() => buildChart3d({ kind: "surface", expr: "x", x: [1, 0] }, math), refused(/x must be \[min, max\]/));
  assert.throws(() => buildChart3d({ kind: "points", points: { x: [1], y: [1, 2], z: [1] } }, math), refused(/same length/));
  assert.throws(() => buildChart3d({ kind: "cube" }, math), refused(/kind must be/));
  assert.throws(() => checkFigure({ data: [{ type: "surface", z: [[1]] }], layout: { images: [{ source: "https://x" }] } }), refused(/layout/));
  assert.throws(() => checkFigure({ data: [{ type: "image", z: [[1]] }], layout: {} }), refused(/type/));
});
