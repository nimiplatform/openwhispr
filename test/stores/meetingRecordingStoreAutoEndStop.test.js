const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// `stopped` is true only when this call ended a live recording. It must not be
// conditioned on Main's processing result. Main owns the structured result and
// media transaction; the renderer reports its outcome separately from capture.

const START_ARGS = {
  noteId: 11,
  noteTitle: "Standup",
  folderId: null,
  autoEndEligible: true,
};

function createElectronAPI({ stopResult }) {
  const noopListener = () => () => {};
  const notes = new Map([[11, { id: 11, transcript: "", deleted_at: null }]]);
  return {
    notes,
    api: {
      checkSystemAudioAccess: async () => ({
        granted: true,
        status: "granted",
        mode: "native",
        strategy: "native",
      }),
      meetingTranscriptionStart: async () => ({
        success: true,
        systemAudioMode: "native",
        systemAudioStrategy: "native",
      }),
      meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
      meetingTranscriptionStop: async () => stopResult(),
      meetingTranscriptionSend: () => {},
      getNote: async (id) => notes.get(id) ?? null,
      updateNote: async () => ({ success: true }),
      onMeetingTranscriptionSegment: noopListener,
      onMeetingSpeakerIdentified: noopListener,
      onMeetingSpeakersMerged: noopListener,
      onMeetingSessionSpeakerConfigUpdated: noopListener,
      onMeetingTranscriptionError: noopListener,
      onMeetingTranscriptionFatalError: noopListener,
      onMeetingSystemAudioSilent: noopListener,
      onMeetingDiarizationComplete: noopListener,
    },
  };
}

async function loadStore(t, api, customDictionary, readiness) {
  globalThis.__meetingStartReadiness = readiness;
  t.after(() => {
    delete globalThis.__meetingStartReadiness;
  });
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  const vite = await createRendererServer(t, {
    // Session readiness is tested separately; these fixtures isolate capture.
    mockModules: {
      "/services/nimiClient":
        "export async function prepareNimiAIWork(signal) { signal?.throwIfAborted(); await globalThis.__meetingStartReadiness?.(signal); signal?.throwIfAborted(); }",
    },
    cachePrefix: "openwhispr-meeting-auto-end-stop-test-",
  });
  if (customDictionary) {
    const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
    settings.useSettingsStore.setState({ customDictionary });
  }
  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

test("original meeting start passes real dictionary intent and refuses its oversized UTF-8 form before main capture", async (t) => {
  const { api } = createElectronAPI({ stopResult: () => ({ success: true }) });
  const requests = [];
  const start = api.meetingTranscriptionStart;
  api.meetingTranscriptionStart = async (options) => {
    requests.push(options);
    return start(options);
  };
  const store = await loadStore(t, api, ["Nimi", "会议专名"]);
  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(requests[0].prompt, "Nimi, 会议专名");
  await store.stopRecording();
  const oversized = await loadStore(t, api, ["字".repeat(1400)]);
  const count = requests.length;
  // This existing API reports whether the UI request was accepted; actual
  // capture/model state and its reported error distinguish setup failure.
  await oversized.startRecording(START_ARGS);
  assert.equal(oversized.useMeetingRecordingStore.getState().isRecording, false);
  assert.ok(oversized.useMeetingRecordingStore.getState().error);
  assert.equal(requests.length, count);
});

for (const hasPriorSegments of [false, true]) {
  test(`Main's structured tail survives Stop with prior segments=${hasPriorSegments}`, async (t) => {
    let entered, release;
    const waiting = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const raw = {
      status: "transcribed",
      text: "declared late fixture",
      language: "en",
      words: [{ text: "declared late fixture", startSeconds: 0.1, endSeconds: 0.5 }],
      diarization: {
        status: "diarized",
        durationSeconds: 10,
        intervals: [{ speakerId: "fixture-voice", startSeconds: 0, endSeconds: 1 }],
      },
    };
    const late = {
      id: "current-fixture:system:240000:0",
      text: raw.text,
      source: "system",
      timestamp: 1736100,
      endTimestamp: 1736500,
      clockBasis: "capture",
      recognition: {
        transcript: raw,
        source: "system",
        startFrame: 240000,
        endFrame: 480000,
        sampleRate: 24000,
        anchorMs: 1726000,
        clockBasis: "capture",
      },
    };
    const prior = hasPriorSegments
      ? [{ ...late, id: "earlier-fixture:system:0:0", text: "earlier fixture" }]
      : [];
    const { api, notes } = createElectronAPI({
      stopResult: async () => {
        entered();
        await gate;
        // This boundary fixture performs Main's already-covered structured commit.
        notes.get(11).transcript = JSON.stringify([...prior, late]);
        return { success: true, transcript: raw.text, segments: [late] };
      },
    });
    notes.get(11).transcript = prior.length ? JSON.stringify(prior) : "";
    const rendererWrites = [];
    api.updateNote = async (_id, patch) => {
      rendererWrites.push(patch);
      Object.assign(notes.get(11), patch);
      return { success: true };
    };
    const store = await loadStore(t, api);
    await store.startRecording({ ...START_ARGS, seedSegments: prior });
    const pending = store.stopRecording();
    await waiting;
    assert.equal(store.useMeetingRecordingStore.getState().isFinalizing, true);
    release();
    await pending;
    assert.deepEqual(rendererWrites, [], "a reading projection must not overwrite Main's commit");
    const saved = JSON.parse(notes.get(11).transcript);
    assert.deepEqual(saved, [...prior, late]);
    assert.deepEqual(saved.at(-1).recognition.transcript, raw);
    assert.equal(store.useMeetingRecordingStore.getState().segments.length, prior.length + 1);
    assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: saved }), true);
    await store.stopRecording();
  });
}

