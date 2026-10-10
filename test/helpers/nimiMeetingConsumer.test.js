const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  Module = require("node:module");
const { EventEmitter } = require("node:events");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimi-meeting-consumer-"));
const handlers = new Map(),
  listeners = new Map(),
  sent = [];
let failMediaNotification = false;
const owner = Object.assign(new EventEmitter(), {
  id: 7,
  isDestroyed: () => false,
  send: (name, payload) => {
    if (
      failMediaNotification &&
      name === "note-updated" &&
      payload.source_media?.recordings?.at(-1)?.sessionId === "meeting-notify-once"
    ) {
      failMediaNotification = false;
      throw new Error("declared single notification failure");
    }
    sent.push({ name, payload });
  },
});
const win = { isDestroyed: () => false, webContents: owner };
const originalLoad = Module._load;
const app = {
  getPath: () => root,
  getAppPath: () => process.cwd(),
  getName: () => "test",
  getVersion: () => "test",
  isReady: () => false,
  isPackaged: false,
  on() {},
  requestSingleInstanceLock: () => true,
};
const stubElectron = {
  app,
  ipcMain: {
    handle: (name, fn) => handlers.set(name, fn),
    on: (name, fn) => listeners.set(name, fn),
    removeHandler() {},
  },
  BrowserWindow: { fromWebContents: () => win, getAllWindows: () => [win] },
  net: {
    fetch() {
      assert.fail("retired direct AI HTTP path");
    },
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: {} }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};
Module._load = function (request, parent, isMain) {
  if (request === "electron") return stubElectron;
  if (request === "./debugLogger") return new Proxy({}, { get: () => () => {} });
  if (request === "./tokenStore")
    return {
      getState: () => ({ token: null, generation: 0 }),
      getGeneration: () => 0,
      subscribe() {},
    };
  return originalLoad.call(this, request, parent, isMain);
};
const Database = require("../../src/helpers/database"),
  ai = require("../../src/helpers/nimiAI"),
  IPC = require("../../src/helpers/ipcHandlers");
process.env.NODE_ENV = "test";
function anything() {
  return new Proxy(function () {}, {
    get(_t, key) {
      if (key === "then") return undefined;
      if (key === Symbol.toPrimitive) return () => "";
      return anything();
    },
    apply() {
      return anything();
    },
  });
}
const database = new Database();
// This suite exercises one business guest; a named account without a bearer
// is correctly refused by the actual workspace policy owner.
database.setActiveAccountId(null);
const note = database.saveNote("Actual consumer test", "", "meeting").note;

test("retired App inference and renderer vector-write entrances are absent from the original IPC registry", () => {
  for (const name of [
    "diarize-audio-file",
    "download-diarization-models",
    "get-diarization-model-status",
    "merge-speaker-text",
    "save-note-speaker-embeddings",
  ])
    assert.equal(handlers.has(name), false, name);
});

test("original manual naming consumes only that note's persisted voice, with a text-only label allowed", () => {
  const owner = Object.assign(Object.create(IPC.prototype), {
    databaseManager: database,
    _retroactiveMapping() {},
  });
  const other = database.saveNote("Text-only historical note", "", "meeting").note;
  const currentId = "current-generation:speaker_0";
  const before = database.getSpeakerProfiles(true).length;
  assert.equal(
    owner._setSpeakerMapping(other.id, currentId, "Text-only name", null, null).success,
    true
  );
  assert.equal(database.getSpeakerProfiles(true).length, before);
  const historicalVoice = { vector: [0.2, 0.3], spaceId: "declared-historical-space" };
  database.saveNoteSpeakerEmbeddings(other.id, { [currentId]: historicalVoice });
  owner._setSpeakerMapping(other.id, currentId, "Historical person", null, null);
  const profile = database
    .getSpeakerProfiles(true)
    .find((value) => value.display_name === "Historical person");
  assert.deepEqual(profile.representations[0], historicalVoice);
  assert.deepEqual(database.getNoteSpeakerEmbeddings(note.id), []);
});
IPC.prototype.setupHandlers.call(
  new Proxy(
    {
      databaseManager: database,
      activeMeetingSpeakerConfig: null,
      audioTapManager: { isSupported: () => false, stop: async () => {} },
      linuxPortalAudioManager: { stop: async () => {} },
      windowsLoopbackAudioManager: {
        getCapability: async () => ({ available: false }),
        stop: async () => {},
      },
      meetingAecManager: { stop: async () => {} },
      meetingDetectionEngine: {
        beginRecordingSession: async () => {},
        endRecordingSession() {},
        setUserRecording() {},
        recordMeetingAudioChunk() {},
      },
      _asyncMirrorWrite() {},
      windowManager: { controlPanelWindow: win },
    },
    { get: (value, key) => (key in value ? value[key] : anything()) }
  )
);
const invoke = (name, ...args) => handlers.get(name)({ sender: owner }, ...args);

