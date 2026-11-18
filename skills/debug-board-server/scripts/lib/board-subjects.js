"use strict";

// BoardSubjects (Entity), Watchman Whiteboard. The school subjects the other drawing tools do not cover, as the
// board's own elements, each with its own id so an agent can erase or edit any part when the user says it is wrong:
//   - draw_timeline (history): events in order along a line, dates and labels alternating above and below;
//   - draw_cycle (biology, earth science: water cycle, cell cycle, life cycles): steps in a ring, arrows between;
//   - draw_parts (biology, anatomy, any "label the parts"): a subject in the middle, its parts around with leaders;
//   - draw_circuit (physics, electronics): a source and branches of components (series in a branch, branches in
//     parallel), each component as its usual symbol with its label and value.
// Pure; errors are AppError InvalidSubject (400) naming the field. Called by talk-on-board's mcp.js.

const { AppError } = require("./app-error");
const { AGENT_INK, AGENT_FILL } = require("./agent-ink");

const INK = "#1e1e1e";
// The agent's ink and its pale fill (agent-ink.js).
const LINE = AGENT_INK;
const SOFT = "#495057";
const FILL = AGENT_FILL;
const MAX_ITEMS = 40;

// @purity pure
function round(n) {
  return Math.round(n * 10) / 10;
}

// @purity pure
function fail(message) {
  return new AppError("InvalidSubject", 400, message);
}

// @purity pure
function list(value, what, min, max = MAX_ITEMS) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw fail(`${what} must be a list of ${min} to ${max}`);
  return value;
}

// @purity pure
function words(value, what, max = 80) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw fail(`${what} must be text of 1 to ${max} characters`);
  return value.trim();
}

// @purity pure
function maybeWords(value, what, max) {
  return value === undefined ? undefined : words(value, what, max);
}

// Element makers in board coordinates; every id is PREFIX-suffix.
// @purity pure
function makers(prefix) {
  const id = (suffix) => `${prefix}-${suffix}`;
  return {
    id,
    text: (key, x, y, text, size = 18, color = INK, font = 6) => ({
      type: "text", id: id(key), x: round(x), y: round(y), text: String(text), fontSize: size, fontFamily: font, strokeColor: color,
    }),
    line: (key, points, style = {}) => {
      const [x0, y0] = points[0];
      return {
        type: style.arrow ? "arrow" : "line", id: id(key), x: round(x0), y: round(y0),
        points: points.map(([x, y]) => [round(x - x0), round(y - y0)]),
        strokeColor: style.color || LINE, strokeWidth: style.width || 2, roughness: 0,
        ...(style.dashed ? { strokeStyle: "dashed" } : {}),
        ...(style.arrow ? { startArrowhead: null, endArrowhead: "arrow" } : {}),
      };
    },
    box: (key, x, y, width, height, label, color = LINE, fill = FILL, shape = "rectangle") => ({
      type: shape, id: id(key), x: round(x), y: round(y), width: round(width), height: round(height),
      strokeColor: color, backgroundColor: fill, fillStyle: "solid", strokeWidth: 2, roughness: 0,
      ...(label ? { label: { text: String(label) } } : {}),
    }),
  };
}

// The width a label needs in the board's font, roughly.
// @purity pure
function widthOf(text, size = 18) {
  return Math.max(...String(text).split("\n").map((line) => line.length)) * size * 0.55 + 24;
}

// draw_timeline: `spec` { events: [{ when, label, note? }], title?, sort? }. Events in the order given, or by their
// `when` when every one is a number (a year) and sort is not false. Returns { skeletons, summary }.
// @purity pure
function buildTimeline(spec, prefix) {
  const events = list(spec && spec.events, "events", 2).map((event, i) => {
    if (!event || typeof event !== "object") throw fail(`events[${i}] must be an object`);
    return {
      when: words(String(event.when ?? ""), `events[${i}].when`, 30),
      label: words(event.label, `events[${i}].label`, 80),
      note: maybeWords(event.note, `events[${i}].note`, 160),
    };
  });
  const numeric = events.every((e) => Number.isFinite(Number(e.when)));
  const ordered = numeric && spec.sort !== false ? [...events].sort((a, b) => Number(a.when) - Number(b.when)) : events;
  const m = makers(prefix);
  const out = [];
  const top = spec.title ? 50 : 10;
  if (spec.title) out.push(m.text("title", 20, 4, words(spec.title, "title", 120), 24, INK, 5));
  const step = Math.max(150, ...ordered.map((e) => Math.min(widthOf(e.label, 16), 260)));
  const axisY = top + 130;
  const x0 = 40;
  const x1 = x0 + step * (ordered.length - 1) + 80;
  out.push(m.line("axis", [[x0 - 20, axisY], [x1, axisY]], { color: SOFT, width: 2, arrow: true }));
  ordered.forEach((event, k) => {
    const n = k + 1;
    const x = x0 + 40 + step * k;
    const above = k % 2 === 0;
    out.push(m.box(`e${n}-dot`, x - 6, axisY - 6, 12, 12, null, LINE, LINE, "ellipse"));
    out.push(m.line(`e${n}-tick`, [[x, axisY], [x, above ? axisY - 40 : axisY + 40]], { color: SOFT, width: 1 }));
    const text = event.note ? `${event.label}\n${event.note}` : event.label;
    const lines = text.split("\n").length;
    out.push(m.text(`e${n}-when`, x - widthOf(event.when, 16) / 2 + 12, above ? axisY + 12 : axisY - 34, event.when, 16, LINE));
    out.push(m.text(`e${n}-label`, x - Math.min(widthOf(event.label, 16), 260) / 2 + 12, above ? axisY - 48 - lines * 22 : axisY + 48, text, 16, INK));
  });
  return { skeletons: out, summary: ordered.map((e) => `${e.when}: ${e.label}`).join("; ") };
}

