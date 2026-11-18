"use strict";

// MathCheck (Entity + Adapter), Watchman Whiteboard. The computer algebra behind check_math, so an agent can check its
// own working (or a person's) before it writes it on the board. LaTeX goes to the Compute Engine; plain text (2*x^2+3,
// sin(x)/x) to nerdamer, Algebrite, mathjs or SymPy (Pyodide, in a worker thread: math-libs.js runPython). The answer
// is one short text: "ok check task=... engine=..." and then result=, latex=, equal=, one line per step, or numbers.
// Errors are AppErrors: InvalidArguments (a task or engine that does not fit), InvalidMath (the engine's own words),
// MathUnavailable, MathTimeout. Called by talk-on-board's mcp.js check_math.

const { AppError } = require("./app-error");
const mathLibs = require("./math-libs");

const TASKS = Object.freeze(["equal", "steps", "simplify", "expand", "factor", "solve", "derivative", "integral", "limit", "evaluate", "statistics"]);
const ENGINES = Object.freeze(["auto", "compute-engine", "nerdamer", "algebrite", "mathjs", "sympy"]);
// What each engine does.
const SUPPORT = Object.freeze({
  "compute-engine": ["equal", "steps", "simplify", "expand", "factor", "solve", "derivative", "integral", "limit", "evaluate"],
  nerdamer: ["equal", "simplify", "expand", "factor", "solve", "derivative", "integral", "limit", "evaluate"],
  algebrite: ["equal", "simplify", "expand", "factor", "derivative", "integral", "evaluate"],
  mathjs: ["equal", "simplify", "derivative", "evaluate", "statistics"],
  sympy: ["equal", "steps", "simplify", "expand", "factor", "solve", "derivative", "integral", "limit", "evaluate"],
});
// The engine for plain text when none is named.
const TEXT_ENGINE = Object.freeze({
  equal: "algebrite", steps: "compute-engine", simplify: "algebrite", expand: "algebrite", factor: "algebrite", solve: "nerdamer",
  derivative: "algebrite", integral: "nerdamer", limit: "nerdamer", evaluate: "mathjs", statistics: "mathjs",
});
const VAR_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;
// Sample values for a numeric check, one list per variable (shifted for the next one), away from 0 and 1.
const SAMPLES = Object.freeze([0.7, 1.3, 2.1, -0.6, 3.7, -1.9, 0.35, 2.9]);
const MAX_TEXT = 2000;

// @purity pure
function invalidArgs(message) {
  return new AppError("InvalidArguments", 400, message);
}

// @purity pure
function invalidMath(message) {
  return new AppError("InvalidMath", 400, String(message).split("\n")[0].slice(0, 300));
}

// Whether `text` is LaTeX rather than plain text: a command or a brace, or a number written against a letter (5x) with
// no "*" anywhere (plain text writes 5*x). The format argument says it outright.
// @purity pure
function isLatex(text) {
  return /[\\{}]/.test(text) || (/\d[A-Za-z]/.test(text) && !text.includes("*"));
}

// A number in 4 significant digits, as text (no trailing zeros).
// @purity pure
function short(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) < 1e-12) return "0";
  return String(Number(n.toPrecision(4)));
}

// Whether `text` is a plain expression that Python's parser may see: no quotes, no attribute access, no dunder names,
// no statements. SymPy's parse_expr runs Python's eval on it (with no builtins); this keeps anything else out.
// @purity pure
function safePythonText(text) {
  return typeof text === "string" && text.length <= MAX_TEXT && /^[A-Za-z0-9_+\-*/^().,=<>!\[\] \t]*$/.test(text)
    && !text.includes("__") && !/\.[A-Za-z_]/.test(text) && !/\blambda\b/.test(text);
}

