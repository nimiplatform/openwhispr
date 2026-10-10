const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

test("safePaste preserves exact final text only for confirmed permission recovery", async (t) => {
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-paste-recovery-",
    settingsKey: "__pasteRecoverySettings",
  });
  const errors = [];
  const manager = createManager({
    onError: (error) => errors.push(error),
    streamingFinalText: "raw text",
  });
  const text = "  Final translated text\nwith spacing  ";
  const options = { restoreClipboard: false };
  const calls = [];
  window.electronAPI.pasteText = async (...args) => {
    calls.push(args);
    return {
      success: false,
      pasted: false,
      code: "ACCESSIBILITY_PERMISSION_REQUIRED",
      clipboardCopied: true,
    };
  };
  assert.deepEqual(await manager.safePaste(text, options), { pasted: false });
  assert.deepEqual(calls, [[text, options]]);
  assert.deepEqual(errors, [
    {
      title: "Paste Error",
      code: "ACCESSIBILITY_PERMISSION_REQUIRED",
      clipboardCopied: true,
      transcript: text,
    },
  ]);

  for (const pasted of [true, false]) {
    errors.length = 0;
    window.electronAPI.pasteText = async () => ({ success: true, pasted });
    assert.deepEqual(await manager.safePaste(text), { pasted });
    assert.deepEqual(errors, []);
  }
  window.electronAPI.pasteText = async () => {
    throw new Error("accessibility in an unrelated error");
  };
  assert.deepEqual(await manager.safePaste(text), { pasted: false });
  assert.deepEqual(errors, [
    {
      title: "Paste Error",
      code: "PASTE_FAILED",
      description: "accessibility in an unrelated error",
      transcript: text,
    },
  ]);

  errors.length = 0;
  window.electronAPI.pasteText = async () => {
    throw new Error(
      "Error invoking remote method 'paste-text': Error: Please install xdotool or paste manually with Ctrl+V."
    );
  };
  assert.deepEqual(await manager.safePaste(text), { pasted: false });
  assert.equal(errors[0].description, "Please install xdotool or paste manually with Ctrl+V.");

  window.electronAPI.pasteText = async () => {
    throw new Error("Error invoking remote method 'paste-text': TypeError: bad input");
  };
  await manager.safePaste(text);
  assert.equal(errors[1].description, "bad input");
});

test("successful inference waits for delivery and never saves a delivery rejection as failed ASR", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-delivery-lifetime-",
    settingsKey: "__deliveryLifetimeSettings",
    mockModules: {
      "/services/nimiRecording":
        'export async function transcribeNimiRecording() { return { transcript: { text: "raw fixture" }, chunks: [] }; }',
    },
  });
  let entered, finish;
  const enteredPromise = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = new Promise((_resolve, reject) => {
    finish = reject;
  });
  const errors = [],
    failed = [];
  const manager = createManager({
    isProcessing: true,
    getEffectiveSttLanguage: () => "zh",
    getCustomDictionaryPrompt: () => "",
    processTranscriptionWithNimi: async () => "final fixture",
    _takePendingResultExtras: () => ({}),
    onTranscriptionComplete: async (result) => {
      assert.equal(result.text, "final fixture");
      entered();
      await pending;
    },
    onError: (error) => errors.push(error),
    saveFailedTranscription: (error) => failed.push(error),
  });
  let settled = false;
  const work = manager.processAudio(new Blob(["audio fixture"], { type: "audio/wav" })).then(() => {
    settled = true;
  });
  await enteredPromise;
  assert.equal(manager.isProcessing, true);
  assert.equal(settled, false);
  finish(new Error("delivery rejected"));
  await work;
  assert.equal(manager.isProcessing, false);
  assert.deepEqual(failed, []);
  assert.deepEqual(errors, [
    { title: "Paste Error", code: "PASTE_FAILED", transcript: "final fixture" },
  ]);
});
