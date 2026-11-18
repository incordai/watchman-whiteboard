"use strict";

// Watchman Whiteboard: BoardGeometry (lib/board-geometry.js). A construction (points, lines, circles, and what is built
// from them) becomes the board's own elements at one scale for both axes, so angles and circles stay true; the reply
// gives the measures (lengths, angles, coordinates) an agent can say.

const test = require("node:test");
const assert = require("node:assert/strict");
const { AppError } = require("../../skills/debug-board-server/scripts/lib/app-error");
const { checkDraw } = require("../../skills/debug-board-server/scripts/lib/board-ops");
const { buildGeometry } = require("../../skills/debug-board-server/scripts/lib/board-geometry");

// @purity pure
function assertDrawable(skeletons, prefix) {
  assert.ok(skeletons.length > 0 && skeletons.length <= 500);
  checkDraw({ elements: skeletons }, new Map(), 2000);
  const ids = skeletons.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const id of ids) assert.ok(id.startsWith(`${prefix}-`), id);
}

// The board point of a point's dot (its center).
// @purity pure
function centerOf(skeletons, id) {
  const dot = skeletons.find((s) => s.id === id);
  assert.ok(dot, id);
  return [dot.x + dot.width / 2, dot.y + dot.height / 2];
}

const refused = (pattern) => (error) => {
  assert.ok(error instanceof AppError, String(error));
  assert.equal(error.code, "InvalidGeometry");
  assert.match(error.message, pattern);
  return true;
};

const TRIANGLE = [
  { type: "point", name: "A", x: 0, y: 0 },
  { type: "point", name: "B", x: 4, y: 0 },
  { type: "point", name: "C", x: 0, y: 3 },
  { type: "polygon", name: "T", points: ["A", "B", "C"] },
  { type: "segment", name: "BC", from: "B", to: "C", label: "length" },
  { type: "angle", name: "atA", points: ["B", "A", "C"], label: "degrees" },
  { type: "circumcircle", name: "k", of: ["A", "B", "C"], center: "O" },
];

test("a right triangle with its circumcircle: true shape, a right-angle mark, and the measures", () => {
  const { skeletons, measures } = buildGeometry({ objects: TRIANGLE }, "g1");
  assertDrawable(skeletons, "g1");
  const [ax, ay] = centerOf(skeletons, "g1-A");
  const [bx] = centerOf(skeletons, "g1-B");
  const [, cy] = centerOf(skeletons, "g1-C");
  assert.ok(Math.abs((bx - ax) / (ay - cy) - 4 / 3) < 0.01, "one scale for both axes");
  assert.ok(ay > cy, "y goes up on the board as in mathematics");
  const circle = skeletons.find((s) => s.id === "g1-k");
  assert.equal(circle.type, "ellipse");
  assert.ok(Math.abs(circle.width - circle.height) < 0.2, "the circle is round");
  assert.ok(Math.abs(circle.width - (bx - ax) * 5 / 4) < 1, "diameter 5");
  assert.ok(skeletons.find((s) => s.id === "g1-atA-mark" && s.type === "line"), "a right angle gets a square mark");
  assert.ok(skeletons.find((s) => s.id === "g1-atA-label" && s.text === "90°"));
  assert.ok(skeletons.find((s) => s.id === "g1-BC-label" && s.text === "5"));
  assert.ok(skeletons.find((s) => s.id === "g1-A-label" && s.text === "A"));
  for (const part of ["A = (0, 0)", "O = (2, 1.5)", "BC = 5", "angle BAC = 90°", "k: center (2, 1.5), radius 2.5", "T: area 6, perimeter 12"]) {
    assert.ok(measures.includes(part), `${part} in ${measures}`);
  }
});

test("intersections, the foot of a perpendicular, midpoints, parallels, bisectors and the incircle", () => {
  const { skeletons, measures } = buildGeometry({
    objects: [
      { type: "point", name: "A", x: 0, y: 0 },
      { type: "point", name: "B", x: 4, y: 0 },
      { type: "point", name: "C", x: 1, y: 3 },
      { type: "line", name: "l", through: ["A", "B"] },
      { type: "circle", name: "c", center: "A", radius: 2 },
      { type: "intersection", name: "X", of: ["l", "c"], which: 1 },
      { type: "intersection", name: "Y", of: ["l", "c"], which: 2 },
      { type: "foot", name: "F", from: "C", to: "l" },
      { type: "segment", name: "CF", from: "C", to: "F", dashed: true },
      { type: "midpoint", name: "M", of: ["A", "B"] },
      { type: "parallel", name: "p", to: "l", through: "C" },
      { type: "bisector", name: "b", angle: ["B", "A", "C"] },
      { type: "perpBisector", name: "q", of: ["A", "B"] },
      { type: "incircle", name: "i", of: ["A", "B", "C"], center: "I" },
      { type: "ray", name: "r", from: "A", through: "C" },
      { type: "vector", name: "v", from: "A", to: "C" },
      { type: "text", name: "note", at: "M", text: "midpoint" },
    ],
  }, "g2");
  assertDrawable(skeletons, "g2");
  for (const part of ["X = (2, 0)", "Y = (-2, 0)", "F = (1, 0)", "M = (2, 0)"]) assert.ok(measures.includes(part), `${part} in ${measures}`);
  assert.ok(skeletons.find((s) => s.id === "g2-v" && s.type === "arrow"));
  assert.ok(skeletons.find((s) => s.id === "g2-CF" && s.strokeStyle === "dashed"));
  assert.ok(skeletons.find((s) => s.id === "g2-note" && s.text === "midpoint"));
  assert.ok(skeletons.find((s) => s.id === "g2-I"), "the incircle's center is a point");
  // Area 6, semiperimeter (4 + 3.162 + 4.243) / 2 = 5.702: r = 1.052, at (a A + b B + c C) / (a + b + c).
  assert.ok(measures.includes("i: center (1.46, 1.052), radius 1.052"), measures);
});

test("a coordinate grid when asked, and a construction that does not hold together is refused", () => {
  const withAxes = buildGeometry({ objects: TRIANGLE.slice(0, 3), axes: true }, "g3");
  assertDrawable(withAxes.skeletons, "g3");
  assert.ok(withAxes.skeletons.find((s) => s.id === "g3-axis-x"));
  assert.throws(() => buildGeometry({ objects: [{ type: "segment", from: "A", to: "Z" }] }, "g4"), refused(/^objects\[0\]: A is not defined above/));
  assert.throws(() => buildGeometry({
    objects: [
      { type: "point", name: "A", x: 0, y: 0 }, { type: "point", name: "B", x: 1, y: 0 }, { type: "point", name: "C", x: 0, y: 1 },
      { type: "line", name: "l", through: ["A", "B"] }, { type: "parallel", name: "m", to: "l", through: "C" },
      { type: "intersection", name: "X", of: ["l", "m"] },
    ],
  }, "g4"), refused(/^objects\[5\]: l and m do not meet/));
  assert.throws(() => buildGeometry({ objects: [{ type: "point", name: "A", x: 0, y: 0 }, { type: "point", name: "A", x: 1, y: 1 }] }, "g4"), refused(/^objects\[1\]: the name A is used twice/));
  assert.throws(() => buildGeometry({ objects: [{ type: "spline" }] }, "g4"), refused(/^objects\[0\]: type must be one of/));
  assert.throws(() => buildGeometry({ objects: [{ type: "point", name: "bad name", x: 0, y: 0 }] }, "g4"), refused(/name/));
});
