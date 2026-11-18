// Watchman Whiteboard: the pure half of the drawing animation (see ../../../UPSTREAM). When an agent draws,
// the page reveals the new Elements like a person at a whiteboard explaining them, one step at a time along the
// diagram's flow: a shape is traced and its label written at once, then the arrow leaving it grows (with its
// label), then the next shape, and so on (see revealPlan). This file plans and times that; app.js puts
// the frames on screen as local Elements that are never sent (ANIMATION_MARK). No browser or Excalidraw here:
// test/unit/reveal.test.js loads this same file.

export const REVEAL = Object.freeze({
  // Base time of each step at speed 1 (ms). A text takes CHAR_MS a letter, within TEXT_MIN_MS..TEXT_MAX_MS.
  SHAPE_MS: 450,
  SHOW_MS: 150,
  LINE_MS: 350,
  CHAR_MS: 35,
  TEXT_MIN_MS: 150,
  TEXT_MAX_MS: 900,
  // A part of the narration with nothing to draw still takes this long.
  PAUSE_MS: 500,
  // A whole drawing never takes longer: a big table is drawn faster, not longer.
  MAX_TOTAL_MS: 6000,
  // At most this share of the Job timeout, so the reply always comes in time.
  TIMEOUT_SHARE: 0.4,
  DEFAULT_SPEED: 1,
  MAX_SPEED: 10,
  ELLIPSE_STEPS: 32,
  // Two Elements are in one row when the top of the second is at most this far below the row's top, or half
  // the height of the lower of the two (a tall lifeline does not swallow the arrows beside it).
  ROW_MIN_PX: 10,
  // A free text (not bound) this near an arrow is that arrow's label, as Mermaid places some labels.
  LABEL_NEAR_PX: 40,
  // The page waits this long after scrolling to a drawing, so its first step is drawn where the viewer looks.
  SCROLL_WAIT_MS: 600,
  // The frames of the page come about this often (ms).
  FRAME_MS: 33,
});

// customData flag of the animation's own Elements: the page never sends them (app.js collectChanges).
export const ANIMATION_MARK = "grwbAnimation";
// The DOM event (on window) and the postMessage type of one part of the narration.
export const SAY_EVENT = "watchman-whiteboard:say";

const TRACED_TYPES = ["rectangle", "ellipse", "diamond"];
const LINEAR_TYPES = ["arrow", "line"];

export function isAnimationTemp(element) {
  return Boolean(element && element.customData && element.customData[ANIMATION_MARK] === true);
}

// The speed of the animation: `param` (the page's #anim= value) or the default; 0 is no animation.
// Reduced motion and a hidden page (timers are slowed there) always give 0.
export function animationSpeed({ param, reducedMotion = false, hidden = false } = {}) {
  if (reducedMotion || hidden) return 0;
  if (param === undefined || param === null || String(param).trim() === "") return REVEAL.DEFAULT_SPEED;
  const value = Number(param);
  if (!Number.isFinite(value) || value < 0) return REVEAL.DEFAULT_SPEED;
  return Math.min(value, REVEAL.MAX_SPEED);
}

function isLinear(element) {
  return LINEAR_TYPES.includes(element.type) && Array.isArray(element.points) && element.points.length >= 2;
}

// The box of an Element; arrows and lines by their points.
function boxOf(element) {
  if (Array.isArray(element.points) && element.points.length > 0) {
    const xs = element.points.map((p) => element.x + p[0]);
    const ys = element.points.map((p) => element.y + p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  return { x: element.x, y: element.y, width: element.width || 0, height: element.height || 0 };
}

function centerOf(element) {
  const box = boxOf(element);
  return [box.x + box.width / 2, box.y + box.height / 2];
}

// The distance from a point to the path of an arrow or line.
function distanceToPath([px, py], line) {
  let best = Infinity;
  for (let i = 1; i < line.points.length; i += 1) {
    const ax = line.x + line.points[i - 1][0];
    const ay = line.y + line.points[i - 1][1];
    const bx = line.x + line.points[i][0];
    const by = line.y + line.points[i][1];
    const length2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / length2)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay))));
  }
  return best;
}

