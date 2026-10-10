const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { randomUUID } = require("node:crypto");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-import-note-"));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron")
    return {
      app: {
        getPath: () => root,
        getAppPath: () => process.cwd(),
        isReady: () => false,
        isPackaged: false,
      },
    };
  return originalLoad.call(this, request, parent, isMain);
};
const DatabaseManager = require("../../src/helpers/database");
const { getAppDataDirectory } = require("../../src/helpers/appData");
Module._load = originalLoad;
process.env.NODE_ENV = "test";

test("dictation preserves actual recognition chunks across database reopen and text editing", () => {
  const database = new DatabaseManager();
  const recognition = {
    transcript: { status: "transcribed", text: "首段\n尾段", language: "zh", words: [] },
    chunks: [
      { offsetSeconds: 0, transcription: { status: "transcribed", text: "首段", words: [] } },
      { offsetSeconds: 300, transcription: { status: "transcribed", text: "尾段", words: [] } },
    ],
  };
  const saved = database.saveTranscription("润色结果", recognition.transcript.text, {
    recognition,
  });
  database.updateTranscriptionText(saved.id, "编辑后的结果", recognition.transcript.text);
  database.db.close();
  const reopened = new DatabaseManager();
  try {
    const row = reopened.getTranscriptions().find((value) => value.id === saved.id);
    assert.equal(row.text, "编辑后的结果");
    assert.equal(row.raw_text, recognition.transcript.text);
    assert.deepEqual(JSON.parse(row.recognition_result), recognition);
  } finally {
    reopened.db.close();
  }
});

