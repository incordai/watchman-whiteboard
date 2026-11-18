"use strict";

// Watchman Whiteboard: BoardChem (lib/board-chem.js). A structural formula from SMILES, drawn by OpenChemLib as an SVG
// in Node (the page turns it into a PNG, as a math step), with its formula and molar mass. A bad SMILES is refused with
// the parser's words and nothing is drawn.

require("../support/private-temp");
const { attempts } = require("../support/no-network");
const test = require("node:test");
const assert = require("node:assert/strict");
const { AppError } = require("../../skills/debug-board-server/scripts/lib/app-error");
const { checkMoleculeBody, renderMolecules, MOLECULE_LIMITS } = require("../../skills/debug-board-server/scripts/lib/board-chem");

const board = (list = []) => new Map(list.map((element) => [element.id, element]));
const refused = (code, details = {}) => (error) => {
  assert.ok(error instanceof AppError, String(error && error.stack));
  assert.equal(error.code, code, error.message);
  for (const [key, value] of Object.entries(details)) {
    if (value instanceof RegExp) assert.match(String(key === "message" ? error.message : error.details[key]), value);
    else assert.deepEqual(key === "message" ? error.message : error.details[key], value, key);
  }
  return true;
};

test("checkMoleculeBody takes 1 to MOLECULE_LIMITS.molecules molecules, each with an id and its SMILES", () => {
  const checked = checkMoleculeBody({ molecules: [{ id: "k1-m1", smiles: "CCO", name: "ethanol", note: "a drink" }] }, board());
  assert.deepEqual(checked.molecules, [{ id: "k1-m1", smiles: "CCO", name: "ethanol", note: "a drink" }]);
  assert.throws(() => checkMoleculeBody({ molecules: [] }, board()), refused("InvalidChemistry", { field: "molecules" }));
  const many = Array.from({ length: MOLECULE_LIMITS.molecules + 1 }, (_, i) => ({ id: `m${i}`, smiles: "C" }));
  assert.throws(() => checkMoleculeBody({ molecules: many }, board()), refused("InvalidChemistry", { field: "molecules" }));
  assert.throws(() => checkMoleculeBody({ molecules: [{ id: "a", smiles: "" }] }, board()), refused("InvalidChemistry", { index: 0, field: "smiles" }));
  assert.throws(() => checkMoleculeBody({ molecules: [{ id: "a", smiles: "C", extra: 1 }] }, board()), refused("InvalidChemistry", { index: 0, field: "extra" }));
  assert.throws(() => checkMoleculeBody({ molecules: [{ id: "a", smiles: "C" }] }, board([{ id: "a", isDeleted: false }])), refused("DuplicateId", { ids: ["a"] }));
});

test("renderMolecules draws each structure as an SVG with lines and atom letters only, with formula and molar mass", async () => {
  const [aspirin, water] = await renderMolecules([
    { id: "k1-m1", smiles: "CC(=O)Oc1ccccc1C(=O)O", name: "aspirin", note: null },
    { id: "k1-m2", smiles: "O", name: null, note: null },
  ]);
  assert.match(aspirin.svg, /^<svg [^>]*width="[\d.]+px" height="[\d.]+px"/);
  assert.doesNotMatch(aspirin.svg, /<(script|a|foreignObject|image|use|iframe)\b|href=|on[a-z]+=/i);
  assert.ok(aspirin.width > 100 && aspirin.height > 100, `${aspirin.width}x${aspirin.height}`);
  assert.equal(aspirin.formula, "C9H8O4");
  assert.equal(aspirin.molarMass, "180.159");
  assert.equal(water.molarMass, "18.015");
  assert.equal(water.formula, "H2O");
  assert.equal(aspirin.smiles, "CC(=O)Oc1ccccc1C(=O)O");
});

test("a bad SMILES is refused with the parser's words, naming the molecule", async () => {
  await assert.rejects(renderMolecules([{ id: "a", smiles: "CCO", note: null }, { id: "b", smiles: "C1CC(", note: null }]),
    refused("InvalidChemistry", { index: 1, field: "smiles", message: /^molecules\[1\]: SmilesParser: .+/ }));
});

test("no chemistry call reached the network", () => {
  assert.deepEqual(attempts, []);
});