test("original transcript export IPC selects only that note's aligned media before opening a picker", async () => {
  const { imported, recorded, media } = require("../lib/mixedTranscriptFixture")();
  database.setActiveAccountId("export-owner-a");
  const target = database.saveImportedNote({
    title: "Export fixture",
    content: "Hello, world!",
    transcript: JSON.stringify(imported),
    sourceMedia: { ...media, recordings: [] },
  }).note;
  database.saveMeetingNoteResult(target.id, recorded, media.recordings[0]);
  const previous = stubElectron.dialog.showSaveDialog;
  let picked = 0;
  const output = path.join(root, "selected-media.srt");
  stubElectron.dialog.showSaveDialog = async () => {
    picked++;
    return { filePath: output };
  };
  try {
    const mixed = await invoke("export-transcript", target.id, "srt");
    assert.equal(mixed.success, false);
    assert.match(mixed.error, /Choose one media/);
    const foreign = await invoke("export-transcript", target.id, "srt", {
      type: "recording",
      sessionId: "foreign",
      source: "mic",
    });
    assert.equal(foreign.success, false);
    assert.equal(picked, 0);
    assert.equal(
      (await invoke("export-transcript", target.id, "srt", { type: "original" })).success,
      true
    );
    assert.match(fs.readFileSync(output, "utf8"), /00:05:04,000 --> 00:05:04,400/);
    assert.equal(
      (
        await invoke("export-transcript", target.id, "srt", {
          type: "recording",
          sessionId: "live-session",
          source: "mic",
        })
      ).success,
      true
    );
    const exported = fs.readFileSync(output, "utf8");
    assert.match(exported, /00:00:01,000 --> 00:00:01,800/);
    assert.match(exported, /新发言。/);
    assert.doesNotMatch(exported, /Hello|New reply/);
    assert.equal(picked, 2);
    database.setActiveAccountId("foreign-export-owner");
    assert.equal(
      (await invoke("export-transcript", target.id, "srt", { type: "original" })).success,
      false
    );
    assert.equal(picked, 2, "a foreign account cannot open the picker for this note");
  } finally {
    database.setActiveAccountId(null);
    stubElectron.dialog.showSaveDialog = previous;
  }
});
const send = (source, frames, sessionId) =>
  listeners.get("meeting-transcription-send")(
    { sender: owner },
    Buffer.alloc(frames * 2, 1),
    source,
    sessionId
  );
const tick = () => new Promise((resolve) => setImmediate(resolve));
let resolvePending;
const submissions = [],
  jobs = new Map();