test("imported text, exact alignment and source metadata commit together and survive reopening", () => {
  const database = new DatabaseManager();
  database.setActiveAccountId("import-test");
  const origin = 1791400000000;
  const transcript = JSON.stringify([
    { text: "你好", timestamp: origin + 2300, endTimestamp: origin + 2800 },
  ]);
  const input = {
    title: "中文导入",
    content: "你好。",
    sourceFile: "long.wav",
    audioDuration: 305,
    transcript,
    sourceMedia: { originalPath: "imports/test/source.wav", transcriptOriginMs: origin },
  };
  const saved = database.saveImportedNote(input);
  assert.equal(saved.note.content, "你好。");
  assert.equal(saved.note.transcript, transcript);
  assert.deepEqual(database.getNote(saved.note.id).source_media, input.sourceMedia);
  const before = database.db.prepare("SELECT count(*) AS count FROM notes").get().count;
  const actualUpdate = database.updateNote;
  database.updateNote = () => {
    throw new Error("alignment write failed");
  };
  assert.throws(
    () => database.saveImportedNote({ ...input, title: "must roll back" }),
    /alignment write failed/
  );
  assert.equal(database.db.prepare("SELECT count(*) AS count FROM notes").get().count, before);
  database.updateNote = actualUpdate;
  database.db.close();
  const reopened = new DatabaseManager();
  reopened.setActiveAccountId("import-test");
  assert.equal(reopened.getNote(saved.note.id).transcript, transcript);
  assert.deepEqual(reopened.getNote(saved.note.id).source_media, input.sourceMedia);
  reopened.db.close();
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("immediate recording append keeps the original upload first and preserves both raw clocks through reopen", () => {
  const { imported, recorded, media } = require("../lib/mixedTranscriptFixture")();
  const database = new DatabaseManager();
  database.setActiveAccountId("mixed-media-owner");
  const saved = database.saveImportedNote({
    title: "Mixed fixture",
    content: "Hello, world!",
    transcript: JSON.stringify(imported),
    audioDuration: 305,
    sourceMedia: { ...media, recordings: [] },
  });
  const result = database.saveMeetingNoteResult(
    saved.note.id,
    [...recorded].reverse(),
    media.recordings[0]
  );
  const units = JSON.parse(result.note.transcript);
  assert.deepEqual(units.slice(0, imported.length), imported);
  assert.deepEqual(
    units
      .slice(imported.length)
      .map((s) => [s.id, s.text, s.timestamp, s.endTimestamp, s.clockBasis]),
    recorded.map((s) => [s.id, s.text, s.timestamp, s.endTimestamp, s.clockBasis])
  );
  assert.equal(result.note.content, "Hello, world!");
  assert.equal(result.note.source_media.recordings[0].status, "canceled");
  const once = result.note.transcript;
  assert.equal(
    database.saveMeetingNoteResult(saved.note.id, recorded, media.recordings[0]).note.transcript,
    once
  );
  database.db.close();
  const reopened = new DatabaseManager();
  reopened.setActiveAccountId("mixed-media-owner");
  const reloaded = reopened.getNote(saved.note.id);
  assert.equal(reloaded.transcript, once);
  assert.equal(reloaded.content, "Hello, world!");
  assert.deepEqual(reloaded.source_media, result.note.source_media);
  reopened.db.close();
});

test("note-owned voice, raw intervals and inferred names survive reopen; failed writes roll back every field", () => {
  const database = new DatabaseManager();
  database.setActiveAccountId("speaker-consumer-owner");
  const voice = { vector: [0.123456789012345, -0.5], spaceId: "declared-consumer-space" };
  const profile = database.upsertSpeakerProfile("Saved Alice", null, voice);
  const id = "recording-generation:speaker_0";
  const raw = {
    status: "transcribed",
    text: "未经改写的模型文本",
    words: [{ text: "未经改写的模型文本", startSeconds: 0.2, endSeconds: 0.8 }],
    diarization: {
      status: "diarized",
      durationSeconds: 2,
      intervals: [{ speakerId: "job-local", startSeconds: 0.1, endSeconds: 1 }],
    },
  };
  const segments = [
    {
      id: "word-0",
      source: "mic",
      text: raw.text,
      timestamp: 1200,
      endTimestamp: 1800,
      speaker: id,
      speakerMatching: "matched-space",
      recognition: { transcript: raw },
    },
  ];
  const saved = database.saveImportedNote({
    title: "Actual consumer fixture",
    content: raw.text,
    transcript: JSON.stringify(segments),
    sourceMedia: {
      originalPath: "imports/owned/source.wav",
      chunks: [{ transcript: raw, offsetSeconds: 300 }],
    },
    speakerRepresentations: { [id]: voice },
  });
  const noteId = saved.note.id;
  assert.equal(JSON.parse(saved.note.transcript)[0].speakerName, "Saved Alice");
  const before = database.getNote(noteId);
  assert.throws(
    () =>
      database.saveImportedNote({
        title: "Must roll back",
        content: raw.text,
        transcript: JSON.stringify(segments),
        sourceMedia: {},
        speakerRepresentations: { [id]: { vector: [], spaceId: voice.spaceId } },
      }),
    /Invalid speaker representation/
  );
  assert.equal(database.getNotes().filter((note) => note.title === "Must roll back").length, 0);
  const actualUpdate = database.updateNote;
  database.updateNote = () => {
    throw new Error("declared DB failure after voice write");
  };
  assert.throws(
    () =>
      database.saveMeetingNoteResult(noteId, [{ ...segments[0], id: "tail" }], null, {
        [id]: { ...voice, vector: [0.9, 0.1] },
      }),
    /declared DB failure/
  );
  database.updateNote = actualUpdate;
  assert.equal(database.getNote(noteId).transcript, before.transcript);
  assert.deepEqual(database.getNoteSpeakerEmbeddings(noteId)[0].representation, voice);
  database.db.close();
  const reopened = new DatabaseManager();
  reopened.setActiveAccountId("speaker-consumer-owner");
  try {
    const persisted = reopened.getNote(noteId);
    assert.deepEqual(JSON.parse(persisted.transcript)[0].recognition.transcript, raw);
    assert.deepEqual(persisted.source_media.chunks[0].transcript, raw);
    assert.deepEqual(reopened.getNoteSpeakerEmbeddings(noteId)[0].representation, voice);
    assert.equal(
      reopened.getSpeakerProfiles(true).find((value) => value.id === profile.id).sample_count,
      1
    );
    reopened.setActiveAccountId("different-account");
    assert.equal(reopened.getNote(noteId), null);
    assert.deepEqual(reopened.getNoteSpeakerEmbeddings(noteId), []);
  } finally {
    reopened.db.close();
  }
});

test("soft deletion and transaction rollback retain media; permanent deletion retires only owned imports", () => {
  const database = new DatabaseManager();
  database.setActiveAccountId("import-test");
  const appRoot = getAppDataDirectory();
  const id = randomUUID();
  const directory = path.join(appRoot, "imports", id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "source.wav"), "owned source");
  fs.writeFileSync(path.join(directory, "audio.wav"), "owned model input");
  const external = path.join(root, "user-original.wav");
  fs.writeFileSync(external, "user original");
  try {
    const saved = database.saveImportedNote({
      title: "retire",
      content: "body",
      sourceFile: "user-original.wav",
      transcript: "[]",
      sourceMedia: {
        originalPath: "imports/" + id + "/source.wav",
        audioPath: "imports/" + id + "/audio.wav",
      },
    });
    database.deleteNote(saved.note.id);
    assert.equal(fs.existsSync(directory), true);
    assert.throws(
      database.db.transaction(() => {
        database.hardDeleteNote(saved.note.id);
        throw new Error("rollback delete");
      }),
      /rollback delete/
    );
    assert.equal(fs.existsSync(directory), true);
    database.hardDeleteNote(saved.note.id);
    assert.equal(fs.existsSync(directory), false);
    assert.equal(fs.readFileSync(external, "utf8"), "user original");
  } finally {
    database.db.close();
  }
});

test("permanent container deletion retires its imported media", () => {
  const database = new DatabaseManager();
  database.setActiveAccountId("import-test");
  const id = randomUUID();
  const directory = path.join(getAppDataDirectory(), "imports", id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "source.wav"), "source");
  fs.writeFileSync(path.join(directory, "audio.wav"), "audio");
  try {
    const folder = database.createFolder("import-media-test");
    const saved = database.saveImportedNote({
      title: "folder-note",
      content: "body",
      folderId: folder.folder.id,
      transcript: "[]",
      sourceMedia: {
        originalPath: "imports/" + id + "/source.wav",
        audioPath: "imports/" + id + "/audio.wav",
      },
    });
    database.deleteFolder(folder.folder.id);
    assert.equal(database.getNote(saved.note.id), null);
    assert.equal(fs.existsSync(directory), false);
  } finally {
    database.db.close();
  }
});

