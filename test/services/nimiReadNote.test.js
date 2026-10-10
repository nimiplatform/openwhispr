const test = require("node:test");
const assert = require("node:assert/strict");
const { getNoteTool } = require("../../src/services/tools/getNoteTool.ts");

test("get_note keeps original body, summary and real saved speech separate without raw JSON metadata", async () => {
  const note = {
    id: 14,
    title: "Saved note",
    content: "Original budget83万元",
    enhanced_content: "Earlier summary",
    transcript: JSON.stringify([
      {
        text: "新增录音预算72万元",
        source: "system",
        id: "PRIVATE_JOB",
        recognition: { text: "NOT_SPOKEN" },
      },
    ]),
  };
  const raw = JSON.stringify(note);
  global.window = { electronAPI: { getNote: async () => note } };
  const result = await getNoteTool.execute({ id: 14 });
  assert.equal(result.success, true);
  assert.equal(result.data.content, "Original budget83万元");
  assert.equal(result.data.summary, "Earlier summary");
  assert.equal(result.data.transcript, "新增录音预算72万元");
  assert.doesNotMatch(JSON.stringify(result.data), /PRIVATE_JOB|NOT_SPOKEN|recognition/);
  assert.equal(JSON.stringify(note), raw);
});

test("get_note respects owner not-found and retires a response canceled during the owner read", async () => {
  global.window = { electronAPI: { getNote: async () => null } };
  assert.equal((await getNoteTool.execute({ id: 14 })).success, false);
  const controller = new AbortController();
  let calls = 0;
  global.window.electronAPI.getNote = async () => {
    calls++;
    controller.abort();
    return { id: 14, content: "Late" };
  };
  await assert.rejects(getNoteTool.execute({ id: 14 }, { signal: controller.signal }), {
    name: "AbortError",
  });
  await assert.rejects(getNoteTool.execute({ id: 14 }, { signal: controller.signal }), {
    name: "AbortError",
  });
  assert.equal(calls, 1);
});
