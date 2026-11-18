"use strict";

// BoardMusic (Entity), Watchman Whiteboard. draw_music (music lessons): a staff in treble or bass clef with its time
// signature and notes, drawn as the board's own elements, every note its own id so a wrong one is fixed alone:
// note heads placed by pitch (ledger lines above and below the staff), hollow for whole and half notes, stems and
// flags for shorter ones, sharps and flats, rests, bar lines where each bar fills, and a lyric under a note.
// Pure; errors are AppError InvalidMusic (400) naming the note. Called by talk-on-board's mcp.js.

const { AppError } = require("./app-error");

const INK = "#1e1e1e";
const SOFT = "#495057";
const GAP = 12; // between staff lines
const NOTE_W = 15;
const NOTE_H = 11;
const STEP = 46; // between notes
const LETTERS = "CDEFGAB";
// Each clef's bottom line, as a diatonic step number (letter + 7 x octave): E4 for treble, G2 for bass.
const BOTTOM = Object.freeze({ treble: 2 + 7 * 4, bass: 4 + 7 * 2 });
const DURATIONS = Object.freeze({ 1: "whole", 2: "half", 4: "quarter", 8: "eighth", 16: "sixteenth" });
// The clefs as one stroke each, in staff spaces (x right, y up from the bottom line). The G clef: its tail below the
// staff, the stem up past the top line, the loop, and the curl round the G line (y = 1). The F clef: from its head on
// the F line (y = 3) round and down; its two dots are drawn beside it.
const TREBLE_CLEF = Object.freeze([
  [-0.2, -1.8], [0.3, -1.9], [0.5, -1.5], [0.4, -1.0], [0.25, 0], [0.15, 1.5], [0.1, 3], [0.15, 4.2], [0.35, 5.0], [0.6, 5.4],
  [0.65, 4.9], [0.4, 4.2], [-0.1, 3.4], [-0.6, 2.6], [-0.85, 1.8], [-0.8, 1.0], [-0.45, 0.4], [0.1, 0.15], [0.6, 0.3],
  [0.85, 0.8], [0.8, 1.3], [0.45, 1.6], [0, 1.55], [-0.25, 1.25], [-0.15, 0.9],
]);
// The quarter rest's zigzag, in staff spaces from the note's place.
const QUARTER_REST = Object.freeze([[-0.1, 3.3], [0.35, 2.7], [-0.15, 2.15], [0.3, 1.6], [-0.2, 1.3], [0.05, 0.9], [-0.15, 0.7]]);
const BASS_CLEF = Object.freeze([
  [0, 3], [0.2, 3.6], [0.8, 3.9], [1.4, 3.6], [1.6, 2.8], [1.3, 1.6], [0.6, 0.6], [-0.1, 0],
]);

// @purity pure
function fail(message) {
  return new AppError("InvalidMusic", 400, message);
}

// @purity pure
function round(n) {
  return Math.round(n * 10) / 10;
}