test("meeting words, actual recognition and multiple owned capture sessions survive reopen and retire with their note", () => {
  const database = new DatabaseManager();
  database.setActiveAccountId("meeting-test");
  const note = database.saveNote("Meeting", "", "meeting").note;
  const directories = [];
  for (let session = 0; session < 2; session++) {
    const id = randomUUID();
    const relative = "imports/" + id + "/mic.wav";
    const directory = path.join(getAppDataDirectory(), "imports", id);
    directories.push(directory);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "mic.wav"), "actual-owned-capture-fixture");
    const segment = {
      id: "meeting-" + session,
      text: "实际输出",
      source: "mic",
      timestamp: 1000 + session * 1000,
      endTimestamp: 1500 + session * 1000,
      recognition: {
        transcript: {
          status: "transcribed",
          text: "实际输出",
          language: "zh",
          words: [{ text: "实际输出", startSeconds: 0, endSeconds: 0.5 }],
        },
      },
    };
    database.saveMeetingNoteResult(note.id, [segment]);
    database.saveMeetingNoteResult(note.id, [segment], {
      sessionId: "session-" + session,
      originalPath: relative,
      audioPath: relative,
    });
  }
  assert.equal(JSON.parse(database.getNote(note.id).transcript).length, 2);
  database.db.close();
  const reopened = new DatabaseManager();
  reopened.setActiveAccountId("meeting-test");
  try {
    const saved = reopened.getNote(note.id);
    assert.equal(JSON.parse(saved.transcript)[0].recognition.transcript.text, "实际输出");
    assert.equal(saved.source_media.recordings.length, 2);
    reopened.deleteNote(note.id);
    assert.ok(directories.every((directory) => fs.existsSync(directory)));
    assert.throws(() => reopened.saveMeetingNoteResult(note.id, []), /unavailable/);
    reopened.hardDeleteNote(note.id);
    assert.ok(directories.every((directory) => !fs.existsSync(directory)));
  } finally {
    reopened.db.close();
  }
});