const prompts = [];
let mode = "normal";
let encoderCalls = 0;
const jobSnapshot = (scenarioType, fields) => ({
  scenarioType,
  status: "completed",
  submissionOutcome: "accepted",
  artifacts: [],
  progressPercent: 100,
  progressCurrentStep: 0,
  progressTotalSteps: 0,
  reasonCode: "action-executed",
  reasonDetail: "",
  traceId: "declared-consumer-trace",
  createdAt: null,
  updatedAt: null,
  transcriptionText: "",
  ...fields,
});
ai.bindServices({
  aiConfig: {
    get: async () => ({
      effectiveSelections: [
        {
          capabilityContract: "audio.speaker.embed",
          state: "ready",
          resource: {
            oneofKind: "local",
            local: {
              loadoutRef: "declared-fixture-loadout",
              implementation: "declared-fixture-encoder",
            },
          },
        },
      ],
    }),
  },
  ai: {
    scenarioJobs: {
      submit: async (spec) => {
        if (spec.type === "audio-speaker-embed") {
          assert.equal(spec.mimeType, "audio/wav");
          assert.ok(spec.audioSource.bytes.length >= 44 + 1.5 * 24000 * 2);
          const job = jobSnapshot(spec.type, {
            jobId: "encoder-fixture-" + ++encoderCalls,
            status: "completed",
            speakerEmbedding: {
              vector: encoderCalls % 2 ? [1, 0] : [0, 1],
              spaceId: "declared-IPC-space",
            },
          });
          jobs.set(job.jobId, job);
          return { job };
        }
        assert.equal(spec.timestamps, true);
        prompts.push(spec.prompt);
        submissions.push(Buffer.from(spec.audioSource.bytes));
        if (mode === "failure")
          throw Object.assign(new Error("declared actual inference failure"), {
            reasonCode: "AI_PROVIDER_UNAVAILABLE",
          });
        if (mode === "reject-dictionary" && spec.prompt)
          throw Object.assign(new Error("declared resource rejects dictionary prompt"), {
            reasonCode: "AI_INPUT_INVALID",
          });
        if (mode === "pending")
          await new Promise((resolve) => {
            resolvePending = resolve;
          });
        const id = "fixture-job-" + submissions.length;
        let transcription =
          submissions.length === 1
            ? { status: "no-speech", text: "", language: "", words: [] }
            : {
                status: "transcribed",
                text: "实际fixture文本",
                language: "zh",
                words: [{ text: "实际fixture文本", startSeconds: 0.01, endSeconds: 0.05 }],
              };
        if (mode === "diarized") {
          assert.equal(spec.diarization, true);
          assert.equal(
            spec.speakerCount,
            undefined,
            "whole-meeting count is not a per-window inference count"
          );
          transcription = {
            status: "transcribed",
            text: "declared ASR fixture",
            language: "zh",
            words: [
              { text: "first voice", startSeconds: 1.2, endSeconds: 1.8 },
              { text: "second voice", startSeconds: 4.2, endSeconds: 4.8 },
            ],
            diarization: {
              status: "diarized",
              durationSeconds: 10,
              intervals: [
                { speakerId: "job-A", startSeconds: 1, endSeconds: 3 },
                { speakerId: "job-B", startSeconds: 4, endSeconds: 6 },
              ],
            },
          };
        }
        const job = jobSnapshot(spec.type, {
          jobId: id,
          transcription,
          transcriptionText: transcription.text,
        });
        jobs.set(id, job);
        return { job };
      },
      get: async (id) => ({ job: jobs.get(id) }),
      cancel: async (id) => {
        const job = jobs.get(id);
        Object.assign(job, { status: "canceled", stopOutcome: "confirmed" });
        return { job };
      },
    },
  },
});
// Actual IPC registration, protected scope, disk scheduler and matching Electron SQLite;
// hardware/capture and ASR responses are explicit fixtures, not product acceptance.
test("original meeting consumers save genuine no-speech/later speech/tails and complete channel media", async () => {
  const id = "meeting-test-first";
  assert.equal(
    (
      await invoke("meeting-transcription-start", {
        sessionId: id,
        noteId: note.id,
        language: "zh",
        prompt: "Nimi, 会议专名",
      })
    ).success,
    true
  );
  send("mic", 240000, "stale-id");
  assert.equal(submissions.length, 0);
  send("mic", 240000, id);
  await tick();
  await tick();
  assert.equal(database.getNote(note.id).transcript, null);
  send("mic", 24000, id);
  send("system", 2400, id);
  const stopped = await invoke("meeting-transcription-stop", id);
  assert.equal(stopped.success, true, stopped.error);
  assert.equal(stopped.segments.length, 2);
  assert.equal(submissions.length, 3);
  assert.deepEqual(prompts, ["Nimi, 会议专名", "Nimi, 会议专名", "Nimi, 会议专名"]);
  assert.ok(submissions.every((audio) => audio.length <= 480044));
  assert.equal(JSON.parse(database.getNote(note.id).transcript).length, 2);
  const media = database.getNote(note.id).source_media.recordings[0];
  assert.equal(media.tracks.length, 2);
  const mic = media.tracks.find((track) => track.source === "mic");
  assert.equal(
    fs
      .readFileSync(path.join(require("../../src/helpers/appData").getAppDataDirectory(), mic.path))
      .readUInt32LE(40),
    264000 * 2
  );
});
test("navigation during a pending tail preserves captured media and refuses later commits", async () => {
  const prior = database.getNote(note.id);
  mode = "pending";
  const id = "meeting-test-pending";
  assert.equal(
    (await invoke("meeting-transcription-start", { sessionId: id, noteId: note.id })).success,
    true
  );
  send("mic", 2400, id);
  assert.equal((await invoke("meeting-transcription-cancel", id)).reason, "not-finalizing");
  const stop = invoke("meeting-transcription-stop", id);
  while (!resolvePending) await tick();
  const checkpoint = database.getNote(note.id).source_media;
  assert.equal(checkpoint.recordings.at(-1).sessionId, id);
  assert.equal(checkpoint.recordings.at(-1).status, "processing");
  owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  resolvePending();
  const result = await stop;
  assert.equal(result.success, false);
  assert.equal(database.getNote(note.id).transcript, prior.transcript);
  assert.deepEqual(database.getNote(note.id).source_media, checkpoint);
  mode = "normal";
  assert.equal(
    (await invoke("meeting-transcription-start", { sessionId: "after-cancel", noteId: note.id }))
      .success,
    true
  );
  await invoke("meeting-transcription-stop", "after-cancel");
});

