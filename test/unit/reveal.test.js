"use strict";

// Watchman Whiteboard: the pure half of the drawing animation (page/reveal.mjs). The page imports it as a
// browser module; these tests load the same file. What the page does with it on screen needs a browser.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const REVEAL_FILE = path.join(__dirname, "..", "..", "skills", "debug-board-server", "page", "reveal.mjs");
const load = () => import(pathToFileURL(REVEAL_FILE).href);

// @purity pure
function shape(id, x, y, extra = {}) {
  return { id, type: "rectangle", x, y, width: 100, height: 50, angle: 0, ...extra };
}

// @purity pure
function label(id, containerId, text) {
  return { id, type: "text", x: 0, y: 0, width: 50, height: 25, angle: 0, containerId, text };
}

// @purity pure
function arrow(id, from, to, extra = {}) {
  return {
    id, type: "arrow", x: 0, y: 0, width: 100, height: 0, angle: 0, points: [[0, 0], [100, 0]],
    startBinding: from ? { elementId: from } : null, endBinding: to ? { elementId: to } : null, ...extra,
  };
}

// @purity pure
function stepsOf(part) {
  return part.steps.map((step) => `${step.kind}:${step.id}`);
}

test("reading order: rows from top to bottom, each row from left to right", async () => {
  const { readingOrder } = await load();
  const list = [shape("c", 300, 5), shape("a", 0, 0), shape("d", 0, 200), shape("b", 150, 10), shape("e", 150, 190)];
  assert.deepEqual(readingOrder(list).map((e) => e.id), ["a", "b", "c", "d", "e"]);
  // An arrow counts by its points, not by a stale width.
  const low = arrow("low", null, null, { x: 0, y: 300, width: 0, points: [[0, 0], [0, 100]] });
  assert.deepEqual(readingOrder([low, shape("top", 500, 0)]).map((e) => e.id), ["top", "low"]);
});

// The owner's example as @excalidraw/mermaid-to-excalidraw gives it after convertToExcalidrawElements:
//   flowchart LR: A[write code] --> B[run tests] --> C{green?}; C -- yes --> D[ship]; C -- no --> A
// Node labels and edge labels are texts bound by containerId; `freeLabels` puts yes/no on their own instead.
// @purity pure
function ownerFlowchart({ freeLabels = false } = {}) {
  const yes = freeLabels
    ? { id: "yes", type: "text", x: 545, y: 10, width: 30, height: 20, angle: 0, containerId: null, text: "yes" }
    : label("yes", "eCD", "yes");
  const no = freeLabels
    ? { id: "no", type: "text", x: 245, y: 120, width: 30, height: 20, angle: 0, containerId: null, text: "no" }
    : label("no", "eCA", "no");
  // Shuffled, so only the walk decides the order.
  return [
    arrow("eCA", "C", "A", { x: 460, y: 70, points: [[0, 0], [0, 60], [-400, 60], [-400, -10]] }), no,
    label("D-l", "D", "ship"), yes, arrow("eCD", "C", "D", { x: 520, y: 30, points: [[0, 0], [80, 0]] }),
    shape("D", 600, 0, { width: 120, height: 60 }), label("C-l", "C", "green?"),
    shape("C", 400, -10, { type: "diamond", width: 120, height: 80 }), arrow("eBC", "B", "C", { x: 320, y: 30, points: [[0, 0], [80, 0]] }),
    label("B-l", "B", "run tests"), shape("B", 200, 0, { width: 120, height: 60 }),
    arrow("eAB", "A", "B", { x: 120, y: 30, points: [[0, 0], [80, 0]] }), label("A-l", "A", "write code"),
    shape("A", 0, 0, { width: 120, height: 60 }),
  ];
}

// What a viewer sees, step by step (each shape traced, then its text written; each arrow grown, then its label):
// the "write code" box, "write code", the arrow to "run tests", the "run tests" box, "run tests", the arrow to
// the diamond, the diamond, "green?", the arrow to "ship", "yes", the "ship" box, "ship", the arrow back to
// "write code", "no". That is the flow a person explains; nothing is drawn twice.
const OWNER_SEQUENCE = [
  "shape:A", "text:A-l", "line:eAB", "shape:B", "text:B-l", "line:eBC", "shape:C", "text:C-l",
  "line:eCD", "text:yes", "shape:D", "text:D-l", "line:eCA", "text:no",
];

