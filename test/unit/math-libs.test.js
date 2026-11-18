"use strict";

// Watchman Whiteboard: each math library of the board loads in Node with no network and does its job
// (lib/math-libs.js; the staged copies come from scripts/stage-whiteboard.mjs). A library loads from the
// staged folder when the build staged it, else from the repository's node_modules.

require("../support/private-temp");
const { attempts } = require("../support/no-network");
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMathLib, loadPython, runPython, stopPython, pythonStaged, mathLibFile } = require("../../skills/debug-board-server/scripts/lib/math-libs");

test("KaTeX with mhchem accepts good LaTeX and refuses bad LaTeX with its message and position", async () => {
  const { katex } = await loadMathLib("katex");
  assert.match(katex.renderToString("\\ce{2H2 + O2 -> 2H2O}", { throwOnError: true }), /class="katex"/);
  assert.match(katex.renderToString("\\frac{a}{b} + \\sqrt{x}", { throwOnError: true }), /class="katex"/);
  assert.throws(() => katex.renderToString("\\frac{1}{", { throwOnError: true }), (error) => {
    assert.equal(error.name, "ParseError");
    assert.equal(error.position, 9);
    return true;
  });
});

test("MathJax turns LaTeX (and \\ce chemistry) into an SVG of pure paths: no text, script, link or foreign object", async () => {
  const { texToSvg } = await loadMathLib("mathjax");
  for (const tex of ["x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}", "\\ce{2H2 + O2 -> 2H2O}", "\\int_0^1 x^2\\,dx = \\tfrac13"]) {
    const svg = texToSvg(tex, { display: true });
    assert.match(svg, /^<svg[^>]* width="[\d.]+ex" height="[\d.]+ex"/, tex);
    assert.match(svg, /<path /, tex);
    assert.doesNotMatch(svg, /<(text|script|a|foreignObject|image|use)\b/i, tex);
    assert.doesNotMatch(svg, /data-mml-node="merror"/, tex);
  }
  // A command MathJax does not know is an error it reports, not a picture of the error.
  assert.match(texToSvg("\\nosuchcommand{x}", { display: true }), /data-mml-node="merror"/);
});

test("mathjs computes with units and statistics", async () => {
  const math = await loadMathLib("mathjs");
  assert.equal(math.evaluate("90 km/h to m/s").toNumber("m/s"), 25);
  assert.equal(math.median([3, 1, 2]), 2);
  assert.ok(Math.abs(math.std([2, 4, 4, 4, 5, 5, 7, 9], "uncorrected") - 2) < 1e-12);
});

test("the Compute Engine parses LaTeX, expands and solves", async () => {
  const { ComputeEngine } = await loadMathLib("compute-engine");
  const ce = new ComputeEngine();
  assert.equal(ce.box(["Expand", ce.parse("(x+1)^2")]).evaluate().latex, "x^2+2x+1");
  assert.deepEqual(ce.parse("x^2-5x+6=0").solve("x").map((root) => root.latex).sort(), ["2", "3"]);
});

test("nerdamer solves and integrates", async () => {
  const { nerdamer } = await loadMathLib("nerdamer");
  assert.equal(nerdamer("integrate(x^2, x)").toString(), "(1/3)*x^3");
  assert.match(nerdamer.solve("x^2-5x+6=0", "x").toString(), /^\{(3, 2|2, 3)\}$/);
});

test("Algebrite factors and differentiates", async () => {
  const { Algebrite } = await loadMathLib("algebrite");
  assert.equal(Algebrite.run("factor(x^2-5x+6)"), "(x-3)*(x-2)");
  assert.equal(Algebrite.run("d(sin(x)^2,x)"), "2*cos(x)*sin(x)");
});

test("an unknown library name is refused", () => {
  assert.throws(() => mathLibFile("../evil"), /no math library/);
  assert.throws(() => mathLibFile("nosuchlib"), /no math library/);
});

test("Pyodide runs SymPy from the staged folder, offline", { skip: pythonStaged() ? false : "SymPy is not staged: run npm run stage:whiteboard" }, async () => {
  const py = await loadPython();
  assert.equal(py.runPython("import sympy as sp; x = sp.symbols('x'); str(sp.factor(x**2 - 5*x + 6))"), "(x - 3)*(x - 2)");
});

test("Python runs in a worker that a time limit stops; the next call starts a new one", { skip: pythonStaged() ? false : "SymPy is not staged: run npm run stage:whiteboard" }, async () => {
  await assert.rejects(runPython("while True:\n    pass", {}, 300), (error) => error.code === "MathTimeout");
  assert.equal(await runPython("str(wb_in['a'] + 1)", { a: 41 }), "42");
  stopPython();
});

test("no library called the network", () => {
  assert.deepEqual(attempts, []);
});
