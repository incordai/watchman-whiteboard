"use strict";

// BoardIndex (Entity), Watchman Whiteboard. What the board can draw, by subject (the owner, 2026-11-17: every school
// and university subject covered): one short line per subject naming the tool to use, then how to correct a drawing.
// The board_index tool gives it (mcp.js), the same words for every agent. test/unit/board-index.test.js checks that
// every draw tool is in it and that every tool it names exists. Pure.

const BOARD_INDEX = Object.freeze([
  { subject: "Mathematics", use: "check the working with check_math, then write it step by step with draw_math (LaTeX)", tools: ["check_math", "draw_math"] },
  { subject: "Functions and graphs", use: "draw_plot: y = f(x), parametric and polar curves, marked points", tools: ["draw_plot"] },
  { subject: "Statistics and data", use: "draw_chart: bar, line, scatter with a fitted line, histogram, box; it writes the numbers and your explanation", tools: ["draw_chart", "check_math"] },
  { subject: "Geometry", use: "draw_geometry: constructions true to scale, with lengths, angles and areas", tools: ["draw_geometry"] },
  { subject: "3D", use: "draw_chart3d: surfaces z = f(x, y), curves in space, points", tools: ["draw_chart3d"] },
  { subject: "Physics", use: "draw_circuit for circuits; draw_geometry vectors for forces; check_math evaluate for units; draw_math \\pu for quantities", tools: ["draw_circuit", "draw_geometry", "check_math", "draw_math"] },
  { subject: "Chemistry", use: "draw_math with \\ce for equations; draw_molecule for structures from SMILES, with formula and molar mass", tools: ["draw_math", "draw_molecule"] },
  { subject: "Biology", use: "draw_parts for labelled parts (a cell, the heart, a flower); draw_cycle for life cycles and processes", tools: ["draw_parts", "draw_cycle"] },
  { subject: "Geography", use: "draw_map: countries highlighted and labelled, places marked by longitude and latitude", tools: ["draw_map"] },
  { subject: "History", use: "draw_timeline: events in order of their dates; draw_map for where they happened", tools: ["draw_timeline", "draw_map"] },
  { subject: "Music", use: "draw_music: notes on a staff with clef, time, rests and lyrics", tools: ["draw_music"] },
  { subject: "Computer science", use: "draw_mermaid: graphs, trees, automata (stateDiagram), flowcharts, sequence and class diagrams", tools: ["draw_mermaid"] },
  { subject: "Languages", use: "draw_table: conjugations, vocabulary, grammar tables", tools: ["draw_table"] },
  { subject: "Economics", use: "draw_plot for supply and demand curves (mark the equilibrium with points); draw_chart for data", tools: ["draw_plot", "draw_chart"] },
  { subject: "Anything else", use: "write_answer for a few words; draw_skeletons for other shapes", tools: ["write_answer", "draw_skeletons"] },
]);

const CORRECTING = [
  "Correcting a whole drawing: call the same draw tool again with the corrected data and replace=PREFIX",
  "  (PREFIX: the part of its ids before the first -); it is drawn again in the same place with the same ids.",
  "Correcting one part: edit_items on its id (text, color, place; a math step's tex, a molecule's smiles), or delete_items on its ids.",
].join("\n");

// The index as the board_index tool gives it: one line per subject, then how to correct.
// @purity pure
function boardIndexText() {
  return [...BOARD_INDEX.map((row) => `${row.subject}: ${row.use}`), CORRECTING].join("\n");
}

module.exports = { BOARD_INDEX, boardIndexText };