// The engine for `args`: the named one (if it does the task), else the default for its input.
// @purity pure
function pickEngine(args, texts) {
  if (args.engine && args.engine !== "auto") {
    if (!SUPPORT[args.engine].includes(args.task)) {
      throw invalidArgs(`${args.engine} does not do ${args.task}; it does ${SUPPORT[args.engine].join(", ")}`);
    }
    return args.engine;
  }
  if (args.task === "statistics") return "mathjs";
  const latex = args.format === "latex" || (args.format !== "text" && texts.some(isLatex));
  if (latex && SUPPORT["compute-engine"].includes(args.task)) return "compute-engine";
  return TEXT_ENGINE[args.task];
}

// @purity pure
function needText(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_TEXT) {
    throw invalidArgs(`${args.task} needs ${name}: 1 to ${MAX_TEXT} characters`);
  }
  return value;
}

// Compares two functions of the same variables at sample points. Returns { equal: "yes"|"no"|"unknown", counterexample }.
// valueOf(which, point) gives a number (or NaN) for expression 0 or 1 at point { name: value }.
// @purity pure
function numericCompare(names, valueOf) {
  let checked = 0;
  for (let i = 0; i < SAMPLES.length; i += 1) {
    const point = Object.fromEntries(names.map((name, k) => [name, SAMPLES[(i + k * 3) % SAMPLES.length] + k * 0.11]));
    const a = valueOf(0, point);
    const b = valueOf(1, point);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    checked += 1;
    if (Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))) {
      const where = names.map((name) => `${name}=${short(point[name])}`).join(", ");
      return { equal: "no", counterexample: `${where}: ${short(a)} vs ${short(b)}` };
    }
  }
  return { equal: checked >= 3 ? "yes" : "unknown", counterexample: null };
}

// @purity pure
function equalLine(found, method) {
  return `equal=${found.equal} method=${method}${found.counterexample ? ` counterexample=${found.counterexample}` : ""}`;
}

// ---- Compute Engine (LaTeX) ----

// @purity pure
function errorsOf(json, out = []) {
  if (Array.isArray(json)) {
    if (json[0] === "Error") out.push(String(json[1]).replace(/^'|'$/g, ""));
    for (const part of json) errorsOf(part, out);
  }
  return out;
}

// @purity non-pure
function ceParse(ce, latex) {
  const expr = ce.parse(latex);
  if (!expr.isValid) throw invalidMath(`Compute Engine: ${[...new Set(errorsOf(expr.json))].join(", ") || "the LaTeX is not valid"}`);
  return expr;
}

// @purity non-pure
function ceNumber(expr) {
  const value = expr.N();
  const re = value.re;
  if (typeof re === "number" && (value.im === 0 || value.im === undefined)) return re;
  const n = Number(value.valueOf());
  return Number.isFinite(n) ? n : NaN;
}

// @purity non-pure
function ceEqual(ce, a, b) {
  const symbolic = a.isEqual(b);
  if (symbolic === true) return { equal: { equal: "yes", counterexample: null }, method: "symbolic" };
  const expanded = (e) => ce.box(["Expand", e]).evaluate();
  if (expanded(a).isSame(expanded(b))) return { equal: { equal: "yes", counterexample: null }, method: "symbolic" };
  const names = [...new Set([...a.unknowns, ...b.unknowns])].sort();
  const found = numericCompare(names, (which, point) => {
    try {
      return ceNumber((which === 0 ? a : b).subs(point));
    } catch (error) {
      return NaN;
    }
  });
  return { equal: found, method: "numeric" };
}

// @purity pure
function isEquation(expr) {
  return Array.isArray(expr.json) && expr.json[0] === "Equal";
}

// @purity non-pure
function ceSolutions(expr, variable) {
  const roots = expr.solve(variable);
  if (!Array.isArray(roots)) return null;
  return [...new Set(roots.map((root) => root.latex))].sort((x, y) => (Number(x) - Number(y)) || x.localeCompare(y));
}

// The variable of `exprs`: the one named, else x when it appears, else the only unknown.
// @purity non-pure
function variableOf(args, unknowns) {
  if (args.var) return args.var;
  if (unknowns.includes("x") || unknowns.length === 0) return "x";
  return unknowns.length === 1 ? unknowns[0] : "x";
}