test("sequence 1, the owner's flowchart: each step's shape and label, then the arrow leaving it, along the flow", async () => {
  const { revealPlan, revealGroups } = await load();
  const plan = revealPlan(ownerFlowchart());
  assert.equal(plan.length, 1);
  assert.deepEqual(stepsOf(plan[0]), OWNER_SEQUENCE);
  assert.equal(plan[0].steps.find((s) => s.id === "A-l").chars, 10);
  assert.equal(plan[0].steps[0].kind, "shape", "it starts by tracing the first shape");
  // Step groups: a shape with its text, an arrow with its label.
  assert.deepEqual(revealGroups(ownerFlowchart()).map((g) => g.map((s) => s.id)), [
    ["A", "A-l"], ["eAB"], ["B", "B-l"], ["eBC"], ["C", "C-l"], ["eCD", "yes"], ["D", "D-l"], ["eCA", "no"],
  ]);
});

test("sequence 1 with say: part k is the k-th step groups, in the same order", async () => {
  const { revealPlan } = await load();
  assert.deepEqual(revealPlan(ownerFlowchart(), 8).map(stepsOf)[5], ["line:eCD", "text:yes"]);
  assert.deepEqual(revealPlan(ownerFlowchart(), 4).map(stepsOf), [
    ["shape:A", "text:A-l", "line:eAB"], ["shape:B", "text:B-l", "line:eBC"],
    ["shape:C", "text:C-l", "line:eCD", "text:yes"], ["shape:D", "text:D-l", "line:eCA", "text:no"],
  ]);
  // More sentences than steps: the extra parts are empty, so every sentence is still announced.
  assert.deepEqual(revealPlan([shape("a", 0, 0)], 3).map(stepsOf), [["shape:a"], [], []]);
});

// A 3-row table from draw_table (lib/table.js): a free title text above, cells with bound labels, one empty cell.
// A viewer sees: the title written, then row 1 (header) cell by cell, each cell traced and its text written at
// once, then row 2, then row 3 (the empty cell is only traced).
test("sequence 2, a 3-row table: title, then row by row, each cell then its text", async () => {
  const { revealPlan } = await load();
  const cells = [];
  for (let r = 1; r <= 3; r += 1) {
    for (let c = 1; c <= 2; c += 1) {
      const id = `t1-r${r}c${c}`;
      cells.push(shape(id, (c - 1) * 100, 40 * r, { height: 40 }));
      if (!(r === 3 && c === 2)) cells.push(label(`${id}-l`, id, `cell ${r}${c}`));
    }
  }
  const title = { id: "t1-title", type: "text", x: 0, y: 0, width: 100, height: 30, angle: 0, text: "Plan" };
  assert.deepEqual(stepsOf(revealPlan([...cells.reverse(), title])[0]), [
    "text:t1-title",
    "shape:t1-r1c1", "text:t1-r1c1-l", "shape:t1-r1c2", "text:t1-r1c2-l",
    "shape:t1-r2c1", "text:t1-r2c1-l", "shape:t1-r2c2", "text:t1-r2c2-l",
    "shape:t1-r3c1", "text:t1-r3c1-l", "shape:t1-r3c2",
  ]);
});

// Two start nodes: A --> C, B --> C, C --> D (A above B, both left of C). A viewer sees: A and "A", the arrow
// to C, C and "C", the arrow to D, D and "D" (the first start walked to its end); then B and "B", and the arrow
// from B into C, which is already there and is not drawn again.
test("sequence 3, two start nodes: the first start is walked to its end, then the second", async () => {
  const { revealPlan } = await load();
  const elements = [
    shape("D", 400, 100), label("D-l", "D", "D"), arrow("eCD", "C", "D", { x: 300, y: 125 }),
    shape("C", 200, 100), label("C-l", "C", "C"), arrow("eBC", "B", "C", { x: 100, y: 225, points: [[0, 0], [100, -100]] }),
    shape("B", 0, 200), label("B-l", "B", "B"), arrow("eAC", "A", "C", { x: 100, y: 25, points: [[0, 0], [100, 100]] }),
    shape("A", 0, 0), label("A-l", "A", "A"),
  ];
  assert.deepEqual(stepsOf(revealPlan(elements)[0]), [
    "shape:A", "text:A-l", "line:eAC", "shape:C", "text:C-l", "line:eCD", "shape:D", "text:D-l",
    "shape:B", "text:B-l", "line:eBC",
  ]);
});

