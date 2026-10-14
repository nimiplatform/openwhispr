const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
async function load(t, result = { success: true, note: { id: 7 } }) {
  installBrowserGlobals(t);
  const calls = [];
  globalThis.__commitUpload = async (...args) => {
    calls.push(args);
    return result;
  };
  t.after(() => {
    delete globalThis.__commitUpload;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-commit-",
    mockModules: {
      "/nimiClient": "export const runNimiRequest=(...args)=>globalThis.__commitUpload(...args);",
    },
  });
  return { calls, ...(await vite.ssrLoadModule("/services/uploadNotes.ts")) };
}
test("upload commit sends identity and business labels, never renderer-authored transcript facts", async (t) => {
  const h = await load(t);
  const signal = new AbortController().signal;
  const result = await h.saveUploadNote({
    requestId: "upload-1",
    title: "Meeting",
    sourceName: "meeting.mp4",
    folderId: 3,
    text: "renderer text",
    segments: [{ text: "renderer text", start: 0, end: 2 }],
    durationSeconds: 999,
    diarization: { enabled: true, numSpeakers: 2 },
    signal,
  });
  assert.deepEqual(result, { success: true, note: { id: 7 } });
  assert.deepEqual(h.calls, [
    [
      "openwhispr.upload.commit-note",
      { requestId: "upload-1", title: "Meeting", sourceName: "meeting.mp4", folderId: 3 },
      signal,
    ],
  ]);
});
test("missing identity or cancellation refuses commit", async (t) => {
  const h = await load(t);
  await assert.rejects(h.saveUploadNote({ title: "Meeting" }), /identity/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.saveUploadNote({ requestId: "upload-1", signal: controller.signal }), {
    name: "AbortError",
  });
  assert.deepEqual(h.calls, []);
});
for (const result of [{ success: false }, { success: true }])
  test(`incomplete Host commit is not success: ${JSON.stringify(result)}`, async (t) => {
    const h = await load(t, result);
    await assert.rejects(h.saveUploadNote({ requestId: "upload-1" }), /not saved/);
  });
test("upload titles fall back to the transcript, then the file name", async (t) => {
  const { uploadTitleFallback } = await load(t);

  assert.equal(uploadTitleFallback("one two three", "board.m4a"), "one two three");
  assert.equal(
    uploadTitleFallback("one two three four five six seven", "board.m4a"),
    "one two three four five six..."
  );
  assert.equal(uploadTitleFallback("   ", "board-meeting.m4a"), "board-meeting");
});