test("a completed stop reports that it ended the recording", async (t) => {
  const { api } = createElectronAPI({ stopResult: () => ({ success: true }) });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  const result = await store.stopRecording();

  assert.equal(result.stopped, true);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
});

// The note header's timer derives its elapsed seconds from this stamp instead of
// counting ticks, so a note switch (which remounts the editor) keeps the real
// duration rather than restarting at 00:00.
test("capture closes before deferred final processing and only a saved result ends that phase", async (t) => {
  let resolveStop, entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const { api } = createElectronAPI({
    stopResult: () => {
      entered();
      return new Promise((resolve) => {
        resolveStop = resolve;
      });
    },
  });
  const store = await loadStore(t, api);
  const stream = await navigator.mediaDevices.getUserMedia();
  let stops = 0;
  stream.getTracks()[0].stop = () => {
    stops++;
  };
  await store.startRecording(START_ARGS);
  const pending = store.stopRecording();
  await waiting;
  const processing = store.useMeetingRecordingStore.getState();
  assert.equal(processing.isRecording, false);
  assert.equal(processing.isFinalizing, true);
  assert.equal(processing.micCaptureStatus, "inactive");
  assert.equal(store.getMicAnalyser(), null);
  assert.ok(stops > 0);
  assert.equal(processing.finalizationOutcome, null);
  resolveStop({ success: true });
  await pending;
  assert.equal(store.useMeetingRecordingStore.getState().isFinalizing, false);
  assert.equal(store.useMeetingRecordingStore.getState().finalizationOutcome, "saved");
});

test("finalization cancellation is scoped, fences writes immediately and retains its terminal outcome", async (t) => {
  let resolveStop, entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const { api } = createElectronAPI({
    stopResult: () => {
      entered();
      return new Promise((resolve) => {
        resolveStop = resolve;
      });
    },
  });
  let startedSession,
    store,
    calls = 0;
  const start = api.meetingTranscriptionStart;
  api.meetingTranscriptionStart = async (options) => {
    startedSession = options.sessionId;
    return start(options);
  };
  api.meetingTranscriptionCancel = async (sessionId) => {
    assert.equal(sessionId, startedSession);
    assert.equal(store.useMeetingRecordingStore.getState().isCancelingFinalization, true);
    calls++;
    resolveStop({ success: false, reason: "canceled", mediaRetained: true });
    return { success: true, reason: "canceled" };
  };
  store = await loadStore(t, api);
  await store.startRecording(START_ARGS);
  const pending = store.stopRecording();
  await waiting;
  await Promise.all([store.cancelMeetingFinalization(), store.cancelMeetingFinalization()]);
  await pending;
  assert.equal(calls, 1);
  const final = store.useMeetingRecordingStore.getState();
  assert.equal(final.isFinalizing, false);
  assert.equal(final.isCancelingFinalization, false);
  assert.equal(final.finalizationOutcome, "canceled");
  assert.equal(final.error, null);
});

test("cancellation save failure stays visible after stop clears its session", async (t) => {
  let resolveStop, entered, pending;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const failure = "declared cancellation persistence failure";
  const { api } = createElectronAPI({
    stopResult: () => {
      entered();
      return new Promise((resolve) => {
        resolveStop = resolve;
      });
    },
  });
  api.meetingTranscriptionCancel = async () => {
    resolveStop({ success: false, error: failure });
    await pending;
    return { success: false, error: failure };
  };
  const store = await loadStore(t, api);
  await store.startRecording(START_ARGS);
  pending = store.stopRecording();
  await waiting;
  await store.cancelMeetingFinalization();
  await pending;
  const state = store.useMeetingRecordingStore.getState();
  assert.equal(state.isFinalizing, false);
  assert.equal(state.error, failure);
  assert.equal(state.finalizationOutcome, null);
});

