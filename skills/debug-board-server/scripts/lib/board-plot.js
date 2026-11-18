"use strict";

// BoardPlot (Entity), Watchman Whiteboard. Function plots (draw_plot) and data charts with their written summary
// (draw_chart) as the board's own elements: lines for curves and axes, rectangles for bars, ellipses for points, texts
// for ticks, labels and the summary. So each part has an id an agent can change (edit_items) or erase (delete_items),
// the board's drawing animation traces each curve like a pen, and nothing here needs a browser. mathjs evaluates and
// sums (passed in: lib/math-libs.js loadMathLib("mathjs")). The result is a list of Skeletons for POST /v1/draw, at
// (0, 0); the board places the drawing. Errors are AppError InvalidPlot (400) with the field that is wrong.
// Called by talk-on-board's mcp.js (draw_plot, draw_chart).

const { AppError } = require("./app-error");
const { AGENT_INK } = require("./agent-ink");

// Where the plot area sits in the drawing: room above for the title, at the left for the y ticks.
const PLOT_BOX = Object.freeze({ left: 70, top: 56, width: 600, height: 400 });
// The first series in the agent's ink (agent-ink.js); "blue" in NAMED stays blue for an agent that asks for it.
const PALETTE = Object.freeze([AGENT_INK, "#1971c2", "#e03131", "#2f9e44", "#f08c00", "#9c36b5", "#0c8599", "#e8590c", "#495057"]);
const NAMED = Object.freeze({
  blue: "#1971c2", red: "#e03131", green: "#2f9e44", orange: "#f08c00", violet: "#9c36b5", cyan: "#0c8599", gray: "#495057", black: "#1e1e1e",
});
const AXIS_COLOR = "#495057";
const GRID_COLOR = "#ced4da";
const TEXT_COLOR = "#1e1e1e";
const SUMMARY_COLOR = "#495057";
const AGENT_BLUE = AGENT_INK;
// Excalidraw font numbers: 6 Nunito (clean, for numbers), 5 Excalifont (hand-written, for the explanation).
const FONT_CLEAN = 6;
const FONT_HAND = 5;
const SAMPLES = 600;
const MAX_POINTS = 100;
const MAX_FUNCTIONS = 8;
const TWO_PI = 2 * Math.PI;

// @purity pure
function invalid(message) {
  return new AppError("InvalidPlot", 400, message);
}

// @purity pure
function round(n) {
  return Math.round(n * 10) / 10;
}

// A number in at most 4 significant digits (no trailing zeros, no "-0").
// @purity pure
function short(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) < 1e-9) return "0";
  return String(Number(n.toPrecision(4)));
}

// @purity pure
function textWidth(text, fontSize) {
  return Math.max(...String(text).split("\n").map((line) => line.length)) * fontSize * 0.55;
}