// @purity non-pure
async function withComputeEngine(args, libs) {
  const { ComputeEngine } = await libs.loadMathLib("compute-engine");
  const ce = new ComputeEngine();
  if (args.task === "steps") {
    const parsed = args.exprs.map((latex) => ceParse(ce, latex));
    const lines = [];
    let first = null;
    let unknown = false;
    for (let i = 1; i < parsed.length; i += 1) {
      const [a, b] = [parsed[i - 1], parsed[i]];
      let line;
      if (isEquation(a) && isEquation(b)) {
        const variable = variableOf(args, [...new Set([...a.unknowns, ...b.unknowns])]);
        const [sa, sb] = [ceSolutions(a, variable), ceSolutions(b, variable)];
        if (sa === null || sb === null) line = "unknown (cannot solve)";
        else line = sa.join(",") === sb.join(",") ? "ok" : `WRONG solutions {${sa.join(", ")}} vs {${sb.join(", ")}}`;
      } else if (isEquation(a) || isEquation(b)) {
        line = "unknown (an equation next to an expression)";
      } else {
        const { equal } = ceEqual(ce, a, b);
        line = equal.equal === "yes" ? "ok" : equal.equal === "no" ? `WRONG counterexample=${equal.counterexample}` : "unknown";
      }
      if (line.startsWith("WRONG") && first === null) first = i + 1;
      if (line.startsWith("unknown")) unknown = true;
      lines.push(`step ${i}->${i + 1} ${line}`);
    }
    lines.push(first !== null ? `all=wrong first=${first}` : unknown ? "all=unknown" : "all=ok");
    return lines;
  }
  const expr = ceParse(ce, needText(args, "expr"));
  const variable = variableOf(args, expr.unknowns);
  if (args.task === "equal") {
    const { equal, method } = ceEqual(ce, expr, ceParse(ce, needText(args, "expr2")));
    return [equalLine(equal, method)];
  }
  if (args.task === "solve") {
    const roots = ceSolutions(expr, variable);
    if (roots === null) throw invalidMath(`Compute Engine could not solve for ${variable}`);
    return [`result=${roots.join(", ")}`, `latex=${roots.join(", ")}`];
  }
  const run = {
    simplify: () => expr.simplify(),
    expand: () => ce.box(["Expand", expr]).evaluate(),
    factor: () => ce.box(["Factor", expr]).evaluate(),
    derivative: () => ce.box(["D", expr, variable]).evaluate(),
    integral: () => ce.box(["Integrate", expr, variable]).evaluate(),
    limit: () => expr.evaluate(),
    evaluate: () => expr.evaluate(),
  }[args.task];
  const result = run();
  if (!result.isValid) throw invalidMath(`Compute Engine: ${errorsOf(result.json).join(", ") || "no answer"}`);
  const lines = [`result=${String(result)}`, `latex=${result.latex}`];
  if (args.task === "evaluate" && result.unknowns.length === 0 && !result.isNumberLiteral) lines.splice(1, 0, `decimal=${short(ceNumber(result))}`);
  return lines;
}

// ---- nerdamer, Algebrite, mathjs (plain text) ----

// @purity non-pure
async function numericText(libs, a, b) {
  const math = await libs.loadMathLib("mathjs");
  let nodes;
  try {
    nodes = [math.parse(a), math.parse(b)];
  } catch (error) {
    return { equal: "unknown", counterexample: null };
  }
  const names = new Set();
  for (const node of nodes) {
    node.traverse((n, path, parent) => {
      const isFunctionName = parent && parent.type === "FunctionNode" && path === "fn";
      if (n.type === "SymbolNode" && !isFunctionName && !(n.name in math)) names.add(n.name);
    });
  }
  const compiled = nodes.map((node) => node.compile());
  return numericCompare([...names].sort(), (which, point) => {
    try {
      const value = compiled[which].evaluate({ ...point });
      return typeof value === "number" ? value : NaN;
    } catch (error) {
      return NaN;
    }
  });
}

