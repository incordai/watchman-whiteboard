"use strict";

// Watchman Whiteboard: BoardPlot (lib/board-plot.js). Function plots and data charts become the board's own elements
// (lines, shapes, texts), each with an id an agent can change or erase, and every one passes the board's draw check.

const test = require("node:test");
const assert = require("node:assert/strict");
const { AppError } = require("../../skills/debug-board-server/scripts/lib/app-error");
const { checkDraw } = require("../../skills/debug-board-server/scripts/lib/board-ops");
const { loadMathLib } = require("../../skills/debug-board-server/scripts/lib/math-libs");
const { buildFunctionPlot, buildChart, niceTicks, PLOT_BOX } = require("../../skills/debug-board-server/scripts/lib/board-plot");

let math = null;
test.before(async () => {
  math = await loadMathLib("mathjs");
});

// Every skeleton passes the board's own check, and every id is unique and starts with the prefix.
// @purity pure
function assertDrawable(skeletons, prefix) {
  assert.ok(skeletons.length > 0 && skeletons.length <= 500, `${skeletons.length} elements`);
  checkDraw({ elements: skeletons }, new Map(), 2000);
  const ids = skeletons.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const id of ids) assert.ok(id.startsWith(`${prefix}-`), id);
}

// The board points of every curve element whose id starts with `start`.
// @purity pure
function curvePoints(skeletons, start) {
  return skeletons.filter((s) => s.type === "line" && s.id.startsWith(start)).flatMap((s) => s.points.map(([px, py]) => [s.x + px, s.y + py]));
}

const refused = (code, pattern) => (error) => {
  assert.ok(error instanceof AppError, String(error));
  assert.equal(error.code, code);
  if (pattern) assert.match(error.message, pattern);
  return true;
};

test("niceTicks gives round steps that cover the range", () => {
  assert.deepEqual(niceTicks(-10, 10), { step: 2, ticks: [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10] });
  assert.deepEqual(niceTicks(0, 1).step, 0.1);
  assert.deepEqual(niceTicks(0, 37).ticks.slice(0, 3), [0, 5, 10]);
});

test("a function plot: axes through 0 with ticks, the curve inside the box, its label, and the title", () => {
  const { skeletons, info } = buildFunctionPlot({ functions: [{ expr: "x^2", label: "y = x^2" }], x: [-3, 3], title: "A parabola" }, math, "p1");
  assertDrawable(skeletons, "p1");
  assert.ok(skeletons.find((s) => s.id === "p1-axis-x" && s.type === "arrow"));
  assert.ok(skeletons.find((s) => s.id === "p1-axis-y" && s.type === "arrow"));
  assert.ok(skeletons.find((s) => s.id === "p1-title" && s.text === "A parabola"));
  assert.ok(skeletons.find((s) => s.id === "p1-f1-label" && s.text === "y = x^2"));
  assert.ok(skeletons.some((s) => s.type === "text" && s.id.startsWith("p1-tx") && s.text === "2"), "x tick labels");
  const points = curvePoints(skeletons, "p1-f1-");
  assert.ok(points.length >= 20, `${points.length} points`);
  for (const [px, py] of points) {
    assert.ok(px >= PLOT_BOX.left - 1 && px <= PLOT_BOX.left + PLOT_BOX.width + 1, `x ${px}`);
    assert.ok(py >= PLOT_BOX.top - 1 && py <= PLOT_BOX.top + PLOT_BOX.height + 1, `y ${py}`);
  }
  assert.deepEqual(info.x, [-3, 3]);
  assert.ok(info.y[0] <= 0 && info.y[1] >= 9, `y range ${info.y}`);
});

test("a curve breaks at an asymptote instead of drawing a wall across the plot", () => {
  const { skeletons } = buildFunctionPlot({ functions: [{ expr: "tan(x)" }], x: [-4, 4], y: [-5, 5] }, math, "p2");
  assertDrawable(skeletons, "p2");
  const pieces = skeletons.filter((s) => s.type === "line" && s.id.startsWith("p2-f1-") && s.id !== "p2-f1-label");
  assert.ok(pieces.length >= 3, `${pieces.length} pieces`);
  for (const piece of pieces) {
    for (let i = 1; i < piece.points.length; i += 1) {
      assert.ok(Math.abs(piece.points[i][1] - piece.points[i - 1][1]) < PLOT_BOX.height * 0.6, "no jump across the asymptote");
    }
  }
});