// A color: a name of NAMED, a #hex, else the palette's color number `index`.
// @purity pure
function colorOf(wanted, index) {
  if (typeof wanted === "string" && NAMED[wanted]) return NAMED[wanted];
  if (typeof wanted === "string" && /^#[0-9a-fA-F]{6}$/.test(wanted)) return wanted;
  return PALETTE[index % PALETTE.length];
}

// Breaks `text` into lines of at most `width` characters, at spaces.
// @purity pure
function wrap(text, width = 64) {
  return String(text).split("\n").map((paragraph) => {
    const lines = [];
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
    return lines.join("\n");
  }).join("\n");
}

// ---- Skeletons ----

// @purity pure
function lineOf(id, points, style = {}) {
  const [x0, y0] = points[0];
  return {
    type: "line", id, x: round(x0), y: round(y0), points: points.map(([x, y]) => [round(x - x0), round(y - y0)]),
    strokeColor: style.color || AXIS_COLOR, strokeWidth: style.width || 1, roughness: 0,
    ...(style.dashed ? { strokeStyle: "dashed" } : {}), ...(style.opacity !== undefined ? { opacity: style.opacity } : {}),
  };
}

// @purity pure
function arrowOf(id, from, to) {
  return {
    type: "arrow", id, x: round(from[0]), y: round(from[1]), points: [[0, 0], [round(to[0] - from[0]), round(to[1] - from[1])]],
    strokeColor: AXIS_COLOR, strokeWidth: 1, roughness: 0, startArrowhead: null, endArrowhead: "arrow",
  };
}

// @purity pure
function textOf(id, x, y, text, { size = 14, color = TEXT_COLOR, font = FONT_CLEAN } = {}) {
  return { type: "text", id, x: round(x), y: round(y), text: String(text), fontSize: size, fontFamily: font, strokeColor: color };
}

// @purity pure
function rectOf(id, x, y, width, height, color) {
  return {
    type: "rectangle", id, x: round(x), y: round(y), width: round(width), height: round(height),
    strokeColor: color, backgroundColor: color, fillStyle: "solid", strokeWidth: 1, roughness: 0, opacity: 80,
  };
}

// @purity pure
function dotOf(id, cx, cy, color, r = 4) {
  return {
    type: "ellipse", id, x: round(cx - r), y: round(cy - r), width: 2 * r, height: 2 * r,
    strokeColor: color, backgroundColor: color, fillStyle: "solid", strokeWidth: 1, roughness: 0,
  };
}

// ---- Scales and axes ----

// Round tick values from min to max: { step, ticks }, about `target` of them (steps of 1, 2 or 5 times a power of 10).
// @purity pure
function niceTicks(min, max, target = 8) {
  const raw = (max - min) / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * magnitude;
  const ticks = [];
  for (let k = Math.ceil(min / step - 1e-9); k * step <= max + step * 1e-9; k += 1) ticks.push(Number((k * step).toFixed(12)));
  return { step: Number(step.toFixed(12)), ticks };
}

// @purity pure
function tickText(value, step) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const text = value.toFixed(decimals);
  return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
}

// The map from values to board points over PLOT_BOX.
// @purity pure
function scaleOf(xRange, yRange) {
  const [x0, x1] = xRange;
  const [y0, y1] = yRange;
  return {
    px: (x) => PLOT_BOX.left + ((x - x0) / (x1 - x0)) * PLOT_BOX.width,
    py: (y) => PLOT_BOX.top + ((y1 - y) / (y1 - y0)) * PLOT_BOX.height,
    xRange, yRange,
  };
}

// Grid lines, the two axes (through 0 when 0 is in range, else at the edges), tick labels, axis names, and the title.
// @purity pure
function axesOf(prefix, scale, spec, { grid = true, xTicks = null, atZero = true } = {}) {
  const out = [];
  const { px, py, xRange, yRange } = scale;
  const xt = xTicks || niceTicks(xRange[0], xRange[1]);
  const yt = niceTicks(yRange[0], yRange[1], 6);
  const zeroX = atZero && xRange[0] < 0 && xRange[1] > 0;
  const zeroY = atZero && yRange[0] < 0 && yRange[1] > 0;
  const axisY = zeroY ? py(0) : PLOT_BOX.top + PLOT_BOX.height;
  const axisX = zeroX ? px(0) : PLOT_BOX.left;
  const right = PLOT_BOX.left + PLOT_BOX.width;
  const bottom = PLOT_BOX.top + PLOT_BOX.height;
  if (grid) {
    xt.ticks.forEach((value, k) => {
      if (Math.abs(px(value) - axisX) > 0.5) out.push(lineOf(`${prefix}-gx${k + 1}`, [[px(value), PLOT_BOX.top], [px(value), bottom]], { color: GRID_COLOR, opacity: 70 }));
    });
    yt.ticks.forEach((value, k) => {
      if (Math.abs(py(value) - axisY) > 0.5) out.push(lineOf(`${prefix}-gy${k + 1}`, [[PLOT_BOX.left, py(value)], [right, py(value)]], { color: GRID_COLOR, opacity: 70 }));
    });
  }
  out.push(arrowOf(`${prefix}-axis-x`, [PLOT_BOX.left, axisY], [right + 14, axisY]));
  out.push(arrowOf(`${prefix}-axis-y`, [axisX, bottom], [axisX, PLOT_BOX.top - 14]));
  if (!spec.categoryAxis) {
    xt.ticks.forEach((value, k) => {
      if (zeroX && zeroY && value === 0) return;
      const label = xt.labels ? xt.labels[k] : tickText(value, xt.step);
      out.push(textOf(`${prefix}-tx${k + 1}`, px(value) - textWidth(label, 14) / 2, axisY + 6, label));
    });
  }
  yt.ticks.forEach((value, k) => {
    if (zeroX && zeroY && value === 0) return;
    const label = tickText(value, yt.step);
    out.push(textOf(`${prefix}-ty${k + 1}`, axisX - 8 - textWidth(label, 14), py(value) - 9, label));
  });
  if (zeroX && zeroY) out.push(textOf(`${prefix}-t0`, axisX - 16, axisY + 4, "0"));
  if (spec.xLabel) out.push(textOf(`${prefix}-xlabel`, right - textWidth(spec.xLabel, 16), axisY + (zeroY ? -24 : 28), spec.xLabel, { size: 16 }));
  if (spec.yLabel) out.push(textOf(`${prefix}-ylabel`, axisX + 10, PLOT_BOX.top - 16, spec.yLabel, { size: 16 }));
  if (spec.title) out.push(textOf(`${prefix}-title`, PLOT_BOX.left, 4, spec.title, { size: 24, font: FONT_HAND }));
  return out;
}

