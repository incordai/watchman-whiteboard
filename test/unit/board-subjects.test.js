"use strict";

// Watchman Whiteboard: BoardSubjects (lib/board-subjects.js). Timelines, cycles, labelled parts and circuits become the
// board's own elements, each with its own id so an agent can erase or edit a wrong part; a bad request is refused with
// the field named, and nothing is drawn.

const test = require("node:test");
const assert = require("node:assert/strict");
const { checkDraw } = require("../../skills/debug-board-server/scripts/lib/board-ops");
const { buildTimeline, buildCycle, buildParts, buildCircuit, COMPONENTS } = require("../../skills/debug-board-server/scripts/lib/board-subjects");

// @purity pure
function assertDrawable(skeletons, prefix) {
  assert.ok(skeletons.length > 0 && skeletons.length <= 500);
  checkDraw({ elements: skeletons }, new Map(), 2000);
  const ids = skeletons.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const id of ids) assert.ok(id.startsWith(`${prefix}-`), id);
}

const byId = (skeletons, id) => skeletons.find((s) => s.id === id);
const refused = (pattern) => (error) => error.code === "InvalidSubject" && pattern.test(error.message);

test("a timeline puts years in order, each event with its own dot, date and label", () => {
  const { skeletons, summary } = buildTimeline({
    title: "Moon race",
    events: [
      { when: 1969, label: "Apollo 11 lands" },
      { when: 1957, label: "Sputnik", note: "first satellite" },
      { when: 1961, label: "Gagarin orbits" },
    ],
  }, "h1");
  assertDrawable(skeletons, "h1");
  assert.equal(summary, "1957: Sputnik; 1961: Gagarin orbits; 1969: Apollo 11 lands");
  assert.match(byId(skeletons, "h1-e1-label").text, /Sputnik\nfirst satellite/);
  assert.ok(byId(skeletons, "h1-e1-dot").x < byId(skeletons, "h1-e3-dot").x, "left to right in time");
  assert.equal(byId(skeletons, "h1-title").text, "Moon race");
});

test("a timeline keeps the given order when the dates are not numbers", () => {
  const { summary } = buildTimeline({ events: [{ when: "Bronze Age", label: "bronze" }, { when: "Iron Age", label: "iron" }] }, "h2");
  assert.equal(summary, "Bronze Age: bronze; Iron Age: iron");
  assert.throws(() => buildTimeline({ events: [{ when: 1, label: "only one" }] }, "h3"), refused(/events must be a list of 2/));
  assert.throws(() => buildTimeline({ events: [{ when: 1, label: "" }, { when: 2, label: "b" }] }, "h3"), refused(/events\[0\]\.label/));
});

test("a cycle rings its steps with an arrow from each to the next and back to the first", () => {
  const steps = ["Evaporation", "Condensation", "Precipitation", "Collection"].map((label) => ({ label }));
  const { skeletons, summary } = buildCycle({ steps, center: "Water cycle" }, "y1");
  assertDrawable(skeletons, "y1");
  assert.equal(summary, "Evaporation -> Condensation -> Precipitation -> Collection -> Evaporation");
  for (let k = 1; k <= 4; k++) {
    assert.equal(byId(skeletons, `y1-s${k}`).label.text, steps[k - 1].label);
    const arrow = byId(skeletons, `y1-a${k}`);
    assert.equal(arrow.type, "arrow");
    // Seen in Chrome: arrows between wide boxes shrank to stubs. Each must run between the two boxes' edges.
    const [, [dx, dy]] = arrow.points;
    assert.ok(Math.hypot(dx, dy) >= 40, `y1-a${k} is ${Math.round(Math.hypot(dx, dy))} px long`);
  }
  assert.equal(byId(skeletons, "y1-center").text, "Water cycle");
  assert.throws(() => buildCycle({ steps: [{ label: "alone" }] }, "y2"), refused(/steps must be a list of 2/));
});

test("labelled parts surround their subject, each part with a leader line", () => {
  const { skeletons, summary } = buildParts({
    subject: "Plant cell",
    parts: [{ label: "Cell wall" }, { label: "Nucleus", note: "holds the DNA" }, { label: "Chloroplast" }],
  }, "l1");
  assertDrawable(skeletons, "l1");
  assert.equal(summary, "Plant cell: Cell wall, Nucleus, Chloroplast");
  assert.equal(byId(skeletons, "l1-subject").label.text, "Plant cell");
  assert.match(byId(skeletons, "l1-p2").label.text, /Nucleus\nholds the DNA/);
  for (let k = 1; k <= 3; k++) assert.ok(byId(skeletons, `l1-p${k}-leader`));
  assert.throws(() => buildParts({ subject: "x", parts: [] }, "l2"), refused(/parts must be a list of 1/));
});

test("a series circuit draws the source, then each component as its symbol with its label", () => {
  const { skeletons, summary } = buildCircuit({
    source: { type: "battery", value: "9 V" },
    branches: [[{ type: "switch" }, { type: "resistor", label: "R1", value: "100 Ω" }, { type: "bulb" }, { type: "ammeter" }]],
  }, "e1");
  assertDrawable(skeletons, "e1");
  assert.match(summary, /^series; battery 9 V; branch 1: switch, resistor R1 100 Ω, bulb, ammeter$/);
  assert.ok(byId(skeletons, "e1-src") && byId(skeletons, "e1-src-label"));
  assert.equal(byId(skeletons, "e1-b1-c2-label").text, "R1 100 Ω");
  assert.equal(byId(skeletons, "e1-b1-c4-mark").text, "A");
});

test("branches are in parallel between the rails, and every component type draws", () => {
  const parts = COMPONENTS.map((type) => ({ type }));
  const branches = [parts.slice(0, 6), parts.slice(6, 12)];
  const { skeletons, summary } = buildCircuit({ source: { type: "ac" }, branches }, "e2");
  assertDrawable(skeletons, "e2");
  assert.match(summary, /^parallel; ac; branch 1: .*; branch 2: /);
  assert.ok(byId(skeletons, "e2-b1-up") && byId(skeletons, "e2-b2-up"), "each branch hangs from the top rail");
  assert.throws(() => buildCircuit({ source: { type: "sun" }, branches: [[{ type: "bulb" }]] }, "e3"), refused(/source\.type/));
  assert.throws(() => buildCircuit({ source: { type: "cell" }, branches: [[{ type: "toaster" }]] }, "e3"), refused(/branches\[0\]\[0\]\.type/));
});