test("explicit owned cancellation retains capture once and rejects late transcription and terminal overwrite", async () => {
  const target = database.saveNote("Cancellation fixture", "", "meeting").note;
  const id = "meeting-cancel-tail";
  mode = "pending";
  resolvePending = null;
  assert.equal(
    (await invoke("meeting-transcription-start", { sessionId: id, noteId: target.id })).success,
    true
  );
  send("mic", 2400, id);
  const stop = invoke("meeting-transcription-stop", id);
  while (!resolvePending) await tick();
  const checkpoint = database.getNote(target.id);
  assert.equal(checkpoint.source_media.recordings[0].status, "processing");
  const original = checkpoint.source_media.recordings[0].originalPath;
  assert.equal(
    fs
      .readFileSync(path.join(require("../../src/helpers/appData").getAppDataDirectory(), original))
      .readUInt32LE(40),
    4800
  );
  assert.equal(
    (await invoke("meeting-transcription-cancel", "older-session")).reason,
    "stale-session"
  );
  assert.equal(
    (await handlers.get("meeting-transcription-cancel")({ sender: { id: 999 } }, id)).reason,
    "wrong-owner"
  );
  const first = sent.length;
  const cancel = invoke("meeting-transcription-cancel", id);
  await tick();
  resolvePending();
  const [stopped, canceled] = await Promise.all([stop, cancel]);
  assert.equal(stopped.success, false);
  assert.equal(stopped.reason, "canceled");
  assert.equal(stopped.mediaRetained, true);
  assert.equal(canceled.success, true);
  const final = database.getNote(target.id);
  assert.equal(final.transcript, checkpoint.transcript);
  assert.equal(final.source_media.recordings.length, 1);
  assert.equal(final.source_media.recordings[0].status, "canceled");
  assert.equal(final.source_media.recordings[0].originalPath, original);
  assert.equal(
    sent.slice(first).filter((item) => item.name === "meeting-transcription-segment").length,
    0
  );
  assert.equal(
    sent.slice(first).filter((item) => item.name === "meeting-transcription-fatal-error").length,
    0
  );
  mode = "normal";
});
for (const outcome of ["completed", "failed"]) {
  test(`same-turn ${outcome} tail and cancel persist cancellation before retiring its scope`, async () => {
    const id = "meeting-cancel-race-" + outcome;
    const target = database.saveNote(id, "", "meeting").note;
    const original = ai.openMeetingWork;
    let canceled;
    ai.openMeetingWork = (...args) => {
      const current = original(...args);
      const finish = current.work.finish.bind(current.work);
      current.work.finish = async () => {
        try {
          return await finish();
        } finally {
          // Cancel runs before stop's already-queued finish/catch continuation;
          // its captureSaved await resumes after that continuation.
          queueMicrotask(() => {
            canceled = invoke("meeting-transcription-cancel", id);
          });
        }
      };
      return current;
    };
    try {
      mode = outcome === "failed" ? "failure" : "normal";
      await invoke("meeting-transcription-start", { sessionId: id, noteId: target.id });
      send("mic", 2400, id);
      const stopped = await invoke("meeting-transcription-stop", id);
      assert.equal((await canceled).success, true);
      assert.equal(stopped.reason, "canceled");
      const final = database.getNote(target.id);
      assert.equal(final.source_media.recordings.length, 1);
      assert.equal(final.source_media.recordings[0].status, "canceled");
      assert.ok(
        fs.existsSync(
          path.join(
            require("../../src/helpers/appData").getAppDataDirectory(),
            final.source_media.recordings[0].originalPath
          )
        )
      );
    } finally {
      ai.openMeetingWork = original;
      mode = "normal";
    }
  });
}

