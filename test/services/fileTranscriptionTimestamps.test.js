const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function load(t, result) {
  installBrowserGlobals(t);
  const calls = [];
  globalThis.__fileTranscriptionRequest = async (...args) => {
    calls.push(args);
    if (result instanceof Error) throw result;
    return result;
  };
  t.after(() => {
    delete globalThis.__fileTranscriptionRequest;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-nimi-test-",
    mockModules: {
      "/nimiClient":
        "export const runNimiRequest=(...args)=>globalThis.__fileTranscriptionRequest(...args);",
    },
  });
  return { calls, ...(await vite.ssrLoadModule("/services/fileTranscription.ts")) };
}

test("timestamps, request identity and cancellation reach the Nimi Host unchanged", async (t) => {
  const result = {
    success: true,
    text: "Hello.",
    segments: [{ text: "Hello.", start: 0, end: 2.5 }],
    durationSeconds: 3,
  };
  const h = await load(t, result);
  const signal = new AbortController().signal;
  assert.deepEqual(
    await h.transcribeFile("/tmp/audio.wav", { language: "en" }, false, {
      requestId: "upload-1",
      timestamps: true,
      signal,
    }),
    result
  );
  assert.deepEqual(h.calls[0], [
    "openwhispr.ai.transcribe-file",
    {
      requestId: "upload-1",
      filePath: "/tmp/audio.wav",
      language: "en",
      timestamps: true,
      diarization: false,
      numSpeakers: null,
      retainForNote: false,
    },
    signal,
  ]);
  await h.transcribeFile("/tmp/audio.wav", { language: "en" }, false);
  assert.equal(h.calls[1][1].timestamps, false);
  assert.equal(typeof h.calls[1][1].requestId, "string");
});

test("upload retains Host results and measured timing rather than the renderer duration hint", async (t) => {
  const result = {
    success: true,
    text: "Hello.",
    durationSeconds: 3,
    segments: [{ text: "Hello.", start: 0, end: 2.5 }],
  };
  const h = await load(t, result);
  assert.deepEqual(
    await h.transcribeFileWithSpeakers(
      "/tmp/audio.wav",
      { language: "en" },
      { enabled: false, numSpeakers: null },
      120,
      { requestId: "upload-2", timestamps: true }
    ),
    result
  );
  assert.equal(h.calls[0][1].timestamps, true);
  assert.equal(h.calls[0][1].retainForNote, true);
});
