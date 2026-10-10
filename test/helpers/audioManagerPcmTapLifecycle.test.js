const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { installMicCaptureGlobals } = require("../lib/rendererTestHarness");

// The PCM tap must follow the batch recorder exactly: handed over at finalize,
// released on cancel, and carried onto a replacement microphone.

async function load(t) {
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-pcm-tap-lifecycle-test-",
    settingsKey: "__pcmTapLifecycleSettings",
  });
  return AudioManager;
}

const webm = () => new Blob([new Uint8Array(512)], { type: "audio/webm" });
const wav = () => new Blob([new Uint8Array(4)], { type: "audio/wav" });

function finalizingManager(AudioManager, tap) {
  let handoff = null;
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    isProcessing: false,
    _processingCancellationGeneration: 0,
    _streamingCancellationGeneration: 0,
    _streamingStopPromise: null,
    _activeTranscriptionAbortController: null,
    _batchSegments: [],
    _batchPcmTap: tap,
    _receivedAudioData: true,
    _localSpeechGateState: null,
    _streamingCommitActive: false,
    recordingMimeType: "audio/webm",
    recordingStartTime: Date.now(),
    lastAudioBlob: null,
    micRecovery: { stop() {} },
    teardownSpeechGate() {},
    cleanupPreview: async () => null,
    shouldShowPreviewCleanupState: () => false,
    mergeRecordedSegments: async () => webm(),
    getLargestRecordedSegment: () => null,
    processAudio: async (blob, metadata) => {
      handoff = { blob, metadata };
    },
    onStateChange() {},
    _requestStreamingCancellation() {},
  });
  return { manager, handoff: () => handoff };
}

test("finalize waits for the tap and hands its WAV over beside the WebM", async (t) => {
  const AudioManager = await load(t);
  const rawWav = wav();
  const { manager, handoff } = finalizingManager(AudioManager, { stop: async () => rawWav });

  await manager.finalizeBatchRecording(webm());

  assert.equal(handoff().blob.type, "audio/webm", "the WebM remains the recording of record");
  assert.strictEqual(handoff().metadata.rawWav, rawWav);
  assert.equal(manager._batchPcmTap, null);
});

test("a dropped tap leaves the WebM path exactly as before", async (t) => {
  const AudioManager = await load(t);
  const { manager, handoff } = finalizingManager(AudioManager, { stop: async () => null });

  await manager.finalizeBatchRecording(webm());

  assert.equal("rawWav" in handoff().metadata, false);
});

test("cancelling a recording releases the tap", async (t) => {
  const AudioManager = await load(t);
  let closes = 0;
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    _batchPcmTap: { close: () => (closes += 1) },
    teardownSpeechGate() {},
    cleanupPreview() {},
    onStateChange() {},
  });

  manager.resetDiscardedBatchRecordingState();

  assert.equal(closes, 1);
  assert.equal(manager._batchPcmTap, null);
});

test("a replacement microphone is bound into the same tap", async (t) => {
  const AudioManager = await load(t);
  const replacement = { id: "headset" };
  const rebound = [];
  const recorders = [];
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    mediaRecorder: { state: "inactive" },
    _silenceSource: null,
    _silenceCtx: null,
    _previewSource: null,
    _previewAudioContext: null,
    _batchPcmTap: { attach: (stream) => rebound.push(stream) },
    _cancelRequestedDuringMicRecovery: false,
    _stopRequestedDuringMicRecovery: false,
    createBatchRecorder: (stream) => recorders.push(stream),
  });

  await manager.replaceBatchMic(replacement);

  assert.deepEqual(rebound, [replacement]);
  assert.deepEqual(recorders, [replacement]);
});

async function loadWithSettings(t, settings, mockModules = {}) {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-pcm-tap-start-test-",
    settingsKey: "__pcmTapStartSettings",
    settings,
    mockModules,
  });
  installMicCaptureGlobals(t);
  return loaded;
}

const offlineLocal = {
  useLocalWhisper: true,
  localTranscriptionProvider: "nvidia",
  parakeetModel: "orukeet-v0.1.0",
  showTranscriptionPreview: false,
};

