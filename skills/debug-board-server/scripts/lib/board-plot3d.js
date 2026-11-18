"use strict";

// BoardPlot3d (Entity), Watchman Whiteboard. The numbers of a 3D chart (draw_chart3d), worked out in Node with mathjs:
// a surface z = f(x, y) on a grid, a curve (x, y, z) of t, or labelled points. The result is a Plotly figure made only
// of numbers and plain texts, which the page draws with its staged Plotly and turns into a PNG image (page/app.js
// drawPicture). checkFigure is the board server's check of a figure before it goes to the page (no images, links or
// other trace types). Errors are AppError InvalidPlot (400). Called by talk-on-board's mcp.js and server.js.

const { AppError } = require("./app-error");

// Points per side of a surface's grid (odd, so the middle is on the axis), and along a curve.
const GRID = 41;
const CURVE_POINTS = 400;
const MAX_POINTS = 2000;
const TRACE_TYPES = Object.freeze(["surface", "scatter3d"]);
const TEXT_MAX = 120;
const COLORSCALES = Object.freeze(["Viridis", "Blues", "RdBu", "Portland", "Jet", "Greys"]);

// @purity pure
function invalid(message) {
  return new AppError("InvalidPlot", 400, message);
}

// @purity pure
function short(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) < 1e-9) return "0";
  return String(Number(n.toPrecision(4)));
}

// @purity pure
function rangeOf(given, name, fallback) {
  if (given === undefined) return fallback;
  if (!(Array.isArray(given) && given.length === 2 && given.every(Number.isFinite) && given[0] < given[1])) {
    throw invalid(`${name} must be [min, max] with min < max`);
  }
  return given;
}

// @purity pure
function plainText(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > TEXT_MAX) throw invalid(`${name} must be text of at most ${TEXT_MAX} characters`);
  // Plotly reads a few HTML tags in its texts; the board's figures have none.
  return value.replace(/[<>]/g, "");
}

// A compiled mathjs expression that gives a number or null at `scope`.
// @purity non-pure
function compileExpr(m, text, name) {
  if (typeof text !== "string" || text.trim() === "" || text.length > 500) throw invalid(`${name} must be 1 to 500 characters`);
  let compiled;
  try {
    compiled = m.compile(text);
  } catch (error) {
    throw invalid(`${name}: ${error && error.message}`);
  }
  return (scope) => {
    try {
      const value = compiled.evaluate(scope);
      return typeof value === "number" && Number.isFinite(value) ? Number(value.toPrecision(12)) : null;
    } catch (error) {
      return null;
    }
  };
}

// @purity pure
function steps(range, count) {
  return Array.from({ length: count }, (_, i) => Number((range[0] + ((range[1] - range[0]) * i) / (count - 1)).toPrecision(12)));
}

// @purity pure
function layoutOf(spec) {
  const axis = (name, fallback) => ({ title: { text: plainText(spec[name], name) || fallback } });
  return {
    title: { text: plainText(spec.title, "title") || "" },
    margin: { l: 10, r: 10, t: spec.title ? 50 : 10, b: 10 },
    paper_bgcolor: "rgba(0,0,0,0)",
    scene: { xaxis: axis("xLabel", "x"), yaxis: axis("yLabel", "y"), zaxis: axis("zLabel", "z"), camera: { eye: { x: 1.6, y: -1.6, z: 0.9 } } },
    showlegend: false,
  };
}

const predictableMath = new WeakMap();

// @purity non-pure
function predictable(math) {
  if (!predictableMath.has(math)) predictableMath.set(math, math.create(math.all, { predictable: true }));
  return predictableMath.get(math);
}