// draw_cycle: `spec` { steps: [{ label, note? }], center?, title? }. Steps around a ring, clockwise from the top, an
// arrow from each to the next and from the last back to the first. Returns { skeletons, summary }.
// @purity pure
function buildCycle(spec, prefix) {
  const steps = list(spec && spec.steps, "steps", 2, 16).map((step, i) => {
    if (!step || typeof step !== "object") throw fail(`steps[${i}] must be an object`);
    return { label: words(step.label, `steps[${i}].label`, 60), note: maybeWords(step.note, `steps[${i}].note`, 120) };
  });
  const m = makers(prefix);
  const out = [];
  const top = spec.title ? 50 : 10;
  if (spec.title) out.push(m.text("title", 20, 4, words(spec.title, "title", 120), 24, INK, 5));
  const boxW = Math.min(Math.max(...steps.map((s) => widthOf(s.label))), 220);
  const boxH = 56;
  const radius = Math.max(170, (steps.length * (boxW + 30)) / (2 * Math.PI));
  const cx = radius + boxW / 2 + 30;
  const cy = top + radius + boxH / 2 + 20;
  const centers = steps.map((_, k) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * k) / steps.length;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  });
  steps.forEach((step, k) => {
    const [x, y] = centers[k];
    out.push(m.box(`s${k + 1}`, x - boxW / 2, y - boxH / 2, boxW, boxH, step.label));
    if (step.note) out.push(m.text(`s${k + 1}-note`, x - boxW / 2, y + boxH / 2 + 4, step.note, 14, SOFT));
  });
  // Arrows along the ring, from the edge of one box toward the next.
  steps.forEach((_, k) => {
    const a = centers[k];
    const b = centers[(k + 1) % steps.length];
    const d = [b[0] - a[0], b[1] - a[1]];
    const length = Math.hypot(d[0], d[1]) || 1;
    const u = [d[0] / length, d[1] / length];
    // Where the ray from the center leaves the box: the nearer of its side and its top or bottom edge (seen in
    // Chrome: taking the farther one shrank the arrows between wide boxes to stubs).
    const edge = Math.min(Math.abs(u[0]) > 1e-9 ? boxW / 2 / Math.abs(u[0]) : Infinity, Math.abs(u[1]) > 1e-9 ? boxH / 2 / Math.abs(u[1]) : Infinity);
    const cut = Math.min(length / 2 - 20, edge + 8);
    out.push(m.line(`a${k + 1}`, [[a[0] + u[0] * cut, a[1] + u[1] * cut], [b[0] - u[0] * cut, b[1] - u[1] * cut]], { arrow: true, color: SOFT }));
  });
  if (spec.center !== undefined) {
    const center = words(spec.center, "center", 60);
    out.push(m.text("center", cx - widthOf(center, 22) / 2 + 12, cy - 14, center, 22, INK, 5));
  }
  return { skeletons: out, summary: steps.map((s) => s.label).join(" -> ") + ` -> ${steps[0].label}` };
}

