const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { deferred } = require("./harness/deferred");

async function loadManagerClass(t) {
  const { AudioManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-cancel-lifecycle-test-",
    settingsKey: "__cancelLifecycleSettings",
    settings: {
      preferredLanguage: "en",
      customDictionary: [],
      customPrompts: {},
    },
    mockModules: {
      "/services/nimiRecording":
        "export const transcribeNimiRecording = (...args) => globalThis.__nimiCancelTranscription(...args);",
    },
  });
  t.after(() => delete globalThis.__nimiCancelTranscription);
  return { AudioManager, window };
}

const response = (text) => ({
  transcript: { status: "transcribed", text, language: "en", words: [] },
  chunks: [],
});

function createManager(AudioManager, transcription) {
  globalThis.__nimiCancelTranscription = () =>
    transcription.promise.then((result) => response(result.text));
  const calls = { errors: 0, saved: 0, noAudio: 0, completed: 0, states: [] };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isProcessing: true,
    _localSpeechGateState: null,
    _processingCancellationGeneration: 0,
    _streamingStopPromise: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    lastAudioBlob: {},
    processTranscriptionWithNimi: async (text) => text,
    onStateChange: (state) => calls.states.push(state.isProcessing ? "processing" : "idle"),
    onNoAudio: () => calls.noAudio++,
    onError: () => calls.errors++,
    onTranscriptionComplete: () => calls.completed++,
    saveFailedTranscription: () => calls.saved++,
  });
  // The real implementation also aborts ReasoningService/IPC work; the test
  // only needs the generation bump that marks the pipeline cancelled.
  manager._requestStreamingCancellation = () => {
    manager._streamingCancellationGeneration += 1;
  };
  return { manager, calls };
}

function createBatchFinalizationManager(AudioManager, merge) {
  let processAudioCalls = 0;
  let processAudioMetadata = null;
  const mergedBlob = new Blob([new Uint8Array(512)], { type: "audio/webm" });
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    isProcessing: false,
    _processingCancellationGeneration: 0,
    _streamingCancellationGeneration: 0,
    _streamingStopPromise: null,
    _activeTranscriptionAbortController: null,
    _batchSegments: [],
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
    mergeRecordedSegments: () => merge.promise,
    getLargestRecordedSegment: () => null,
    processAudio: async (_audioBlob, metadata) => {
      processAudioCalls += 1;
      processAudioMetadata = metadata;
    },
    onStateChange() {},
  });
  manager._requestStreamingCancellation = () => {
    manager._streamingCancellationGeneration += 1;
  };
  return {
    manager,
    mergedBlob,
    getProcessAudioCalls: () => processAudioCalls,
    getProcessAudioMetadata: () => processAudioMetadata,
  };
}

test("batch finalization keeps the recording occurrence time", async (t) => {
  const { AudioManager } = await loadManagerClass(t);
  const merge = deferred();
  const recordingStartedAt = Date.parse("2026-09-02T14:00:00.000Z");
  const { manager, mergedBlob, getProcessAudioMetadata } = createBatchFinalizationManager(
    AudioManager,
    merge
  );
  manager.recordingStartTime = recordingStartedAt;

  const finalization = manager.finalizeBatchRecording(mergedBlob);
  merge.resolve(mergedBlob);
  await finalization;

  assert.equal(
    getProcessAudioMetadata().analyticsOccurredAt,
    new Date(recordingStartedAt).toISOString()
  );
});

test("cancelling while batch segments merge never starts transcription", async (t) => {
  const { AudioManager } = await loadManagerClass(t);
  const merge = deferred();
  const { manager, mergedBlob, getProcessAudioCalls } = createBatchFinalizationManager(
    AudioManager,
    merge
  );

  const finalization = manager.finalizeBatchRecording(mergedBlob);
  assert.equal(manager.isProcessing, true);
  assert.equal(manager.cancelProcessing(), true);
  merge.resolve(mergedBlob);
  await finalization;

  assert.equal(getProcessAudioCalls(), 0);
  assert.equal(manager.lastAudioBlob, null);
});

