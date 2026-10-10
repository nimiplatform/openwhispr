const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  Module = require("node:module");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimi-transcript-search-"));
const load = Module._load;
Module._load = function (name, parent, main) {
  if (name === "electron")
    return {
      app: {
        getPath: () => root,
        getAppPath: () => process.cwd(),
        isReady: () => false,
        isPackaged: false,
      },
    };
  return load.call(this, name, parent, main);
};
const Database = require("../../src/helpers/database");
Module._load = load;
process.env.NODE_ENV = "test";
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const acknowledge = (db) => {
  for (const row of db.getPendingVectorChanges(1000))
    db.clearPendingVectorChange(row.note_id, row.revision);
};

test("real note owner indexes only speech, refreshes transcript-only edits and retains scope through rebuild/delete", () => {
  let database = new Database();
  database.setActiveAccountId("speech-search-owner-a");
  try {
    const saved = database.saveNote("Ordinary title", "Manual body", "meeting").note;
    acknowledge(database);
    const first = JSON.stringify([
      {
        id: "PRIVATE_METADATA",
        text: "先说预算调整为83万元。",
        source: "mic",
        recognition: { transcript: { text: "NOT_SPOKEN" } },
      },
      { text: "quartz deadline", source: "system" },
    ]);
    assert.equal(database.updateNote(saved.id, { transcript: first }).success, true);
    const pending = database.getPendingVectorChanges().find((row) => row.note_id === saved.id);
    assert.ok(pending, "transcript-only commits wake the existing vector queue");
    for (const query of ["预算", "预算调整", "83", "quartz", "Ord", "Man"]) {
      assert.ok(
        database.searchNotes(query).some((note) => note.id === saved.id),
        query
      );
    }
    assert.deepEqual(database.searchNotes("PRIVATE_METADATA"), []);
    assert.deepEqual(database.searchNotes("NOT_SPOKEN"), []);
    assert.deepEqual(database.searchNotes("预算", 10, 999999), []);
    assert.deepEqual(database.searchNotes("预算", 10, saved.space_id, 999999), []);
    assert.equal(
      database.searchNotes("预算", 10, saved.space_id, saved.folder_id)[0]?.id,
      saved.id
    );
    database.setActiveAccountId("speech-search-owner-b");
    assert.deepEqual(database.searchNotes("预算"), []);
    database.setActiveAccountId("speech-search-owner-a");

    const next = JSON.stringify([{ text: "新增发言将预算调整为72万元。", source: "system" }]);
    database.updateNote(saved.id, { transcript: next });
    const newer = database.getPendingVectorChanges().find((row) => row.note_id === saved.id);
    assert.ok(newer.revision > pending.revision);
    database.clearPendingVectorChange(saved.id, pending.revision);
    assert.equal(
      database.getPendingVectorChanges()[0].revision,
      newer.revision,
      "an old acknowledgement cannot erase the new speech"
    );
    assert.deepEqual(database.searchNotes("83"), []);
    assert.deepEqual(database.searchNotes("quartz"), []);
    assert.equal(database.searchNotes("72")[0]?.id, saved.id);
    acknowledge(database);
    database.updateNote(saved.id, { transcript: next });
    assert.deepEqual(
      database.getPendingVectorChanges(),
      [],
      "unchanged speech does not enqueue a false change"
    );
    database.db.exec("INSERT INTO notes_fts(notes_fts, rank) VALUES('integrity-check', 1)");

    database.db.close();
    database = new Database();
    database.setActiveAccountId("speech-search-owner-a");
    assert.equal(database.getNote(saved.id).transcript, next);
    assert.equal(database.getNote(saved.id).content, "Manual body");
    assert.equal(database.searchNotes("新增发言")[0]?.id, saved.id);
    assert.deepEqual(database.searchNotes("83"), []);
    database.db.exec("INSERT INTO notes_fts(notes_fts, rank) VALUES('integrity-check', 1)");
    database.updateNote(saved.id, { deleted_at: "2026-10-10T00:00:00Z" });
    assert.deepEqual(database.searchNotes("72"), []);
    database.db.prepare("DELETE FROM notes WHERE id = ?").run(saved.id);
    assert.deepEqual(database.searchNotes("新增发言"), []);
    database.db.exec("INSERT INTO notes_fts(notes_fts, rank) VALUES('integrity-check', 1)");
  } finally {
    database.db.close();
  }
});