// @purity non-pure
async function withNerdamer(args, libs) {
  const { nerdamer } = await libs.loadMathLib("nerdamer");
  const expr = needText(args, "expr");
  const variable = args.var || "x";
  const run = (text) => {
    try {
      return nerdamer(text);
    } catch (error) {
      throw invalidMath(`nerdamer: ${error && error.message}`);
    }
  };
  if (args.task === "equal") {
    const difference = run(`simplify((${expr})-(${needText(args, "expr2")}))`).toString();
    if (difference === "0") return [equalLine({ equal: "yes", counterexample: null }, "symbolic")];
    return [equalLine(await numericText(libs, expr, args.expr2), "numeric")];
  }
  if (args.task === "solve") {
    let roots;
    try {
      roots = nerdamer.solve(expr, variable).toString();
    } catch (error) {
      throw invalidMath(`nerdamer: ${error && error.message}`);
    }
    const list = roots.replace(/^[[{]|[\]}]$/g, "");
    return [`result=${list}`, `latex=${list}`];
  }
  const text = {
    simplify: () => `simplify(${expr})`,
    expand: () => `expand(${expr})`,
    factor: () => `factor(${expr})`,
    derivative: () => `diff(${expr},${variable})`,
    // nerdamer 2.0: defint(f, x, from, to).
    integral: () => (args.from !== undefined ? `defint(${expr},${variable},${needText(args, "from")},${needText(args, "to")})` : `integrate(${expr},${variable})`),
    limit: () => `limit(${expr},${variable},${needText(args, "at")})`,
    evaluate: () => expr,
  }[args.task]();
  const result = run(text);
  const value = args.task === "evaluate" ? result.evaluate() : result;
  return [`result=${value.toString()}`, `latex=${value.toTeX()}`];
}

// @purity non-pure
async function withAlgebrite(args, libs) {
  const { Algebrite } = await libs.loadMathLib("algebrite");
  const expr = needText(args, "expr");
  const variable = args.var || "x";
  const run = (text) => {
    // Algebrite keeps assignments from one run to the next: start clean each time.
    Algebrite.run("clearall");
    let out;
    try {
      out = String(Algebrite.run(text));
    } catch (error) {
      throw invalidMath(`Algebrite: ${error && error.message}`);
    }
    if (/^Stop:/.test(out)) throw invalidMath(`Algebrite: ${out.replace(/^Stop:\s*/, "")}`);
    return out;
  };
  if (args.task === "equal") {
    const difference = run(`simplify((${expr})-(${needText(args, "expr2")}))`);
    if (difference === "0") return [equalLine({ equal: "yes", counterexample: null }, "symbolic")];
    return [equalLine(await numericText(libs, expr, args.expr2), "numeric")];
  }
  const text = {
    simplify: () => `simplify(${expr})`,
    expand: () => `expand(${expr})`,
    factor: () => `factor(${expr})`,
    derivative: () => `d(${expr},${variable})`,
    integral: () => (args.from !== undefined ? `defint(${expr},${variable},${needText(args, "from")},${needText(args, "to")})` : `integral(${expr},${variable})`),
    evaluate: () => `float(${expr})`,
  }[args.task]();
  return [`result=${run(text)}`];
}

// @purity non-pure
async function withMathjs(args, libs) {
  const math = await libs.loadMathLib("mathjs");
  const format = (value) => math.format(value, { precision: 14 });
  if (args.task === "statistics") return statistics(math, args);
  const expr = needText(args, "expr");
  const attempt = (run) => {
    try {
      return run();
    } catch (error) {
      throw invalidMath(`mathjs: ${error && error.message}`);
    }
  };
  if (args.task === "equal") return [equalLine(await numericText(libs, expr, needText(args, "expr2")), "numeric")];
  if (args.task === "simplify") return [`result=${attempt(() => math.simplify(expr).toString())}`];
  if (args.task === "derivative") return [`result=${attempt(() => math.derivative(expr, args.var || "x").toString())}`];
  return [`result=${attempt(() => format(math.evaluate(expr)))}`];
}