test("a cancelled older pipeline cannot publish or clear a newer pipeline", async (t) => {
  const { AudioManager } = await loadManagerClass(t);
  const firstTranscription = deferred();
  const secondTranscription = deferred();
  const completed = [];
  const firstBlob = new Blob(["first"], { type: "audio/webm" });
  const secondBlob = new Blob(["second"], { type: "audio/webm" });
  const { manager } = createManager(AudioManager, firstTranscription);
  globalThis.__nimiCancelTranscription = (audioBlob) =>
    (audioBlob === firstBlob ? firstTranscription.promise : secondTranscription.promise).then(
      (result) => response(result.text)
    );
  manager.onTranscriptionComplete = (result) => completed.push(result.text);

  const firstRun = manager.processAudio(firstBlob);
  assert.equal(manager.cancelProcessing(), true);

  manager.isProcessing = true;
  const secondRun = manager.processAudio(secondBlob);
  firstTranscription.resolve({ success: true, text: "old", source: "local", timings: {} });
  await firstRun;

  assert.equal(manager.isProcessing, true, "the old pipeline must not clear the new busy state");
  assert.deepEqual(completed, [], "the old pipeline must not publish after cancellation");

  secondTranscription.resolve({ success: true, text: "new", source: "local", timings: {} });
  await secondRun;

  assert.equal(manager.isProcessing, false);
  assert.deepEqual(completed, ["new"]);
});

test("batch processing carries its occurrence time into completion", async (t) => {
  const { AudioManager } = await loadManagerClass(t);
  const transcription = deferred();
  const { manager } = createManager(AudioManager, transcription);
  const analyticsOccurredAt = "2026-09-02T14:00:00.000Z";
  let completion;
  manager.onTranscriptionComplete = (result) => {
    completion = result;
  };

  const processing = manager.processAudio(new Blob(["audio"]), { analyticsOccurredAt });
  transcription.resolve({ success: true, text: "same event", source: "local", timings: {} });
  await processing;

  assert.equal(completion.analyticsOccurredAt, analyticsOccurredAt);
});

test("a cancelled foreground pipeline releases its UI and cannot publish late Nimi output", async (t) => {
  const { AudioManager } = await loadManagerClass(t);
  const transcription = deferred();
  const { manager, calls } = createManager(AudioManager, transcription);

  const run = manager.processAudio(new Blob(["audio"], { type: "audio/webm" }));
  assert.equal(manager.cancelProcessing(), true);
  assert.equal(
    manager.isProcessing,
    false,
    "foreground cancellation releases the local view without claiming the remote model stopped"
  );

  transcription.resolve({ success: true, text: "stale", source: "local", timings: {} });
  await run;

  assert.equal(manager.isProcessing, false);
  assert.deepEqual(calls.states, ["idle"]);
  assert.equal(calls.completed, 0);
});

test("a user cancel during batch transcription is not an error and saves nothing", async (t) => {
  const { AudioManager } = await loadManagerClass(t);
  const transcription = deferred();
  const { manager, calls } = createManager(AudioManager, transcription);

  const run = manager.processAudio(new Blob(["audio"], { type: "audio/webm" }), {});
  assert.equal(manager.cancelProcessing(), true);
  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  // The aborted request rejects after the cancel landed.
  const rejection = Promise.reject(abort);
  rejection.catch(() => {});
  transcription.resolve(rejection);
  await run;

  assert.equal(calls.errors, 0, "cancel must not surface a Transcription Error");
  assert.equal(calls.saved, 0, "cancel must not write a failed-transcription row");
  assert.equal(calls.completed, 0);
  assert.deepEqual(calls.states, ["idle"]);
});

test("a directive banked after the pipeline was cancelled is dropped", async (t) => {
  const { AudioManager } = await loadManagerClass(t);
  const { manager } = createManager(AudioManager, deferred());
  manager.cancelProcessing();
  manager._bankAssistantDirective("late command", {}, null);
  assert.equal(manager.pendingAssistantConversation, null);
});

// Round-2 review finding: finalizeBatchRecording's earlier cleanupPreview()
// call (without dismiss:true) routes through the main process's
// stop-dictation-preview handler, which — whenever the live-preview toggle
// left a session active — calls windowManager.holdTranscriptionPreview(),
// NOT hideTranscriptionPreview(). That sends "preview-hold", which
// useLiveTranscriptPanel.js handles by deliberately keeping the panel open
// (phase "cleanup"/"final") so the user can see the settled text. Before this
// task, onError's unconditional hideDictationPreview() call was what closed
// that held panel on a failure. The cancel guard in processAudio's catch
// means onError never fires for a cancel, so without a dedicated teardown on
// the cancel path itself, a cancel during batch processing leaves the held
// panel on screen indefinitely. cancelProcessing() must dismiss it directly.
test("a cancel during batch processing dismisses the held live-transcript panel", async (t) => {
  const { AudioManager, window } = await loadManagerClass(t);
  const { manager } = createManager(AudioManager, deferred());
  const dismissCalls = [];
  window.electronAPI.dismissDictationPreview = () => {
    dismissCalls.push(true);
    return Promise.resolve({ success: true });
  };
  // hideDictationPreview must NOT be what this fix relies on — onError,
  // which used to own that call, no longer runs for a cancel at all.
  const hideCalls = [];
  window.electronAPI.hideDictationPreview = () => {
    hideCalls.push(true);
    return Promise.resolve({ success: true });
  };

  assert.equal(manager.cancelProcessing(), true);

  assert.equal(
    dismissCalls.length,
    1,
    "a cancel must dismiss the held preview panel, not leave it open"
  );
  assert.equal(hideCalls.length, 0, "the fix must not depend on onError's hideDictationPreview");
});

