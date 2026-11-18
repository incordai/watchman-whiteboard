"use strict";

// BoardGeometry (Entity), Watchman Whiteboard. A geometric construction (draw_geometry) as the board's own elements:
// points (dots with their names), segments, lines and rays (cut to the view), vectors, polygons, circles, angle arcs
// (a square mark for a right angle) and texts, at ONE scale for both axes so angles and circles stay true, with y up
// as in mathematics. Objects are built in order from earlier ones by name: midpoint, intersection, foot of a
// perpendicular, perpendicular, parallel, angle bisector, perpendicular bisector, circumcircle, incircle. The measures
// (coordinates, lengths, angles, circles, areas) come back as text for the agent to say. Pure; errors are AppError
// InvalidGeometry (400) naming the object. Called by talk-on-board's mcp.js (draw_geometry).

const { AppError } = require("./app-error");
const { niceTicks } = require("./board-plot");
const { AGENT_INK } = require("./agent-ink");

const TYPES = Object.freeze([
  "point", "midpoint", "intersection", "foot", "segment", "line", "ray", "vector", "polygon", "circle", "circumcircle", "incircle",
  "perpendicular", "parallel", "bisector", "perpBisector", "angle", "text",
]);
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;
const MAX_OBJECTS = 200;
const VIEW = Object.freeze({ width: 560, height: 420, margin: 36 });
const NAMED = Object.freeze({
  blue: "#1971c2", red: "#e03131", green: "#2f9e44", orange: "#f08c00", violet: "#9c36b5", cyan: "#0c8599", gray: "#495057", black: "#1e1e1e",
});
// Lines in the agent's ink unless the agent names a colour (agent-ink.js).
const LINE_COLOR = AGENT_INK;
const POINT_COLOR = "#1e1e1e";
const MEASURE_COLOR = "#495057";
const EPS = 1e-9;

// @purity pure
function short(n) {
  if (Math.abs(n) < 1e-9) return "0";
  return String(Number(n.toPrecision(4)));
}

// @purity pure
function round(n) {
  return Math.round(n * 10) / 10;
}