// draw_chart3d: `spec` { kind: surface | curve | points, ... }. Returns { figure: { data, layout }, summary }.
// @purity non-pure
function buildChart3d(spec, math) {
  const m = predictable(math);
  const colorscale = spec.colorscale === undefined ? "Viridis" : spec.colorscale;
  if (!COLORSCALES.includes(colorscale)) throw invalid(`colorscale must be one of ${COLORSCALES.join(", ")}`);
  let data;
  let summary;
  if (spec.kind === "surface") {
    const f = compileExpr(m, spec.expr, "expr");
    const xs = steps(rangeOf(spec.x, "x", [-5, 5]), GRID);
    const ys = steps(rangeOf(spec.y, "y", [-5, 5]), GRID);
    const z = ys.map((y) => xs.map((x) => f({ x, y })));
    const values = z.flat().filter((v) => v !== null);
    if (values.length === 0) throw invalid("expr: no value anywhere on the grid");
    data = [{ type: "surface", x: xs, y: ys, z, colorscale, showscale: false }];
    summary = `surface z = ${spec.expr}, x in [${short(xs[0])}, ${short(xs[GRID - 1])}], y in [${short(ys[0])}, ${short(ys[GRID - 1])}], z from ${short(Math.min(...values))} to ${short(Math.max(...values))}`;
  } else if (spec.kind === "curve") {
    const [fx, fy, fz] = ["x", "y", "z"].map((name) => compileExpr(m, spec[name], name));
    const ts = steps(rangeOf(spec.t, "t", [0, 2 * Math.PI]), CURVE_POINTS);
    data = [{ type: "scatter3d", mode: "lines", x: ts.map((t) => fx({ t })), y: ts.map((t) => fy({ t })), z: ts.map((t) => fz({ t })), line: { width: 6, color: "#1971c2" } }];
    if (data[0].x.every((v) => v === null)) throw invalid("x: no value anywhere in the range of t");
    summary = `curve (${spec.x}, ${spec.y}, ${spec.z}), t in [${short(ts[0])}, ${short(ts[ts.length - 1])}]`;
  } else if (spec.kind === "points") {
    const p = spec.points || {};
    const ok = ["x", "y", "z"].every((k) => Array.isArray(p[k]) && p[k].every(Number.isFinite));
    if (!ok || p.x.length !== p.y.length || p.x.length !== p.z.length || p.x.length < 1 || p.x.length > MAX_POINTS) {
      throw invalid(`points needs x, y and z: lists of numbers of the same length (1 to ${MAX_POINTS})`);
    }
    const labels = spec.labels === undefined ? null : spec.labels;
    if (labels !== null && (!Array.isArray(labels) || labels.length !== p.x.length)) throw invalid("labels needs one text per point");
    data = [{
      type: "scatter3d", mode: labels ? "markers+text" : "markers", x: p.x, y: p.y, z: p.z,
      marker: { size: 5, color: p.z, colorscale }, ...(labels ? { text: labels.map((l, i) => plainText(String(l), `labels[${i}]`)) } : {}),
    }];
    summary = `${p.x.length} points, z from ${short(Math.min(...p.z))} to ${short(Math.max(...p.z))}`;
  } else {
    throw invalid("kind must be surface, curve or points");
  }
  const figure = { data, layout: layoutOf(spec) };
  checkFigure(figure);
  return { figure, summary };
}

// The board server's check of a figure from the Control API: only surface and scatter3d traces of numbers and plain
// texts, and a layout of the keys layoutOf writes. Throws InvalidPlot.
// @purity pure
function checkFigure(figure) {
  if (!figure || !Array.isArray(figure.data) || figure.data.length < 1 || figure.data.length > 8 || !figure.layout || typeof figure.layout !== "object") {
    throw invalid("figure must be {data: [1 to 8 traces], layout}");
  }
  for (const trace of figure.data) {
    if (!trace || !TRACE_TYPES.includes(trace.type)) throw invalid(`a trace type must be one of ${TRACE_TYPES.join(", ")}`);
  }
  const allowed = new Set(["title", "margin", "paper_bgcolor", "scene", "showlegend"]);
  const extra = Object.keys(figure.layout).find((key) => !allowed.has(key));
  if (extra) throw invalid(`figure layout may not have ${extra}`);
  const text = JSON.stringify(figure);
  if (text.length > 4 * 1024 * 1024) throw invalid("figure is too large");
  if (/https?:|javascript:|<[a-z/!]/i.test(text)) throw invalid("figure must hold no links or markup");
}

module.exports = { buildChart3d, checkFigure, GRID, COLORSCALES };