test("an old cancellation reply cannot overwrite a newly admitted recording", async (t) => {
  let resolveStop,
    resolveCancel,
    entered,
    stops = 0;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const { api } = createElectronAPI({
    stopResult: () => {
      if (++stops > 1) return { success: true };
      entered();
      return new Promise((resolve) => {
        resolveStop = resolve;
      });
    },
  });
  api.meetingTranscriptionCancel = () =>
    new Promise((resolve) => {
      resolveCancel = resolve;
    });
  const store = await loadStore(t, api);
  await store.startRecording(START_ARGS);
  const pending = store.stopRecording();
  await waiting;
  const canceled = store.cancelMeetingFinalization();
  resolveStop({ success: false, reason: "canceled", mediaRetained: true });
  await pending;
  await store.startRecording(START_ARGS);
  resolveCancel({ success: false, error: "late old cancellation error" });
  await canceled;
  assert.equal(store.useMeetingRecordingStore.getState().error, null);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);
  await store.stopRecording();
});

test("a session stamps its start time and clears it on stop", async (t) => {
  const { api } = createElectronAPI({ stopResult: () => ({ success: true }) });
  const store = await loadStore(t, api);
  const beforeStart = Date.now();

  assert.equal(await store.startRecording(START_ARGS), true);
  const startedAt = store.useMeetingRecordingStore.getState().recordingStartedAt;
  assert.equal(typeof startedAt, "number");
  assert.ok(startedAt >= beforeStart, "the stamp is the moment recording began");

  await store.stopRecording();

  assert.equal(store.useMeetingRecordingStore.getState().recordingStartedAt, null);
});

// The renderer has already run cleanup and written the transcript by the time
// main's result is read, so a teardown failure must not be reported as a
// recording that never stopped.
test("a stop whose main-side teardown fails still reports the recording ended", async (t) => {
  const { api } = createElectronAPI({
    stopResult: () => ({ success: false, error: "audio tap teardown failed" }),
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  const result = await store.stopRecording();

  assert.equal(result.stopped, true);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
});

test("a stop main already dropped as stale still reports the recording ended", async (t) => {
  const { api } = createElectronAPI({
    stopResult: () => ({ success: false, reason: "stale-session" }),
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal((await store.stopRecording()).stopped, true);
});

test("a stop that rejects still reports the recording ended", async (t) => {
  const { api } = createElectronAPI({
    stopResult: () => {
      throw new Error("ipc channel closed");
    },
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal((await store.stopRecording()).stopped, true);
});

test("stopping when nothing is recording reports no stop happened", async (t) => {
  const { api } = createElectronAPI({ stopResult: () => ({ success: true }) });
  const store = await loadStore(t, api);

  assert.equal((await store.stopRecording()).stopped, false);
});

test("a scoped stop for another session reports no stop happened", async (t) => {
  const { api } = createElectronAPI({ stopResult: () => ({ success: true }) });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  const result = await store.stopRecording("some-other-session");

  assert.equal(result.stopped, false);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);
  await store.stopRecording();
});

test("failed readiness opens no meeting capture and a new explicit start can recover", async (t) => {
  const { api } = createElectronAPI({ stopResult: () => ({ success: true }) });
  let calls = 0,
    attempts = 0;
  const start = api.meetingTranscriptionStart;
  api.meetingTranscriptionStart = async (options) => {
    calls++;
    return start(options);
  };
  const store = await loadStore(t, api, undefined, async () => {
    if (++attempts === 1)
      throw Object.assign(new Error("runtime-service-unavailable"), {
        code: "NIMI_SESSION_UNAVAILABLE",
      });
  });
  await store.startRecording(START_ARGS);
  assert.equal(calls, 0);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
  assert.match(store.useMeetingRecordingStore.getState().error, /runtime-service-unavailable/);
  await store.startRecording(START_ARGS);
  assert.equal(calls, 1);
  await store.stopRecording();
});

test("stop during readiness aborts it without later microphone or main capture", async (t) => {
  const { api } = createElectronAPI({ stopResult: () => ({ success: true }) });
  let entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  let mainCalls = 0,
    micCalls = 0;
  api.meetingTranscriptionStart = async () => {
    mainCalls++;
    return { success: true };
  };
  const store = await loadStore(
    t,
    api,
    undefined,
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        entered();
      })
  );
  navigator.mediaDevices.getUserMedia = async () => {
    micCalls++;
    throw new Error("must not capture");
  };
  const pending = store.startRecording(START_ARGS);
  await waiting;
  await store.stopRecording();
  await pending;
  assert.equal(mainCalls, 0);
  assert.equal(micCalls, 0);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
  assert.equal(store.useMeetingRecordingStore.getState().error, null);
});
