const fs = require("node:fs");
const path = require("node:path");

function unavailable(message) {
  return Object.assign(new Error(message), { code: "NOTE_MEDIA_UNAVAILABLE" });
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function resolveNoteMediaPath(database, appRoot, input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !["noteId", "sessionId", "source"].includes(key)) ||
    !Number.isSafeInteger(input.noteId) ||
    input.noteId <= 0
  )
    throw unavailable("Invalid note media selection");
  // getNote is the existing account-scoped business owner, not a caller's path.
  const note = database.getNote(input.noteId);
  if (!note || note.deleted_at || !note.source_media)
    throw unavailable("The note media is unavailable");
  const media = note.source_media;
  if (media.recordings !== undefined && !Array.isArray(media.recordings))
    throw unavailable("Invalid recording metadata");
  let storedPath;
  if (input.sessionId === undefined && input.source === undefined) {
    const originalIsTrack = media.recordings?.some(
      (record) =>
        Array.isArray(record?.tracks) &&
        record.tracks.some((track) => track?.path === media.originalPath)
    );
    if (originalIsTrack) throw unavailable("Choose a recording and audio track");
    storedPath = media.originalPath;
  } else {
    if (
      typeof input.sessionId !== "string" ||
      !input.sessionId ||
      input.sessionId.length > 128 ||
      !["mic", "system"].includes(input.source)
    )
      throw unavailable("Invalid recording selection");
    const recordings = (media.recordings || []).filter(
      (record) => record?.sessionId === input.sessionId
    );
    if (recordings.length !== 1)
      throw unavailable("The selected recording does not belong to this note");
    if (!Array.isArray(recordings[0].tracks)) throw unavailable("Invalid audio track metadata");
    const tracks = recordings[0].tracks.filter((track) => track?.source === input.source);
    if (tracks.length !== 1) throw unavailable("The selected audio track is unavailable");
    storedPath = tracks[0].path;
  }
  if (
    typeof storedPath !== "string" ||
    !storedPath ||
    storedPath.includes("\0") ||
    path.isAbsolute(storedPath)
  )
    throw unavailable("Invalid stored media path");
  const imports = path.resolve(appRoot, "imports");
  const target = path.resolve(appRoot, storedPath);
  if (!contained(imports, target)) throw unavailable("Media path escapes the App imports");
  const realRoot = fs.realpathSync(imports);
  const realTarget = fs.realpathSync(target);
  if (!contained(realRoot, realTarget) || !fs.statSync(realTarget).isFile())
    throw unavailable("Media path escapes the App imports or is not a file");
  return realTarget;
}

module.exports = { resolveNoteMediaPath };
