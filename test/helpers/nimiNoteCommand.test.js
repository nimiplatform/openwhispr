const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const original = Module._load;
let generation = 0;
let search;
const database = { activeAccountId: "a" };
const semanticSearch = {};
Module._load = function (request, parent, isMain) {
  if (request === "./tokenStore") return { getGeneration: () => generation, subscribe() {} };
  if (request === "./appData") return { getAppDataDirectory: () => "isolated-unit-root" };
  if (request === "./nimiFileTranscription") return {};
  if (request === "./nimiNoteSearch")
    return {
      searchNimiNotes: (options) => search(options),
      searchNimiConversations: (options) => search(options),
    };
  return original.call(this, request, parent, isMain);
};
const ai = require("../../src/helpers/nimiAI");
// The actual command lazily resolves the business owner; keep only that declared fixture binding.
Module._load = function (request, parent, isMain) {
  if (request === "./nimiNoteSearch")
    return {
      searchNimiNotes: (options) => search(options),
      searchNimiConversations: (options) => search(options),
    };
  return original.call(this, request, parent, isMain);
};
ai.configureUploadOwner({ database, getSemanticSearch: () => semanticSearch });
test.after(() => {
  ai.invalidate();
  Module._load = original;
});
const input = (requestId) => ({
  event: { sender: { id: 7 } },
  payload: {
    requestId,
    query: "note query",
    spaceId: 4,
    folderId: 12,
    database: "untrusted",
    semanticSearch: "untrusted",
  },
});
test("the actual Host note command fixes its business owners and cancellation request identity", async () => {
  ai.bindServices({});
  let entered;
  let options;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  search = (request) => {
    options = request;
    entered();
    return new Promise((_resolve, reject) =>
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
    );
  };
  const pending = ai.commandHandlers["openwhispr.notes.search"](input("query-1"));
  await started;
  assert.equal(options.database, database);
  assert.equal(options.semanticSearch, semanticSearch);
  assert.equal(options.folderId, 12);
  assert.equal(options.query, "note query");
  assert.equal(ai.commandHandlers["openwhispr.ai.cancel"](input("query-1")).canceled, true);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(ai.commandHandlers["openwhispr.ai.cancel"](input("query-1")).canceled, false);
});
test("Host invalidation aborts old work while fresh local searches remain available", async () => {
  ai.bindServices({});
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  search = (request) => {
    entered();
    return new Promise((_resolve, reject) =>
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
    );
  };
  const pending = ai.commandHandlers["openwhispr.notes.search"](input("query-2"));
  await started;
  ai.invalidate();
  await assert.rejects(pending, { name: "AbortError" });
  search = async (options) => {
    assert.equal(options.semanticSearch, undefined);
    return { notes: [{ id: 1 }], mode: "keyword" };
  };
  assert.deepEqual(await ai.commandHandlers["openwhispr.notes.search"](input("query-3")), {
    notes: [{ id: 1 }],
    mode: "keyword",
  });
  search = async (options) => {
    assert.equal(options.semanticSearch, undefined);
    return { conversations: [{ id: 2 }], mode: "keyword" };
  };
  assert.deepEqual(await ai.commandHandlers["openwhispr.conversations.search"](input("query-4")), {
    conversations: [{ id: 2 }],
    mode: "keyword",
  });
  await assert.rejects(
    ai.commandHandlers["openwhispr.ai.transcribe"](input("ai-no-session")),
    /session is unavailable/
  );
});