// draw_parts: `spec` { subject, parts: [{ label, note? }], title? }. The subject in the middle, each part in a box
// around it with a leader line, so a "label the parts" diagram can be read and corrected part by part.
// @purity pure
function buildParts(spec, prefix) {
  const subject = words(spec && spec.subject, "subject", 60);
  const parts = list(spec.parts, "parts", 1, 20).map((part, i) => {
    if (!part || typeof part !== "object") throw fail(`parts[${i}] must be an object`);
    return { label: words(part.label, `parts[${i}].label`, 60), note: maybeWords(part.note, `parts[${i}].note`, 160) };
  });
  const m = makers(prefix);
  const out = [];
  const top = spec.title ? 50 : 10;
  if (spec.title) out.push(m.text("title", 20, 4, words(spec.title, "title", 120), 24, INK, 5));
  const coreW = Math.max(160, widthOf(subject, 22));
  const coreH = 110;
  const radius = Math.max(230, parts.length * 34);
  const cx = radius + 160;
  const cy = top + radius + 40;
  out.push(m.box("subject", cx - coreW / 2, cy - coreH / 2, coreW, coreH, subject, LINE, "#d0ebff", "ellipse"));
  parts.forEach((part, k) => {
    const n = k + 1;
    const angle = -Math.PI / 2 + (2 * Math.PI * k) / parts.length;
    const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
    const text = part.note ? `${part.label}\n${part.note}` : part.label;
    const w = Math.min(widthOf(text, 16), 240);
    const h = 26 + text.split("\n").length * 20;
    const bx = cx + ux * radius;
    const by = cy + uy * radius * 0.75;
    out.push(m.box(`p${n}`, bx - w / 2, by - h / 2, w, h, text, SOFT, "#fff9db"));
    const edge = [cx + ux * coreW / 2, cy + uy * coreH / 2];
    out.push(m.line(`p${n}-leader`, [edge, [bx - ux * w / 2, by - uy * h / 2]], { color: SOFT, width: 1.5 }));
  });
  return { skeletons: out, summary: `${subject}: ${parts.map((p) => p.label).join(", ")}` };
}

const COMPONENTS = Object.freeze(["resistor", "bulb", "switch", "closed-switch", "capacitor", "ammeter", "voltmeter", "diode", "led", "fuse", "motor", "wire"]);
const SOURCES = Object.freeze(["battery", "cell", "ac"]);
const SLOT = 90;

// A component's symbol drawn vertically in a slot of SLOT px starting at (x, y), with the wire through it.
// @purity pure
function symbol(m, key, type, x, y) {
  const mid = y + SLOT / 2;
  const wire = (from, to) => m.line(`${key}-w${from < mid ? "a" : "b"}`, [[x, from], [x, to]], { color: INK, width: 2 });
  const out = [];
  switch (type) {
    case "resistor":
      out.push(wire(y, mid - 22), wire(mid + 22, y + SLOT));
      out.push(m.box(key, x - 9, mid - 22, 18, 44, null, INK, "transparent"));
      break;
    case "fuse":
      out.push(wire(y, mid - 20), wire(mid + 20, y + SLOT));
      out.push(m.box(key, x - 8, mid - 20, 16, 40, null, INK, "transparent"));
      out.push(m.line(`${key}-wire`, [[x, mid - 20], [x, mid + 20]], { color: INK, width: 1 }));
      break;
    case "bulb":
    case "ammeter":
    case "voltmeter":
    case "motor": {
      out.push(wire(y, mid - 18), wire(mid + 18, y + SLOT));
      out.push(m.box(key, x - 18, mid - 18, 36, 36, null, INK, "transparent", "ellipse"));
      if (type === "bulb") {
        out.push(m.line(`${key}-x1`, [[x - 12, mid - 12], [x + 12, mid + 12]], { color: INK, width: 1.5 }));
        out.push(m.line(`${key}-x2`, [[x + 12, mid - 12], [x - 12, mid + 12]], { color: INK, width: 1.5 }));
      } else {
        out.push(m.text(`${key}-mark`, x - 7, mid - 12, { ammeter: "A", voltmeter: "V", motor: "M" }[type], 20, INK, 2));
      }
      break;
    }
    case "switch":
      out.push(wire(y, mid - 14), wire(mid + 14, y + SLOT));
      out.push(m.line(key, [[x, mid + 14], [x + 18, mid - 12]], { color: INK, width: 2 }));
      break;
    case "closed-switch":
      out.push(wire(y, mid - 14), wire(mid + 14, y + SLOT));
      out.push(m.line(key, [[x, mid + 14], [x, mid - 14]], { color: INK, width: 2 }));
      break;
    case "capacitor":
      out.push(wire(y, mid - 5), wire(mid + 5, y + SLOT));
      out.push(m.line(key, [[x - 16, mid - 5], [x + 16, mid - 5]], { color: INK, width: 3 }));
      out.push(m.line(`${key}-b`, [[x - 16, mid + 5], [x + 16, mid + 5]], { color: INK, width: 3 }));
      break;
    case "diode":
    case "led":
      out.push(wire(y, mid - 12), wire(mid + 12, y + SLOT));
      out.push(m.line(key, [[x - 12, mid - 12], [x + 12, mid - 12], [x, mid + 10], [x - 12, mid - 12]], { color: INK, width: 2 }));
      out.push(m.line(`${key}-bar`, [[x - 12, mid + 12], [x + 12, mid + 12]], { color: INK, width: 2 }));
      if (type === "led") {
        out.push(m.line(`${key}-ray1`, [[x + 16, mid - 4], [x + 28, mid - 14]], { color: INK, width: 1, arrow: true }));
        out.push(m.line(`${key}-ray2`, [[x + 16, mid + 4], [x + 28, mid - 6]], { color: INK, width: 1, arrow: true }));
      }
      break;
    default:
      out.push(m.line(key, [[x, y], [x, y + SLOT]], { color: INK, width: 2 }));
  }
  return out;
}