test("parametric and polar curves, equal axes, and marked points", () => {
  const circle = buildFunctionPlot({ functions: [{ x: "cos(t)", y: "sin(t)", t: [0, 6.2832] }], equalAxes: true, points: [{ x: 1, y: 0, label: "A" }] }, math, "p3");
  assertDrawable(circle.skeletons, "p3");
  const xs = curvePoints(circle.skeletons, "p3-f1-").map((p) => p[0]);
  const ys = curvePoints(circle.skeletons, "p3-f1-").map((p) => p[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  assert.ok(Math.abs(width - height) < 3, `a circle looks round: ${width} x ${height}`);
  assert.ok(circle.skeletons.find((s) => s.id === "p3-pt1" && s.type === "ellipse"));
  assert.ok(circle.skeletons.find((s) => s.id === "p3-pt1-label" && s.text === "A"));
  const polar = buildFunctionPlot({ functions: [{ r: "1 + cos(t)" }] }, math, "p4");
  assertDrawable(polar.skeletons, "p4");
  assert.ok(curvePoints(polar.skeletons, "p4-f1-").length > 20);
});

test("a bad expression is refused with mathjs's own words, naming the function", () => {
  assert.throws(() => buildFunctionPlot({ functions: [{ expr: "x^2" }, { expr: "sin(x" }] }, math, "p5"), refused("InvalidPlot", /^functions\[1\]: /));
  assert.throws(() => buildFunctionPlot({ functions: [{ expr: "x" }], x: [2, 1] }, math, "p5"), refused("InvalidPlot", /x must be \[min, max\]/));
  assert.throws(() => buildFunctionPlot({ functions: [{ expr: "y" }] }, math, "p5"), refused("InvalidPlot", /no value/));
});

test("a bar chart: one bar per category and series, heights to scale, a legend, and the summary below", () => {
  const { skeletons, summary } = buildChart({
    kind: "bar", categories: ["Mon", "Tue", "Wed"], series: [{ name: "Cups", values: [3, 6, 0] }], title: "Coffee", explain: "Tuesday was the busiest.",
  }, math, "c1");
  assertDrawable(skeletons, "c1");
  const bars = skeletons.filter((s) => s.type === "rectangle" && /^c1-s1-b\d+$/.test(s.id));
  assert.equal(bars.length, 3);
  assert.ok(Math.abs(bars[1].height - 2 * bars[0].height) < 1, `${bars[0].height} vs ${bars[1].height}`);
  assert.ok(skeletons.find((s) => s.id === "c1-cat1" && s.text === "Mon"));
  assert.ok(skeletons.find((s) => s.id === "c1-explain" && s.text === "Tuesday was the busiest."));
  assert.match(skeletons.find((s) => s.id === "c1-summary").text, /^Cups: n = 3, mean = 3, median = 3, sd = 3, min = 0 \(Wed\), max = 6 \(Tue\)$/);
  assert.equal(summary, skeletons.find((s) => s.id === "c1-summary").text);
});

test("a chart of values that are all positive starts its axis at 0, not one step below (seen in Chrome)", () => {
  const { skeletons } = buildChart({ kind: "bar", categories: ["Mon", "Tue", "Wed"], series: [{ name: "Cups", values: [3, 6, 2] }] }, math, "c9");
  const labels = skeletons.filter((s) => /^c9-ty\d+$/.test(s.id)).map((s) => s.text);
  assert.equal(labels[0], "0", labels.join(" "));
  assert.ok(!labels.includes("-1"), labels.join(" "));
});

test("a histogram, a box plot and a scatter plot with its fitted line", () => {
  const data = [2, 4, 4, 4, 5, 5, 7, 9];
  const histogram = buildChart({ kind: "histogram", data, bins: 4 }, math, "c2");
  assertDrawable(histogram.skeletons, "c2");
  assert.equal(histogram.skeletons.filter((s) => s.type === "rectangle" && /^c2-s1-b\d+$/.test(s.id)).length, 4);
  assert.match(histogram.summary, /n = 8, mean = 5, median = 4\.5, sd = 2\.138/);

  const box = buildChart({ kind: "box", groups: [{ name: "A", data }, { name: "B", data: [1, 2, 3, 4, 100] }] }, math, "c3");
  assertDrawable(box.skeletons, "c3");
  assert.ok(box.skeletons.find((s) => s.id === "c3-g1-box" && s.type === "rectangle"));
  assert.ok(box.skeletons.find((s) => s.id === "c3-g1-median" && s.type === "line"));
  assert.ok(box.skeletons.find((s) => s.id === "c3-g2-out1" && s.type === "ellipse"), "100 is an outlier");

  const scatter = buildChart({ kind: "scatter", x: [1, 2, 3, 4], y: [2, 4.1, 5.9, 8.1], fit: true, xLabel: "hours", yLabel: "score" }, math, "c4");
  assertDrawable(scatter.skeletons, "c4");
  assert.equal(scatter.skeletons.filter((s) => s.type === "ellipse" && /^c4-s1-p\d+$/.test(s.id)).length, 4);
  assert.ok(scatter.skeletons.find((s) => s.id === "c4-fit" && s.type === "line"));
  assert.match(scatter.summary, /fit: y = 2\.01x [+-] 0(\.\d+)?, r = 0\.999\d*/);
  assert.ok(scatter.skeletons.find((s) => s.id === "c4-xlabel" && s.text === "hours"));
});

test("a line chart of several series, and bad charts refused", () => {
  const line = buildChart({ kind: "line", categories: ["Q1", "Q2", "Q3", "Q4"], series: [{ name: "A", values: [1, 3, 2, 4] }, { name: "B", values: [2, 2, 3, 1] }] }, math, "c5");
  assertDrawable(line.skeletons, "c5");
  assert.ok(line.skeletons.find((s) => s.id === "c5-s2-line" && s.type === "line"));
  assert.ok(line.skeletons.find((s) => s.id === "c5-legend2" && s.text === "B"));
  assert.throws(() => buildChart({ kind: "bar", categories: ["a"], series: [{ name: "x", values: [1, 2] }] }, math, "c6"), refused("InvalidPlot", /values/));
  assert.throws(() => buildChart({ kind: "pie" }, math, "c6"), refused("InvalidPlot", /kind/));
});
