const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

async function setup(t, transcribe) {
  globalThis.__noSpeechTranscribe = transcribe;
  t.after(() => delete globalThis.__noSpeechTranscribe);
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-nimi-no-speech-",
    settingsKey: "__noSpeechSettings",
    settings: { useCleanupModel: false },
    mockModules: {
      "/services/nimiRecording":
        "export const transcribeNimiRecording = (...args) => globalThis.__noSpeechTranscribe(...args);",
    },
  });
  const results = [],
    errors = [];
  const manager = createManager({
    isProcessing: true,
    _localSpeechGateState: null,
    getEffectiveSttLanguage: () => "",
    getCustomDictionaryPrompt: () => "",
    onStateChange() {},
    onTranscriptionComplete: (value) => results.push(value),
    onError: (error) => errors.push(error),
    saveFailedTranscription: () => assert.fail("successful no-speech must not be saved as failure"),
  });
  return { manager, results, errors };
}

test("typed Nimi no-speech settles once without a provider error or invented transcript", async (t) => {
  const transcript = { status: "no-speech", text: "", language: "", words: [] };
  const { manager, results, errors } = await setup(t, async () => ({ transcript, chunks: [] }));
  await manager.processAudio(new Blob(["declared boundary fixture"], { type: "audio/wav" }));
  assert.equal(manager.isProcessing, false);
  assert.deepEqual(errors, []);
  assert.equal(results.length, 1);
  assert.equal(results[0].text, "");
  assert.deepEqual(results[0].transcription, transcript);
});

test("canceling pending Nimi preparation discards a late transcript", async (t) => {
  let finish, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const { manager, results, errors } = await setup(t, async () => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const pending = manager.processAudio(
    new Blob(["declared boundary fixture"], { type: "audio/wav" })
  );
  await ready;
  manager.cancelProcessing();
  finish({
    transcript: { status: "transcribed", text: "Late result", language: "en", words: [] },
    chunks: [],
  });
  await pending;
  assert.deepEqual(results, []);
  assert.deepEqual(errors, []);
  assert.equal(manager.isProcessing, false);
});
