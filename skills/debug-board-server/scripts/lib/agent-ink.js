"use strict";
// The agent's own ink on the board: Watchman's clay (the owner, 2026-11-17: "the blue text colour also, use the default
// clay we have"; it was blue). Whatever an agent draws without naming a colour takes it: text, math, geometry lines,
// the first plot series and an explanation (board-math.js, board-geometry.js, board-plot.js, board-subjects.js). A
// colour an agent names ("blue", a hex) is still drawn as asked. The page draws its answers in the same ink
// (page/app.js ANSWER_COLOR, a browser module that cannot load this file): change both together.

// Watchman's clay (src/styles/index.css --link-color), and a pale fill of it for shapes it outlines.
const AGENT_INK = "#d97757";
const AGENT_FILL = "#fbe9e3";

module.exports = { AGENT_INK, AGENT_FILL };