test("failed cancellation persistence remains an error and cannot claim a canceled terminal", async () => {
  const id = "meeting-cancel-save-failure";
  const target = database.saveNote(id, "", "meeting").note;
  const save = database.saveMeetingNoteResult;
  database.saveMeetingNoteResult = function (noteId, segments, recording, ...rest) {
    if (recording?.status === "canceled") throw new Error("declared cancellation save failure");
    return save.call(this, noteId, segments, recording, ...rest);
  };
  try {
    mode = "pending";
    resolvePending = null;
    await invoke("meeting-transcription-start", { sessionId: id, noteId: target.id });
    send("mic", 2400, id);
    const stop = invoke("meeting-transcription-stop", id);
    while (!resolvePending) await tick();
    const checkpoint = database.getNote(target.id);
    const canceled = invoke("meeting-transcription-cancel", id);
    await tick();
    resolvePending();
    const results = await Promise.all([stop, canceled]);
    for (const result of results) {
      assert.equal(result.success, false);
      assert.match(result.error, /cancellation save failure/);
      assert.notEqual(result.reason, "canceled");
    }
    assert.deepEqual(database.getNote(target.id).source_media, checkpoint.source_media);
    assert.equal(database.getNote(target.id).transcript, checkpoint.transcript);
  } finally {
    database.saveMeetingNoteResult = save;
    mode = "normal";
  }
});

test("active recording preserves a newer main result across a delayed renderer save and retains failed capture without success", async () => {
  const id = "meeting-delayed-save";
  const prior = database.getNote(note.id).transcript;
  assert.equal(
    (await invoke("meeting-transcription-start", { sessionId: id, noteId: note.id })).success,
    true
  );
  send("mic", 240000, id);
  await tick();
  await tick();
  const count = JSON.parse(database.getNote(note.id).transcript).length;
  assert.ok(count > JSON.parse(prior).length);
  await invoke("db-update-note", note.id, { transcript: prior });
  assert.equal(JSON.parse(database.getNote(note.id).transcript).length, count);
  mode = "failure";
  send("mic", 2400, id);
  const result = await invoke("meeting-transcription-stop", id);
  assert.equal(result.success, false);
  assert.match(result.error, /inference failure/);
  const media = database.getNote(note.id).source_media.recordings.at(-1);
  assert.equal(media.status, "failed");
  assert.equal(
    fs
      .readFileSync(
        path.join(require("../../src/helpers/appData").getAppDataDirectory(), media.originalPath)
      )
      .readUInt32LE(40),
    242400 * 2
  );
});

