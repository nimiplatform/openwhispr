const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const MARKER_RE = /__OPENWHISPR_SELECTION_COMPLETE_[0-9a-f-]+__/;

// audioManager pulls in the whole renderer graph; ReasoningService is routed
// through a globalThis slot so each test can script its responses.
async function loadAudioManager(t, { cachePrefix, settingsKey, reasoningKey }) {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix,
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.${settingsKey};
        export const getEffectiveCleanupModel = () => null;
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/services/ReasoningService": `
        export default { processText: (...args) => globalThis.${reasoningKey}(...args) };
      `,
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });
  t.after(() => {
    delete globalThis[settingsKey];
    delete globalThis[reasoningKey];
  });
  globalThis[settingsKey] = {};

  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  return {
    window,
    setProcessText: (fn) => {
      globalThis[reasoningKey] = fn;
    },
    // Prototype-only instance: the constructor wires up media devices we don't need.
    createManager: (overrides = {}) =>
      Object.assign(Object.create(AudioManager.prototype), overrides),
  };
}

test("a rejected selection image fails without silently retrying a different text-only task", async (t) => {
  const { window, setProcessText, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-sc-retry-test-",
    settingsKey: "__scRetrySettings",
    reasoningKey: "__scRetryProcessText",
  });

  window.electronAPI.captureSelectedText = async () => ({
    status: "selected",
    text: "selected body",
    sessionId: "s1",
  });

  const processTextCalls = [];
  setProcessText(async (text, model, agentName, config) => {
    processTextCalls.push({ text, config });
    if (config.screenContext) {
      throw new Error("model rejected the image");
    }
    const marker = config.systemPrompt.match(MARKER_RE)?.[0] ?? "";
    return `shorter text${marker}`;
  });

  const notices = [];
  const manager = createManager({ onError: (notice) => notices.push(notice) });

  await assert.rejects(
    manager.processAgentCommand("make it shorter", "", "Agent", {
      systemPrompt: "BASE PROMPT SCREEN_SUFFIX_SENTINEL",
      screenContext: { mediaType: "image/jpeg", data: "x" },
      selectionEditReachable: true,
    }),
    { code: "SELECTION_EDIT_REASONING_FAILED" }
  );
  assert.equal(processTextCalls.length, 1);
  assert.ok(processTextCalls[0].config.systemPrompt.match(MARKER_RE));
  assert.ok(processTextCalls[0].config.systemPrompt.includes("SCREEN_SUFFIX_SENTINEL"));
  assert.equal(processTextCalls[0].config.requireCompleteOutput, true);
  assert.equal(manager.pendingSelectionEdit, undefined);
  assert.deepEqual(notices, []);
});

test("canceled or invalidated image requests never retry or create a late selection write", async (t) => {
  const { setProcessText, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-sc-retry-direct-test-",
    settingsKey: "__scRetryDirectSettings",
    reasoningKey: "__scRetryDirectProcessText",
  });

  for (const mode of ["abort", "session", "late-success", "retired-generation"]) {
    const controller = new AbortController();
    let calls = 0;
    let retired = false;
    setProcessText(async (_text, _model, _agent, config) => {
      calls++;
      if (mode === "abort") controller.abort();
      if (mode === "session")
        throw Object.assign(new Error("session invalid"), { code: "NIMI_SESSION_UNAVAILABLE" });
      if (mode === "retired-generation") retired = true;
      if (mode === "late-success") controller.abort();
      if (mode === "abort") throw new Error("image operation stopped");
      return `late text${config.systemPrompt.match(MARKER_RE)?.[0]}`;
    });
    const manager = createManager({
      consumeSelectionCapture: async () => ({
        status: "selected",
        text: "original",
        sessionId: "s1",
      }),
    });
    await assert.rejects(
      manager.processAgentCommand(
        "edit",
        "",
        "Agent",
        {
          signal: controller.signal,
          screenContext: { mediaType: "image/jpeg", data: "x" },
          selectionEditReachable: true,
        },
        () => retired
      ),
      { code: "SELECTION_EDIT_REASONING_FAILED" }
    );
    assert.equal(calls, 1, mode);
    assert.equal(manager.pendingSelectionEdit, undefined, mode);
  }
});

test("a non-voice-agent recording clears a stale screen capture", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-sc-stale-test-",
    settingsKey: "__scStaleSettings",
    reasoningKey: "__scStaleProcessText",
  });

  const manager = createManager();
  const stale = Promise.resolve({ mediaType: "image/jpeg", data: "stale" });

  manager.screenContextPromise = stale;
  manager.setVoiceAgentRequested(false);
  assert.equal(manager.screenContextPromise, null);
  assert.equal(await manager.consumeScreenContext(), null);

  // A capture left by a cancelled recording never rides into the next
  // voice-agent start either — begin() re-captures after the reset.
  manager.screenContextPromise = stale;
  manager.setVoiceAgentRequested(true);
  assert.equal(manager.screenContextPromise, null);

  // A fresh capture set after the start (as beginScreenContextCapture does)
  // is consumed normally.
  manager.screenContextPromise = Promise.resolve({ mediaType: "image/jpeg", data: "fresh" });
  assert.deepEqual(await manager.consumeScreenContext(), {
    mediaType: "image/jpeg",
    data: "fresh",
  });

  // Guards the dead-code removal in getEffectiveSttLanguage.
  manager.translationRequested = false;
  assert.equal(manager.getEffectiveSttLanguage({ preferredLanguage: "en" }), "en");
});
