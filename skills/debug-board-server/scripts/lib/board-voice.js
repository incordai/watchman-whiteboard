"use strict";

// BoardVoice (Entity), Watchman Whiteboard. The voice character on the board (the owner, 2026-11-17: "the character
// with voice in hands-free is also visible on the whiteboard"). The board is a page in Watchman's child webview, which
// Watchman's own drawing cannot cover, so the page draws the character itself: while Watchman's hands-free voice
// speaks for a chat in Whiteboard mode, Watchman posts { speaking, text, name, picture } to POST /api/voice
// (board-api.js), from its own window only (voiceOrigin) and with the board's Token; the hub passes it to every page
// (board-hub.js setVoice), which draws it (page/voice.mjs). Watchman's side: src/features/whiteboard/model/boardVoice.ts.

//
// The same 3-D character as Watchman (the owner, 2026-11-17): Watchman also names, once per board and character, the
// .vrm and the .vrma clips its voice mode draws, by absolute path on this computer (`character`, `clips`). The board
// keeps the paths to itself (board-api.js), tells its pages only which character it is and the clips' names
// (`voiceModel`), and serves the files by GET /api/voice/character and /api/voice/clip/N to a page with the Token
// (`voiceFile`); the page draws them with Watchman's own avatar code (src/features/whiteboard/board/boardCharacter.ts,
// bundled as page/vendor/character.js).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AppError } = require("./app-error");

// Watchman's own window: the built app (macOS and Linux tauri://, Windows http(s)://tauri.localhost) and its dev server.
const VOICE_ORIGINS = Object.freeze(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"]);
const VOICE_LIMITS = Object.freeze({ text: 400, name: 40, pictureChars: 700000 });
const NAME_PATTERN = /^[\p{L}\p{N} ._'-]*$/u;
const PICTURE_PATTERN = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
// The character's files: how many clips at most (voice mode's own 40 and the 35 Watchman ships), the longest path,
// and the largest file served, in bytes (the shipped character is 13 MB; downloaded ones run to about 30 MB).
const VOICE_FILE_LIMITS = Object.freeze({ clips: 80, pathChars: 4096, character: 256 * 1024 * 1024, clip: 32 * 1024 * 1024 });

// `value` when it is an absolute path on this computer ending in `extension`, else null.
// @purity pure
function filePath(value, extension) {
  if (typeof value !== "string" || value.length > VOICE_FILE_LIMITS.pathChars || value.includes("\u0000")) return null;
  if (!path.isAbsolute(value) || path.extname(value).toLowerCase() !== extension) return null;
  return value;
}

// `origin` when it is Watchman's own window, else null.
// @purity pure
function voiceOrigin(origin) {
  return typeof origin === "string" && VOICE_ORIGINS.includes(origin) ? origin : null;
}

// The CORS answer for Watchman's own origin.
// @purity pure
function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST",
    "access-control-allow-headers": "content-type, x-board-token",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

// The voice as the page draws it: { speaking, text, name, picture? }. Throws InvalidVoice (400).
// @purity pure
function checkVoice(body) {
  const invalid = (message) => new AppError("InvalidVoice", 400, message);
  if (!body || typeof body !== "object" || typeof body.speaking !== "boolean") throw invalid("speaking must be true or false");
  const text = typeof body.text === "string" ? body.text.trim().slice(0, VOICE_LIMITS.text) : "";
  const name = body.name === undefined ? "" : body.name;
  if (typeof name !== "string" || name.length > VOICE_LIMITS.name || !NAME_PATTERN.test(name)) throw invalid("name must be a short plain name");
  const voice = { speaking: body.speaking, text, name };
  if (body.picture !== undefined) {
    const picture = body.picture;
    if (typeof picture !== "string" || picture.length > VOICE_LIMITS.pictureChars || !PICTURE_PATTERN.test(picture)) {
      throw invalid("picture must be a small PNG, JPEG, WebP or GIF data: URL");
    }
    voice.picture = picture;
  }
  if (body.character !== undefined || body.clips !== undefined) {
    const character = filePath(body.character, ".vrm");
    if (!character) throw invalid("character must be the absolute path of a .vrm file");
    const clips = body.clips === undefined ? [] : body.clips;
    if (!Array.isArray(clips) || clips.length > VOICE_FILE_LIMITS.clips || !clips.every((clip) => filePath(clip, ".vrma"))) {
      throw invalid(`clips must be at most ${VOICE_FILE_LIMITS.clips} absolute paths of .vrma files`);
    }
    voice.character = character;
    voice.clips = [...clips];
  }
  return voice;
}

// What a page is told of the character's files { character, clips }: an id that changes with them, and the clips'
// file names (the page picks its talking clips by name, as voice mode does); never a path. Null with no files.
// @purity pure
function voiceModel(files) {
  if (!files || !files.character) return null;
  const id = crypto.createHash("sha256").update(JSON.stringify([files.character, files.clips])).digest("hex").slice(0, 16);
  return Object.freeze({ id, clips: Object.freeze(files.clips.map((clip) => clip.split(/[\\/]/).pop())) });
}

// The file a page asks for by `part` ("character" or "clip/N"), from the files Watchman named: { path, size } when it
// is there, a plain file, and within `limits`; else null. Called by board-api.js GET /api/voice/...
// @purity semi-pure-b
function voiceFile(files, part, limits = VOICE_FILE_LIMITS) {
  if (!files) return null;
  let file = null;
  let limit = limits.clip;
  if (part === "character") {
    file = files.character;
    limit = limits.character;
  } else {
    const match = /^clip\/(\d{1,3})$/.exec(String(part));
    if (match) file = files.clips[Number(match[1])] || null;
  }
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size <= limit ? { path: file, size: stat.size } : null;
  } catch (error) {
    return null;
  }
}

module.exports = { checkVoice, voiceOrigin, corsHeaders, voiceModel, voiceFile, VOICE_ORIGINS, VOICE_LIMITS, VOICE_FILE_LIMITS };
