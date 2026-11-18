"use strict";

// BoardMath (Entity + Adapter), Watchman Whiteboard. The math steps of a draw_math call (POST /v1/math) and the
// LaTeX of an edit_items change {id, tex}: checked, then drawn. KaTeX (with mhchem) checks every step first, so a bad
// step is refused with KaTeX's own message and position and nothing is drawn; MathJax then draws each step as an SVG
// of paths, here sized in pixels and colored, which the page turns into a PNG on a canvas (page/app.js drawMath): the
// board keeps PNG files only (board-files.js refuses SVG). When MathJax cannot load, KaTeX's HTML of the step goes to
// the page instead, which draws that. A drawn step is an image element whose customData.mathTex is its LaTeX, so
// read_board shows the LaTeX and edit_items can change one step.

const { AppError } = require("./app-error");
const mathLibs = require("./math-libs");
const { AGENT_INK } = require("./agent-ink");

const MATH_LIMITS = Object.freeze({ steps: 30, texChars: 2000, noteChars: 300 });
// A step id leaves room for "-note", the id of its note, within the 64 characters of an element id.
const STEP_ID_PATTERN = /^[A-Za-z0-9_-]{1,59}$/;
const STEP_FIELDS = Object.freeze(["id", "tex", "note"]);
const NOTE_SUFFIX = "-note";
// MathJax gives sizes in ex (half an em). One ex is this many pixels on the board: a 26 px em, a little larger than
// the board's 20 px text, as formulas need.
const EX_PX = 13;
// The agent's ink (agent-ink.js), as the page draws the agent's other items (page/app.js ANSWER_COLOR).
const MATH_COLOR = AGENT_INK;
// KaTeX as a checker: no \href, \url or \includegraphics (trust false), and bounded macro expansion.
const KATEX_OPTIONS = Object.freeze({ throwOnError: true, displayMode: true, strict: "ignore", trust: false, maxExpand: 1000, maxSize: 100 });

// @purity pure
function invalid(index, field, message, extra = {}) {
  return new AppError("InvalidMath", 400, message, { index, field, ...extra });
}

// @purity pure
function checkAt(at) {
  if (at === undefined || at === null) return null;
  if (!(at && typeof at === "object" && Number.isFinite(at.x) && Number.isFinite(at.y))) {
    throw new AppError("InvalidAt", 400, "at must be {\"x\": number, \"y\": number}");
  }
  return { x: at.x, y: at.y };
}

// Checks the body of POST /v1/math. `elements`: Map id -> Element (the board). Returns { steps: [{id, tex, note}], at }.
// Throws InvalidMath (400, with index and field), InvalidAt (400), or DuplicateId (409, with ids).
// @purity pure
function checkMathBody(body, elements) {
  const list = body && body.steps;
  if (!Array.isArray(list) || list.length < 1 || list.length > MATH_LIMITS.steps) {
    throw invalid(null, "steps", `steps must be a list of 1 to ${MATH_LIMITS.steps} steps`);
  }
  const ids = new Set();
  const steps = list.map((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) throw invalid(index, null, "a step must be a JSON object");
    const extra = Object.keys(step).find((field) => !STEP_FIELDS.includes(field));
    if (extra) throw invalid(index, extra, `field ${extra} is not allowed in a step`);
    if (typeof step.id !== "string" || !STEP_ID_PATTERN.test(step.id)) throw invalid(index, "id", "id must be 1 to 59 letters, digits, - or _");
    if (ids.has(step.id)) throw invalid(index, "id", `id ${step.id} is twice in the list`);
    ids.add(step.id);
    if (typeof step.tex !== "string" || step.tex.trim() === "" || step.tex.length > MATH_LIMITS.texChars) {
      throw invalid(index, "tex", `tex must be 1 to ${MATH_LIMITS.texChars} characters and not blank`);
    }
    const note = step.note === undefined || step.note === null ? null : step.note;
    if (note !== null && (typeof note !== "string" || note.trim() === "" || note.length > MATH_LIMITS.noteChars)) {
      throw invalid(index, "note", `note must be 1 to ${MATH_LIMITS.noteChars} characters`);
    }
    return { id: step.id, tex: step.tex, note };
  });
  const wanted = steps.flatMap((step) => (step.note === null ? [step.id] : [step.id, `${step.id}${NOTE_SUFFIX}`]));
  const taken = wanted.filter((id) => elements.has(id) && !elements.get(id).isDeleted);
  if (taken.length > 0) throw new AppError("DuplicateId", 409, `ids already on the Board: ${taken.join(", ")}`, { ids: taken });
  return { steps, at: checkAt(body.at) };
}

