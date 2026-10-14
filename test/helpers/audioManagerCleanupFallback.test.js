const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

test("safePaste reports not pasted when the preload reports that no text was pasted", async (t) => {
  const { createManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-audio-cleanup-paste-outcome-",
    settingsKey: "__audioCleanupPasteOutcomeSettings",
  });
  const manager = createManager({
    onError: () => assert.fail("a resolved no-op is not a paste error"),
  });
  window.electronAPI.pasteText = async () => ({ success: true, pasted: false });

  assert.deepEqual(await manager.safePaste("onboarding transcript"), {
    pasted: false,
  });
});

test("safePaste reports pasted only when the preload reports a completed paste", async (t) => {
  const { createManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-audio-cleanup-paste-success-",
    settingsKey: "__audioCleanupPasteSuccessSettings",
  });
  const manager = createManager({
    onError: () => assert.fail("a completed paste must not report an error"),
  });
  window.electronAPI.pasteText = async () => ({ success: true, pasted: true });

  assert.deepEqual(await manager.safePaste("completed transcript"), {
    pasted: true,
  });
});

// The hook tells a paste held back for still-held modifiers apart from an
// ordinary clipboard-only fallback by this reason, so it must survive safePaste.
test("safePaste passes through why a paste was held back", async (t) => {
  const { createManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-audio-cleanup-paste-held-",
    settingsKey: "__audioCleanupPasteHeldSettings",
  });
  const manager = createManager({
    onError: () => assert.fail("a held-back paste is not a paste error"),
  });
  window.electronAPI.pasteText = async () => ({
    success: true,
    pasted: false,
    reason: "modifiers-held",
  });

  assert.deepEqual(await manager.safePaste("held transcript"), {
    pasted: false,
    reason: "modifiers-held",
  });
});