// The statistics of `data` (and a straight-line fit with `data2`).
// @purity non-pure
function statistics(math, args) {
  const data = args.data;
  if (!Array.isArray(data) || data.length < 1 || !data.every(Number.isFinite)) throw invalidArgs("statistics needs data: a list of numbers");
  const mode = math.mode(data);
  const line = [
    `n=${data.length}`, `mean=${short(math.mean(data))}`, `median=${short(math.median(data))}`,
    `mode=${mode.length === data.length ? "none" : mode.map(short).join(",")}`,
    `sd=${data.length > 1 ? short(math.std(data)) : "0"}`, `sdPopulation=${short(math.std(data, "uncorrected"))}`,
    `min=${short(math.min(data))}`, `max=${short(math.max(data))}`,
    `q1=${short(math.quantileSeq(data, 0.25))}`, `q3=${short(math.quantileSeq(data, 0.75))}`,
  ].join(" ");
  const lines = [line];
  if (args.data2 !== undefined) {
    const ys = args.data2;
    if (!Array.isArray(ys) || ys.length !== data.length || data.length < 2 || !ys.every(Number.isFinite)) {
      throw invalidArgs("data2 needs as many numbers as data (at least 2)");
    }
    const fit = linearFit(data, ys);
    lines.push(`regression slope=${short(fit.slope)} intercept=${short(fit.intercept)} r=${short(fit.r)} r2=${short(fit.r * fit.r)}`);
  }
  return lines;
}

// Least squares y = slope x + intercept, and Pearson's r.
// @purity pure
function linearFit(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxx === 0 ? NaN : sxy / sxx;
  return { slope, intercept: my - slope * mx, r: sxx === 0 || syy === 0 ? NaN : sxy / Math.sqrt(sxx * syy) };
}

// ---- SymPy (Pyodide) ----

// The program run in the Python worker: parse with SymPy's names only (no builtins), then do wb_in["task"].
const SYMPY_PROGRAM = String.raw`
import sympy as _sp
from sympy.parsing.sympy_parser import parse_expr as _pe, standard_transformations as _st, implicit_multiplication_application as _ima, convert_xor as _cx
_G = {_n: getattr(_sp, _n) for _n in dir(_sp) if not _n.startswith("_")}
_G["__builtins__"] = {}
_T = _st + (_ima, _cx)
def _one(s):
    return _pe(s, local_dict={}, global_dict=dict(_G), transformations=_T)
def _p(s):
    if "=" in s and not any(op in s for op in ("==", "<=", ">=", "!=")):
        l, r = s.split("=", 1)
        return _sp.Eq(_one(l), _one(r))
    return _one(s)
def _run(i):
    t = i["task"]
    x = _sp.Symbol(i["var"])
    if t == "steps":
        es = [_p(s) for s in i["exprs"]]
        out = []
        for k in range(1, len(es)):
            a, b = es[k - 1], es[k]
            if isinstance(a, _sp.Equality) and isinstance(b, _sp.Equality):
                sa, sb = set(_sp.solve(a, x)), set(_sp.solve(b, x))
                out.append("ok" if sa == sb else "WRONG solutions {%s} vs {%s}" % (", ".join(map(str, sorted(sa, key=str))), ", ".join(map(str, sorted(sb, key=str)))))
            elif isinstance(a, _sp.Equality) or isinstance(b, _sp.Equality):
                out.append("unknown (an equation next to an expression)")
            else:
                d = _sp.simplify(a - b)
                out.append("ok" if d == 0 else "WRONG difference=%s" % d)
        return out
    e = _p(i["expr"])
    if t == "equal":
        d = _sp.simplify(e - _p(i["expr2"]))
        if d == 0:
            return ["yes", "symbolic", ""]
        for v in (0.7, 1.3, 2.1, -0.6, 3.7):
            val = complex(d.subs({s: v for s in d.free_symbols}).evalf())
            if abs(val) > 1e-9:
                return ["no", "numeric", ", ".join("%s=%s" % (s, v) for s in sorted(d.free_symbols, key=str)) + ": difference " + str(_sp.N(val, 4))]
        return ["unknown", "numeric", ""]
    if t == "simplify": r = _sp.simplify(e)
    elif t == "expand": r = _sp.expand(e)
    elif t == "factor": r = _sp.factor(e)
    elif t == "solve": r = _sp.solve(e, x)
    elif t == "derivative": r = _sp.diff(e, x)
    elif t == "integral": r = _sp.integrate(e, (x, _p(i["from"]), _p(i["to"]))) if i.get("from") is not None else _sp.integrate(e, x)
    elif t == "limit": r = _sp.limit(e, x, _p(i["at"]))
    elif t == "evaluate": r = _sp.N(e)
    return [str(r), _sp.latex(r)]
_run(wb_in)
`;

