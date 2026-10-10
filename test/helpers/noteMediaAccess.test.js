const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { resolveNoteMediaPath } = require("../../src/helpers/noteMediaAccess");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "nimi-note-media-"));
const root = path.join(base, process.platform === "win32" ? ".openwhispr-nimi" : "OpenWhispr-Nimi");
fs.mkdirSync(path.join(root, "imports"), { recursive: true });
function file(relative) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "explicit path-layout fixture, not an audio result");
  return fs.realpathSync(target);
}
const first = file("imports/first/mic.wav");
const second = file("imports/later/system.wav");
const media = {
  originalPath: "imports/first/mic.wav",
  audioPath: "imports/first/mic.wav",
  recordings: [
    {
      sessionId: "completed-session",
      status: "completed",
      tracks: [{ source: "mic", path: "imports/first/mic.wav" }],
    },
    {
      sessionId: "canceled-session",
      status: "canceled",
      tracks: [{ source: "system", path: "imports/later/system.wav" }],
    },
  ],
};
const database = { getNote: (id) => (id === 13 ? { id, source_media: media } : null) };
test.after(() => {
  const resolved = path.resolve(base);
  if (
    !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(resolved).startsWith("nimi-note-media-")
  )
    throw new Error("Invalid owned fixture cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

test("recording/session selection resolves retained tracks without changing the first path", () => {
  assert.equal(
    resolveNoteMediaPath(database, root, {
      noteId: 13,
      sessionId: "completed-session",
      source: "mic",
    }),
    first
  );
  assert.equal(
    resolveNoteMediaPath(database, root, {
      noteId: 13,
      sessionId: "canceled-session",
      source: "system",
    }),
    second
  );
  assert.equal(media.originalPath, "imports/first/mic.wav");
});
test("ordinary single-file imports retain their existing reveal selection", () => {
  const single = {
    getNote: () => ({ id: 2, source_media: { originalPath: "imports/first/mic.wav" } }),
  };
  assert.equal(resolveNoteMediaPath(single, root, { noteId: 2 }), first);
});
test("an uploaded original remains selectable after recordings are appended", () => {
  const original = file("imports/upload/source.wav");
  const combined = {
    ...media,
    originalName: "uploaded.wav",
    originalPath: "imports/upload/source.wav",
  };
  const db = { getNote: () => ({ id: 3, source_media: combined }) };
  assert.equal(resolveNoteMediaPath(db, root, { noteId: 3 }), original);
  assert.equal(
    resolveNoteMediaPath(db, root, { noteId: 3, sessionId: "canceled-session", source: "system" }),
    second
  );
});
for (const input of [
  { noteId: 99, sessionId: "canceled-session", source: "system" },
  { noteId: 13, sessionId: "foreign-session", source: "system" },
  { noteId: 13, sessionId: "canceled-session", source: "mic" },
  { noteId: 13, sessionId: "canceled-session", source: "camera" },
  { noteId: 13, sessionId: "canceled-session" },
  { noteId: 13 },
  { noteId: 13, path: second },
])
  test(
    "foreign, incomplete or arbitrary-path selection is refused: " + JSON.stringify(input),
    () => {
      assert.throws(() => resolveNoteMediaPath(database, root, input), {
        code: "NOTE_MEDIA_UNAVAILABLE",
      });
    }
  );
test("stored path traversal and absolute paths are refused", () => {
  for (const originalPath of ["imports/../../outside.wav", second]) {
    assert.throws(
      () =>
        resolveNoteMediaPath({ getNote: () => ({ source_media: { originalPath } }) }, root, {
          noteId: 3,
        }),
      { code: "NOTE_MEDIA_UNAVAILABLE" }
    );
  }
});
test("a stored junction/symlink cannot escape imports", () => {
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "private.wav"), "outside layout fixture");
  fs.symlinkSync(
    outside,
    path.join(root, "imports/link"),
    process.platform === "win32" ? "junction" : "dir"
  );
  assert.throws(
    () =>
      resolveNoteMediaPath(
        { getNote: () => ({ source_media: { originalPath: "imports/link/private.wav" } }) },
        root,
        { noteId: 3 }
      ),
    { code: "NOTE_MEDIA_UNAVAILABLE" }
  );
});
test("deleted, missing-file and directory media cannot be revealed", () => {
  assert.throws(() =>
    resolveNoteMediaPath(
      { getNote: () => ({ deleted_at: "deleted", source_media: media }) },
      root,
      { noteId: 3 }
    )
  );
  for (const originalPath of ["imports/missing.wav", "imports/first"]) {
    assert.throws(() =>
      resolveNoteMediaPath({ getNote: () => ({ source_media: { originalPath } }) }, root, {
        noteId: 3,
      })
    );
  }
});
test("the real SQLite note owner excludes another account's media", () => {
  const originalLoad = Module._load;
  Module._load = function (name, parent, main) {
    if (name === "electron")
      return {
        app: {
          getPath: () => base,
          getAppPath: () => process.cwd(),
          isReady: () => false,
          isPackaged: false,
        },
      };
    return originalLoad.call(this, name, parent, main);
  };
  let db;
  try {
    const Database = require("../../src/helpers/database");
    db = new Database();
    db.setActiveAccountId("media-owner-a");
    const note = db.saveNote("Media owner fixture", "", "meeting").note;
    db.db
      .prepare("INSERT INTO note_import_media (note_id, metadata) VALUES (?, ?)")
      .run(note.id, JSON.stringify(media));
    assert.equal(
      resolveNoteMediaPath(db, root, {
        noteId: note.id,
        sessionId: "canceled-session",
        source: "system",
      }),
      second
    );
    db.setActiveAccountId("media-owner-b");
    assert.throws(
      () =>
        resolveNoteMediaPath(db, root, {
          noteId: note.id,
          sessionId: "canceled-session",
          source: "system",
        }),
      { code: "NOTE_MEDIA_UNAVAILABLE" }
    );
  } finally {
    db?.db.close();
    Module._load = originalLoad;
  }
});
