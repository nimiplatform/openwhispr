const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const original = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "./nimiEmbeddings") return {};
  if (request === "./debugLogger") return { debug() {} };
  return original.call(this, request, parent, isMain);
};
const { VectorIndex } = require("../../src/helpers/vectorIndex");
Module._load = original;
function harness() {
  let spaceId = "runtime-space-a",
    dimensions = 3,
    collectionError,
    writeError;
  const calls = [];
  const collections = new Map();
  const client = {
    async getCollection(name) {
      if (collectionError) throw collectionError;
      if (!collections.has(name)) throw { status: 404 };
      return collections.get(name);
    },
    async createCollection(name, input) {
      calls.push(["create", name, input]);
      collections.set(name, { config: { params: input } });
    },
    async upsert(name, input) {
      calls.push(["upsert", name, input]);
      if (writeError) throw writeError;
    },
    async delete(name, input) {
      calls.push(["delete", name, input]);
      if (writeError) throw writeError;
    },
    async query(name, input) {
      calls.push(["query", name, input]);
      return { points: [{ id: 1, score: 0.9 }] };
    },
    async queryGroups(name, input) {
      calls.push(["queryGroups", name, input]);
      return { groups: [{ id: 1, hits: [{ score: 0.9 }] }] };
    },
    async scroll() {
      return {
        points: [
          { id: 8, payload: { note_id: 8 } },
          { id: 9, payload: { note_id: 9 } },
        ],
        next_page_offset: null,
      };
    },
  };
  const embeddings = {
    async embedText() {
      return this.embedTexts(["fixture"]);
    },
    async embedTexts(inputs) {
      return {
        vectors: inputs.map(() => Array(dimensions).fill(1)),
        dimensions,
        spaceId,
        scopeKey: "business-scope",
        assertCurrent() {},
        async assertValid() {},
      };
    },
  };
  const index = new VectorIndex({ embeddings, clientFactory: () => client });
  index.init(6333);
  return {
    index,
    embeddings,
    calls,
    client,
    collections,
    setSpace: (value) => {
      spaceId = value;
    },
    setDimensions: (value) => {
      dimensions = value;
    },
    failCollection: (value) => {
      collectionError = value;
    },
    failWrite: (value) => {
      writeError = value;
    },
  };
}
test("actual space and dimensions name the index; old unmarked collections are never queried", async () => {
  const h = harness();
  assert.deepEqual(await h.index.ensureCollection("actual query"), { created: true });
  assert.equal(h.calls[0][2].vectors.size, 3);
  assert.match(h.index.collectionName, /^nimi_note_chunks_/);
  assert.deepEqual(await h.index.ensureCollection("actual query"), { created: false });
  await h.index.upsertNote(1, "note");
  await h.index.search("query");
  assert.ok(h.calls.every((call) => call[1] !== "notes"));
  h.setSpace("other-space");
  await assert.rejects(h.index.search("query"), { code: "EMBEDDING_CONTEXT_CHANGED" });
  h.index.init(6333);
  await h.index.ensureCollection("actual query");
  assert.equal(h.calls.filter((call) => call[0] === "create").length, 2);
});
test("dimensions and collection shape must agree even for same-size vectors in different spaces", async () => {
  const h = harness();
  await h.index.ensureCollection("query");
  h.setDimensions(4);
  await assert.rejects(h.index.upsertNote(1, "note"), { code: "EMBEDDING_CONTEXT_CHANGED" });
  h.setDimensions(3);
  h.collections.get(h.index.collectionName).config.params.vectors.distance = "Dot";
  await assert.rejects(h.index.ensureCollection("query"), /incompatible vector/);
});
test("journal acknowledgements require completed successful mutations and no late reset", async () => {
  const h = harness();
  await h.index.ensureCollection("query");
  assert.equal(await h.index.upsertNote(1, "note"), true);
  assert.equal(await h.index.deleteNote(1), true);
  assert.equal(await h.index.deleteBySpace(4), true);
  assert.ok(
    h.calls.filter((call) => ["upsert", "delete"].includes(call[0])).every((call) => call[2].wait)
  );
  h.failWrite(new Error("offline"));
  assert.equal(await h.index.upsertNote(1, "note"), false);
  h.failWrite(null);
  let release;
  h.client.upsert = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = h.index.upsertNote(1, "note");
  await new Promise((resolve) => setImmediate(resolve));
  h.index.reset();
  release();
  await assert.rejects(pending, { code: "EMBEDDING_CONTEXT_CHANGED" });
  assert.equal(h.index.isReady(), false);
});
test("availability failure does not create an empty collection or successful zero-hit result", async () => {
  const h = harness();
  h.failCollection(new Error("offline"));
  await assert.rejects(h.index.ensureCollection("query"), /offline/);
  assert.equal(h.calls.length, 0);
  assert.equal(await h.index.search("query"), null);
});
test("pruning removes deleted and out-of-business-scope derived hits", async () => {
  const h = harness();
  await h.index.ensureCollection("query");
  await h.index.pruneNotes((id) => (id === 8 ? { id } : null));
  const removal = h.calls.find((call) => call[0] === "delete");
  assert.deepEqual(removal[2].points, [9]);
});

test("selected full Unicode note text reaches every embedding chunk and grouped retrieval is note-bounded", async () => {
  const { chunkEmbeddingText } = require("../../src/helpers/embeddingChunks");
  const oldLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "./tokenStore") return { getGeneration: () => 0, subscribe() {} };
    return oldLoad.call(this, request, parent, isMain);
  };
  let NimiEmbeddings;
  try {
    ({ NimiEmbeddings } = require("../../src/helpers/nimiEmbeddings"));
  } finally {
    Module._load = oldLoad;
  }
  const selected = "原文😀".repeat(15000) + "仅在尾部的主题";
  const text = NimiEmbeddings.noteEmbedText("真实标题", "hidden original", selected);
  assert.equal(text, "真实标题\n" + selected);
  const chunks = chunkEmbeddingText(text);
  assert.equal(chunks.join(""), text);
  assert.ok(
    chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 32768 && !chunk.includes("\uFFFD"))
  );
  assert.ok(chunks.at(-1).includes("仅在尾部的主题"));
  const h = harness();
  await h.index.ensureCollection("query");
  let submitted;
  const embed = h.embeddings.embedTexts.bind(h.embeddings);
  h.embeddings.embedTexts = async (inputs) => {
    submitted = [...inputs];
    return embed(inputs);
  };
  assert.equal(await h.index.upsertNote(42, text, { space_id: 4 }), true);
  assert.deepEqual(submitted, chunks);
  const points = h.calls.filter((call) => call[0] === "upsert").flatMap((call) => call[2].points);
  assert.equal(points.length, chunks.length);
  assert.ok(points.every((point) => point.payload.note_id === 42 && point.payload.space_id === 4));
  assert.equal(new Set(points.map((point) => point.id)).size, chunks.length);
  await h.index.search("query", 5);
  const request = h.calls.find((call) => call[0] === "queryGroups")[2];
  assert.equal(request.group_by, "note_id");
  assert.equal(request.group_size, 1);
  assert.equal(request.limit, 5);
});
