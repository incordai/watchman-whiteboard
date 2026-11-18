"use strict";

// Watchman Whiteboard: BoardMath, the board server's checks and rendering of math steps (lib/board-math.js).
// KaTeX checks every step's LaTeX first and refuses a bad one with its own message and position; MathJax draws each
// step as an SVG of paths, sized in pixels and in the agent's blue; with no MathJax, KaTeX's HTML goes to the page.

const test = require("node:test");
const assert = require("node:assert/strict");
const { AppError } = require("../../skills/debug-board-server/scripts/lib/app-error");
const { loadMathLib } = require("../../skills/debug-board-server/scripts/lib/math-libs");
const {
  checkMathBody, renderSteps, sizedSvg, isMathStep, mathTexOf, MATH_LIMITS, EX_PX, MATH_COLOR,
} = require("../../skills/debug-board-server/scripts/lib/board-math");

const board = (list = []) => new Map(list.map((element) => [element.id, element]));
const refused = (code, details = {}) => (error) => {
  assert.ok(error instanceof AppError, String(error));
  assert.equal(error.code, code, error.message);
  for (const [key, value] of Object.entries(details)) {
    if (value instanceof RegExp) assert.match(String(key === "message" ? error.message : error.details[key]), value);
    else assert.deepEqual(key === "message" ? error.message : error.details[key], value, key);
  }
  return true;
};

test("checkMathBody takes 1 to MATH_LIMITS.steps steps, each with an id and its LaTeX, and an optional note", () => {
  const checked = checkMathBody({ steps: [{ id: "m1-s1", tex: "x+1=3" }, { id: "m1-s2", tex: "x=2", note: "minus 1" }], at: { x: 5, y: 6 } }, board());
  assert.deepEqual(checked, { steps: [{ id: "m1-s1", tex: "x+1=3", note: null }, { id: "m1-s2", tex: "x=2", note: "minus 1" }], at: { x: 5, y: 6 } });
  assert.throws(() => checkMathBody({}, board()), refused("InvalidMath", { field: "steps" }));
  const many = Array.from({ length: MATH_LIMITS.steps + 1 }, (_, i) => ({ id: `s${i}`, tex: "x" }));
  assert.throws(() => checkMathBody({ steps: many }, board()), refused("InvalidMath", { field: "steps" }));
  assert.throws(() => checkMathBody({ steps: [{ id: "bad id", tex: "x" }] }, board()), refused("InvalidMath", { index: 0, field: "id" }));
  assert.throws(() => checkMathBody({ steps: [{ id: "a", tex: "" }] }, board()), refused("InvalidMath", { index: 0, field: "tex" }));
  assert.throws(() => checkMathBody({ steps: [{ id: "a", tex: "x".repeat(MATH_LIMITS.texChars + 1) }] }, board()), refused("InvalidMath", { index: 0, field: "tex" }));
  assert.throws(() => checkMathBody({ steps: [{ id: "a", tex: "x", note: 3 }] }, board()), refused("InvalidMath", { index: 0, field: "note" }));
  assert.throws(() => checkMathBody({ steps: [{ id: "a", tex: "x", color: "red" }] }, board()), refused("InvalidMath", { index: 0, field: "color" }));
  assert.throws(() => checkMathBody({ steps: [{ id: "a", tex: "x" }, { id: "a", tex: "y" }] }, board()), refused("InvalidMath", { index: 1, field: "id" }));
  // A step's note is drawn with the id <step>-note, so that id must be free too.
  assert.throws(() => checkMathBody({ steps: [{ id: "a", tex: "x" }] }, board([{ id: "a", isDeleted: false }])), refused("DuplicateId", { ids: ["a"] }));
  assert.throws(() => checkMathBody({ steps: [{ id: "a", tex: "x", note: "n" }] }, board([{ id: "a-note", isDeleted: false }])), refused("DuplicateId", { ids: ["a-note"] }));
  assert.ok(checkMathBody({ steps: [{ id: "a", tex: "x" }] }, board([{ id: "a", isDeleted: true }])), "a deleted step's id may be drawn again");
  assert.throws(() => checkMathBody({ steps: [{ id: "a", tex: "x" }], at: { x: "1" } }, board()), refused("InvalidAt"));
});

