"use strict";

// BoardMap (Entity), Watchman Whiteboard. draw_map (geography): the world's countries from Natural Earth's 1:110m
// data (world-atlas 2.0.2, ISC; geo/countries-110m.json, shipped with the board so it works offline), as the board's
// own outlines, zoomed to the countries asked for or to a box of longitudes and latitudes; chosen countries filled and
// labelled; places marked by longitude and latitude. Every country outline and marker has its own id, so a wrong
// one can be recoloured, relabelled or erased. Pure; errors are AppError InvalidMap (400). Called by mcp.js.

const { AppError } = require("./app-error");
const TOPOLOGY = require("./geo/countries-110m.json");

const VIEW = Object.freeze({ width: 820, height: 460, margin: 20 });
const NAMED = Object.freeze({
  blue: "#a5d8ff", red: "#ffc9c9", green: "#b2f2bb", orange: "#ffd8a8", violet: "#d0bfff", yellow: "#ffec99", gray: "#dee2e6",
});
const OUTLINE = "#868e96";
const STRONG = "#1e1e1e";
const MAX_ELEMENTS = 480;

// @purity pure
function fail(message) {
  return new AppError("InvalidMap", 400, message);
}

// @purity pure
function round(n) {
  return Math.round(n * 10) / 10;
}

// @purity pure
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "x";
}

// TopoJSON arcs in longitude and latitude: delta-encoded, quantized by the topology's transform.
// @purity pure
function decodeArcs(topology) {
  const [sx, sy] = topology.transform.scale;
  const [tx, ty] = topology.transform.translate;
  return topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty];
    });
  });
}

// One ring from arc indices (a negative index ~i is arc i reversed); shared end points are not repeated.
// @purity pure
function ring(indices, arcs) {
  const points = [];
  for (const index of indices) {
    const arc = index < 0 ? [...arcs[~index]].reverse() : arcs[index];
    arc.forEach((p, k) => {
      if (k > 0 || points.length === 0) points.push(p);
    });
  }
  return points;
}

let COUNTRIES = null;

// Every country: { name, rings: [[lon, lat]...] }, its outer rings only (holes are lakes, not needed on a school map).
// @purity non-pure (memoized)
function countries() {
  if (COUNTRIES) return COUNTRIES;
  const arcs = decodeArcs(TOPOLOGY);
  COUNTRIES = TOPOLOGY.objects.countries.geometries.map((g) => {
    const polygons = g.type === "Polygon" ? [g.arcs] : g.type === "MultiPolygon" ? g.arcs : [];
    return { name: g.properties.name, rings: polygons.map((polygon) => ring(polygon[0], arcs)) };
  });
  return COUNTRIES;
}

// The country named `name` (any case; a few common other names too).
// @purity pure
function findCountry(name, all) {
  const ALIASES = { usa: "United States of America", "united states": "United States of America", us: "United States of America", uk: "United Kingdom", britain: "United Kingdom", russia: "Russia", "south korea": "South Korea", "north korea": "North Korea", drc: "Dem. Rep. Congo", "czech republic": "Czechia" };
  const wanted = String(name).trim().toLowerCase();
  const target = (ALIASES[wanted] || wanted).toLowerCase();
  const found = all.find((c) => c.name.toLowerCase() === target);
  if (found) return found;
  const close = all.filter((c) => c.name.toLowerCase().includes(target.slice(0, 4))).slice(0, 5).map((c) => c.name);
  throw fail(`no country named "${name}"${close.length ? `; did you mean ${close.join(", ")}?` : ""}`);
}

// @purity pure
function bboxOf(rings) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) for (const [x, y] of r) {
    box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
  }
  return box;
}

// @purity pure
function areaOf(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a / 2);
}

// The board takes at most 100 points in one line (board-ops MAX_POINTS): an outline is simplified on the board's own
// pixels (Douglas-Peucker, a larger tolerance each round) until it fits, which keeps the shape a person sees.
const MAX_LINE_POINTS = 98;

