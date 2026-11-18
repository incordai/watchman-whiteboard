"use strict";

// Watchman Whiteboard: MathCheck (lib/math-check.js), the computer algebra behind check_math. LaTeX goes to the
// Compute Engine; plain text to nerdamer, Algebrite, mathjs or SymPy (Pyodide). Every answer is one short text an
// agent can read, and a wrong step of a working is named with a counterexample.

require("../support/private-temp");
const { attempts } = require("../support/no-network");
const test = require("node:test");
const assert = require("node:assert/strict");
const { AppError } = require("../../skills/debug-board-server/scripts/lib/app-error");
const { pythonStaged } = require("../../skills/debug-board-server/scripts/lib/math-libs");
const { checkMath, safePythonText, TASKS, ENGINES } = require("../../skills/debug-board-server/scripts/lib/math-check");

const refused = (code, pattern) => (error) => {
  assert.ok(error instanceof AppError, String(error && error.stack));
  assert.equal(error.code, code, error.message);
  if (pattern) assert.match(error.message, pattern);
  return true;
};

test("LaTeX goes to the Compute Engine: solve, derivative, expand, factor, evaluate", async () => {
  assert.match(await checkMath({ task: "solve", expr: "x^2-5x+6=0" }), /^ok check task=solve engine=compute-engine\nresult=2, 3\nlatex=2, 3$/);
  assert.match(await checkMath({ task: "derivative", expr: "\\sin(x)^2" }), /\nlatex=2\\sin\(x\)\\cos\(x\)$/);
  // (x+1)^2 reads as plain text too; format says which it is.
  assert.match(await checkMath({ task: "expand", expr: "(x+1)^2", format: "latex" }), /engine=compute-engine\n.*\nlatex=x\^2\+2x\+1$/);
  assert.match(await checkMath({ task: "factor", expr: "x^2-5x+6" }), /\nlatex=\(x-3\)\(x-2\)$/);
  assert.match(await checkMath({ task: "evaluate", expr: "\\int_0^1 x^2\\,dx" }), /\nlatex=\\frac\{1\}\{3\}$/);
  assert.match(await checkMath({ task: "limit", expr: "\\lim_{x\\to 0} \\frac{\\sin x}{x}" }), /\nresult=1\n/);
});

test("equal says yes, or no with a counterexample; identities the algebra cannot see are checked by numbers", async () => {
  assert.match(await checkMath({ task: "equal", expr: "(x+1)^2", expr2: "x^2+2x+1" }), /\nequal=yes method=(symbolic|numeric)/);
  assert.match(await checkMath({ task: "equal", expr: "\\sin^2 x+\\cos^2 x", expr2: "1" }), /\nequal=yes method=numeric/);
  const no = await checkMath({ task: "equal", expr: "(x+1)^2", expr2: "x^2+1" });
  assert.match(no, /\nequal=no method=numeric counterexample=x=-?[\d.]+: -?[\d.]+ vs -?[\d.]+$/);
  assert.match(await checkMath({ task: "equal", expr: "(x+1)*(x-1)", expr2: "x^2-1" }), /^ok check task=equal engine=algebrite\nequal=yes/);
  await assert.rejects(checkMath({ task: "equal", expr: "x" }), refused("InvalidArguments", /expr2/));
});

test("steps checks a working line by line and names the first wrong step", async () => {
  const right = await checkMath({ task: "steps", exprs: ["2x+3=7", "2x=4", "x=2"] });
  assert.match(right, /\nstep 1->2 ok\nstep 2->3 ok\nall=ok$/);
  const wrong = await checkMath({ task: "steps", exprs: ["2x+3=7", "2x=10", "x=5"] });
  assert.match(wrong, /\nstep 1->2 WRONG solutions \{2\} vs \{5\}\nstep 2->3 ok\nall=wrong first=2$/);
  const algebra = await checkMath({ task: "steps", exprs: ["(a+b)^2", "a^2+2ab+b^2", "a^2+b^2"] });
  assert.match(algebra, /\nstep 1->2 ok\nstep 2->3 WRONG counterexample=.*\nall=wrong first=3$/);
});

