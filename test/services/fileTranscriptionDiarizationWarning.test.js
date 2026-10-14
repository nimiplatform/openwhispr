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

for (const result of [
  { success: true, text: "Plain transcript", diarizationWarning: true, durationSeconds: 1188 },
  {
    success: true,
    text: "Speaker 1: Hello",
    diarized: true,
    segments: [{ text: "Hello", speaker: "Speaker 1", start: 0, end: 2 }],
  },
  {
    success: true,
    text: "Partial transcript",
    speakerMatchingWarning: true,
    warning: "Some chunks failed",
    failedChunks: 1,
    totalChunks: 2,
  },
  { success: true, status: "no-speech", text: "" },
  { success: false, code: "TRANSCRIPTION_FAILED", error: "Host rejected audio" },
]) {
  test(`Host transcription outcome is retained: ${JSON.stringify(result)}`, async (t) => {
    const h = await load(t, result);
    assert.deepEqual(
      await h.transcribeFileWithSpeakers(
        "/tmp/audio.wav",
        { language: "en" },
        { enabled: true, numSpeakers: 2 }
      ),
      result
    );
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][1].diarization, true);
    assert.equal(h.calls[0][1].timestamps, true);
    assert.equal(h.calls[0][1].numSpeakers, 2);
  });
}
test("Host cancellation remains cancellation, not a successful plain transcript", async (t) => {
  const h = await load(t, new DOMException("Cancelled", "AbortError"));
  await assert.rejects(
    h.transcribeFileWithSpeakers(
      "/tmp/audio.wav",
      { language: "en" },
      { enabled: true, numSpeakers: null }
    ),
    { name: "AbortError" }
  );
});