// @purity pure
function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  const [a, b] = [points[0], points[points.length - 1]];
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length = Math.hypot(dx, dy) || 1;
  let far = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = Math.abs(dy * points[i][0] - dx * points[i][1] + b[0] * a[1] - b[1] * a[0]) / length;
    if (d > far) {
      far = d;
      index = i;
    }
  }
  if (far <= tolerance) return [a, b];
  return [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)];
}

// @purity pure
function fitPoints(points) {
  if (points.length <= MAX_LINE_POINTS) return points;
  // A closed ring has the same first and last point: split it in two halves so each keeps its far corners.
  const half = Math.floor(points.length / 2);
  for (let tolerance = 0.5; tolerance < 64; tolerance *= 1.6) {
    const fitted = [...simplify(points.slice(0, half + 1), tolerance).slice(0, -1), ...simplify(points.slice(half), tolerance)];
    if (fitted.length <= MAX_LINE_POINTS) return fitted;
  }
  const step = Math.ceil(points.length / MAX_LINE_POINTS);
  return points.filter((_, i) => i % step === 0);
}

// draw_map: `spec` { highlight?: [{ country, color?, label? }], markers?: [{ lon, lat, label }], region?: "world" |
// [west, south, east, north], title? }. Without a region it zooms to the highlighted countries and markers, else the
// world. Returns { skeletons, summary }.
// @purity pure
function buildMap(spec, prefix) {
  const all = countries();
  const highlight = (spec.highlight || []).map((h, i) => {
    if (!h || typeof h !== "object" || typeof h.country !== "string") throw fail(`highlight[${i}].country must be a country name`);
    const color = h.color === undefined ? "blue" : h.color;
    if (!NAMED[color]) throw fail(`highlight[${i}].color must be one of ${Object.keys(NAMED).join(", ")}`);
    return { country: findCountry(h.country, all), color: NAMED[color], label: h.label === undefined ? null : String(h.label).slice(0, 40) };
  });
  const markers = (spec.markers || []).map((mk, i) => {
    if (!mk || !Number.isFinite(mk.lon) || !Number.isFinite(mk.lat) || Math.abs(mk.lon) > 180 || Math.abs(mk.lat) > 90) {
      throw fail(`markers[${i}] needs lon (-180..180) and lat (-90..90)`);
    }
    if (typeof mk.label !== "string" || !mk.label.trim()) throw fail(`markers[${i}].label must be text`);
    return { lon: mk.lon, lat: mk.lat, label: mk.label.trim().slice(0, 40) };
  });
  if (highlight.length > 40 || markers.length > 40) throw fail("at most 40 highlighted countries and 40 markers");
  // The view: the region given, else the highlighted countries and markers with room around, else the world.
  let box;
  if (Array.isArray(spec.region)) {
    if (spec.region.length !== 4 || !spec.region.every(Number.isFinite) || spec.region[0] >= spec.region[2] || spec.region[1] >= spec.region[3]) {
      throw fail("region must be [west, south, east, north] in degrees, west < east and south < north");
    }
    box = [...spec.region];
  } else if (spec.region !== "world" && (highlight.length || markers.length)) {
    const rings = [...highlight.flatMap((h) => h.country.rings.filter((r) => areaOf(r) > 0.5)), markers.map((mk) => [mk.lon, mk.lat])];
    box = bboxOf(rings.filter((r) => r.length));
    const padX = Math.max((box[2] - box[0]) * 0.25, 4);
    const padY = Math.max((box[3] - box[1]) * 0.25, 3);
    box = [Math.max(-180, box[0] - padX), Math.max(-85, box[1] - padY), Math.min(180, box[2] + padX), Math.min(85, box[3] + padY)];
  } else {
    box = [-180, -58, 180, 84];
  }
  // Equirectangular, x shrunk by the cosine of the middle latitude so shapes keep their look at that latitude.
  const k = Math.cos(((box[1] + box[3]) / 2) * Math.PI / 180);
  const top = spec.title ? 44 : 0;
  const scale = Math.min((VIEW.width - 2 * VIEW.margin) / ((box[2] - box[0]) * k), (VIEW.height - 2 * VIEW.margin) / (box[3] - box[1]));
  const px = ([lon, lat]) => [VIEW.margin + (lon - box[0]) * k * scale, top + VIEW.margin + (box[3] - lat) * scale];
  const inside = (r) => {
    const b = bboxOf([r]);
    return b[2] >= box[0] && b[0] <= box[2] && b[3] >= box[1] && b[1] <= box[3];
  };
  const clamp = ([lon, lat]) => [Math.min(Math.max(lon, box[0]), box[2]), Math.min(Math.max(lat, box[1]), box[3])];
  const id = (suffix) => `${prefix}-${suffix}`;
  const out = [];
  if (spec.title) out.push({ type: "text", id: id("title"), x: VIEW.margin, y: 4, text: String(spec.title).slice(0, 120), fontSize: 24, fontFamily: 5, strokeColor: STRONG });
  out.push({ type: "rectangle", id: id("frame"), x: VIEW.margin, y: top + VIEW.margin, width: round((box[2] - box[0]) * k * scale), height: round((box[3] - box[1]) * scale), strokeColor: OUTLINE, backgroundColor: "transparent", strokeWidth: 1, roughness: 0 });
  const chosen = new Map(highlight.map((h) => [h.country.name, h]));
  // Small islands drop out first when the world would need more outlines than the board takes in one drawing.
  const minArea = spec.region === "world" || (!Array.isArray(spec.region) && !highlight.length && !markers.length) ? 1.5 : 0.05;
  const used = new Set();
  for (const country of all) {
    const pick = chosen.get(country.name);
    const rings = country.rings.filter((r) => inside(r) && (pick || areaOf(r) >= minArea));
    rings.forEach((r, n) => {
      if (out.length >= MAX_ELEMENTS) return;
      const points = fitPoints(r.map(clamp).map(px));
      if (points.length < 3) return;
      const [x0, y0] = points[0];
      let key = `${slug(country.name)}${n ? `-${n + 1}` : ""}`;
      while (used.has(key)) key += "x";
      used.add(key);
      out.push({
        type: "line", id: id(key), x: round(x0), y: round(y0), points: [...points, points[0]].map(([x, y]) => [round(x - x0), round(y - y0)]),
        strokeColor: pick ? STRONG : OUTLINE, strokeWidth: pick ? 1.5 : 1, roughness: 0,
        ...(pick ? { backgroundColor: pick.color } : {}),
      });
    });
  }
  // Labels at the middle of each chosen country's largest piece; markers as dots with their names.
  for (const h of highlight) {
    const biggest = [...h.country.rings].sort((a, b) => areaOf(b) - areaOf(a))[0];
    const b = bboxOf([biggest]);
    const [x, y] = px(clamp([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]));
    const text = h.label || h.country.name;
    out.push({ type: "text", id: id(`${slug(h.country.name)}-label`), x: round(x - text.length * 4.5), y: round(y - 10), text, fontSize: 16, fontFamily: 6, strokeColor: STRONG });
  }
  markers.forEach((mk, i) => {
    const [x, y] = px(clamp([mk.lon, mk.lat]));
    out.push({ type: "ellipse", id: id(`m${i + 1}`), x: round(x - 5), y: round(y - 5), width: 10, height: 10, strokeColor: "#e03131", backgroundColor: "#e03131", fillStyle: "solid", strokeWidth: 1, roughness: 0 });
    out.push({ type: "text", id: id(`m${i + 1}-label`), x: round(x + 8), y: round(y - 10), text: mk.label, fontSize: 16, fontFamily: 6, strokeColor: "#c92a2a" });
  });
  const summary = [
    `view ${box.map((v) => Math.round(v)).join(",")}`,
    highlight.length ? `highlighted ${highlight.map((h) => h.country.name).join(", ")}` : null,
    markers.length ? `marked ${markers.map((mk) => mk.label).join(", ")}` : null,
  ].filter(Boolean).join("; ");
  return { skeletons: out, summary };
}

module.exports = { buildMap, countries, decodeArcs, COLORS: Object.keys(NAMED) };