test("plain text goes to nerdamer and Algebrite: solve, integral, definite integral, limit, factor, derivative", async () => {
  assert.match(await checkMath({ task: "solve", expr: "x^2-5*x+6=0" }), /^ok check task=solve engine=nerdamer\nresult=(3, 2|2, 3)\n/);
  assert.match(await checkMath({ task: "integral", expr: "x^2" }), /^ok check task=integral engine=nerdamer\nresult=\(1\/3\)\*x\^3\n/);
  assert.match(await checkMath({ task: "integral", expr: "x^2", from: "0", to: "3" }), /\nresult=9\n/);
  assert.match(await checkMath({ task: "limit", expr: "sin(x)/x", at: "0" }), /\nresult=1\n/);
  assert.match(await checkMath({ task: "factor", expr: "x^2-5*x+6" }), /^ok check task=factor engine=algebrite\nresult=\(x-3\)\*\(x-2\)/);
  assert.match(await checkMath({ task: "derivative", expr: "sin(x)^2", engine: "algebrite" }), /\nresult=2\*cos\(x\)\*sin\(x\)/);
});

test("mathjs evaluates numbers and units, and gives the statistics of data", async () => {
  assert.match(await checkMath({ task: "evaluate", expr: "90 km/h to m/s" }), /^ok check task=evaluate engine=mathjs\nresult=25 m \/ s$/);
  assert.match(await checkMath({ task: "evaluate", expr: "det([1, 2; 3, 4])" }), /\nresult=-2$/);
  const stats = await checkMath({ task: "statistics", data: [2, 4, 4, 4, 5, 5, 7, 9] });
  assert.match(stats, /\nn=8 mean=5 median=4\.5 mode=4 sd=2\.138 sdPopulation=2 min=2 max=9 q1=4 q3=5\.5$/);
  const fit = await checkMath({ task: "statistics", data: [1, 2, 3, 4], data2: [2, 4.1, 5.9, 8.1] });
  assert.match(fit, /\nregression slope=2\.01 intercept=-?0(\.0+\d*)?(e-\d+)? r=0\.999\d* r2=0\.99\d*$/);
});

test("SymPy (Pyodide) does heavy algebra from plain text, and refuses text that is not an expression", { skip: pythonStaged() ? false : "SymPy is not staged" }, async () => {
  assert.match(await checkMath({ task: "factor", expr: "x^4-1", engine: "sympy" }), /^ok check task=factor engine=sympy\nresult=\(x - 1\)\*\(x \+ 1\)\*\(x\*\*2 \+ 1\)\nlatex=/);
  assert.match(await checkMath({ task: "integral", expr: "exp(-x^2)", from: "-oo", to: "oo", engine: "sympy" }), /\nresult=sqrt\(pi\)\n/);
  assert.match(await checkMath({ task: "solve", expr: "x^3-6x^2+11x-6=0", engine: "sympy" }), /\nresult=\[1, 2, 3\]\n/);
  assert.match(await checkMath({ task: "equal", expr: "sin(x)^2+cos(x)^2", expr2: "1", engine: "sympy" }), /\nequal=yes method=symbolic$/);
  for (const bad of ["().__class__", "x.real", "'a'", "x; import os"]) {
    await assert.rejects(checkMath({ task: "simplify", expr: bad, engine: "sympy" }), refused("InvalidMath"), bad);
  }
});

test("safePythonText lets through expressions only", () => {
  assert.equal(safePythonText("x**2 + 3*x - sin(y)/2 >= 1.5"), true);
  for (const bad of ["__import__", "a.b", "x;y", "\"s\"", "x\ny", "lambda: 1"]) assert.equal(safePythonText(bad), false, bad);
});

test("bad input is refused with the engine's own words; unknown task and engine pairs are refused", async () => {
  await assert.rejects(checkMath({ task: "simplify", expr: "\\frac{1}{" }), refused("InvalidMath", /expected-closing-delimiter/));
  await assert.rejects(checkMath({ task: "evaluate", expr: "1 +* 2", engine: "mathjs" }), refused("InvalidMath"));
  await assert.rejects(checkMath({ task: "limit", expr: "x", engine: "mathjs" }), refused("InvalidArguments", /mathjs does not do limit/));
  assert.ok(TASKS.includes("steps") && ENGINES.includes("sympy"));
});

test("no engine called the network", () => {
  assert.deepEqual(attempts, []);
});
