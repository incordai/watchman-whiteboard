"use strict";

// Watchman Whiteboard: BoardMap (lib/board-map.js). The world's countries, offline, as the board's own outlines:
// zoomed to what is asked, chosen countries filled and labelled, places marked; every outline and marker has its own id.

const test = require("node:test");
const assert = require("node:assert/strict");
const { checkDraw } = require("../../skills/debug-board-server/scripts/lib/board-ops");
const { buildMap, countries } = require("../../skills/debug-board-server/scripts/lib/board-map");

// @purity pure
function assertDrawable(skeletons, prefix) {
  assert.ok(skeletons.length > 0 && skeletons.length <= 500, `${skeletons.length} elements`);
  checkDraw({ elements: skeletons }, new Map(), 2000);
  const ids = skeletons.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const id of ids) assert.ok(id.startsWith(`${prefix}-`), id);
}

const byId = (skeletons, id) => skeletons.find((s) => s.id === id);
const refused = (pattern) => (error) => error.code === "InvalidMap" && pattern.test(error.message);

test("the data is the world's countries, decoded to longitudes and latitudes", () => {
  const all = countries();
  assert.equal(all.length, 177);
  const india = all.find((c) => c.name === "India");
  const [lon, lat] = india.rings[0][0];
  assert.ok(lon > 65 && lon < 100 && lat > 5 && lat < 40, `${lon},${lat} is in India`);
});

test("the whole world fits in one drawing, under the board's limit", () => {
  const { skeletons, summary } = buildMap({ region: "world", title: "The world" }, "w1");
  assertDrawable(skeletons, "w1");
  assert.ok(byId(skeletons, "w1-brazil") && byId(skeletons, "w1-australia"), "big countries are there");
  assert.match(summary, /^view -180,-58,180,84$/);
});

test("highlighted countries are filled, labelled, and the view zooms to them; places are marked", () => {
  const { skeletons, summary } = buildMap({
    highlight: [{ country: "India", color: "orange", label: "India" }, { country: "Nepal", color: "green" }],
    markers: [{ lon: 77.2, lat: 28.6, label: "New Delhi" }],
  }, "w5");
  assertDrawable(skeletons, "w5");
  const india = byId(skeletons, "w5-india");
  assert.equal(india.backgroundColor, "#ffd8a8");
  assert.equal(byId(skeletons, "w5-nepal").backgroundColor, "#b2f2bb");
  assert.equal(byId(skeletons, "w5-india-label").text, "India");
  assert.equal(byId(skeletons, "w5-m1-label").text, "New Delhi");
  assert.ok(!byId(skeletons, "w5-brazil"), "far countries are left out of a zoomed view");
  assert.match(summary, /highlighted India, Nepal; marked New Delhi/);
});

test("common names work, and a wrong name is refused with suggestions", () => {
  const { summary } = buildMap({ highlight: [{ country: "USA" }] }, "w2");
  assert.match(summary, /United States of America/);
  assert.throws(() => buildMap({ highlight: [{ country: "Atlantis" }] }, "w3"), refused(/no country named "Atlantis"/));
  assert.throws(() => buildMap({ highlight: [{ country: "Peru", color: "pink" }] }, "w3"), refused(/color must be one of/));
  assert.throws(() => buildMap({ markers: [{ lon: 200, lat: 0, label: "x" }] }, "w3"), refused(/lon/));
  assert.throws(() => buildMap({ region: [10, 0, 5, 20] }, "w3"), refused(/west < east/));
});

test("a region box shows only what is inside it", () => {
  const { skeletons } = buildMap({ region: [-10, 35, 30, 60], markers: [{ lon: 2.35, lat: 48.86, label: "Paris" }] }, "w4");
  assertDrawable(skeletons, "w4");
  assert.ok(byId(skeletons, "w4-france") && byId(skeletons, "w4-germany"));
  assert.ok(!byId(skeletons, "w4-japan"));
});