test("cancelling when nothing is processing dismisses nothing", async (t) => {
  const { AudioManager, window } = await loadManagerClass(t);
  const { manager } = createManager(AudioManager, deferred());
  manager.isProcessing = false;
  const dismissCalls = [];
  window.electronAPI.dismissDictationPreview = () => {
    dismissCalls.push(true);
    return Promise.resolve({ success: true });
  };

  assert.equal(manager.cancelProcessing(), false);
  assert.equal(dismissCalls.length, 0);
});

test("an earlier cancellation cannot hide a later Nimi cleanup failure", async (t) => {
  const { AudioManager } = await loadManagerClass(t);
  const transcription = deferred();
  const { manager, calls } = createManager(AudioManager, transcription);
  manager._processingCancellationGeneration = 1;
  manager.processTranscriptionWithNimi = async () => {
    throw new Error("declared cleanup failure");
  };
  const work = manager.processAudio(new Blob(["new source"]));
  transcription.resolve({ text: "actual fixture recognition" });
  await work;
  assert.equal(calls.errors, 1);
  assert.equal(calls.saved, 1);
  assert.equal(calls.completed, 0);
});

test("a canceled Nimi voice-agent continuation cannot publish or save its later failure", async (t) => {
  const { AudioManager } = await loadManagerClass(t);
  const transcription = deferred(),
    agent = deferred();
  const { manager, calls } = createManager(AudioManager, transcription);
  let entered = false;
  delete manager.processTranscriptionWithNimi;
  manager.voiceAgentRequested = true;
  manager.consumeScreenContext = async () => null;
  manager.processAgentCommand = () => {
    entered = true;
    return agent.promise;
  };
  const work = manager.processAudio(new Blob(["voice instruction"]));
  transcription.resolve({ text: "declared agent command" });
  while (!entered) await new Promise(setImmediate);
  manager.cancelProcessing();
  agent.resolve(Promise.reject(new Error("declared late agent failure")));
  await work;
  assert.equal(calls.errors, 0);
  assert.equal(calls.saved, 0);
  assert.equal(calls.completed, 0);
});

test("an unconfirmed Nimi cancellation remains visible after the foreground view stops", async (t) => {
  const { AudioManager } = await loadManagerClass(t);
  const transcription = deferred();
  const { manager, calls } = createManager(AudioManager, transcription);
  const work = manager.processAudio(new Blob(["source"]));
  manager.cancelProcessing();
  transcription.resolve(
    Promise.reject(
      Object.assign(new Error("Stop unconfirmed"), {
        audioCancellationFailed: true,
        code: "NIMI_AUDIO_CANCEL_UNCONFIRMED",
      })
    )
  );
  await work;
  assert.equal(calls.errors, 1);
  assert.equal(calls.saved, 0);
  assert.equal(calls.completed, 0);
});

test("a late refused Cancel keeps the old action identity and cannot settle a newer pipeline", async (t) => {
  const { AudioManager } = await loadManagerClass(t);
  const first = deferred(),
    second = deferred();
  const { manager } = createManager(AudioManager, first);
  const oldBlob = new Blob(["old"]),
    newBlob = new Blob(["new"]);
  const notices = [],
    completions = [];
  globalThis.__nimiCancelTranscription = (blob) =>
    (blob === oldBlob ? first.promise : second.promise).then((result) => response(result.text));
  manager.onError = (error) => notices.push(error);
  manager.onTranscriptionComplete = (result) => completions.push(result.text);
  const oldWork = manager.processAudio(oldBlob);
  manager.cancelProcessing();
  manager.isProcessing = true;
  const newWork = manager.processAudio(newBlob);
  first.resolve(
    Promise.reject(
      Object.assign(new Error("Old Cancel refused"), {
        audioCancellationFailed: true,
        code: "host-internal-error",
        reasonCode: "CANCEL_REFUSED",
        details: { jobId: "old-job", clientSubmissionId: "old-action" },
      })
    )
  );
  await oldWork;
  assert.equal(manager.isProcessing, true);
  assert.deepEqual(completions, []);
  assert.equal(notices[0].audioCancellationFailed, true);
  assert.equal(notices[0].jobId, "old-job");
  assert.equal(notices[0].clientSubmissionId, "old-action");
  assert.equal(notices[0].reasonCode, "CANCEL_REFUSED");
  second.resolve({ text: "new result" });
  await newWork;
  assert.deepEqual(completions, ["new result"]);
});