// Rows from top to bottom, each row from left to right.
export function readingOrder(elements) {
  const boxes = new Map(elements.map((element) => [element, boxOf(element)]));
  const byTop = [...elements].sort((a, b) => boxes.get(a).y - boxes.get(b).y);
  const rows = [];
  for (const element of byTop) {
    const row = rows[rows.length - 1];
    const box = boxes.get(element);
    if (row && box.y <= row.top + Math.max(REVEAL.ROW_MIN_PX, Math.min(row.height, box.height) / 2)) row.items.push(element);
    else rows.push({ top: box.y, height: box.height, items: [element] });
  }
  return rows.flatMap((row) => row.items.sort((a, b) => boxes.get(a).x - boxes.get(b).x));
}

// `count` things in `parts` parts, as evenly as possible, larger parts first.
export function splitEven(count, parts) {
  const base = Math.floor(count / parts);
  const extra = count % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

function stepOf(element) {
  if (element.type === "text") return { id: element.id, kind: "text", chars: Array.from(String(element.text || "")).length };
  if (LINEAR_TYPES.includes(element.type) && Array.isArray(element.points) && element.points.length >= 2) return { id: element.id, kind: "line" };
  if (TRACED_TYPES.includes(element.type) && !element.angle) return { id: element.id, kind: "shape" };
  return { id: element.id, kind: "show" };
}

// Left to right, then top to bottom: the order of the arrows that leave one shape.
function byPlace(a, b) {
  return a.at[0] - b.at[0] || a.at[1] - b.at[1];
}

// The step groups of the reveal, in the order a person explaining the drawing would draw them. A group is one
// thing and its label(s): a shape (traced) and its text, or an arrow (grown) and its label.
// - A label is a text bound to a shape or arrow (containerId), or a free text that lies inside a shape or
//   within LABEL_NEAR_PX of an arrow (Mermaid puts some labels on their own).
// - The walk starts at the shapes that no arrow comes into (in reading order, each walked to its end before
//   the next), else at the first shape in reading order. Breadth first: at each shape, every arrow that leaves
//   it is drawn in turn, arrows to new shapes first (their targets left to right, then top to bottom), then
//   arrows back to shapes already drawn; a new target is drawn right after its arrow and walked later. An arrow
//   is drawn once, when its source is reached; its target is never drawn twice.
// - Loose lines and arrows (no shape at either end; sequence diagrams) go in reading order among the start
//   shapes. Shapes the walk never reached come last, in reading order, each walked the same way.
// A table (cells, no arrows) is thus drawn row by row from the top, each cell followed by its text.
export function revealGroups(elements) {
  const ids = new Set(elements.map((element) => element.id));
  const labels = new Map();
  const addLabel = (ownerId, text) => {
    if (!labels.has(ownerId)) labels.set(ownerId, []);
    labels.get(ownerId).push(text);
  };
  const free = [];
  for (const element of elements) {
    if (element.type === "text" && element.containerId && ids.has(element.containerId)) addLabel(element.containerId, element);
    else free.push(element);
  }
  const lines = free.filter(isLinear);
  const shapes = free.filter((element) => !isLinear(element) && element.type !== "text");
  const nodes = [...shapes];
  for (const text of free.filter((element) => element.type === "text")) {
    const center = centerOf(text);
    const holders = shapes.filter((shape) => {
      const box = boxOf(shape);
      return center[0] >= box.x && center[0] <= box.x + box.width && center[1] >= box.y && center[1] <= box.y + box.height;
    });
    if (holders.length > 0) {
      const smallest = holders.reduce((a, b) => (boxOf(b).width * boxOf(b).height < boxOf(a).width * boxOf(a).height ? b : a));
      addLabel(smallest.id, text);
      continue;
    }
    // Arrows before plain lines: a label sits on an arrow, a lifeline is only near it.
    const near = (list) => list
      .map((line) => ({ line, distance: distanceToPath(center, line) }))
      .filter((entry) => entry.distance <= REVEAL.LABEL_NEAR_PX)
      .sort((a, b) => a.distance - b.distance)[0];
    const hit = near(lines.filter((line) => line.type === "arrow")) || near(lines.filter((line) => line.type !== "arrow"));
    if (hit) addLabel(hit.line.id, text);
    else nodes.push(text);
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const endNode = (line, end) => {
    const binding = line[end];
    return binding && nodeById.has(binding.elementId) ? nodeById.get(binding.elementId) : null;
  };
  const outgoing = new Map();
  const comingIn = new Map();
  const reached = new Set();
  const loose = [];
  for (const line of lines) {
    const from = endNode(line, "startBinding");
    const to = endNode(line, "endBinding");
    if (from) {
      if (!outgoing.has(from.id)) outgoing.set(from.id, []);
      outgoing.get(from.id).push(line);
      if (to && to.id !== from.id) reached.add(to.id);
    } else if (to) {
      // From a shape already on the board: drawn right after the new shape it goes into.
      if (!comingIn.has(to.id)) comingIn.set(to.id, []);
      comingIn.get(to.id).push(line);
    } else {
      loose.push(line);
    }
  }
  const groups = [];
  const drawn = new Set();
  const groupOf = (element) => [stepOf(element), ...readingOrder(labels.get(element.id) || []).map(stepOf)];
  const drawLine = (line) => {
    if (drawn.has(line.id)) return;
    drawn.add(line.id);
    groups.push(groupOf(line));
  };
  const drawNode = (node) => {
    drawn.add(node.id);
    groups.push(groupOf(node));
    for (const line of readingOrder(comingIn.get(node.id) || [])) drawLine(line);
  };
  const walk = (start) => {
    if (drawn.has(start.id)) return;
    drawNode(start);
    const queue = [start];
    while (queue.length > 0) {
      const node = queue.shift();
      const leaving = (outgoing.get(node.id) || []).map((line) => {
        const to = endNode(line, "endBinding");
        const box = to ? boxOf(to) : null;
        const last = line.points[line.points.length - 1];
        return { line, to, at: box ? [box.x, box.y] : [line.x + last[0], line.y + last[1]], back: Boolean(to && drawn.has(to.id)) };
      });
      const ordered = [...leaving.filter((e) => !e.back).sort(byPlace), ...leaving.filter((e) => e.back).sort(byPlace)];
      for (const { line, to } of ordered) {
        drawLine(line);
        if (to && !drawn.has(to.id)) {
          drawNode(to);
          queue.push(to);
        }
      }
    }
  };
  const order = readingOrder(nodes);
  const starts = order.filter((node) => !reached.has(node.id));
  if (starts.length === 0 && order.length > 0) starts.push(order[0]);
  const startIds = new Set(starts.map((node) => node.id));
  const looseIds = new Set(loose.map((line) => line.id));
  for (const element of readingOrder([...starts, ...loose])) {
    if (looseIds.has(element.id)) drawLine(element);
    else if (startIds.has(element.id)) walk(element);
  }
  for (const node of order) walk(node);
  return groups;
}

// The plan of the reveal: `parts` parts (one per sentence of the narration), each a list of steps
// { id, kind: "shape" | "show" | "line" | "text", chars? } in drawing order. The step groups of revealGroups are
// split evenly into the parts, in order: with as many sentences as groups, part k is the k-th group.
export function revealPlan(elements, parts = 1) {
  const count = Math.max(1, Math.floor(parts) || 1);
  const groups = revealGroups(elements);
  const sizes = splitEven(groups.length, count);
  let next = 0;
  return sizes.map((size) => {
    const steps = groups.slice(next, next + size).flat();
    next += size;
    return { steps };
  });
}

function baseMs(step) {
  if (step.kind === "shape") return REVEAL.SHAPE_MS;
  if (step.kind === "line") return REVEAL.LINE_MS;
  if (step.kind === "text") return Math.min(REVEAL.TEXT_MAX_MS, Math.max(REVEAL.TEXT_MIN_MS, step.chars * REVEAL.CHAR_MS));
  return REVEAL.SHOW_MS;
}

// When each step and each part starts and ends (ms from the start), one step after another, as one hand draws.
// The time scales with 1 / speed and never goes over maxTotalMs. Speed 0: everything at 0 (no animation).
export function revealSchedule(plan, { speed = REVEAL.DEFAULT_SPEED, maxTotalMs = REVEAL.MAX_TOTAL_MS } = {}) {
  const items = [];
  const partMarks = [];
  let sum = 0;
  plan.forEach((part, index) => {
    const startBase = sum;
    if (part.steps.length === 0) sum += REVEAL.PAUSE_MS;
    for (const step of part.steps) {
      const start = sum;
      sum += baseMs(step);
      items.push({ ...step, part: index, startBase: start, endBase: sum });
    }
    partMarks.push({ startBase, endBase: sum });
  });
  const off = !(speed > 0);
  const scaled = !off && sum / speed > maxTotalMs;
  const at = (base) => {
    if (off) return 0;
    return scaled ? (base * maxTotalMs) / sum : base / speed;
  };
  return {
    totalMs: at(sum),
    steps: items.map(({ startBase, endBase, ...step }) => ({ ...step, startMs: at(startBase), endMs: at(endBase) })),
    parts: partMarks.map(({ startBase, endBase }) => ({ startMs: at(startBase), endMs: at(endBase) })),
  };
}

// How far each step is at `ms` (id -> 0..1), the last part that has started, and whether all is drawn.
export function progressAt(schedule, ms) {
  const progress = new Map();
  for (const step of schedule.steps) {
    const length = step.endMs - step.startMs;
    let value;
    if (ms >= step.endMs) value = 1;
    else if (ms <= step.startMs) value = 0;
    else value = (ms - step.startMs) / length;
    progress.set(step.id, value);
  }
  let part = 0;
  schedule.parts.forEach((mark, index) => {
    if (mark.startMs <= ms) part = index;
  });
  return { progress, part, done: ms >= schedule.totalMs };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

// The outline of a shape as a closed path (relative to its x, y), from its top, clockwise.
export function outlinePoints(shape) {
  const w = shape.width;
  const h = shape.height;
  if (shape.type === "diamond") return [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2], [w / 2, 0]];
  if (shape.type === "ellipse") {
    const n = REVEAL.ELLIPSE_STEPS;
    return Array.from({ length: n + 1 }, (_, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * (i % n)) / n;
      return [round(w / 2 + (w / 2) * Math.cos(a)), round(h / 2 + (h / 2) * Math.sin(a))];
    });
  }
  return [[0, 0], [w, 0], [w, h], [0, h], [0, 0]];
}

// The first `t` (0..1) of a path, by length; the last point is cut in its segment. Always a new list.
export function polylineAt(points, t) {
  const copy = points.map((p) => [p[0], p[1]]);
  if (t >= 1) return copy;
  const lengths = [];
  let total = 0;
  for (let i = 1; i < copy.length; i += 1) {
    const length = Math.hypot(copy[i][0] - copy[i - 1][0], copy[i][1] - copy[i - 1][1]);
    lengths.push(length);
    total += length;
  }
  if (total === 0) return copy;
  if (t <= 0) return [copy[0], [copy[0][0], copy[0][1]]];
  const target = t * total;
  const out = [copy[0]];
  let done = 0;
  for (let i = 1; i < copy.length; i += 1) {
    const length = lengths[i - 1];
    if (done + length >= target) {
      const f = length > 0 ? (target - done) / length : 1;
      out.push([copy[i - 1][0] + (copy[i][0] - copy[i - 1][0]) * f, copy[i - 1][1] + (copy[i][1] - copy[i - 1][1]) * f]);
      return out;
    }
    out.push(copy[i]);
    done += length;
  }
  return out;
}

// A path at (x, y) as an Excalidraw line: its first point at 0,0, and the size of its points.
export function asLinear(x, y, points) {
  const [x0, y0] = points[0];
  const moved = points.map(([px, py]) => [px - x0, py - y0]);
  const xs = moved.map((p) => p[0]);
  const ys = moved.map((p) => p[1]);
  return { x: x + x0, y: y + y0, points: moved, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

// The first `t` (0..1) of a text, by letters (whole characters, never half an emoji).
export function textAt(text, t) {
  const chars = Array.from(String(text || ""));
  if (t >= 1) return chars.join("");
  if (t <= 0) return "";
  // Once writing has started, at least the first letter shows.
  return chars.slice(0, Math.max(1, Math.floor(t * chars.length))).join("");
}

// The times (ms from the start) at which the page shows a frame: one every frameMs, plus the middle of every
// step that no regular frame falls inside, so every step (the first included) is seen half drawn before it is
// whole, however short the budget makes it. The last time is the end: the finished drawing.
export function revealTimeline(schedule, frameMs = REVEAL.FRAME_MS) {
  const times = new Set();
  for (let t = frameMs; t < schedule.totalMs; t += frameMs) times.add(t);
  const ticks = [...times];
  for (const step of schedule.steps) {
    if (!ticks.some((t) => t > step.startMs && t < step.endMs)) times.add((step.startMs + step.endMs) / 2);
  }
  times.add(schedule.totalMs);
  return [...times].sort((a, b) => a - b);
}

// What the page announces when part `index` (from 0) of the narration starts: part counts from 1.
export function sayDetail(say, index, jobId) {
  return { text: say[index], part: index + 1, parts: say.length, jobId };
}