// Labels that Mermaid puts as texts of their own. (a) The owner's flowchart with yes/no as free texts beside
// their arrows: the same sequence as sequence 1, each label written right after its arrow. (b) A sequence
// diagram: actor boxes with their names as free texts inside, dashed lifelines, message arrows bound to
// nothing with their texts just above, and the actor boxes again at the bottom. A viewer sees: Alice's box and
// "Alice", Bob's box and "Bob", the two lifelines, message 1 and "hello", message 2 and "hi back", then the
// bottom boxes, each with its name: the conversation from top to bottom.
test("sequence 4, labels as texts of their own: written right after their arrow or inside their box", async () => {
  const { revealPlan } = await load();
  const free = stepsOf(revealPlan(ownerFlowchart({ freeLabels: true }))[0]);
  assert.deepEqual(free, OWNER_SEQUENCE);
  const name = (id, x, y, text) => ({ id, type: "text", x, y, width: 60, height: 20, angle: 0, containerId: null, text });
  const lifeline = (id, x) => ({ id, type: "line", x, y: 40, width: 0, height: 360, angle: 0, points: [[0, 0], [0, 360]] });
  const sequence = [
    shape("A2", 0, 400, { height: 40 }), name("A2-t", 20, 410, "Alice"), shape("B2", 300, 400, { height: 40 }), name("B2-t", 320, 410, "Bob"),
    arrow("m2", null, null, { x: 350, y: 150, points: [[0, 0], [-300, 0]] }), name("m2-t", 170, 130, "hi back"),
    arrow("m1", null, null, { x: 50, y: 100, points: [[0, 0], [300, 0]] }), name("m1-t", 170, 80, "hello"),
    lifeline("lB", 350), lifeline("lA", 50),
    shape("A", 0, 0, { height: 40 }), name("A-t", 20, 10, "Alice"), shape("B", 300, 0, { height: 40 }), name("B-t", 320, 10, "Bob"),
  ];
  assert.deepEqual(stepsOf(revealPlan(sequence)[0]), [
    "shape:A", "text:A-t", "shape:B", "text:B-t", "line:lA", "line:lB",
    "line:m1", "text:m1-t", "line:m2", "text:m2-t", "shape:A2", "text:A2-t", "shape:B2", "text:B2-t",
  ]);
});

test("pictures and turned shapes appear at once in their place in the order", async () => {
  const { revealPlan } = await load();
  const steps = stepsOf(revealPlan([
    shape("tilted", 0, 400, { angle: 0.5 }), { id: "pic", type: "image", x: 600, y: 0, width: 50, height: 50 }, shape("a", 0, 0),
  ])[0]);
  assert.deepEqual(steps, ["shape:a", "show:pic", "show:tilted"]);
});

test("splitEven gives each part its share, larger parts first", async () => {
  const { splitEven } = await load();
  assert.deepEqual(splitEven(7, 3), [3, 2, 2]);
  assert.deepEqual(splitEven(2, 4), [1, 1, 0, 0]);
  assert.deepEqual(splitEven(5, 1), [5]);
  assert.deepEqual(splitEven(0, 2), [0, 0]);
});

test("outlines are closed paths around the shape, starting at its top", async () => {
  const { outlinePoints } = await load();
  assert.deepEqual(outlinePoints({ type: "rectangle", width: 100, height: 50 }), [[0, 0], [100, 0], [100, 50], [0, 50], [0, 0]]);
  assert.deepEqual(outlinePoints({ type: "diamond", width: 100, height: 50 }), [[50, 0], [100, 25], [50, 50], [0, 25], [50, 0]]);
  const ellipse = outlinePoints({ type: "ellipse", width: 100, height: 50 });
  assert.ok(ellipse.length > 16, "an ellipse has many points");
  assert.deepEqual(ellipse[0], [50, 0]);
  assert.deepEqual(ellipse[ellipse.length - 1], ellipse[0]);
  for (const [px, py] of ellipse) {
    assert.ok(Math.abs(((px - 50) / 50) ** 2 + ((py - 25) / 25) ** 2 - 1) < 1e-3, "every point is on the ellipse");
  }
});

test("polylineAt grows a path from its start to its end", async () => {
  const { polylineAt } = await load();
  const path3 = [[0, 0], [100, 0], [100, 100]];
  assert.deepEqual(polylineAt(path3, 0), [[0, 0], [0, 0]]);
  assert.deepEqual(polylineAt(path3, 0.25), [[0, 0], [50, 0]]);
  assert.deepEqual(polylineAt(path3, 0.5), [[0, 0], [100, 0]]);
  assert.deepEqual(polylineAt(path3, 0.75), [[0, 0], [100, 0], [100, 50]]);
  assert.deepEqual(polylineAt(path3, 1), path3);
  assert.notEqual(polylineAt(path3, 1), path3, "a copy, never the element's own points");
  assert.deepEqual(polylineAt([[5, 5], [5, 5]], 0.5), [[5, 5], [5, 5]], "a path of length 0 stays as it is");
});

