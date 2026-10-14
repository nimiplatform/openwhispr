const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

const RAW = "um so can you uh send me the report by friday";
const CLEAN = "Can you send me the report by Friday?";
async function setup(t, processText, settings = {}) {
  globalThis.__nimiCleanupProcess = processText;
  t.after(() => delete globalThis.__nimiCleanupProcess);
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-nimi-cleanup-recovery-",
    settingsKey: "__nimiCleanupSettings",
    settings: {
      useCleanupModel: true,
      useDictationAgent: false,
      preferredLanguage: "en",
      uiLanguage: "en",
      customDictionary: [],
      customPrompts: { cleanup: "" },
      ...settings,
    },
    mockModules: {
      "/services/ReasoningService": `export default {
      processText: (...args) => globalThis.__nimiCleanupProcess(...args), cancelAllRequests() {}
    };`,
    },
  });
  const manager = loaded.createManager({
    voiceAgentRequested: false,
    translationRequested: false,
    pendingCleanupFailure: null,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    finalizeChineseScript: async (value) => value,
    onError: () => assert.fail("cleanup must report alongside delivery, not before it"),
  });
  return {
    ...loaded,
    manager,
    run: () => manager.processTranscriptionWithNimi(RAW, () => false, new AbortController().signal),
  };
}

test("Nimi cleanup failure preserves recognized text and reports once with delivery", async (t) => {
  const error = Object.assign(new Error("Nimi generation unavailable"), {
    reasonCode: "AI_PROVIDER_UNAVAILABLE",
  });
  const { manager, run } = await setup(t, async () => {
    throw error;
  });
  assert.equal(await run(), RAW);
  assert.equal(manager._takePendingResultExtras().cleanupFailure.message, error.message);
  assert.deepEqual(manager._takePendingResultExtras(), {});
});

test("Nimi cleanup cancellation is not converted into a deliverable result", async (t) => {
  const error = Object.assign(new Error("Canceled"), { name: "AbortError" });
  const { manager, run } = await setup(t, async () => {
    throw error;
  });
  await assert.rejects(run, { name: "AbortError" });
  assert.deepEqual(manager._takePendingResultExtras(), {});
});

test("failed cleanup feeds the original transcript to requested translation", async (t) => {
  const inputs = [];
  const { manager, run } = await setup(
    t,
    async (text) => {
      inputs.push(text);
      if (inputs.length === 1) throw new Error("cleanup unavailable");
      return "Envoyez le rapport vendredi.";
    },
    { translationSourceLanguage: "en", translationTargetLanguage: "fr" }
  );
  manager.translationRequested = true;
  assert.equal(await run(), "Envoyez le rapport vendredi.");
  assert.deepEqual(inputs, [RAW, RAW]);
  assert.equal(manager._takePendingResultExtras().cleanupFailure.message, "cleanup unavailable");
});

test("duplicated default cleanup is rejected, while a deliberate custom prompt remains effective", async (t) => {
  const duplicate = `**Cleaned transcript:**\n${CLEAN}\n${CLEAN}`;
  const { manager, run, setSettings } = await setup(t, async () => duplicate);
  assert.equal(await run(), RAW);
  assert.equal(
    manager._takePendingResultExtras().cleanupFailure.messageKey,
    "hooks.audioRecording.errorDescriptions.cleanupDuplicated"
  );
  setSettings({ useCleanupModel: true, customPrompts: { cleanup: "Repeat twice" } });
  assert.equal(await run(), duplicate);
  assert.deepEqual(manager._takePendingResultExtras(), {});
});

test("a successfully cleaned transcript is delivered unchanged", async (t) => {
  const { manager, run } = await setup(t, async (_text, _model, _agent, options) => {
    assert.equal(options.requireCompleteOutput, true);
    return CLEAN;
  });
  assert.equal(await run(), CLEAN);
  assert.deepEqual(manager._takePendingResultExtras(), {});
});

test("clipped cleanup keeps the full recognition result", async (t) => {
  const { manager, run } = await setup(t, async (_text, _model, _agent, options) => {
    assert.equal(options.requireCompleteOutput, true);
    throw Object.assign(new Error("Generation was truncated"), {
      code: "INFERENCE_OUTPUT_TRUNCATED",
    });
  });
  assert.equal(await run(), RAW);
  assert.equal(
    manager._takePendingResultExtras().cleanupFailure.message,
    "Generation was truncated"
  );
});
