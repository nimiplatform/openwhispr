const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const original = Module._load;
let auth = 0;
Module._load = function (request, parent, isMain) {
  if (request === "./tokenStore") return { getGeneration: () => auth };
  if (request === "./debugLogger") return { error() {} };
  return original.call(this, request, parent, isMain);
};
const { searchNimiNotes } = require("../../src/helpers/nimiNoteSearch");
Module._load = original;
const keyword = { id: 1, title: "Keyword", content: "current" };
function harness() {
  const database = {
    activeAccountId: "first",
    searchNotes: () => [keyword],
    getNoteIdsInScope: (_space, _folder, ids) => ids.filter((id) => [1, 2].includes(id)),
    getNote: (id) => (id === 1 ? keyword : { id, title: "Semantic" }),
  };
  return { database, query: "query", limit: 5, spaceId: 4, folderId: 12 };
}
test("unavailable semantic work returns its actual keyword mode", async () => {
  const input = harness();
  assert.deepEqual(await searchNimiNotes(input), { notes: [keyword], mode: "keyword" });
});
test("semantic note search fuses actual vector hits and validates every returned body in current SQLite scope", async () => {
  const input = harness();
  input.semanticSearch = {
    search: async () => [
      { noteId: 9, score: 0.99 },
      { noteId: 2, score: 0.9 },
    ],
  };
  const result = await searchNimiNotes(input);
  assert.equal(result.mode, "hybrid");
  assert.deepEqual(result.notes.map((note) => note.id).sort(), [1, 2]);
});
test("a note moved out of its pinned folder while inference runs is excluded from both ranking legs", async () => {
  const input = harness();
  input.semanticSearch = {
    search: async () => {
      input.database.getNoteIdsInScope = () => [];
      return [];
    },
  };
  const result = await searchNimiNotes(input);
  assert.deepEqual(result.notes, []);
});
test("business login ABA and direct account replacement cannot return an earlier keyword snapshot", async () => {
  for (const change of [
    (input) => {
      input.database.activeAccountId = "second";
    },
    () => {
      auth += 2;
    },
  ]) {
    const input = harness();
    input.semanticSearch = {
      search: async () => {
        change(input);
        return null;
      },
    };
    await assert.rejects(searchNimiNotes(input), /Note search account changed/);
  }
});
test("cancellation cannot become a keyword fallback or late search result", async () => {
  const input = harness();
  const controller = new AbortController();
  input.signal = controller.signal;
  input.semanticSearch = {
    search: async (_query, _limit, _filter, { signal }) => {
      assert.equal(signal, controller.signal);
      controller.abort();
      return null;
    },
  };
  await assert.rejects(searchNimiNotes(input), { name: "AbortError" });
});
test("retired Nimi Host scope cannot be replaced by current local keyword data", async () => {
  const input = harness();
  let current = true;
  input.assertCurrent = () => {
    if (!current) throw new Error("Nimi App session changed");
  };
  input.semanticSearch = {
    search: async () => {
      current = false;
      return null;
    },
  };
  await assert.rejects(searchNimiNotes(input), /Nimi App session changed/);
});

test("conversation results validate note ownership and archived state before actual delivery", async () => {
  const { searchNimiConversations } = require("../../src/helpers/nimiNoteSearch");
  const input = harness();
  const conversations = new Map([
    [1, { id: 1, title: "Own", messages: [{ content: "current" }] }],
    [2, { id: 2, note_id: 99 }],
    [3, { id: 3, archived_at: "today" }],
  ]);
  input.database.getAgentConversation = (id) => conversations.get(id);
  input.database.getNoteForVectorIndex = () => null;
  input.database.searchAgentConversations = () => [];
  input.semanticSearch = {
    searchConversations: async () => [1, 2, 3].map((conversationId) => ({ conversationId })),
  };
  const result = await searchNimiConversations(input);
  assert.equal(result.mode, "semantic");
  assert.deepEqual(
    result.conversations.map((value) => value.id),
    [1]
  );
  assert.equal(result.conversations[0].last_message, "current");
});
test("conversation account retirement never delivers keyword fallback from a replacement scope", async () => {
  const { searchNimiConversations } = require("../../src/helpers/nimiNoteSearch");
  const input = harness();
  input.semanticSearch = {
    searchConversations: async () => {
      input.database.activeAccountId = "second";
      return null;
    },
  };
  input.database.searchAgentConversations = () => {
    assert.fail("replacement account fallback");
  };
  await assert.rejects(searchNimiConversations(input), /Conversation search account changed/);
});

test("folder filtering precedes grouped Top K even when other-folder hits exceed overfetch", async () => {
  const input = harness();
  input.database.searchNotes = () => [];
  input.database.getNoteIdsInScope = (_space, _folder, ids) => ids.filter((id) => id === 2);
  const candidates = [
    ...Array.from({ length: 21 }, (_, i) => ({
      noteId: 100 + i,
      score: 0.99,
      space_id: 4,
      folder_id: 7,
    })),
    { noteId: 2, score: 0.8, space_id: 4, folder_id: 12 },
  ];
  let received;
  input.semanticSearch = {
    search: async (_query, limit, filter) => {
      received = filter;
      return candidates
        .filter((candidate) =>
          filter.must.every((clause) => candidate[clause.key] === clause.match.value)
        )
        .slice(0, limit);
    },
  };
  const result = await searchNimiNotes(input);
  assert.deepEqual(
    result.notes.map((note) => note.id),
    [2]
  );
  assert.deepEqual(received, {
    must: [
      { key: "space_id", match: { value: 4 } },
      { key: "folder_id", match: { value: 12 } },
    ],
  });
});
