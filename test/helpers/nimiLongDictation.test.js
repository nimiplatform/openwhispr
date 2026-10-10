const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  Module = require("node:module");
const { spawnSync } = require("node:child_process");
const { loadAudioManager } = require("./harness/audioManager");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimi-long-dictation-"));
const oldLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron")
    return { app: { getPath: () => root, isReady: () => false, isPackaged: false } };
  if (request === "./debugLogger") return { debug() {}, info() {}, warn() {}, error() {} };
  if (request === "./tokenStore")
    return {
      getState: () => ({ token: null, generation: 0 }),
      getGeneration: () => 0,
      subscribe() {},
    };
  return oldLoad.call(this, request, parent, isMain);
};
const ai = require("../../src/helpers/nimiAI");
Module._load = oldLoad;
const inputPath = path.join(root, "305.webm");
const referencePath = path.join(root, "reference.wav");
function ffmpeg(args) {
  const result = spawnSync(require("ffmpeg-static"), args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
test.before(() => {
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=16000",
    "-t",
    "305",
    "-c:a",
    "libopus",
    "-y",
    inputPath,
  ]);
  ffmpeg([
    "-i",
    inputPath,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    "-rf64",
    "auto",
    "-y",
    referencePath,
  ]);
});
test.after(() => {
  ai.invalidate();
  delete globalThis.__longDictationHost;
  fs.rmSync(root, { recursive: true, force: true });
});
function bindJobs(submissions, cancelAt, manager, prompts, rejectPrompt) {
  const jobs = new Map();
  ai.bindServices({
    ai: {
      scenarioJobs: {
        submit: async (spec) => {
          prompts.push(spec.prompt);
          if (rejectPrompt && spec.prompt)
            throw new Error("Declared resource rejects transcription prompts");
          const audio = Buffer.from(spec.audioSource.bytes);
          submissions.push(audio);
          const jobId = "declared-fixture-job-" + submissions.length;
          const job = {
            jobId,
            status: "completed",
            transcription: {
              status: "transcribed",
              text: submissions.length === 1 ? "真实fixture首段" : "真实fixture尾段",
              language: "zh",
              words: [],
            },
          };
          jobs.set(jobId, job);
          if (cancelAt === submissions.length) manager().cancelProcessing();
          return { job };
        },
        get: async (jobId) => ({ job: jobs.get(jobId) }),
        cancel: async () => ({ canceled: true }),
      },
    },
  });
}
async function consumer(t, cancelAt, dictionary = [], rejectPrompt = false) {
  const submissions = [];
  let manager;
  const outcomes = [],
    errors = [];
  const prompts = [],
    failures = [];
  globalThis.__longDictationHost = (command, payload) =>
    ai.commandHandlers[command]({
      event: { sender: { id: 7, isDestroyed: () => false } },
      payload,
    });
  const clientFixture = `import { createNimiRequestRunner } from "/services/nimiRequest.ts"; export const invokeNimiBusiness = async (...args) => globalThis.__longDictationHost(...args); export const runNimiRequest = createNimiRequestRunner(invokeNimiBusiness);`;
  const { createManager, window } = await loadAudioManager(t, {
    cachePrefix: "nimi-long-final-",
    settingsKey: "__longFinalSettings",
    settings: { preferredLanguage: "auto", customDictionary: dictionary, useCleanupModel: false },
    mockModules: { "/services/nimiClient": clientFixture, "./nimiClient": clientFixture },
  });
  window.electronAPI.stopDictationPreview = async () => ({
    success: true,
    streamed: false,
    text: "",
  });
  manager = createManager({
    micRecovery: { stop() {} },
    teardownSpeechGate() {},
    _batchSegments: [],
    _receivedAudioData: true,
    _processingCancellationGeneration: 0,
    _activeProcessingPipeline: null,
    recordingStartTime: Date.now() - 305000,
    _batchPcmTap: { stop: async () => null },
    shouldShowPreviewCleanupState: () => false,
    getEffectiveSttLanguage: () => "auto",
    _takePendingResultExtras: () => ({}),
    onTranscriptionComplete: (value) => outcomes.push(value),
    onError: (value) => errors.push(value),
    saveFailedTranscription(message) {
      failures.push(message);
    },
  });
  bindJobs(submissions, cancelAt, () => manager, prompts, rejectPrompt);
  const recording = new Blob([fs.readFileSync(inputPath)], { type: "audio/webm" });
  await manager.finalizeBatchRecording(recording);
  return { submissions, outcomes, errors, manager, prompts, failures };
}
// Actual FFmpeg, upload port, original finalize/process consumer and Host Job observer. Responses are explicit ASR fixtures.
test("over-300-second final dictation consumes complete source in finite Jobs after the 240-second PCM cap", async (t) => {
  const { submissions, outcomes, errors } = await consumer(t);
  assert.equal(submissions.length, 2);
  assert.equal(outcomes.length, 1);
  assert.deepEqual(errors, []);
  assert.equal(outcomes[0].rawText, "真实fixture首段\n真实fixture尾段");
  assert.equal(outcomes[0].chunks.length, 2);
  assert.deepEqual(
    submissions.map((audio) => audio.readUInt32LE(40) / 2 / audio.readUInt32LE(24)),
    [300, 5]
  );
  const { readPcmWavInfo, readPcmWavWindow } = require("../../src/helpers/nimiPcmWav");
  const fd = fs.openSync(referencePath, "r");
  try {
    const info = readPcmWavInfo(fd);
    const reference = readPcmWavWindow(fd, info, 0, info.frameCount).subarray(44);
    assert.deepEqual(Buffer.concat(submissions.map((audio) => audio.subarray(44))), reference);
  } finally {
    fs.closeSync(fd);
  }
});
test("canceling a later Job cannot publish partial final dictation or replay the first chunk", async (t) => {
  const { submissions, outcomes, errors } = await consumer(t, 2);
  assert.equal(submissions.length, 2);
  assert.deepEqual(outcomes, []);
  assert.deepEqual(errors, []);
});

test("plain long dictation forwards the same dictionary intent to every actual final Job", async (t) => {
  const { prompts, outcomes, errors, failures } = await consumer(t, undefined, [
    "Nimi",
    "项目专名",
  ]);
  assert.deepEqual(prompts, ["Nimi, 项目专名", "Nimi, 项目专名"]);
  assert.equal(outcomes.length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
});
test("empty dictionary adds no prompt requirement; rejected and oversized prompts cannot publish success", async (t) => {
  const plain = await consumer(t);
  assert.deepEqual(plain.prompts, ["", ""]);
  const rejected = await consumer(t, undefined, ["Nimi"], true);
  assert.deepEqual(rejected.outcomes, []);
  assert.equal(rejected.errors.length, 1);
  assert.match(rejected.failures[0], /rejects transcription prompts/);
  const oversized = await consumer(t, undefined, ["字".repeat(1400)]);
  assert.deepEqual(oversized.prompts, []);
  assert.deepEqual(oversized.outcomes, []);
  assert.equal(oversized.errors.length, 1);
});