test("Nimi capture creates a PCM tap for the selected public transcription path", async (t) => {
  const { createManager } = await loadWithSettings(t, { preferredLanguage: "en" });
  const manager = createManager();
  const tap = manager._startPcmTap();
  assert.ok(tap);
  assert.match(manager.getWorkletBlobUrl(), /^blob:/);
  URL.revokeObjectURL(manager.workletBlobUrl);
  tap.close();
});

function startingManager(AudioManager, { prepared, tap, events }) {
  const stream = { getAudioTracks: () => [], getTracks: () => [] };
  return Object.assign(Object.create(AudioManager.prototype), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    _streamingStopPromise: null,
    mediaRecorder: null,
    _batchPcmTap: null,
    _batchSegments: [],
    audioChunks: [],
    preparedMicCapture: { take: async () => prepared },
    isRecordingAllowedByPolicy: () => true,
    getAudioConstraints: async () => ({ audio: true }),
    _acquireCaptureStream: async () => {
      events.push("acquire");
      return stream;
    },
    _startPcmTap: () => {
      events.push("tap");
      return tap;
    },
    createBatchRecorder: () => events.push("recorder"),
    beginMicRecovery: async () => {},
    onStateChange() {},
  });
}

const fakeTap = (events, name) => ({
  attach: () => events.push(`attach:${name}`),
  close: () => events.push(`close:${name}`),
});

test("a fresh pre-roll hands its tap to the recording", async (t) => {
  const { AudioManager } = await loadWithSettings(t, offlineLocal);
  const events = [];
  const preRollTap = fakeTap(events, "preroll");
  const prepared = {
    stream: { getAudioTracks: () => [], getTracks: () => [] },
    constraints: { audio: true },
    recorder: { state: "recording" },
    chunks: [],
    pcmTap: preRollTap,
    startedAt: Date.now(),
  };
  const manager = startingManager(AudioManager, { prepared, tap: null, events });
  t.after(() => manager.teardownSpeechGate());

  assert.equal(await manager.startRecording(), true);
  assert.strictEqual(manager._batchPcmTap, preRollTap);
  assert.deepEqual(events, ["recorder"], "no second tap is built and nothing is re-attached");
});

test("an expired pre-roll takes its tap with it and the WebM path runs", async (t) => {
  const { AudioManager, vite } = await loadWithSettings(t, offlineLocal);
  const { PRE_ROLL_MAX_AGE_MS } = await vite.ssrLoadModule("/helpers/preparedMicCapture.js");
  const events = [];
  const prepared = {
    stream: { getAudioTracks: () => [], getTracks: () => [] },
    constraints: { audio: true },
    recorder: { state: "recording", stop: () => events.push("recorder-stop") },
    chunks: ["stale"],
    pcmTap: fakeTap(events, "preroll"),
    startedAt: Date.now() - PRE_ROLL_MAX_AGE_MS - 1,
  };
  const manager = startingManager(AudioManager, { prepared, tap: null, events });
  t.after(() => manager.teardownSpeechGate());

  assert.equal(await manager.startRecording(), true);
  assert.equal(manager._batchPcmTap, null);
  assert.deepEqual(events, ["recorder-stop", "close:preroll", "recorder"]);
});

test("without a prepared capture the tap is built before the mic opens and attached with the recorder", async (t) => {
  const { AudioManager } = await loadWithSettings(t, offlineLocal);
  const events = [];
  const tap = fakeTap(events, "fresh");
  const manager = startingManager(AudioManager, { prepared: null, tap, events });
  t.after(() => manager.teardownSpeechGate());

  assert.equal(await manager.startRecording(), true);
  assert.strictEqual(manager._batchPcmTap, tap);
  assert.deepEqual(events, ["tap", "acquire", "recorder", "attach:fresh"]);
});