// Throws InvalidMath with KaTeX's message and position when KaTeX refuses `tex` (the step at `index`).
// @purity semi-pure-b
function checkTex(katex, tex, index) {
  try {
    katex.renderToString(tex, KATEX_OPTIONS);
  } catch (error) {
    if (!error || error.name !== "ParseError") throw error;
    const position = Number.isInteger(error.position) ? error.position : null;
    const where = position === null ? `step ${index + 1}` : `step ${index + 1}, position ${position}`;
    throw invalid(index, "tex", `${String(error.message).split("\n")[0]} (${where})`, position === null ? {} : { position });
  }
}

// @purity pure
function unescapeAttribute(text) {
  return text.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// MathJax's SVG for a step: refused when it holds MathJax's own error, else with its size in px (not ex, which a
// browser would measure in its own font), no inline style, and color set for MathJax's currentColor.
// Returns { svg, width, height }.
// @purity pure
function sizedSvg(svg, index = 0) {
  const error = /data-mjx-error="([^"]*)"/.exec(svg);
  if (error) throw invalid(index, "tex", `MathJax: ${unescapeAttribute(error[1])} (step ${index + 1})`);
  const root = /^<svg\b([^>]*)>/.exec(svg);
  if (!root) throw new AppError("MathUnavailable", 503, "MathJax gave no SVG");
  const exOf = (name) => {
    const found = new RegExp(`\\s${name}="([\\d.]+)ex"`).exec(root[1]);
    return found ? Number(found[1]) : 0;
  };
  const width = Math.round(exOf("width") * EX_PX * 10) / 10;
  const height = Math.round(exOf("height") * EX_PX * 10) / 10;
  const attributes = root[1]
    .replace(/\s+style="[^"]*"/, "")
    .replace(/(\swidth=")[\d.]+ex"/, `$1${width}px"`)
    .replace(/(\sheight=")[\d.]+ex"/, `$1${height}px"`);
  return { svg: `<svg color="${MATH_COLOR}"${attributes}>${svg.slice(root[0].length)}`, width, height };
}

// The drawing of one step's LaTeX: { svg, width, height } from MathJax, or { html } from KaTeX when MathJax is
// not there (`texToSvg` null). Checks it with KaTeX first.
// @purity semi-pure-b
function drawTex(katex, texToSvg, tex, index) {
  checkTex(katex, tex, index);
  if (texToSvg) return sizedSvg(texToSvg(tex, { display: true }), index);
  return { html: katex.renderToString(tex, { ...KATEX_OPTIONS, output: "html" }) };
}

// KaTeX and, when it loads, MathJax's texToSvg (else null).
// @purity non-pure
async function loadRenderers(libs) {
  const { katex } = await libs.loadMathLib("katex");
  let texToSvg = null;
  try {
    texToSvg = (await libs.loadMathLib("mathjax")).texToSvg;
  } catch (error) {
    texToSvg = null;
  }
  return { katex, texToSvg };
}

// Every step checked, then drawn: [{ id, tex, note, svg, width, height }] (or { ..., html } with no MathJax).
// Rejects with InvalidMath for the first bad step, or MathUnavailable when KaTeX itself cannot load.
// @purity non-pure
async function renderSteps(steps, libs = mathLibs) {
  const { katex, texToSvg } = await loadRenderers(libs);
  steps.forEach((step, index) => checkTex(katex, step.tex, index));
  return steps.map((step, index) => ({ ...step, ...drawTex(katex, texToSvg, step.tex, index) }));
}

// The drawing of the LaTeX of an edit change at `index` (the same as one step of renderSteps).
// @purity non-pure
async function renderTex(tex, index, libs = mathLibs) {
  const { katex, texToSvg } = await loadRenderers(libs);
  return drawTex(katex, texToSvg, tex, index);
}

// @purity pure
function mathTexOf(element) {
  const tex = element && element.customData && element.customData.mathTex;
  return element && element.type === "image" && typeof tex === "string" ? tex : null;
}

// @purity pure
function isMathStep(element) {
  return mathTexOf(element) !== null;
}

// The text read_board shows for a picture the board drew from text: a math step's LaTeX, or "SMILES <smiles>" for a
// molecule (lib/board-chem.js); null for anything else.
// @purity pure
function pictureTextOf(element) {
  const tex = mathTexOf(element);
  if (tex !== null) return tex;
  const data = element && element.type === "image" && element.customData ? element.customData : {};
  if (typeof data.smiles === "string") return `SMILES ${data.smiles}`;
  // A 3D chart (draw_chart3d): what it shows.
  return typeof data.pictureOf === "string" ? `3D ${data.pictureOf}` : null;
}

module.exports = {
  checkMathBody, renderSteps, renderTex, sizedSvg, isMathStep, mathTexOf, pictureTextOf, MATH_LIMITS, EX_PX, MATH_COLOR, NOTE_SUFFIX,
};