// @purity non-pure
async function withSympy(args, libs) {
  const texts = args.task === "steps" ? args.exprs : [needText(args, "expr"), ...["expr2", "from", "to", "at"].filter((k) => args[k] !== undefined).map((k) => args[k])];
  if (args.task === "equal") needText(args, "expr2");
  if (args.task === "limit") needText(args, "at");
  const bad = texts.find((text) => !safePythonText(text));
  if (bad !== undefined) throw invalidMath(`SymPy takes plain math text only (letters, digits, + - * / ^ ( ) , = < > ! [ ]): ${JSON.stringify(String(bad).slice(0, 60))}`);
  const inputs = {
    task: args.task, var: args.var || "x", expr: args.expr || "", expr2: args.expr2 || "", exprs: args.exprs || [],
    from: args.from === undefined ? null : args.from, to: args.to === undefined ? null : args.to, at: args.at || "",
  };
  const out = await libs.runPython(SYMPY_PROGRAM, inputs);
  if (args.task === "steps") {
    const first = out.findIndex((line) => line.startsWith("WRONG"));
    const lines = out.map((line, i) => `step ${i + 1}->${i + 2} ${line}`);
    lines.push(first >= 0 ? `all=wrong first=${first + 2}` : out.some((l) => l.startsWith("unknown")) ? "all=unknown" : "all=ok");
    return lines;
  }
  if (args.task === "equal") return [equalLine({ equal: out[0], counterexample: out[2] || null }, out[1])];
  return [`result=${out[0]}`, `latex=${out[1]}`];
}

const RUNNERS = Object.freeze({
  "compute-engine": withComputeEngine, nerdamer: withNerdamer, algebrite: withAlgebrite, mathjs: withMathjs, sympy: withSympy,
});

// Does `args.task` with `args.engine` (auto by default) and returns the answer text. `libs`: lib/math-libs.js.
// @purity non-pure
async function checkMath(args, libs = mathLibs) {
  if (!TASKS.includes(args.task)) throw invalidArgs(`task must be one of ${TASKS.join(", ")}`);
  if (args.engine !== undefined && !ENGINES.includes(args.engine)) throw invalidArgs(`engine must be one of ${ENGINES.join(", ")}`);
  if (args.var !== undefined && !VAR_PATTERN.test(args.var)) throw invalidArgs("var must be a variable name such as x or t");
  if (args.format !== undefined && !["latex", "text"].includes(args.format)) throw invalidArgs("format must be latex or text");
  if (args.task === "steps" && !(Array.isArray(args.exprs) && args.exprs.length >= 2 && args.exprs.every((e) => typeof e === "string" && e.trim() !== "" && e.length <= MAX_TEXT))) {
    throw invalidArgs("steps needs exprs: a list of 2 or more expressions or equations, in order");
  }
  if ((args.from === undefined) !== (args.to === undefined)) throw invalidArgs("give both from and to, or neither");
  const texts = args.task === "steps" ? args.exprs : [args.expr, args.expr2].filter((t) => typeof t === "string");
  const engine = pickEngine(args, texts);
  const lines = await RUNNERS[engine](args, libs);
  return [`ok check task=${args.task} engine=${engine}`, ...lines].join("\n");
}

module.exports = { checkMath, safePythonText, linearFit, numericCompare, TASKS, ENGINES, SUPPORT };