// draw_circuit: `spec` { source: { type, label?, value? }, branches: [[{ type, label?, value? }]], title? }. One
// branch is a series circuit; more branches are in parallel between the top and bottom rails, the source on the left.
// Returns { skeletons, summary }.
// @purity pure
function buildCircuit(spec, prefix) {
  const source = spec && spec.source;
  if (!source || !SOURCES.includes(source.type)) throw fail(`source.type must be one of ${SOURCES.join(", ")}`);
  const branches = list(spec.branches, "branches", 1, 6).map((branch, b) =>
    list(branch, `branches[${b}]`, 1, 6).map((part, i) => {
      if (!part || !COMPONENTS.includes(part.type)) throw fail(`branches[${b}][${i}].type must be one of ${COMPONENTS.join(", ")}`);
      return { type: part.type, label: maybeWords(part.label, `branches[${b}][${i}].label`, 20), value: maybeWords(part.value, `branches[${b}][${i}].value`, 20) };
    }),
  );
  const m = makers(prefix);
  const out = [];
  const top = (spec.title ? 50 : 10) + 30;
  if (spec.title) out.push(m.text("title", 20, 4, words(spec.title, "title", 120), 24, INK, 5));
  const slots = Math.max(...branches.map((b) => b.length));
  const height = slots * SLOT + 40;
  const bottom = top + height;
  const sx = 60;
  const gap = 170;
  const xs = branches.map((_, b) => sx + gap * (b + 1));
  // Rails: top and bottom wires from the source to the last branch.
  out.push(m.line("rail-top", [[sx, top], [xs[xs.length - 1], top]], { color: INK }));
  out.push(m.line("rail-bottom", [[sx, bottom], [xs[xs.length - 1], bottom]], { color: INK }));
  // The source: long and short plates (a cell; two pairs for a battery), or a circle with a wave for AC.
  const mid = (top + bottom) / 2;
  out.push(m.line("src-wa", [[sx, top], [sx, mid - 10]], { color: INK }));
  out.push(m.line("src-wb", [[sx, mid + 10], [sx, bottom]], { color: INK }));
  if (source.type === "ac") {
    out.push(m.box("src", sx - 20, mid - 20, 40, 40, null, INK, "transparent", "ellipse"));
    out.push(m.text("src-wave", sx - 9, mid - 14, "~", 24, INK, 2));
  } else {
    out.push(m.line("src", [[sx - 20, mid - 10], [sx + 20, mid - 10]], { color: INK, width: 3 }));
    out.push(m.line("src-short", [[sx - 10, mid + 10], [sx + 10, mid + 10]], { color: INK, width: 5 }));
    out.push(m.text("src-plus", sx + 24, mid - 32, "+", 18, INK, 2));
  }
  const sourceText = [source.label, source.value].filter(Boolean).map((t) => words(t, "source label", 20)).join(" ");
  if (sourceText) out.push(m.text("src-label", sx - 50 - sourceText.length * 9, mid - 10, sourceText, 18, LINE));
  const summary = [`${source.type}${sourceText ? ` ${sourceText}` : ""}`];
  branches.forEach((branch, b) => {
    const x = xs[b];
    const used = branch.length * SLOT;
    const start = top + (height - used) / 2;
    out.push(m.line(`b${b + 1}-up`, [[x, top], [x, start]], { color: INK }));
    out.push(m.line(`b${b + 1}-down`, [[x, start + used], [x, bottom]], { color: INK }));
    branch.forEach((part, i) => {
      const key = `b${b + 1}-c${i + 1}`;
      out.push(...symbol(m, key, part.type, x, start + SLOT * i));
      const text = [part.label, part.value].filter(Boolean).join(" ");
      if (text) out.push(m.text(`${key}-label`, x + 26, start + SLOT * i + SLOT / 2 - 12, text, 18, LINE));
    });
    summary.push(`branch ${b + 1}: ${branch.map((p) => [p.type, p.label, p.value].filter(Boolean).join(" ")).join(", ")}`);
  });
  return { skeletons: out, summary: `${branches.length > 1 ? "parallel" : "series"}; ${summary.join("; ")}` };
}

module.exports = { buildTimeline, buildCycle, buildParts, buildCircuit, COMPONENTS, SOURCES };
