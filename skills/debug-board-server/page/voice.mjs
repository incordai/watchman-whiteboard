// Watchman Whiteboard: how the page shows Watchman's voice character (the owner, 2026-11-17: "the character with voice
// in hands-free is also visible on the whiteboard"). While Watchman's hands-free voice speaks for a chat in Whiteboard
// mode, Watchman posts what it says (debug-board-server/scripts/lib/board-voice.js), and every page shows the
// character, its name, and the sentence as a subtitle, over the board's corner. The character is the same 3-D one as
// Watchman's voice mode when the board has its files (`model`, board-voice.js voiceModel; drawn by app.js startFigure
// with vendor/character.js), else its picture, else a plain mark. The pure half: app.js VoiceCharacter draws it;
// test/unit/board-voice.test.js loads this same file.

// After the voice stops, the character stays this long, so it does not blink out between two sentences.
export const VOICE_LINGER_MS = 1200;

const HIDDEN = Object.freeze({ shown: false, picture: null, name: "", subtitle: "", label: "", model: null });
const MODEL_ID = /^[0-9a-f]{16}$/;

// The character's model as the board sent it ({ id, clips: file names }), or null when it is not one.
function modelOf(model) {
  if (!model || typeof model !== "object" || typeof model.id !== "string" || !MODEL_ID.test(model.id)) return null;
  if (!Array.isArray(model.clips) || !model.clips.every((clip) => typeof clip === "string")) return null;
  return model;
}

// What the page shows for `voice` ({ speaking, text, name, picture, model } from the board, or null).
export function voiceView(voice) {
  if (!voice || voice.speaking !== true) return HIDDEN;
  const name = typeof voice.name === "string" ? voice.name : "";
  return {
    shown: true,
    picture: typeof voice.picture === "string" && voice.picture.startsWith("data:image/") ? voice.picture : null,
    name,
    subtitle: typeof voice.text === "string" ? voice.text : "",
    label: name ? `${name} is speaking` : "Speaking",
    model: modelOf(voice.model),
  };
}