// "C#4", "Bb3", "G5", "rest" -> { step, accidental } or { rest: true }.
// @purity pure
function parsePitch(text, where) {
  if (String(text).toLowerCase() === "rest") return { rest: true };
  const m = /^([A-Ga-g])(#|b|n)?(-?\d)$/.exec(String(text).trim());
  if (!m) throw fail(`${where}: pitch must be like C4, F#5, Bb3 or rest`);
  return { step: LETTERS.indexOf(m[1].toUpperCase()) + 7 * Number(m[3]), accidental: m[2] || null };
}

// draw_music: `spec` { clef?: "treble"|"bass", time?: "4/4", notes: [{ pitch, duration: 1|2|4|8|16, dot?, lyric? }],
// title? }. Returns { skeletons, summary }.
// @purity pure
function buildMusic(spec, prefix) {
  const clef = spec.clef === undefined ? "treble" : spec.clef;
  if (!BOTTOM[clef]) throw fail("clef must be treble or bass");
  const time = spec.time === undefined ? "4/4" : String(spec.time);
  const tm = /^(\d{1,2})\/(1|2|4|8|16)$/.exec(time);
  if (!tm) throw fail("time must be like 4/4, 3/4 or 6/8");
  const barLength = Number(tm[1]) / Number(tm[2]);
  if (!Array.isArray(spec.notes) || spec.notes.length < 1 || spec.notes.length > 64) throw fail("notes must be a list of 1 to 64");
  const notes = spec.notes.map((note, i) => {
    const where = `notes[${i}]`;
    if (!note || typeof note !== "object") throw fail(`${where} must be an object`);
    if (!DURATIONS[note.duration]) throw fail(`${where}.duration must be 1, 2, 4, 8 or 16 (whole to sixteenth)`);
    const pitch = parsePitch(note.pitch, where);
    if (!pitch.rest && (pitch.step - BOTTOM[clef] < -8 || pitch.step - BOTTOM[clef] > 16)) throw fail(`${where}: ${note.pitch} is too far from the ${clef} staff`);
    return { ...pitch, duration: note.duration, dot: note.dot === true, lyric: note.lyric === undefined ? null : String(note.lyric).slice(0, 20), text: String(note.pitch) };
  });
  const id = (suffix) => `${prefix}-${suffix}`;
  const out = [];
  const top = (spec.title ? 50 : 10) + 50;
  const x0 = 30;
  const lineY = (k) => top + (4 - k) * GAP; // k = 0 bottom line .. 4 top line
  const yOf = (pos) => lineY(0) - (pos * GAP) / 2; // pos in half-spaces above the bottom line
  if (spec.title) out.push({ type: "text", id: id("title"), x: x0, y: 4, text: String(spec.title).slice(0, 120), fontSize: 24, fontFamily: 5, strokeColor: INK });
  // Clef and time signature.
  // The clef drawn as lines (seen in Chrome: the clef characters U+1D11E and U+1D122 showed as empty boxes, as the
  // board's fonts have neither). Points in staff spaces: x right from the clef's place, y up from the bottom line.
  const clefLine = (key, points) => {
    const board = points.map(([px, py]) => [x0 + 14 + px * GAP, lineY(0) - py * GAP]);
    const [bx, by] = board[0];
    return { type: "line", id: id(key), x: round(bx), y: round(by), points: board.map(([px, py]) => [round(px - bx), round(py - by)]), strokeColor: INK, strokeWidth: 2.5, roughness: 0 };
  };
  if (clef === "treble") {
    out.push(clefLine("clef", TREBLE_CLEF));
  } else {
    out.push(clefLine("clef", BASS_CLEF));
    for (const [k, dotY] of [[1, 3.5], [2, 2.5]]) {
      out.push({ type: "ellipse", id: id(`clef-dot${k}`), x: round(x0 + 14 + 1.9 * GAP - 2.5), y: round(lineY(0) - dotY * GAP - 2.5), width: 5, height: 5, strokeColor: INK, backgroundColor: INK, fillStyle: "solid", strokeWidth: 1, roughness: 0 });
    }
  }
  out.push({ type: "text", id: id("time"), x: x0 + 52, y: lineY(4) - 4, text: tm[1], fontSize: 22, fontFamily: 2, strokeColor: INK });
  out.push({ type: "text", id: id("time-unit"), x: x0 + 52, y: lineY(2) - 4, text: tm[2], fontSize: 22, fontFamily: 2, strokeColor: INK });
  // Notes, bars, and their x places.
  let x = x0 + 96;
  let inBar = 0;
  let bars = 0;
  const heads = [];
  notes.forEach((note, i) => {
    const n = i + 1;
    const length = (1 / note.duration) * (note.dot ? 1.5 : 1);
    if (note.rest) {
      // Drawn, not written (seen in Chrome: the rest characters U+1D13B to U+1D13F showed as empty boxes): a whole rest
      // hangs from the fourth line, a half rest sits on the middle line, shorter ones are a stroke with their dots.
      const restLine = (key, points) => {
        const board = points.map(([px, py]) => [x + px * GAP, lineY(0) - py * GAP]);
        const [bx, by] = board[0];
        return { type: "line", id: id(key), x: round(bx), y: round(by), points: board.map(([px, py]) => [round(px - bx), round(py - by)]), strokeColor: INK, strokeWidth: 2.5, roughness: 0 };
      };
      const block = (top) => ({
        type: "rectangle", id: id(`n${n}`), x: round(x - 6), y: round(top), width: 12, height: round(GAP / 2), strokeColor: INK, backgroundColor: INK, fillStyle: "solid", strokeWidth: 1, roughness: 0,
      });
      if (note.duration === 1) out.push(block(lineY(3)));
      else if (note.duration === 2) out.push(block(lineY(2) - GAP / 2));
      else if (note.duration === 4) out.push(restLine(`n${n}`, QUARTER_REST));
      else {
        out.push(restLine(`n${n}`, [[0.4, 2.6], [-0.2, 0.6]]));
        const dots = note.duration === 8 ? [[-0.15, 2.45]] : [[-0.05, 2.45], [-0.3, 1.65]];
        dots.forEach(([dx, dy], k) => out.push({
          type: "ellipse", id: id(`n${n}-restdot${k + 1}`), x: round(x + dx * GAP - 3), y: round(lineY(0) - dy * GAP - 3), width: 6, height: 6,
          strokeColor: INK, backgroundColor: INK, fillStyle: "solid", strokeWidth: 1, roughness: 0,
        }));
      }
    } else {
      const pos = note.step - BOTTOM[clef];
      const y = yOf(pos);
      const hollow = note.duration <= 2;
      out.push({
        type: "ellipse", id: id(`n${n}`), x: round(x - NOTE_W / 2), y: round(y - NOTE_H / 2), width: NOTE_W, height: NOTE_H, angle: -0.35,
        strokeColor: INK, backgroundColor: hollow ? "transparent" : INK, fillStyle: "solid", strokeWidth: 2, roughness: 0,
      });
      // Ledger lines below the staff (pos <= -2) and above it (pos >= 10).
      for (let p = -2; p >= pos; p -= 2) out.push({ type: "line", id: id(`n${n}-ledger${-p}`), x: round(x - 13), y: round(yOf(p)), points: [[0, 0], [26, 0]], strokeColor: INK, strokeWidth: 1.5, roughness: 0 });
      for (let p = 10; p <= pos; p += 2) out.push({ type: "line", id: id(`n${n}-ledger${p}`), x: round(x - 13), y: round(yOf(p)), points: [[0, 0], [26, 0]], strokeColor: INK, strokeWidth: 1.5, roughness: 0 });
      if (note.duration >= 2) {
        // Stem up for notes below the middle line, down from it and above; a flag for eighths, two for sixteenths.
        const up = pos < 4;
        const sx = up ? x + NOTE_W / 2 - 1 : x - NOTE_W / 2 + 1;
        const end = up ? y - 36 : y + 36;
        out.push({ type: "line", id: id(`n${n}-stem`), x: round(sx), y: round(y), points: [[0, 0], [0, round(end - y)]], strokeColor: INK, strokeWidth: 1.5, roughness: 0 });
        for (let f = 0; f < (note.duration === 8 ? 1 : note.duration === 16 ? 2 : 0); f++) {
          const fy = end + (up ? f * 8 : -f * 8);
          out.push({ type: "line", id: id(`n${n}-flag${f + 1}`), x: round(sx), y: round(fy), points: [[0, 0], [10, up ? 14 : -14]], strokeColor: INK, strokeWidth: 2, roughness: 0 });
        }
      }
      if (note.accidental) out.push({ type: "text", id: id(`n${n}-acc`), x: round(x - NOTE_W - 10), y: round(y - 14), text: { "#": "♯", b: "♭", n: "♮" }[note.accidental], fontSize: 22, fontFamily: 2, strokeColor: INK });
      heads.push(x);
    }
    if (note.dot) out.push({ type: "ellipse", id: id(`n${n}-dot`), x: round(x + NOTE_W / 2 + 3), y: round((note.rest ? lineY(2) : yOf(note.step - BOTTOM[clef])) - 2), width: 4, height: 4, strokeColor: INK, backgroundColor: INK, fillStyle: "solid", strokeWidth: 1, roughness: 0 });
    if (note.lyric) out.push({ type: "text", id: id(`n${n}-lyric`), x: round(x - note.lyric.length * 4), y: round(lineY(0) + 34), text: note.lyric, fontSize: 16, fontFamily: 6, strokeColor: SOFT });
    inBar += length;
    x += STEP + (note.duration <= 2 ? 14 : 0);
    if (inBar >= barLength - 1e-9) {
      bars += 1;
      out.push({ type: "line", id: id(`bar${bars}`), x: round(x - STEP / 2 + 4), y: round(lineY(4)), points: [[0, 0], [0, GAP * 4]], strokeColor: INK, strokeWidth: 1.5, roughness: 0 });
      inBar = 0;
    }
  });
  // The staff under everything, as long as the music.
  const width = x - x0;
  for (let k = 0; k < 5; k++) out.unshift({ type: "line", id: id(`staff${k + 1}`), x: x0, y: round(lineY(k)), points: [[0, 0], [round(width), 0]], strokeColor: INK, strokeWidth: 1, roughness: 0 });
  const summary = `${clef} clef, ${time}, ${notes.length} notes, ${bars} full bar${bars === 1 ? "" : "s"}${inBar > 1e-9 ? " and a part bar" : ""}: ${notes.map((n) => `${n.text}/${n.duration}${n.dot ? "." : ""}`).join(" ")}`;
  return { skeletons: out, summary };
}

module.exports = { buildMusic, parsePitch, DURATIONS };