// ---- Curves ----

// Ramer-Douglas-Peucker: the points of `points` (board px) that keep its shape within `tolerance` px.
// @purity pure
function simplify(points, tolerance = 0.4) {
  if (points.length < 3) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const length = Math.hypot(bx - ax, by - ay) || 1;
    let far = -1;
    let farDistance = tolerance;
    for (let i = a + 1; i < b; i += 1) {
      const d = Math.abs((bx - ax) * (ay - points[i][1]) - (ax - points[i][0]) * (by - ay)) / length;
      if (d > farDistance) {
        far = i;
        farDistance = d;
      }
    }
    if (far >= 0) {
      keep[far] = true;
      stack.push([a, far], [far, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// The pieces of a sampled curve that lie in the box: a piece ends where the curve leaves the box (cut at the edge),
// has no value, or jumps (an asymptote). `values`: [[x, y]] (NaN where there is none).
// @purity pure
function piecesOf(values, scale) {
  const [x0, x1] = scale.xRange;
  const [y0, y1] = scale.yRange;
  const inside = ([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x >= x0 && x <= x1 && y >= y0 && y <= y1;
  // Where the segment from inside point a to b crosses the box edge.
  const edge = (a, b) => {
    let t = 1;
    for (const [value, lo, hi, from] of [[b[0], x0, x1, a[0]], [b[1], y0, y1, a[1]]]) {
      if (value < lo) t = Math.min(t, (lo - from) / (value - from));
      if (value > hi) t = Math.min(t, (hi - from) / (value - from));
    }
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  };
  const pieces = [];
  let piece = [];
  const close = () => {
    if (piece.length >= 2) pieces.push(piece);
    piece = [];
  };
  for (let i = 0; i < values.length; i += 1) {
    const point = values[i];
    const before = values[i - 1];
    const finite = Number.isFinite(point[0]) && Number.isFinite(point[1]);
    const beforeFinite = before && Number.isFinite(before[0]) && Number.isFinite(before[1]);
    if (inside(point)) {
      const jump = beforeFinite && piece.length > 0 && Math.abs(scale.py(point[1]) - scale.py(before[1])) > PLOT_BOX.height * 0.5;
      if (jump) close();
      if (piece.length === 0 && beforeFinite && !inside(before)) {
        const cut = edge(point, before);
        if (Math.abs(scale.py(cut[1]) - scale.py(point[1])) < PLOT_BOX.height * 0.5) piece.push(cut);
      }
      piece.push(point);
    } else {
      if (piece.length > 0 && finite) {
        const cut = edge(before, point);
        if (Math.abs(scale.py(cut[1]) - scale.py(before[1])) < PLOT_BOX.height * 0.5) piece.push(cut);
      }
      close();
    }
  }
  close();
  return pieces.map((list) => list.map(([x, y]) => [scale.px(x), scale.py(y)]));
}

// Line Skeletons of at most MAX_POINTS points each, for the pieces of one curve: `${base}-1`, `${base}-2`, ...
// @purity pure
function curveLines(base, pieces, color) {
  const out = [];
  for (const piece of pieces) {
    const points = simplify(piece);
    for (let start = 0; start < points.length - 1; start += MAX_POINTS - 1) {
      out.push(lineOf(`${base}-${out.length + 1}`, points.slice(start, start + MAX_POINTS), { color, width: 2 }));
    }
  }
  return out;
}

// @purity pure
function rangeOf(given, name) {
  if (given === undefined) return null;
  if (!(Array.isArray(given) && given.length === 2 && given.every(Number.isFinite) && given[0] < given[1])) {
    throw invalid(`${name} must be [min, max] with min < max`);
  }
  return given;
}

// A robust range of `values` (2nd to 98th percentile, so an asymptote does not flatten the curve), padded by 8%.
// @purity pure
function autoRange(values, robust) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return [-1, 1];
  const at = (q) => finite[Math.min(finite.length - 1, Math.max(0, Math.round(q * (finite.length - 1))))];
  let [lo, hi] = robust ? [at(0.02), at(0.98)] : [finite[0], finite[finite.length - 1]];
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

const compiledMath = new WeakMap();

// mathjs with predictable results (sqrt(-1) is NaN, not a complex number), made once per mathjs module.
// @purity non-pure
function predictable(math) {
  if (!compiledMath.has(math)) compiledMath.set(math, math.create(math.all, { predictable: true }));
  return compiledMath.get(math);
}

// @purity pure
function numberOf(value) {
  return typeof value === "number" ? value : NaN;
}

// The samples [[x, y]] of function `index` and its label.
// @purity non-pure
function sampleFunction(m, fn, index, xGiven) {
  const where = `functions[${index}]`;
  const compile = (text, name) => {
    if (typeof text !== "string" || text.trim() === "" || text.length > 500) throw invalid(`${where}: ${name} must be 1 to 500 characters`);
    try {
      return m.compile(text);
    } catch (error) {
      throw invalid(`${where}: ${error && error.message}`);
    }
  };
  let firstError = null;
  const at = (compiled, scope) => {
    try {
      return numberOf(compiled.evaluate(scope));
    } catch (error) {
      if (firstError === null) firstError = error && error.message;
      return NaN;
    }
  };
  const tRange = rangeOf(fn.t, `${where}.t`) || [0, TWO_PI];
  const steps = Array.from({ length: SAMPLES + 1 }, (_, i) => i / SAMPLES);
  let values;
  let label;
  if (fn.expr !== undefined) {
    const f = compile(fn.expr, "expr");
    const [a, b] = xGiven || [-10, 10];
    values = steps.map((s) => {
      const x = a + s * (b - a);
      return [x, at(f, { x })];
    });
    label = `y = ${fn.expr}`;
  } else if (fn.x !== undefined && fn.y !== undefined) {
    const fx = compile(fn.x, "x");
    const fy = compile(fn.y, "y");
    values = steps.map((s) => {
      const t = tRange[0] + s * (tRange[1] - tRange[0]);
      return [at(fx, { t }), at(fy, { t })];
    });
    label = `(${fn.x}, ${fn.y})`;
  } else if (fn.r !== undefined) {
    const fr = compile(fn.r, "r");
    values = steps.map((s) => {
      const t = tRange[0] + s * (tRange[1] - tRange[0]);
      const r = at(fr, { t });
      return [r * Math.cos(t), r * Math.sin(t)];
    });
    label = `r = ${fn.r}`;
  } else {
    throw invalid(`${where}: give expr (y = f(x)), x and y (of t), or r (of t)`);
  }
  if (!values.some(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) {
    throw invalid(`${where}: no value anywhere in the range${firstError ? ` (${firstError})` : ""}`);
  }
  return { values, label: typeof fn.label === "string" && fn.label ? fn.label : label };
}

// draw_plot: `spec` { functions: [{expr} | {x, y, t} | {r, t}, with label, color], x, y, equalAxes, grid, points,
// title, xLabel, yLabel }. Returns { skeletons, info: { x, y } }.
// @purity non-pure
function buildFunctionPlot(spec, math, prefix) {
  const m = predictable(math);
  const functions = spec.functions;
  if (!Array.isArray(functions) || functions.length < 1 || functions.length > MAX_FUNCTIONS) throw invalid(`functions must be a list of 1 to ${MAX_FUNCTIONS}`);
  const xGiven = rangeOf(spec.x, "x");
  const yGiven = rangeOf(spec.y, "y");
  const sampled = functions.map((fn, i) => sampleFunction(m, fn, i, xGiven));
  const allX = sampled.flatMap((s) => s.values.map((v) => v[0]));
  const allY = sampled.flatMap((s) => s.values.map((v) => v[1]));
  const pointXs = (spec.points || []).map((p) => p.x);
  const pointYs = (spec.points || []).map((p) => p.y);
  let xRange = xGiven || autoRange([...allX, ...pointXs], false);
  let yRange = yGiven || autoRange([...allY, ...pointYs], true);
  if (spec.equalAxes) {
    const unit = Math.min(PLOT_BOX.width / (xRange[1] - xRange[0]), PLOT_BOX.height / (yRange[1] - yRange[0]));
    const cx = (xRange[0] + xRange[1]) / 2;
    const cy = (yRange[0] + yRange[1]) / 2;
    xRange = [cx - PLOT_BOX.width / unit / 2, cx + PLOT_BOX.width / unit / 2];
    yRange = [cy - PLOT_BOX.height / unit / 2, cy + PLOT_BOX.height / unit / 2];
  }
  const scale = scaleOf(xRange, yRange);
  const skeletons = axesOf(prefix, scale, spec, { grid: spec.grid !== false });
  // Labels already placed, so the next one moves down until it is clear of them all.
  const placed = [];
  sampled.forEach((s, i) => {
    const color = colorOf(functions[i].color, i);
    const lines = curveLines(`${prefix}-f${i + 1}`, piecesOf(s.values, scale), color);
    skeletons.push(...lines);
    if (lines.length > 0) {
      const last = lines[lines.length - 1];
      const [ex, ey] = [last.x + last.points[last.points.length - 1][0], last.y + last.points[last.points.length - 1][1]];
      const width = textWidth(s.label, 16);
      const x = ex + 8 + width > PLOT_BOX.left + PLOT_BOX.width + 60 ? ex - 8 - width : ex + 8;
      let y = Math.max(PLOT_BOX.top, ey - 22);
      const hits = (box) => placed.some((p) => box.x < p.x + p.w && p.x < box.x + box.w && box.y < p.y + 22 && p.y < box.y + 22);
      for (let tries = 0; tries < 20 && hits({ x, y, w: width }); tries += 1) y += 22;
      placed.push({ x, y, w: width });
      skeletons.push(textOf(`${prefix}-f${i + 1}-label`, x, y, s.label, { size: 16, color }));
    }
  });
  (spec.points || []).forEach((point, i) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw invalid(`points[${i}] needs numbers x and y`);
    const color = colorOf(point.color, 7);
    skeletons.push(dotOf(`${prefix}-pt${i + 1}`, scale.px(point.x), scale.py(point.y), color, 5));
    if (point.label) skeletons.push(textOf(`${prefix}-pt${i + 1}-label`, scale.px(point.x) + 8, scale.py(point.y) - 24, point.label, { size: 16, color }));
  });
  return { skeletons, info: { x: xRange.map(Number), y: yRange.map(Number) } };
}

// ---- Data charts ----

// @purity pure
function numbersOf(list, name, min = 1) {
  if (!Array.isArray(list) || list.length < min || !list.every(Number.isFinite)) throw invalid(`${name} must be a list of at least ${min} numbers`);
  return list;
}

// "n = 3, mean = 3, median = 3, sd = 3, min = 0 (Wed), max = 6 (Tue)": the numbers of one series.
// @purity non-pure
function describe(m, values, names = null) {
  const parts = [`n = ${values.length}`, `mean = ${short(m.mean(values))}`, `median = ${short(m.median(values))}`];
  parts.push(`sd = ${values.length > 1 ? short(m.std(values)) : "0"}`);
  const lo = values.indexOf(Math.min(...values));
  const hi = values.indexOf(Math.max(...values));
  parts.push(`min = ${short(values[lo])}${names ? ` (${names[lo]})` : ""}`, `max = ${short(values[hi])}${names ? ` (${names[hi]})` : ""}`);
  return parts.join(", ");
}

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
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r: sxy / Math.sqrt(sxx * syy) };
}

// The value range of a chart's y axis: 0 included, ends on round ticks.
// @purity pure
function valueRange(values, withZero = true) {
  let lo = Math.min(...values, ...(withZero ? [0] : []));
  let hi = Math.max(...values, ...(withZero ? [0] : []));
  if (hi - lo < 1e-9) hi = lo + 1;
  const { step } = niceTicks(lo, hi, 6);
  // + 1e-9: a value on a tick (0 above all) stays on it; seen in Chrome, - 1e-9 put a chart of positive bars on -1.
  lo = Math.floor(lo / step + 1e-9) * step;
  hi = Math.ceil(hi / step - 1e-9) * step;
  return [lo, hi === lo ? lo + step : hi];
}

// The series of a bar or line chart, checked against the categories.
// @purity pure
function seriesOf(spec) {
  const categories = spec.categories;
  if (!Array.isArray(categories) || categories.length < 1 || categories.length > 40 || !categories.every((c) => typeof c === "string")) {
    throw invalid("categories must be a list of 1 to 40 names");
  }
  if (!Array.isArray(spec.series) || spec.series.length < 1 || spec.series.length > 6) throw invalid("series must be a list of 1 to 6 {name, values}");
  spec.series.forEach((s, j) => {
    if (!s || !Array.isArray(s.values) || s.values.length !== categories.length || !s.values.every(Number.isFinite)) {
      throw invalid(`series[${j}].values must have one number per category (${categories.length})`);
    }
  });
  return { categories, series: spec.series };
}

// Category names under the x axis, and a legend when there is more than one series.
// @purity pure
function categoryLabels(prefix, categories, centerOf, series) {
  const out = categories.map((name, i) => textOf(`${prefix}-cat${i + 1}`, centerOf(i) - textWidth(name, 14) / 2, PLOT_BOX.top + PLOT_BOX.height + 8, name));
  if (series.length > 1) {
    series.forEach((s, j) => {
      const y = PLOT_BOX.top + j * 24;
      const x = PLOT_BOX.left + PLOT_BOX.width + 24;
      out.push(rectOf(`${prefix}-legend${j + 1}-key`, x, y + 4, 14, 14, colorOf(s.color, j)));
      out.push(textOf(`${prefix}-legend${j + 1}`, x + 20, y, String(s.name || `series ${j + 1}`)));
    });
  }
  return out;
}

// @purity non-pure
function barChart(m, spec, prefix) {
  const { categories, series } = seriesOf(spec);
  const yRange = valueRange(series.flatMap((s) => s.values));
  const scale = scaleOf([0, categories.length], yRange);
  const out = axesOf(prefix, scale, { ...spec, categoryAxis: true }, { atZero: false });
  const group = PLOT_BOX.width / categories.length;
  const barWidth = (group * 0.7) / series.length;
  series.forEach((s, j) => {
    const color = colorOf(s.color, j);
    s.values.forEach((value, i) => {
      const x = PLOT_BOX.left + i * group + group * 0.15 + j * barWidth;
      const [top, base] = [scale.py(Math.max(value, 0)), scale.py(Math.min(value, 0))];
      out.push(rectOf(`${prefix}-s${j + 1}-b${i + 1}`, x, top, barWidth, base - top, color));
      out.push(textOf(`${prefix}-s${j + 1}-v${i + 1}`, x + barWidth / 2 - textWidth(short(value), 12) / 2, top - 18, short(value), { size: 12 }));
    });
  });
  out.push(...categoryLabels(prefix, categories, (i) => PLOT_BOX.left + (i + 0.5) * group, series));
  const summary = series.map((s, j) => `${s.name || `series ${j + 1}`}: ${describe(m, s.values, categories)}`).join("\n");
  return { out, summary };
}

// @purity non-pure
function lineChart(m, spec, prefix) {
  const { categories, series } = seriesOf(spec);
  const yRange = valueRange(series.flatMap((s) => s.values), false);
  const scale = scaleOf([0, categories.length], yRange);
  const out = axesOf(prefix, scale, { ...spec, categoryAxis: true }, { atZero: false });
  const centerOf = (i) => PLOT_BOX.left + ((i + 0.5) * PLOT_BOX.width) / categories.length;
  series.forEach((s, j) => {
    const color = colorOf(s.color, j);
    const points = s.values.map((value, i) => [centerOf(i), scale.py(value)]);
    if (points.length >= 2) out.push(lineOf(`${prefix}-s${j + 1}-line`, points.slice(0, MAX_POINTS), { color, width: 2 }));
    points.forEach(([x, y], i) => out.push(dotOf(`${prefix}-s${j + 1}-p${i + 1}`, x, y, color)));
  });
  out.push(...categoryLabels(prefix, categories, centerOf, series));
  const summary = series.map((s, j) => `${s.name || `series ${j + 1}`}: ${describe(m, s.values, categories)}`).join("\n");
  return { out, summary };
}

// @purity non-pure
function scatterChart(m, spec, prefix) {
  const xs = numbersOf(spec.x, "x", 2);
  const ys = numbersOf(spec.y, "y", 2);
  if (xs.length !== ys.length || xs.length > 300) throw invalid("x and y must have the same length, at most 300");
  const scale = scaleOf(valueRange(xs, false), valueRange(ys, false));
  const out = axesOf(prefix, scale, spec, { atZero: false });
  const color = colorOf(spec.color, 0);
  xs.forEach((x, i) => out.push(dotOf(`${prefix}-s1-p${i + 1}`, scale.px(x), scale.py(ys[i]), color)));
  let summary = `n = ${xs.length}, x mean = ${short(m.mean(xs))}, y mean = ${short(m.mean(ys))}`;
  if (spec.fit) {
    const fit = linearFit(xs, ys);
    const f = (x) => fit.slope * x + fit.intercept;
    const pieces = piecesOf(Array.from({ length: 41 }, (_, k) => {
      const x = scale.xRange[0] + (k / 40) * (scale.xRange[1] - scale.xRange[0]);
      return [x, f(x)];
    }), scale);
    if (pieces.length > 0) out.push(lineOf(`${prefix}-fit`, simplify(pieces[0]), { color: colorOf("red", 1), width: 2, dashed: true }));
    const sign = fit.intercept < 0 && short(fit.intercept) !== "0" ? "-" : "+";
    summary += `; fit: y = ${short(fit.slope)}x ${sign} ${short(Math.abs(fit.intercept))}, r = ${short(fit.r)}`;
  }
  return { out, summary };
}

// @purity non-pure
function histogramChart(m, spec, prefix) {
  const data = numbersOf(spec.data, "data", 2);
  const bins = spec.bins === undefined ? Math.min(30, Math.ceil(Math.log2(data.length)) + 1) : spec.bins;
  if (!Number.isInteger(bins) || bins < 1 || bins > 40) throw invalid("bins must be a whole number from 1 to 40");
  const lo = Math.min(...data);
  const hi = Math.max(...data) === lo ? lo + 1 : Math.max(...data);
  const width = (hi - lo) / bins;
  const counts = new Array(bins).fill(0);
  for (const value of data) counts[Math.min(bins - 1, Math.floor((value - lo) / width))] += 1;
  const scale = scaleOf([lo, hi], valueRange(counts));
  const edges = Array.from({ length: bins + 1 }, (_, k) => lo + k * width);
  const step = edges.length > 12 ? Math.ceil(edges.length / 12) : 1;
  const shown = edges.filter((_, k) => k % step === 0);
  const out = axesOf(prefix, scale, spec, { atZero: false, xTicks: { step: width, ticks: shown, labels: shown.map(short) } });
  const color = colorOf(spec.color, 0);
  counts.forEach((count, k) => {
    const x = scale.px(edges[k]);
    out.push(rectOf(`${prefix}-s1-b${k + 1}`, x, scale.py(count), scale.px(edges[k + 1]) - x, scale.py(0) - scale.py(count), color));
  });
  return { out, summary: describe(m, data) };
}

// @purity non-pure
function boxChart(m, spec, prefix) {
  const groups = spec.groups;
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > 10) throw invalid("groups must be a list of 1 to 10 {name, data}");
  groups.forEach((g, i) => numbersOf(g && g.data, `groups[${i}].data`, 1));
  const scale = scaleOf([0, groups.length], valueRange(groups.flatMap((g) => g.data), false));
  const out = axesOf(prefix, scale, { ...spec, categoryAxis: true }, { atZero: false });
  const slot = PLOT_BOX.width / groups.length;
  const lines = [];
  groups.forEach((g, i) => {
    const id = `${prefix}-g${i + 1}`;
    const color = colorOf(g.color, i);
    const [q1, median, q3] = [0.25, 0.5, 0.75].map((q) => m.quantileSeq(g.data, q));
    const iqr = q3 - q1;
    const inside = g.data.filter((v) => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
    const outliers = g.data.filter((v) => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr);
    const [low, high] = [Math.min(...inside), Math.max(...inside)];
    const center = PLOT_BOX.left + (i + 0.5) * slot;
    const half = Math.min(40, slot * 0.3);
    out.push({ ...rectOf(`${id}-box`, center - half, scale.py(q3), 2 * half, scale.py(q1) - scale.py(q3), color), opacity: 40 });
    out.push(lineOf(`${id}-median`, [[center - half, scale.py(median)], [center + half, scale.py(median)]], { color, width: 3 }));
    out.push(lineOf(`${id}-wlo`, [[center, scale.py(q1)], [center, scale.py(low)]], { color }));
    out.push(lineOf(`${id}-whi`, [[center, scale.py(q3)], [center, scale.py(high)]], { color }));
    out.push(lineOf(`${id}-caplo`, [[center - half / 2, scale.py(low)], [center + half / 2, scale.py(low)]], { color }));
    out.push(lineOf(`${id}-caphi`, [[center - half / 2, scale.py(high)], [center + half / 2, scale.py(high)]], { color }));
    outliers.forEach((v, k) => out.push(dotOf(`${id}-out${k + 1}`, center, scale.py(v), color, 3)));
    const name = String(g.name || `group ${i + 1}`);
    out.push(textOf(`${id}-name`, center - textWidth(name, 14) / 2, PLOT_BOX.top + PLOT_BOX.height + 8, name));
    lines.push(`${name}: n = ${g.data.length}, median = ${short(median)}, q1 = ${short(q1)}, q3 = ${short(q3)}, IQR = ${short(iqr)}${outliers.length ? `, outliers = ${outliers.map(short).join(" ")}` : ""}`);
  });
  return { out, summary: lines.join("\n") };
}

const CHARTS = Object.freeze({ bar: barChart, line: lineChart, scatter: scatterChart, histogram: histogramChart, box: boxChart });

// draw_chart: `spec` { kind, ... the data of that kind, title, xLabel, yLabel, explain }. Below the chart: the summary
// (the numbers, worked out here) and the explanation (the agent's words). Returns { skeletons, summary }.
// @purity non-pure
function buildChart(spec, math, prefix) {
  const make = CHARTS[spec && spec.kind];
  if (!make) throw invalid(`kind must be one of ${Object.keys(CHARTS).join(", ")}`);
  const m = predictable(math);
  const { out, summary } = make(m, spec, prefix);
  let y = PLOT_BOX.top + PLOT_BOX.height + 48;
  out.push(textOf(`${prefix}-summary`, PLOT_BOX.left, y, summary, { size: 16, color: SUMMARY_COLOR }));
  y += summary.split("\n").length * 22 + 14;
  if (typeof spec.explain === "string" && spec.explain.trim() !== "") {
    out.push(textOf(`${prefix}-explain`, PLOT_BOX.left, y, wrap(spec.explain.trim()), { size: 20, color: AGENT_BLUE, font: FONT_HAND }));
  }
  return { skeletons: out, summary };
}

module.exports = { buildFunctionPlot, buildChart, niceTicks, simplify, piecesOf, wrap, PLOT_BOX, PALETTE, NAMED };