// @purity pure
function colorOf(wanted, fallback) {
  if (typeof wanted === "string" && NAMED[wanted]) return NAMED[wanted];
  if (typeof wanted === "string" && /^#[0-9a-fA-F]{6}$/.test(wanted)) return wanted;
  return fallback;
}

// ---- Vectors ----
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => mul(a, 1 / (len(a) || 1));
const normal = (a) => [-a[1], a[0]];

// Builds the construction in world coordinates. Returns { env: Map name -> object, order: [names], measures: [text] }.
// Objects: { kind: "point", p } | { kind: "linear", a, d, extent: "line"|"ray"|"segment", b? } | { kind: "circle", c, r }.
// @purity pure
function construct(objects) {
  if (!Array.isArray(objects) || objects.length < 1 || objects.length > MAX_OBJECTS) {
    throw new AppError("InvalidGeometry", 400, `objects must be a list of 1 to ${MAX_OBJECTS}`);
  }
  const env = new Map();
  const drawn = [];
  const measures = [];
  objects.forEach((object, index) => {
    const fail = (message) => new AppError("InvalidGeometry", 400, `objects[${index}]: ${message}`);
    if (!object || typeof object !== "object") throw fail("must be an object");
    if (!TYPES.includes(object.type)) throw fail(`type must be one of ${TYPES.join(", ")}`);
    const name = object.name === undefined ? `${object.type}${index + 1}` : object.name;
    if (typeof name !== "string" || !NAME_PATTERN.test(name)) throw fail("name must be a letter, then up to 15 letters, digits or _");
    if (env.has(name)) throw fail(`the name ${name} is used twice`);
    const ref = (key, kinds) => {
      if (typeof key !== "string" || !env.has(key)) throw fail(`${key} is not defined above`);
      const found = env.get(key);
      if (!kinds.includes(found.kind)) throw fail(`${key} is not a ${kinds.join(" or ")}`);
      return found;
    };
    const point = (key) => ref(key, ["point"]).p;
    const pair = (list, what) => {
      if (!Array.isArray(list) || list.length !== 2) throw fail(`${what} must name two objects`);
      return list;
    };
    const triple = (list, what) => {
      if (!Array.isArray(list) || list.length !== 3) throw fail(`${what} must name three points`);
      return list.map(point);
    };
    const number = (value, what) => {
      if (!Number.isFinite(value)) throw fail(`${what} must be a number`);
      return value;
    };
    const definePoint = (pointName, p) => {
      if (env.has(pointName)) throw fail(`the name ${pointName} is used twice`);
      env.set(pointName, { kind: "point", p, object, label: object.label });
      drawn.push(pointName);
      measures.push(`${pointName} = (${short(p[0])}, ${short(p[1])})`);
    };
    let made = null;
    switch (object.type) {
      case "point":
        definePoint(name, [number(object.x, "x"), number(object.y, "y")]);
        return;
      case "midpoint": {
        const [a, b] = pair(object.of, "of").map(point);
        definePoint(name, mul(add(a, b), 0.5));
        return;
      }
      case "foot": {
        const p = point(object.from);
        const l = ref(object.to, ["linear"]);
        const t = dot(sub(p, l.a), l.d) / dot(l.d, l.d);
        definePoint(name, add(l.a, mul(l.d, t)));
        return;
      }
      case "intersection": {
        const [first, second] = pair(object.of, "of");
        const objs = [ref(first, ["linear", "circle"]), ref(second, ["linear", "circle"])];
        const found = intersections(objs[0], objs[1]);
        if (found.length === 0) throw fail(`${first} and ${second} do not meet`);
        const which = object.which === undefined ? 1 : object.which;
        if (which !== 1 && which !== 2) throw fail("which must be 1 or 2");
        if (which > found.length) throw fail(`${first} and ${second} meet at one point only`);
        definePoint(name, found[which - 1]);
        return;
      }
      case "segment":
      case "vector": {
        const a = point(object.from);
        const b = point(object.to);
        if (len(sub(b, a)) < EPS) throw fail("its two points are the same");
        made = { kind: "linear", a, b, d: sub(b, a), extent: "segment", arrow: object.type === "vector" };
        measures.push(`${object.from}${object.to} = ${short(len(sub(b, a)))}`);
        break;
      }
      case "line":
      case "ray": {
        const [p, q] = object.type === "line" ? pair(object.through, "through").map(point) : [point(object.from), point(object.through)];
        if (len(sub(q, p)) < EPS) throw fail("its two points are the same");
        made = { kind: "linear", a: p, d: sub(q, p), extent: object.type };
        break;
      }
      case "perpendicular":
      case "parallel": {
        const l = ref(object.to, ["linear"]);
        made = { kind: "linear", a: point(object.through), d: object.type === "parallel" ? l.d : normal(l.d), extent: "line" };
        break;
      }
      case "perpBisector": {
        const [a, b] = pair(object.of, "of").map(point);
        if (len(sub(b, a)) < EPS) throw fail("its two points are the same");
        made = { kind: "linear", a: mul(add(a, b), 0.5), d: normal(sub(b, a)), extent: "line" };
        break;
      }
      case "bisector": {
        const [b, a, c] = triple(object.angle, "angle");
        const d = add(unit(sub(b, a)), unit(sub(c, a)));
        made = { kind: "linear", a, d: len(d) < EPS ? normal(sub(b, a)) : d, extent: "ray" };
        break;
      }
      case "polygon": {
        if (!Array.isArray(object.points) || object.points.length < 3 || object.points.length > 50) throw fail("points must name 3 to 50 points");
        const ps = object.points.map(point);
        let area = 0;
        let perimeter = 0;
        ps.forEach((p, i) => {
          const q = ps[(i + 1) % ps.length];
          area += cross(p, q) / 2;
          perimeter += len(sub(q, p));
        });
        made = { kind: "polygon", ps };
        measures.push(`${name}: area ${short(Math.abs(area))}, perimeter ${short(perimeter)}`);
        break;
      }
      case "circle": {
        const c = point(object.center);
        const r = object.through !== undefined ? len(sub(point(object.through), c)) : number(object.radius, "radius");
        if (!(r > 0)) throw fail("radius must be more than 0");
        made = { kind: "circle", c, r };
        break;
      }
      case "circumcircle":
      case "incircle": {
        const [a, b, c] = triple(object.of, "of");
        const area2 = cross(sub(b, a), sub(c, a));
        if (Math.abs(area2) < EPS) throw fail("its three points are on one line");
        let center;
        let r;
        if (object.type === "circumcircle") {
          const d = 2 * area2;
          const [ba, ca] = [sub(b, a), sub(c, a)];
          const ux = (ca[1] * dot(ba, ba) - ba[1] * dot(ca, ca)) / d;
          const uy = (ba[0] * dot(ca, ca) - ca[0] * dot(ba, ba)) / d;
          center = add(a, [ux, uy]);
          r = len(sub(a, center));
        } else {
          const [la, lb, lc] = [len(sub(b, c)), len(sub(c, a)), len(sub(a, b))];
          const sum = la + lb + lc;
          center = mul(add(add(mul(a, la), mul(b, lb)), mul(c, lc)), 1 / sum);
          r = Math.abs(area2) / sum;
        }
        if (object.center !== undefined) {
          if (typeof object.center !== "string" || !NAME_PATTERN.test(object.center)) throw fail("center must be a name");
          definePoint(object.center, center);
        }
        made = { kind: "circle", c: center, r };
        break;
      }
      case "angle": {
        const [b, a, c] = triple(object.points, "points");
        const [u, v] = [sub(b, a), sub(c, a)];
        if (len(u) < EPS || len(v) < EPS) throw fail("the vertex must differ from the other two points");
        const degrees = (Math.acos(Math.max(-1, Math.min(1, dot(unit(u), unit(v))))) * 180) / Math.PI;
        made = { kind: "angle", a, u, v, degrees };
        measures.push(`angle ${object.points.join("")} = ${short(degrees)}°`);
        break;
      }
      case "text": {
        const at = Array.isArray(object.at) ? [number(object.at[0], "at[0]"), number(object.at[1], "at[1]")] : point(object.at);
        if (typeof object.text !== "string" || object.text.trim() === "" || object.text.length > 300) throw fail("text must be 1 to 300 characters");
        made = { kind: "text", at, text: object.text };
        break;
      }
      default:
        throw fail("unknown type");
    }
    if (made.kind === "circle") measures.push(`${name}: center (${short(made.c[0])}, ${short(made.c[1])}), radius ${short(made.r)}`);
    env.set(name, { ...made, object, name });
    drawn.push(name);
  });
  return { env, drawn, measures };
}

// Where two lines or circles meet: [] or one or two points. Along a line, the point further along its direction
// (from its first point to its second) comes first; for two circles, the one left of the line between the centers.
// A segment or ray only counts where it is.
// @purity pure
function intersections(first, second) {
  const onIt = (l, p) => {
    if (l.extent === "line") return true;
    const t = dot(sub(p, l.a), l.d) / dot(l.d, l.d);
    return t >= -EPS && (l.extent === "ray" || t <= 1 + EPS);
  };
  if (first.kind === "linear" && second.kind === "linear") {
    const denominator = cross(first.d, second.d);
    if (Math.abs(denominator) < EPS) return [];
    const t = cross(sub(second.a, first.a), second.d) / denominator;
    const p = add(first.a, mul(first.d, t));
    return onIt(first, p) && onIt(second, p) ? [p] : [];
  }
  if (first.kind === "circle" && second.kind === "linear") return intersections(second, first);
  if (first.kind === "linear") {
    const f = sub(first.a, second.c);
    const [a, b, c] = [dot(first.d, first.d), 2 * dot(f, first.d), dot(f, f) - second.r ** 2];
    const disc = b * b - 4 * a * c;
    if (disc < -EPS) return [];
    const root = Math.sqrt(Math.max(0, disc));
    const ts = disc <= EPS ? [-b / (2 * a)] : [(-b + root) / (2 * a), (-b - root) / (2 * a)];
    return ts.map((t) => add(first.a, mul(first.d, t))).filter((p) => onIt(first, p));
  }
  const between = sub(second.c, first.c);
  const d = len(between);
  if (d < EPS || d > first.r + second.r + EPS || d < Math.abs(first.r - second.r) - EPS) return [];
  const along = (first.r ** 2 - second.r ** 2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, first.r ** 2 - along * along));
  const base = add(first.c, mul(unit(between), along));
  const side = mul(unit(normal(between)), h);
  return h <= EPS ? [base] : [add(base, side), sub(base, side)];
}