test("renderSteps refuses a bad step with KaTeX's own message and position, and draws nothing", async () => {
  const steps = [{ id: "s1", tex: "x^2", note: null }, { id: "s2", tex: "\\frac{1}{", note: null }];
  await assert.rejects(renderSteps(steps), refused("InvalidMath", {
    index: 1, field: "tex", position: 9, message: /^KaTeX parse error: .*\(step 2, position 9\)$/,
  }));
});

test("renderSteps draws each step with MathJax as an SVG of paths, sized in px, in the agent's blue (\\ce too)", async () => {
  const done = await renderSteps([
    { id: "s1", tex: "x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}", note: "the formula" },
    { id: "s2", tex: "\\ce{CH4 + 2O2 -> CO2 + 2H2O}", note: null },
    { id: "s3", tex: "\\pu{9.81 m/s^2}", note: null },
  ]);
  assert.equal(done.length, 3);
  for (const step of done) {
    assert.match(step.svg, /^<svg [^>]*width="[\d.]+px" height="[\d.]+px"/);
    assert.match(step.svg, new RegExp(`^<svg [^>]*color="${MATH_COLOR}"`));
    assert.doesNotMatch(step.svg, /vertical-align/);
    assert.ok(step.width > 20 && step.height > 10, `${step.width}x${step.height}`);
    assert.equal(step.html, undefined);
  }
  assert.deepEqual(done.map((s) => [s.id, s.note]), [["s1", "the formula"], ["s2", null], ["s3", null]]);
});

test("sizedSvg turns ex into px and refuses an SVG that holds MathJax's error, with MathJax's message", () => {
  const svg = '<svg style="vertical-align: -0.186ex;" xmlns="http://www.w3.org/2000/svg" width="10ex" height="2ex" viewBox="0 0 1 1"><g/></svg>';
  const sized = sizedSvg(svg);
  assert.equal(sized.width, 10 * EX_PX);
  assert.equal(sized.height, 2 * EX_PX);
  assert.match(sized.svg, new RegExp(`^<svg color="${MATH_COLOR}" xmlns="http://www.w3.org/2000/svg" width="${10 * EX_PX}px" height="${2 * EX_PX}px"`));
  const broken = '<svg width="1ex" height="1ex"><g data-mml-node="merror" data-mjx-error="Missing close brace"></g></svg>';
  assert.throws(() => sizedSvg(broken, 3), refused("InvalidMath", { index: 3, field: "tex", message: /^MathJax: Missing close brace \(step 4\)$/ }));
});

test("with no MathJax, renderSteps gives the page KaTeX's HTML of each step to draw instead", async () => {
  const noMathJax = (name) => (name === "mathjax" ? Promise.reject(new AppError("MathUnavailable", 503, "gone")) : loadMathLib(name));
  const done = await renderSteps([{ id: "s1", tex: "\\ce{H2O}", note: null }], { loadMathLib: noMathJax });
  assert.equal(done[0].svg, undefined);
  assert.match(done[0].html, /class="katex"/);
  assert.doesNotMatch(done[0].html, /<script|href=/i);
});

test("a math step is an image element that carries its LaTeX", () => {
  const step = { id: "m1-s1", type: "image", isDeleted: false, customData: { grwbKind: "claudeItem", mathTex: "x^2" } };
  assert.equal(isMathStep(step), true);
  assert.equal(mathTexOf(step), "x^2");
  assert.equal(isMathStep({ ...step, type: "rectangle" }), false);
  assert.equal(isMathStep({ ...step, customData: { grwbKind: "claudeItem" } }), false);
  assert.equal(mathTexOf({ id: "x", type: "text" }), null);
});
