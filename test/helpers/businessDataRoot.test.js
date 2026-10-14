const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const Database = require("better-sqlite3");

test(
  "Windows business root remains stable when AppData or technical profile changes",
  { skip: process.platform !== "win32" },
  () => {
    const home = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "nimi-business-home-"))
    );
    const ownerPath = require.resolve("../../src/helpers/appData");
    const original = Module._load;
    let appData = path.join(home, "context-one");
    Module._load = function (request, parent, isMain) {
      if (request === "electron")
        return { app: { getPath: (name) => (name === "home" ? home : appData) } };
      return original.call(this, request, parent, isMain);
    };
    try {
      delete require.cache[ownerPath];
      const owner = require(ownerPath);
      const root = owner.getAppDataDirectory();
      appData = path.join(home, "context-two");
      assert.equal(owner.getAppDataDirectory(), root);
      assert.equal(root, path.join(home, ".openwhispr-nimi"));
      assert.equal(fs.realpathSync.native(root), root);
    } finally {
      Module._load = original;
      delete require.cache[ownerPath];
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
);

test("explicit one-time copy snapshots live WAL and retains original media without overwriting", async () => {
  const { copyBusinessData } = require("../../tools/copy-business-data-once.cjs");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nimi-business-copy-"));
  const source = path.join(temporary, "source");
  const destination = path.join(temporary, "restored");
  fs.mkdirSync(source);
  const database = new Database(path.join(source, "transcriptions-dev.db"));
  database.pragma("journal_mode = WAL");
  database.pragma("wal_autocheckpoint = 0");
  database.exec("CREATE TABLE notes (id INTEGER, transcript TEXT, original_path TEXT)");
  const transcript = JSON.stringify([{ text: "林", startSeconds: 0.56, endSeconds: 0.72 }]);
  database.prepare("INSERT INTO notes VALUES (?, ?, ?)").run(3, transcript, "imports/source.wav");
  fs.mkdirSync(path.join(source, "imports"));
  fs.writeFileSync(path.join(source, "imports/source.wav"), "declared media fixture");
  let restored;
  try {
    await copyBusinessData(source, destination);
    restored = new Database(path.join(destination, "transcriptions-dev.db"), { readonly: true });
    assert.deepEqual(restored.prepare("SELECT * FROM notes").get(), {
      id: 3,
      transcript,
      original_path: "imports/source.wav",
    });
    assert.equal(
      fs.readFileSync(path.join(destination, "imports/source.wav"), "utf8"),
      "declared media fixture"
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM notes").get().count, 1);
    await assert.rejects(copyBusinessData(source, destination), /already exists/);
    assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM notes").get().count, 1);
  } finally {
    restored?.close();
    database.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
