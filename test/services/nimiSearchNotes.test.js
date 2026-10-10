const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const original = Module._load;
let localSearch;
Module._load = function (request, parent, isMain) {
  if (request === "../nimiNotes") return { searchNimiNotes: (...args) => localSearch(...args) };
  return original.call(this, request, parent, isMain);
};
const { createSearchNotesTool } = require("../../src/services/tools/searchNotesTool.ts");
Module._load = original;
const i18n = require("../../src/i18n.ts").default;
test.before(() => i18n.changeLanguage("zh-CN"));
function api(mode) {
  const calls = [];
  global.window = {
    electronAPI: {
      getSpaces: async () => [{ id: 4, name: "Research", kind: "private" }],
      searchNotes: async () => {
        throw new Error("The handled keyword response must not be retried");
      },
    },
  };
  localSearch = async (...args) => {
    calls.push(args);
    return { mode, notes: [{ id: 7, title: "研究笔记", content: "真实业务笔记", space_id: 4 }] };
  };
  return calls;
}
test("the actual assistant search_notes reports the executed method and retains its fixed folder scope", async () => {
  for (const mode of ["keyword", "hybrid"]) {
    const calls = api(mode);
    const tool = createSearchNotesTool({
      useCloudSearch: false,
      fixedScope: { spaceId: 4, folderId: 12 },
    });
    const result = await tool.execute({ query: "语义问题", space: "Ignored" });
    assert.equal(result.success, true);
    assert.match(result.displayText, mode === "keyword" ? /关键词检索/ : /语义检索/);
    assert.deepEqual(calls[0], ["语义问题", 5, 4, 12, undefined]);
    assert.equal(result.data[0].content, "真实业务笔记");
  }
});
test("the assistant does not retry a retired account request against the replacement account", async () => {
  api("hybrid");
  localSearch = async () => {
    throw new Error("Note search account changed");
  };
  const result = await createSearchNotesTool({ useCloudSearch: false }).execute({ query: "query" });
  assert.equal(result.success, false);
  assert.match(result.displayText, /Note search account changed/);
});

test("assistant search previews include the matching late speech while keeping note body and summary separate", async () => {
  const calls = api("hybrid");
  localSearch = async (...args) => {
    calls.push(args);
    return {
      mode: "hybrid",
      notes: [
        {
          id: 14,
          title: "Mixed note",
          space_id: 4,
          content: "Original budget83万元",
          enhanced_content: "Earlier summary",
          transcript: JSON.stringify([
            { text: "早先83万元的原录音。".repeat(90), source: "system" },
            { text: "新的预算72万元", source: "system", recognition: { text: "PRIVATE_METADATA" } },
          ]),
        },
      ],
    };
  };
  const result = await createSearchNotesTool({
    useCloudSearch: false,
    fixedScope: { spaceId: 4, folderId: 12 },
  }).execute({ query: "72万元" });
  assert.equal(result.success, true);
  assert.equal(result.data[0].content, "Original budget83万元");
  assert.equal(result.data[0].summary, "Earlier summary");
  assert.match(result.data[0].transcript, /新的预算72万元/);
  assert.doesNotMatch(result.data[0].transcript, /PRIVATE_METADATA|recognition/);
  assert.ok(Array.from(result.data[0].transcript).length <= 502);
  assert.deepEqual(calls[0], ["72万元", 5, 4, 12, undefined]);
});
