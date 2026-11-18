"use strict";

// BoardChem (Entity + Adapter), Watchman Whiteboard. Structural formulas for draw_molecule: each molecule's SMILES is
// read by OpenChemLib in Node, which draws it as an SVG (lines, and letters for atoms other than carbon, in the usual
// colors) and gives its formula and molar mass. The SVG then goes to the page in a math Job, which turns it into a PNG
// image as it does a math step (page/app.js drawMath); the image carries its SMILES in customData.smiles, so
// read_board shows it. A bad SMILES is refused with the parser's words and nothing is drawn.

const { AppError } = require("./app-error");
const mathLibs = require("./math-libs");

const MOLECULE_LIMITS = Object.freeze({ molecules: 12, smilesChars: 500, noteChars: 300, nameChars: 80 });
const ID_PATTERN = /^[A-Za-z0-9_-]{1,59}$/;
const FIELDS = Object.freeze(["id", "smiles", "name", "note"]);
// The box OpenChemLib draws in before it crops to the molecule: big enough for a bond to be about 30 px.
const DRAW_BOX = Object.freeze({ width: 420, height: 320 });

// @purity pure
function invalid(index, field, message) {
  return new AppError("InvalidChemistry", 400, message, { index, field });
}

// Checks the body of POST /v1/molecule. Returns { molecules: [{ id, smiles, name, note }], at }.
// @purity pure
function checkMoleculeBody(body, elements) {
  const list = body && body.molecules;
  if (!Array.isArray(list) || list.length < 1 || list.length > MOLECULE_LIMITS.molecules) {
    throw invalid(null, "molecules", `molecules must be a list of 1 to ${MOLECULE_LIMITS.molecules}`);
  }
  const ids = new Set();
  const molecules = list.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid(index, null, "a molecule must be a JSON object");
    const extra = Object.keys(item).find((field) => !FIELDS.includes(field));
    if (extra) throw invalid(index, extra, `field ${extra} is not allowed in a molecule`);
    if (typeof item.id !== "string" || !ID_PATTERN.test(item.id) || ids.has(item.id)) throw invalid(index, "id", "id must be 1 to 59 letters, digits, - or _, once");
    ids.add(item.id);
    if (typeof item.smiles !== "string" || item.smiles.trim() === "" || item.smiles.length > MOLECULE_LIMITS.smilesChars || /\s/.test(item.smiles.trim())) {
      throw invalid(index, "smiles", `smiles must be one SMILES string of 1 to ${MOLECULE_LIMITS.smilesChars} characters`);
    }
    const text = (field, max) => {
      const value = item[field];
      if (value === undefined || value === null) return null;
      if (typeof value !== "string" || value.trim() === "" || value.length > max) throw invalid(index, field, `${field} must be 1 to ${max} characters`);
      return value;
    };
    return { id: item.id, smiles: item.smiles.trim(), name: text("name", MOLECULE_LIMITS.nameChars), note: text("note", MOLECULE_LIMITS.noteChars) };
  });
  const wanted = molecules.flatMap((m) => (m.note === null ? [m.id] : [m.id, `${m.id}-note`]));
  const taken = wanted.filter((id) => elements.has(id) && !elements.get(id).isDeleted);
  if (taken.length > 0) throw new AppError("DuplicateId", 409, `ids already on the Board: ${taken.join(", ")}`, { ids: taken });
  const at = body.at;
  if (at !== undefined && at !== null && !(at && Number.isFinite(at.x) && Number.isFinite(at.y))) {
    throw new AppError("InvalidAt", 400, "at must be {\"x\": number, \"y\": number}");
  }
  return { molecules, at: at ? { x: at.x, y: at.y } : null };
}

// Each molecule drawn: [{ id, smiles, name, note, svg, width, height, formula, molarMass }]. The note is the name and
// the formula when none is given. Rejects with InvalidChemistry for the first bad SMILES.
// @purity non-pure
async function renderMolecules(molecules, libs = mathLibs) {
  const { Molecule } = await libs.loadMathLib("openchemlib");
  return molecules.map((item, index) => {
    let molecule;
    try {
      molecule = Molecule.fromSmiles(item.smiles);
    } catch (error) {
      const words = String((error && error.message) || error).replace(/^Class\$\S+:\s*/, "").split("\n")[0].slice(0, 200);
      throw invalid(index, "smiles", `molecules[${index}]: ${words}`);
    }
    if (molecule.getAllAtoms() === 0) throw invalid(index, "smiles", `molecules[${index}]: the SMILES has no atoms`);
    const raw = molecule.toSVG(DRAW_BOX.width, DRAW_BOX.height, item.id, { autoCrop: true, autoCropMargin: 12 });
    const size = /^<svg\b[^>]*\swidth="([\d.]+)px"[^>]*\sheight="([\d.]+)px"/.exec(raw);
    if (!size || /<(script|a|foreignObject|image|use|iframe)\b|href=|\son[a-z]+=/i.test(raw)) {
      throw new AppError("MathUnavailable", 503, "OpenChemLib gave an SVG the board cannot use");
    }
    const { formula, relativeWeight } = molecule.getMolecularFormula();
    // Three decimals: OpenChemLib's water is 18.01488, which two decimals would show as 18.01, not the books' 18.015.
    const molarMass = relativeWeight.toFixed(3);
    const note = item.note !== null ? item.note : `${item.name ? `${item.name}, ` : ""}${formula}, ${molarMass} g/mol`;
    return { ...item, note, svg: raw, width: Number(size[1]), height: Number(size[2]), formula, molarMass };
  });
}

module.exports = { checkMoleculeBody, renderMolecules, MOLECULE_LIMITS };