// The part of a line, ray or segment inside the world box, or null (Liang-Barsky).
// @purity pure
function clip(l, box) {
  let [t0, t1] = l.extent === "segment" ? [0, 1] : l.extent === "ray" ? [0, Infinity] : [-Infinity, Infinity];
  const checks = [[-l.d[0], l.a[0] - box.x0], [l.d[0], box.x1 - l.a[0]], [-l.d[1], l.a[1] - box.y0], [l.d[1], box.y1 - l.a[1]]];
  for (const [p, q] of checks) {
    if (Math.abs(p) < EPS) {
      if (q < 0) return null;
    } else if (p < 0) {
      t0 = Math.max(t0, q / p);
    } else {
      t1 = Math.min(t1, q / p);
    }
  }
  return t0 <= t1 ? [add(l.a, mul(l.d, t0)), add(l.a, mul(l.d, t1))] : null;
}

// draw_geometry: `spec` { objects, axes, title }. Returns { skeletons, measures (text) }.
// @purity pure
function buildGeometry(spec, prefix) {
  const { env, drawn, measures } = construct(spec && spec.objects);
  // The world box: every point and circle, plus the origin with axes, with room around.
  const xs = [];
  const ys = [];
  for (const item of env.values()) {
    if (item.kind === "point") {
      xs.push(item.p[0]);
      ys.push(item.p[1]);
    } else if (item.kind === "circle") {
      xs.push(item.c[0] - item.r, item.c[0] + item.r);
      ys.push(item.c[1] - item.r, item.c[1] + item.r);
    } else if (item.kind === "text") {
      xs.push(item.at[0]);
      ys.push(item.at[1]);
    }
  }
  if (spec.axes) {
    xs.push(0);
    ys.push(0);
  }
  if (xs.length === 0) throw new AppError("InvalidGeometry", 400, "objects: nothing has a place (give at least one point)");
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  const pad = span * 0.12;
  const box = { x0: Math.min(...xs) - pad, x1: Math.max(...xs) + pad, y0: Math.min(...ys) - pad, y1: Math.max(...ys) + pad };
  const scale = Math.min(VIEW.width / (box.x1 - box.x0), VIEW.height / (box.y1 - box.y0));
  const top = spec.title ? 44 : 0;
  const px = (p) => [VIEW.margin + (p[0] - box.x0) * scale, top + VIEW.margin + (box.y1 - p[1]) * scale];
  const out = [];
  const id = (suffix) => `${prefix}-${suffix}`;
  const lineOf = (key, points, style = {}) => {
    const board = points.map(px);
    const [x0, y0] = board[0];
    return {
      type: style.arrow ? "arrow" : "line", id: id(key), x: round(x0), y: round(y0), points: board.map(([x, y]) => [round(x - x0), round(y - y0)]),
      strokeColor: style.color || LINE_COLOR, strokeWidth: style.width || 2, roughness: 0,
      ...(style.dashed ? { strokeStyle: "dashed" } : {}), ...(style.fill ? { backgroundColor: style.fill } : {}),
      ...(style.arrow ? { startArrowhead: null, endArrowhead: "arrow" } : {}),
    };
  };
  const textAt = (key, [x, y], text, size = 18, color = POINT_COLOR, font = 6) => ({
    type: "text", id: id(key), x: round(x), y: round(y), text: String(text), fontSize: size, fontFamily: font, strokeColor: color,
  });
  // The title in the board's hand-written font, as draw_plot's and draw_chart's.
  if (spec.title) out.push(textAt("title", [VIEW.margin, 4], spec.title, 24, POINT_COLOR, 5));
  if (spec.axes) {
    const xt = niceTicks(box.x0, box.x1, 10);
    const yt = niceTicks(box.y0, box.y1, 8);
    out.push(lineOf("axis-x", [[box.x0, 0], [box.x1, 0]], { color: MEASURE_COLOR, width: 1, arrow: true }));
    out.push(lineOf("axis-y", [[0, box.y0], [0, box.y1]], { color: MEASURE_COLOR, width: 1, arrow: true }));
    xt.ticks.forEach((value, k) => {
      if (value === 0) return;
      const [x, y] = px([value, 0]);
      out.push(textAt(`tx${k + 1}`, [x - 4, y + 4], short(value), 12, MEASURE_COLOR));
    });
    yt.ticks.forEach((value, k) => {
      if (value === 0) return;
      const [x, y] = px([0, value]);
      out.push(textAt(`ty${k + 1}`, [x - 10 - String(short(value)).length * 7, y - 8], short(value), 12, MEASURE_COLOR));
    });
  }
  // Shapes first, then points on top, so a dot is never hidden under a line.
  const points = [];
  for (const name of drawn) {
    const item = env.get(name);
    const object = item.object || {};
    const color = colorOf(object.color, LINE_COLOR);
    if (item.kind === "point") {
      points.push([name, item]);
    } else if (item.kind === "linear") {
      const piece = clip(item, box);
      if (!piece) continue;
      out.push(lineOf(name, piece, { color, dashed: object.dashed === true, arrow: item.arrow }));
      if (item.extent === "segment" && object.label !== undefined) {
        const text = object.label === "length" ? short(len(item.d)) : String(object.label).slice(0, 60);
        const [mx, my] = px(mul(add(item.a, item.b), 0.5));
        const n = unit(normal(sub(px(item.b), px(item.a))));
        out.push(textAt(`${name}-label`, [mx + n[0] * 16 - text.length * 5, my + n[1] * 16 - 11], text, 18, color));
      }
    } else if (item.kind === "polygon") {
      const fill = object.fill ? colorOf(object.fill, "#a5d8ff") : null;
      out.push(lineOf(name, [...item.ps, item.ps[0]], { color, fill }));
    } else if (item.kind === "circle") {
      const [cx, cy] = px(item.c);
      const r = item.r * scale;
      out.push({
        type: "ellipse", id: id(name), x: round(cx - r), y: round(cy - r), width: round(2 * r), height: round(2 * r),
        strokeColor: color, backgroundColor: "transparent", strokeWidth: 2, roughness: 0, ...(object.dashed ? { strokeStyle: "dashed" } : {}),
      });
    } else if (item.kind === "angle") {
      const [vx, vy] = px(item.a);
      // Board directions (y down) of the two arms.
      const arm = (w) => unit([w[0], -w[1]]);
      const [u, v] = [arm(item.u), arm(item.v)];
      const radius = 26;
      if (Math.abs(item.degrees - 90) < 0.05) {
        const s = 14;
        const corner = [vx + (u[0] + v[0]) * s, vy + (u[1] + v[1]) * s];
        const mark = [[vx + u[0] * s, vy + u[1] * s], corner, [vx + v[0] * s, vy + v[1] * s]];
        out.push(lineOfBoard(id(`${name}-mark`), mark, color));
      } else {
        const from = Math.atan2(u[1], u[0]);
        let sweep = Math.atan2(v[1], v[0]) - from;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep < -Math.PI) sweep += 2 * Math.PI;
        const steps = Math.max(6, Math.round(Math.abs(sweep) * 12));
        const arc = Array.from({ length: steps + 1 }, (_, k) => {
          const angle = from + (sweep * k) / steps;
          return [vx + radius * Math.cos(angle), vy + radius * Math.sin(angle)];
        });
        out.push(lineOfBoard(id(`${name}-arc`), arc, color));
      }
      if (object.label !== undefined) {
        const text = object.label === "degrees" ? `${short(item.degrees)}°` : String(object.label).slice(0, 30);
        const middle = unit(add(u, v));
        // A narrow angle has little room between its arms: its label goes further out.
        const distance = radius + 18 + (item.degrees < 45 ? 34 : 0);
        const at = [vx + middle[0] * distance - text.length * 4.5, vy + middle[1] * distance - 10];
        out.push(textAt(`${name}-label`, at, text, 16, color));
      }
    } else if (item.kind === "text") {
      const [x, y] = px(item.at);
      out.push(textAt(name, [x + 8, y + 6], item.text, 18, colorOf(object.color, POINT_COLOR)));
    }
  }
  // A point's name goes on the side away from the middle of the drawing, so it is outside the figure.
  const middle = points.length > 0
    ? mul(points.reduce((sum, [, item]) => add(sum, px(item.p)), [0, 0]), 1 / points.length) : [0, 0];
  for (const [name, item] of points) {
    const [x, y] = px(item.p);
    const color = colorOf(item.object && item.object.color, POINT_COLOR);
    out.push({
      type: "ellipse", id: id(name), x: round(x - 4), y: round(y - 4), width: 8, height: 8,
      strokeColor: color, backgroundColor: color, fillStyle: "solid", strokeWidth: 1, roughness: 0,
    });
    const label = typeof item.label === "string" && item.label ? item.label.slice(0, 30) : name;
    if (item.object && item.object.hideLabel === true) continue;
    const away = sub([x, y], middle);
    const [dx, dy] = len(away) < 20 ? [0.6, -0.8] : unit(away);
    const width = label.length * 10;
    out.push(textAt(`${name}-label`, [x + dx * 18 - width / 2, y + dy * 18 - 12], label, 18, color));
  }
  return { skeletons: out, measures: measures.join("; ") };
}

// A line Skeleton from board points.
// @purity pure
function lineOfBoard(fullId, points, color) {
  const [x0, y0] = points[0];
  return {
    type: "line", id: fullId, x: round(x0), y: round(y0), points: points.map(([x, y]) => [round(x - x0), round(y - y0)]),
    strokeColor: color, strokeWidth: 1.5, roughness: 0,
  };
}

module.exports = { buildGeometry, construct, intersections, TYPES };
