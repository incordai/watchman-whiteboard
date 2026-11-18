"use strict";

// Watchman Whiteboard: BoardMusic (lib/board-music.js). A staff with clef, time and notes as the board's own elements,
// every note its own id: placed by pitch, hollow or filled by length, stems, flags, accidentals, rests, bars, lyrics.

const test = require("node:test");
const assert = require("node:assert/strict");
const { checkDraw } = require("../../skills/debug-board-server/scripts/lib/board-ops");
const { buildMusic, parsePitch } = require("../../skills/debug-board-server/scripts/lib/board-music");

// @purity pure
function assertDrawable(skeletons, prefix) {
  assert.ok(skeletons.length > 0 && skeletons.length <= 500);
  checkDraw({ elements: skeletons }, new Map(), 2000);
  const ids = skeletons.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const id of ids) assert.ok(id.startsWith(`${prefix}-`), id);
}

const byId = (skeletons, id) => skeletons.find((s) => s.id === id);
const refused = (pattern) => (error) => error.code === "InvalidMusic" && pattern.test(error.message);
const centerY = (s) => s.y + s.height / 2;

test("pitches read as letters, accidentals and octaves", () => {
  assert.deepEqual(parsePitch("C4", "n"), { step: 28, accidental: null });
  assert.deepEqual(parsePitch("F#5", "n"), { step: 3 + 35, accidental: "#" });
  assert.deepEqual(parsePitch("rest", "n"), { rest: true });
  assert.throws(() => parsePitch("H2", "notes[0]"), refused(/notes\[0\]: pitch must be like C4/));
});

test("Twinkle Twinkle: notes climb the staff, half notes are hollow, a bar line closes each full bar, lyrics sit under", () => {
  const notes = ["C4", "C4", "G4", "G4", "A4", "A4"].map((pitch, i) => ({ pitch, duration: 4, lyric: ["Twin", "kle", "twin", "kle", "lit", "tle"][i] }));
  notes.push({ pitch: "G4", duration: 2, lyric: "star" });
  const { skeletons, summary } = buildMusic({ clef: "treble", time: "4/4", notes, title: "Twinkle" }, "u1");
  assertDrawable(skeletons, "u1");
  assert.ok(centerY(byId(skeletons, "u1-n3")) < centerY(byId(skeletons, "u1-n1")), "G4 is higher than C4");
  assert.ok(byId(skeletons, "u1-n1-ledger2"), "middle C has its ledger line");
  assert.equal(byId(skeletons, "u1-n1").backgroundColor, "#1e1e1e", "a quarter note is filled");
  assert.equal(byId(skeletons, "u1-n7").backgroundColor, "transparent", "a half note is hollow");
  assert.ok(byId(skeletons, "u1-bar1") && byId(skeletons, "u1-bar2"), "two full bars");
  assert.equal(byId(skeletons, "u1-n7-lyric").text, "star");
  assert.match(summary, /^treble clef, 4\/4, 7 notes, 2 full bars: C4\/4 C4\/4 G4\/4/);
  // Seen in Chrome: the clef as a text character (U+1D11E) showed as an empty box; it is drawn as lines, which every
  // font shows.
  const clef = byId(skeletons, "u1-clef");
  assert.equal(clef.type, "line");
  assert.ok(clef.points.length >= 12, "a curve, not a stroke");
  const ys = clef.points.map((p) => clef.y + p[1]);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 5 * 12, "the treble clef reaches above and below the staff");
});

test("eighths have flags, sharps and flats are written, dotted notes and rests count in the bar", () => {
  const { skeletons, summary } = buildMusic({
    clef: "bass", time: "3/4",
    notes: [{ pitch: "F#3", duration: 8 }, { pitch: "Bb2", duration: 8 }, { pitch: "rest", duration: 4 }, { pitch: "C3", duration: 4 }, { pitch: "D3", duration: 2, dot: true }],
  }, "u2");
  assertDrawable(skeletons, "u2");
  assert.ok(byId(skeletons, "u2-n1-flag1") && byId(skeletons, "u2-n1-acc"));
  assert.equal(byId(skeletons, "u2-n2-acc").text, "♭");
  assert.ok(byId(skeletons, "u2-n5-dot"));
  assert.match(summary, /bass clef, 3\/4, 5 notes, 2 full bars/);
  assert.equal(byId(skeletons, "u2-clef").type, "line");
  // Rests are drawn too (seen in Chrome: the rest characters showed as empty boxes).
  assert.equal(byId(skeletons, "u2-n3").type, "line", "a quarter rest is a zigzag");
  const rests = buildMusic({ notes: [1, 2, 8, 16].map((duration) => ({ pitch: "rest", duration })) }, "u4").skeletons;
  assertDrawable(rests, "u4");
  assert.deepEqual(["u4-n1", "u4-n2", "u4-n3", "u4-n4"].map((rid) => byId(rests, rid).type), ["rectangle", "rectangle", "line", "line"]);
  assert.ok(byId(rests, "u4-n4-restdot2"), "a sixteenth rest has two dots");
  assert.equal(rests.some((s) => s.type === "text" && /[\u{1D100}-\u{1D1FF}]/u.test(s.text)), false, "no music character a font may lack");
  assert.ok(byId(skeletons, "u2-clef-dot1") && byId(skeletons, "u2-clef-dot2"), "the bass clef's two dots");
});

test("bad music is refused with the note named, and nothing is drawn", () => {
  assert.throws(() => buildMusic({ clef: "alto", notes: [{ pitch: "C4", duration: 4 }] }, "u3"), refused(/clef must be treble or bass/));
  assert.throws(() => buildMusic({ time: "5", notes: [{ pitch: "C4", duration: 4 }] }, "u3"), refused(/time must be like/));
  assert.throws(() => buildMusic({ notes: [{ pitch: "C4", duration: 3 }] }, "u3"), refused(/notes\[0\]\.duration/));
  assert.throws(() => buildMusic({ notes: [{ pitch: "C9", duration: 4 }] }, "u3"), refused(/too far from the treble staff/));
});
