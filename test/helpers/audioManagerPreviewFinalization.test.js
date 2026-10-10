const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

test("finite preview retirement preserves the complete final recording and actual PCM copy", async (t) => {
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "nimi-preview-finalization-",
    settingsKey: "__nimiPreviewSettings",
    settings: { preferredLanguage: "en" },
  });
  const bytes = Uint8Array.from({ length: 4096 }, (_, index) => index % 251);
  const recording = new Blob([bytes], { type: "audio/webm" });
  const wav = new Blob([bytes], { type: "audio/wav" });
  const calls = [];
  window.electronAPI.stopDictationPreview = async () => {
    calls.push("native-preview-stop");
    return { success: true, streamed: false, text: "" };
  };
  const manager = createManager({
    micRecovery: { stop() {} },
    teardownSpeechGate() {},
    _batchSegments: [],
    _receivedAudioData: true,
    recordingStartTime: Date.now() - 2000,
    _batchPcmTap: { stop: async () => wav },
    _nimiPreview: {
      close: () => {
        calls.push("cancel-preview-job");
      },
    },
    _startProcessingPipeline: () => ({}),
    _shouldAbandonProcessingPipeline: () => false,
    shouldShowPreviewCleanupState: () => false,
    async processAudio(blob, metadata) {
      calls.push("full-final-input");
      assert.equal(blob, recording);
      assert.equal(metadata.rawWav, wav);
      assert.equal(metadata.streamedText, undefined);
      assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
    },
  });
  await manager.finalizeBatchRecording(recording);
  assert.deepEqual(calls, ["cancel-preview-job", "native-preview-stop", "full-final-input"]);
  assert.equal(manager._nimiPreview, null);
  assert.equal(manager.lastAudioBlob, recording);
});