test("asLinear moves the first point to 0,0 and gives the size of the points", async () => {
  const { asLinear } = await load();
  assert.deepEqual(asLinear(10, 20, [[50, 0], [100, 25], [50, 50]]), {
    x: 60, y: 20, points: [[0, 0], [50, 25], [0, 50]], width: 50, height: 50,
  });
});

test("textAt writes the text letter by letter, never splitting a character", async () => {
  const { textAt } = await load();
  assert.equal(textAt("Hello\nWorld", 0), "");
  assert.equal(textAt("Hi", 0.1), "H", "once writing starts, the first letter shows");
  assert.equal(textAt("Hello\nWorld", 0.5), "Hello");
  assert.equal(textAt("Hello\nWorld", 1), "Hello\nWorld");
  const face = "a\u{1F600}b";
  assert.equal(textAt(face, 0.67), "a\u{1F600}");
  assert.equal(textAt("", 0.5), "");
});

test("the schedule draws one step after another, scales with the speed, and fits the budget", async () => {
  const { revealPlan, revealSchedule, REVEAL } = await load();
  const plan = revealPlan([shape("a", 0, 0), label("la", "a", "Hi"), shape("b", 200, 0), arrow("ab", "a", "b")]);
  const normal = revealSchedule(plan, { speed: 1, maxTotalMs: 60000 });
  assert.deepEqual(normal.steps.map((s) => s.id), ["a", "la", "ab", "b"]);
  for (let i = 1; i < normal.steps.length; i += 1) assert.equal(normal.steps[i].startMs, normal.steps[i - 1].endMs);
  assert.equal(normal.steps[0].startMs, 0);
  assert.equal(normal.steps[0].endMs, REVEAL.SHAPE_MS);
  assert.equal(normal.steps[1].endMs - normal.steps[1].startMs, REVEAL.TEXT_MIN_MS, "a short text takes the least time");
  assert.equal(normal.steps[2].endMs - normal.steps[2].startMs, REVEAL.LINE_MS);
  assert.equal(normal.totalMs, normal.steps[3].endMs);
  const fast = revealSchedule(plan, { speed: 2, maxTotalMs: 60000 });
  assert.equal(fast.totalMs, normal.totalMs / 2);
  const capped = revealSchedule(plan, { speed: 1, maxTotalMs: 500 });
  assert.equal(capped.totalMs, 500);
  assert.equal(revealSchedule(plan, { speed: 0, maxTotalMs: 60000 }).totalMs, 0, "speed 0: no animation");
  // A diagram takes a few seconds, not more: a big table still fits the default budget.
  const big = revealPlan(Array.from({ length: 400 }, (_, i) => shape(`s${i}`, (i % 10) * 120, Math.floor(i / 10) * 60)));
  assert.equal(revealSchedule(big, { speed: 1 }).totalMs, REVEAL.MAX_TOTAL_MS);
});

// Live defect "your animation skips the first": every step, the first included, must be seen part drawn.
// @purity pure
function framesOf(lib, timing) {
  const seen = new Map(timing.steps.map((step) => [step.id, []]));
  const order = [];
  for (const t of lib.revealTimeline(timing, lib.REVEAL.FRAME_MS)) {
    const { progress } = lib.progressAt(timing, t);
    for (const step of timing.steps) {
      const p = progress.get(step.id);
      if (p > 0 && seen.get(step.id).length === 0) order.push(step.id);
      if (p > 0) seen.get(step.id).push(p);
    }
  }
  return { seen, order };
}

