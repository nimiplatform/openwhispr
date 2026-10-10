const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const Module = require("node:module");
const { mediaHelperEnvironment } = require("../../src/helpers/mediaHelperEnvironment");
const original = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "./nimiEmbeddings") return {};
  if (request === "./tokenStore") return { getGeneration: () => 0 };
  if (request === "./debugLogger") return { debug() {}, error() {} };
  return original.call(this, request, parent, isMain);
};
const { VectorIndex } = require("../../src/helpers/vectorIndex");
const { searchNimiNotes } = require("../../src/helpers/nimiNoteSearch");
Module._load = original;
const binary = path.resolve("resources/bin/qdrant-win32-x64.exe");
const available = process.platform === "win32" && fs.existsSync(binary);
// Actual Qdrant storage and App index functions; these declared vector fixtures are not model inference.
async function withQdrant(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimi-qdrant-owned-test-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const config = path.join(root, "config.yaml");
  fs.writeFileSync(
    config,
    [
      "storage:",
      "  storage_path: " + JSON.stringify(path.join(root, "storage")),
      "service:",
      "  host: 127.0.0.1",
      "  http_port: " + port,
      "  grpc_port: null",
      "  enable_cors: false",
      "telemetry_disabled: true",
      "log_level: ERROR",
      "",
    ].join("\n")
  );
  const version = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    env: mediaHelperEnvironment(),
  });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /1\.19\.2/);
  let child;
  let log = "";
  let closed;
  const start = async () => {
    child = spawn(binary, ["--config-path", config], {
      cwd: root,
      windowsHide: true,
      env: mediaHelperEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    closed = once(child, "close");
    child.stdout.on("data", (data) => {
      log = (log + data.toString()).slice(-4096);
    });
    child.stderr.on("data", (data) => {
      log = (log + data.toString()).slice(-4096);
    });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("Owned Qdrant exited: " + log);
      try {
        const response = await fetch("http://127.0.0.1:" + port + "/readyz");
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Owned Qdrant readiness timed out: " + log);
  };
  const stop = async () => {
    if (child?.exitCode === null && child.signalCode === null) child.kill();
    if (closed) await closed;
    child = null;
    closed = null;
  };
  let spaceId = "declared-unit-runtime-space-a";
  const consumed = [];
  const embeddings = {
    async embedText(text) {
      return this.embedTexts([text]);
    },
    async embedTexts(inputs) {
      consumed.push(...inputs);
      return {
        vectors: inputs.map((text) =>
          text.includes("TAIL_TOPIC") || text.includes("TAIL_QUERY")
            ? [0, 0, 1]
            : text.includes("unrelated")
              ? [0, 1, 0]
              : [1, 0, 0]
        ),
        spaceId,
        dimensions: 3,
        scopeKey: "unit-business-scope",
        assertCurrent() {},
        async assertValid() {},
      };
    },
  };
  const index = new VectorIndex({ embeddings });
  try {
    await run({
      index,
      embeddings,
      consumed,
      port,
      start,
      stop,
      setSpace: (value) => {
        spaceId = value;
      },
    });
  } catch (error) {
    error.message += "\nOwned Qdrant diagnostics: " + log;
    throw error;
  } finally {
    await stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test(
  "isolated actual Qdrant persists compatible note/conversation indexes and never mixes Runtime spaces",
  { skip: !available, timeout: 25000 },
  async () => {
    await withQdrant(async ({ index, consumed, port, start, stop, setSpace }) => {
      await start();
      index.init(port);
      assert.deepEqual(await index.ensureCollection("actual query fixture"), { created: true });
      const originalName = index.collectionName;
      await index.upsertNote(1, "note fixture", { space_id: 4, folder_id: 12 });
      await index.upsertNote(2, "unrelated fixture", { space_id: 8 });
      const hits = await index.search("query fixture", 5, {
        must: [{ key: "space_id", match: { value: 4 } }],
      });
      assert.deepEqual(
        hits.map((hit) => hit.noteId),
        [1]
      );
      const longText = "长文😀".repeat(25000) + "TAIL_TOPIC";
      assert.equal(await index.upsertNote(3, longText, { space_id: 4 }), true);
      assert.ok(consumed.some((text) => text.endsWith("TAIL_TOPIC")));
      const tailHits = await index.search("TAIL_QUERY", 2, {
        must: [{ key: "space_id", match: { value: 4 } }],
      });
      assert.equal(tailHits[0].noteId, 3);
      assert.equal(tailHits.length, 2);
      assert.equal(new Set(tailHits.map((hit) => hit.noteId)).size, 2);
      assert.equal(await index.upsertNote(3, "replacement body", { space_id: 4 }), true);
      const replaced = await index.search("TAIL_QUERY", 3);
      assert.ok(replaced.find((hit) => hit.noteId === 3).score < 0.1);
      await index.deleteNote(3);
      assert.ok((await index.search("TAIL_QUERY", 3)).every((hit) => hit.noteId !== 3));
      await index.upsertConversationChunks(7, "Conversation", [
        { role: "user", content: "message fixture" },
      ]);
      assert.deepEqual(
        (await index.searchConversations("query fixture")).map((hit) => hit.conversationId),
        [7]
      );
      await index.reindexAllConversations([]);
      assert.deepEqual(await index.searchConversations("query fixture"), []);
      await stop();
      await start();
      index.init(port);
      assert.deepEqual(await index.ensureCollection("query fixture"), { created: false });
      assert.equal(index.collectionName, originalName);
      assert.equal((await index.search("query fixture"))[0].noteId, 1);
      setSpace("declared-unit-runtime-space-b");
      await assert.rejects(index.search("query fixture"), { code: "EMBEDDING_CONTEXT_CHANGED" });
      index.init(port);
      assert.deepEqual(await index.ensureCollection("query fixture"), { created: true });
      assert.notEqual(index.collectionName, originalName);
      assert.deepEqual(await index.search("query fixture"), []);
      setSpace("declared-unit-runtime-space-a");
      index.init(port);
      await index.ensureCollection("query fixture");
      await index.pruneNotes((id) => (id === 1 ? { id } : null));
      assert.deepEqual(
        (await index.search("query fixture")).map((hit) => hit.noteId),
        [1]
      );
      await index.deleteBySpace(4);
      assert.deepEqual(await index.search("query fixture"), []);
      const cors = await fetch("http://127.0.0.1:" + port + "/collections", {
        headers: { Origin: "https://example.com" },
      });
      assert.equal(cors.headers.has("access-control-allow-origin"), false);
      await stop();
    });
  }
);

test(
  "actual Qdrant folder constraints precede Top K for the App's business search",
  { skip: !available, timeout: 25000 },
  async () => {
    await withQdrant(async ({ index, embeddings, port, start }) => {
      const embed = embeddings.embedTexts.bind(embeddings);
      embeddings.embedTexts = async (inputs) => {
        const result = await embed(inputs);
        result.vectors = inputs.map((text) =>
          text === "target-folder" ? [0.8, 0.6, 0] : [1, 0, 0]
        );
        return result;
      };
      await start();
      index.init(port);
      await index.ensureCollection("query fixture");
      for (let i = 0; i < 21; i++)
        assert.equal(
          await index.upsertNote(100 + i, "high-scoring-other-folder", {
            space_id: 4,
            folder_id: 7,
          }),
          true
        );
      assert.equal(
        await index.upsertNote(500, "target-folder", { space_id: 4, folder_id: 12 }),
        true
      );
      const database = {
        activeAccountId: "unit-scope",
        searchNotes: () => [],
        getNoteIdsInScope: (_space, _folder, ids) => ids.filter((id) => id === 500),
        getNote: (id) => (id === 500 ? { id, title: "Target", content: "target-folder" } : null),
      };
      const result = await searchNimiNotes({
        database,
        semanticSearch: index,
        query: "query fixture",
        limit: 5,
        spaceId: 4,
        folderId: 12,
      });
      assert.equal(result.mode, "hybrid");
      assert.deepEqual(
        result.notes.map((note) => note.id),
        [500]
      );
    });
  }
);