test("post-commit notification failure keeps one committed recording and its actual media", async () => {
  mode = "normal";
  failMediaNotification = true;
  const id = "meeting-notify-once";
  assert.equal(
    (await invoke("meeting-transcription-start", { sessionId: id, noteId: note.id })).success,
    true
  );
  send("mic", 2400, id);
  const result = await invoke("meeting-transcription-stop", id);
  assert.equal(result.success, true);
  assert.equal(failMediaNotification, false);
  const records = database
    .getNote(note.id)
    .source_media.recordings.filter((record) => record.sessionId === id);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "completed");
  assert.ok(
    fs.existsSync(
      path.join(require("../../src/helpers/appData").getAppDataDirectory(), records[0].originalPath)
    )
  );
  assert.equal(prompts.at(-1), "");
});

test("meeting dictionary over-budget and selected-resource refusal cannot become successful recognition", async () => {
  const before = submissions.length;
  const oversized = await invoke("meeting-transcription-start", {
    sessionId: "meeting-budget",
    noteId: note.id,
    prompt: "字".repeat(1400),
  });
  assert.equal(oversized.success, false);
  assert.equal(submissions.length, before);
  mode = "reject-dictionary";
  const id = "meeting-rejected-prompt";
  assert.equal(
    (
      await invoke("meeting-transcription-start", {
        sessionId: id,
        noteId: note.id,
        prompt: "Nimi",
      })
    ).success,
    true
  );
  send("mic", 2400, id);
  const result = await invoke("meeting-transcription-stop", id);
  assert.equal(result.success, false);
  assert.match(result.error, /rejects dictionary/);
  assert.equal(prompts.at(-1), "Nimi");
});
test.after(() => {
  ai.invalidate();
  database.db.close();
  Module._load = originalLoad;
  fs.rmSync(root, { recursive: true, force: true });
});

test("original diarized meeting IPC consumes ASR and speaker Jobs, saved names and raw evidence across both channels", async () => {
  mode = "diarized";
  const diarizedNote = database.saveNote("Diarized consumer fixture", "", "meeting").note;
  database.upsertSpeakerProfile("Fixture Alice", null, {
    vector: [1, 0],
    spaceId: "declared-IPC-space",
  });
  const sessionId = "diarized-original-consumer";
  const first = sent.length;
  assert.equal(
    (
      await invoke("meeting-transcription-start", {
        sessionId,
        noteId: diarizedNote.id,
        diarization: true,
      })
    ).success,
    true
  );
  send("mic", 240000, sessionId);
  send("system", 240000, sessionId);
  const stopped = await invoke("meeting-transcription-stop", sessionId);
  assert.equal(stopped.success, true);
  assert.equal(stopped.segments.length, 4);
  assert.equal(encoderCalls, 4);
  const persisted = JSON.parse(database.getNote(diarizedNote.id).transcript);
  const mic = persisted.filter((segment) => segment.source === "mic"),
    system = persisted.filter((segment) => segment.source === "system");
  assert.equal(mic[0].speaker, system[0].speaker);
  assert.equal(mic[0].speakerName, "Fixture Alice");
  assert.equal(system[0].speakerName, "Fixture Alice");
  assert.equal(database.getNoteSpeakerEmbeddings(diarizedNote.id).length, 2);
  assert.equal(mic[0].recognition.transcript.diarization.intervals[1].endSeconds, 6);
  const published = sent
    .slice(first)
    .filter((event) => event.name === "meeting-transcription-segment");
  assert.equal(published.length, 4);
  assert.equal(published[0].payload.speakerName, "Fixture Alice");
  mode = "normal";
});