test("actual recording setup feeds finite preview through the existing protected Nimi command and retires its old tap", async (t) => {
  const calls = [];
  let reply;
  globalThis.__nimiPreviewPort = (command, input, signal) => {
    calls.push({ command, input, signal });
    return new Promise((resolve) => {
      reply = resolve;
    });
  };
  t.after(() => {
    delete globalThis.__nimiPreviewPort;
  });
  const { AudioManager } = await loadWithSettings(
    t,
    { showTranscriptionPreview: true, preferredLanguage: "zh" },
    {
      "/services/nimiClient":
        "export const runNimiRequest = (...args) => globalThis.__nimiPreviewPort(...args);",
    }
  );
  const events = [];
  const tap = { ...fakeTap(events, "preview"), capturedPcm: () => [] };
  const manager = startingManager(AudioManager, { prepared: null, tap, events });
  manager.getEffectiveSttLanguage = () => "zh";
  const texts = [];
  manager.onPartialTranscript = (text) => texts.push(text);
  t.after(() => manager.teardownSpeechGate());
  assert.equal(await manager.startRecording(), true);
  tap.onPcm(new Int16Array(32000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0].command, "openwhispr.ai.transcribe");
  assert.equal(calls[0].input.language, "zh");
  assert.equal(calls[0].input.mimeType, "audio/wav");
  manager.cleanupPreview({ dismiss: true });
  assert.equal(calls[0].signal.aborted, true);
  reply({ transcript: { text: "ignored late fixture" } });
  await new Promise((resolve) => setImmediate(resolve));
  tap.onPcm(new Int16Array(32000));
  assert.equal(calls.length, 1);
  assert.deepEqual(texts, []);
});

test("renderer disposal cancels in-flight work and discards capture instead of starting a final AI request", async (t) => {
  const { createManager } = await loadWithSettings(t, {});
  const controller = new AbortController();
  let canceled = 0;
  const manager = createManager({
    _processingCancellationGeneration: 0,
    _activeProcessingPipeline: { controller },
    _nimiPreview: { close() {} },
    micRecovery: { stop() {} },
    preparedMicCapture: { cancel() {} },
    micStreamHold: { drop() {} },
    _closeBatchPcmTap() {},
    mediaRecorder: { state: "recording" },
    cancelRecording: () => {
      canceled++;
    },
    stopRecording: () => {
      assert.fail("must not launch final decoding on disposal");
    },
    getStreamingProvider: () => ({}),
  });
  manager.cleanup();
  assert.equal(controller.signal.aborted, true);
  assert.equal(canceled, 1);
  assert.equal(manager._processingCancellationGeneration, 1);
});


test("preview auto and Chinese UI language values match final transcription inputs", async t => {
  const calls = []; globalThis.__nimiPreviewPort = async (command, input) => { calls.push({ command, input }); return { transcript: { text: "declared fixture" } }; };
  t.after(() => { delete globalThis.__nimiPreviewPort; });
  const { AudioManager, setSettings } = await loadWithSettings(t, { showTranscriptionPreview: true }, { "/services/nimiClient": "export const runNimiRequest = (...args) => globalThis.__nimiPreviewPort(...args);" });
  for (const [selected, expected] of [["auto", ""], ["zh-CN", "zh"], ["zh-TW", "zh"]]) {
    setSettings({ showTranscriptionPreview: true }); const events = []; const tap = { ...fakeTap(events, selected), capturedPcm: () => [] };
    const manager = startingManager(AudioManager, { prepared: null, tap, events }); manager.getEffectiveSttLanguage = () => selected;
    await manager.startRecording(); tap.onPcm(new Int16Array(32000)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.at(-1).input.language, expected); manager.cleanupPreview({ dismiss: true }); manager.teardownSpeechGate();
  }
});
test("preview error clears its old draft and reports nonfatal retirement while capture continues", async t => {
  globalThis.__nimiPreviewPort = async () => { throw new Error("declared-platform-failure"); }; t.after(() => { delete globalThis.__nimiPreviewPort; });
  const { AudioManager, window } = await loadWithSettings(t, { showTranscriptionPreview: true }, { "/services/nimiClient": "export const runNimiRequest = (...args) => globalThis.__nimiPreviewPort(...args);" });
  const events = []; const tap = { ...fakeTap(events, "error"), capturedPcm: () => [] }; const manager = startingManager(AudioManager, { prepared: null, tap, events });
  manager.getEffectiveSttLanguage = () => "auto"; let notice = 0, hidden = 0; manager.onPreviewUnavailable = () => { notice++; }; window.electronAPI.hideDictationPreview = () => { hidden++; };
  await manager.startRecording(); tap.onPcm(new Int16Array(32000)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.isRecording, true); assert.equal(manager._nimiPreview.closed, true); assert.equal(notice, 1); assert.equal(hidden, 1);
  tap.onPcm(new Int16Array(32000)); assert.equal(notice, 1); manager.teardownSpeechGate();
});