test("the first frames trace the first shape part way; every step, the first included, is seen part drawn", async () => {
  const lib = await load();
  const timing = lib.revealSchedule(lib.revealPlan(ownerFlowchart()), { speed: 1 });
  const { seen, order } = framesOf(lib, timing);
  assert.deepEqual(order, OWNER_SEQUENCE.map((s) => s.split(":")[1]), "steps start in the drawing order");
  const first = seen.get("A");
  assert.ok(first[0] > 0 && first[0] < 1, `the first frame of the first shape is a part of its outline (p=${first[0]})`);
  assert.ok(first.filter((p) => p < 1).length >= 5, "the first shape is traced over several frames");
  const outline = lib.outlinePoints({ type: "rectangle", width: 120, height: 60 });
  assert.ok(lib.polylineAt(outline, first[0]).length < outline.length, "a partial outline, not the whole box");
  for (const [id, values] of seen) {
    assert.ok(values.some((p) => p > 0 && p < 1), `${id} is seen part drawn`);
    assert.equal(values[values.length - 1], 1, `${id} ends whole`);
  }
  // A big table squeezed into the budget: steps shorter than a frame still get one half-drawn frame.
  const cells = Array.from({ length: 400 }, (_, i) => shape(`s${i}`, (i % 10) * 120, Math.floor(i / 10) * 60));
  const squeezed = lib.revealSchedule(lib.revealPlan(cells), { speed: 1 });
  for (const [id, values] of framesOf(lib, squeezed).seen) assert.ok(values.some((p) => p > 0 && p < 1), `${id} is seen part drawn`);
  const times = lib.revealTimeline(squeezed);
  assert.equal(times[times.length - 1], squeezed.totalMs, "the last frame is the finished drawing");
  assert.ok(times[0] > 0, "no frame before the start: the first frame already shows a part of the first step");
});

test("parts start in order; an empty part still takes a short pause", async () => {
  const { revealPlan, revealSchedule, REVEAL } = await load();
  const timing = revealSchedule(revealPlan([shape("a", 0, 0)], 3), { speed: 1, maxTotalMs: 60000 });
  assert.deepEqual(timing.parts.map((p) => p.startMs), [0, REVEAL.SHAPE_MS, REVEAL.SHAPE_MS + REVEAL.PAUSE_MS]);
  assert.equal(timing.totalMs, REVEAL.SHAPE_MS + 2 * REVEAL.PAUSE_MS);
});

test("progressAt tells how far each step is and which part has started", async () => {
  const { revealPlan, revealSchedule, progressAt, REVEAL } = await load();
  const plan = revealPlan([shape("a", 0, 0), shape("b", 200, 0)], 2);
  const timing = revealSchedule(plan, { speed: 1, maxTotalMs: 60000 });
  const start = progressAt(timing, 0);
  assert.equal(start.part, 0);
  assert.equal(start.progress.get("a"), 0);
  const half = progressAt(timing, REVEAL.SHAPE_MS / 2);
  assert.equal(half.progress.get("a"), 0.5);
  assert.equal(half.progress.get("b"), 0);
  const second = progressAt(timing, REVEAL.SHAPE_MS + 1);
  assert.equal(second.part, 1);
  assert.equal(second.progress.get("a"), 1);
  const end = progressAt(timing, Infinity);
  assert.deepEqual([end.part, end.progress.get("a"), end.progress.get("b"), end.done], [1, 1, 1, true]);
});

test("animationSpeed: default 1, 0 turns it off, reduced motion and a hidden page turn it off", async () => {
  const { animationSpeed, REVEAL } = await load();
  assert.equal(animationSpeed({}), REVEAL.DEFAULT_SPEED);
  assert.equal(REVEAL.DEFAULT_SPEED, 1);
  assert.equal(animationSpeed({ param: "0" }), 0);
  assert.equal(animationSpeed({ param: "2.5" }), 2.5);
  assert.equal(animationSpeed({ param: "fast" }), 1, "a wrong value keeps the default");
  assert.equal(animationSpeed({ param: "-1" }), 1);
  assert.equal(animationSpeed({ param: "1000" }), REVEAL.MAX_SPEED);
  assert.equal(animationSpeed({ reducedMotion: true }), 0);
  assert.equal(animationSpeed({ param: "2", hidden: true }), 0);
});

test("the animation's own elements are marked, so the page never sends them", async () => {
  const { isAnimationTemp, ANIMATION_MARK } = await load();
  assert.equal(isAnimationTemp({ id: "x", customData: { [ANIMATION_MARK]: true } }), true);
  assert.equal(isAnimationTemp({ id: "x", customData: { grwbKind: "claudeItem" } }), false);
  assert.equal(isAnimationTemp({ id: "x" }), false);
});

test("sayDetail: the sentence of a part, numbered from 1, with the job", async () => {
  const { sayDetail, SAY_EVENT } = await load();
  assert.equal(SAY_EVENT, "watchman-whiteboard:say");
  assert.deepEqual(sayDetail(["First the client.", "Then the server."], 1, 7), { text: "Then the server.", part: 2, parts: 2, jobId: 7 });
});
