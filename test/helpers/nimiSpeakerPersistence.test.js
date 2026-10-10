const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-speaker-space-"));
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
Module._load = originalLoad;
process.env.NODE_ENV = "test";
const first = { vector: [0.123456789012345, -0.5, 0.75], spaceId: "declared-fixture-A" };
const second = { vector: [0.4, -0.2, 0.6], spaceId: "declared-fixture-B" };

test("device people preserve separate model spaces, actual precision, manual mappings and unknown historical blobs", () => {
  const database = new DatabaseManager();
  database.setActiveAccountId("speaker-owner-A");
  const oldBlob = Buffer.from(new Float32Array([1, 2, 3]).buffer);
  const legacy = database.db
    .prepare("INSERT INTO speaker_profiles (display_name, embedding) VALUES (?, ?)")
    .run("Unknown historical voice", oldBlob).lastInsertRowid;
  assert.deepEqual(
    database.getSpeakerProfiles(true).find((profile) => profile.id === legacy).representations,
    []
  );
  const person = database.upsertSpeakerProfile("Alice", "alice@example.test", first);
  const samePerson = database.upsertSpeakerProfile("Alice", "alice@example.test", second);
  assert.equal(samePerson.id, person.id);
  assert.deepEqual(samePerson.representations, [first, second]);
  const note = database.saveNote("Meeting", "actual note fixture").note;
  database.saveNoteSpeakerEmbeddings(note.id, { speaker_0: first });
  database.setSpeakerMapping(note.id, "speaker_0", person.id, "Alice");
  assert.deepEqual(database.getNoteSpeakerEmbeddings(note.id)[0].representation, first);
  const duplicate = database.upsertSpeakerProfile("Alice other label", null, {
    ...first,
    vector: [0.5, -0.25, 1],
  });
  const merged = database.mergeSpeakerProfiles(samePerson, duplicate);
  assert.equal(merged.representations.length, 2);
  assert.deepEqual(
    merged.representations.find((value) => value.spaceId === second.spaceId),
    second
  );
  assert.equal(
    merged.representations.find((value) => value.spaceId === first.spaceId).vector[0],
    (first.vector[0] + 0.5) / 2
  );
  database.setActiveAccountId("speaker-owner-B");
  assert.deepEqual(database.getNoteSpeakerEmbeddings(note.id), []);
  assert.ok(
    database.getSpeakerProfiles(true).some((profile) => profile.id === person.id),
    "person profiles keep original device ownership"
  );
  database.db.close();
  const reopened = new DatabaseManager();
  try {
    reopened.setActiveAccountId("speaker-owner-A");
    assert.deepEqual(reopened.getNoteSpeakerEmbeddings(note.id)[0].representation, first);
    assert.deepEqual(
      reopened.db.prepare("SELECT embedding FROM speaker_profiles WHERE id = ?").get(legacy)
        .embedding,
      oldBlob
    );
    assert.equal(reopened.getSpeakerMappings(note.id)[0].display_name, "Alice");
    assert.throws(() =>
      reopened.upsertSpeakerProfile("Bad", null, { vector: [0, 0], spaceId: "A" })
    );
    assert.throws(() =>
      reopened.saveNoteSpeakerEmbeddings(note.id, { x: { vector: [1], spaceId: "A" }, y: [1, 2] })
    );
    assert.equal(
      reopened.getNoteSpeakerEmbeddings(note.id).length,
      1,
      "invalid batch rolls back all its rows"
    );
  } finally {
    reopened.db.close();
  }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
