const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimi-file-transcription-"));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron")
    return { app: { getPath: () => root, isReady: () => false, isPackaged: false } };
  return originalLoad.call(this, request, parent, isMain);
};
const { transcribeNimiFile, cleanupNimiFile } = require("../../src/helpers/nimiFileTranscription");
const { approveAudioPath } = require("../../src/helpers/audioFileAccess");
Module._load = originalLoad;

test("real FFmpeg decoding yields bounded windows with one source offset", async () => {
  const sourcePath = path.join(root, "305-seconds.wav");
  const generated = spawnSync(
    require("ffmpeg-static"),
    [
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=16000:cl=mono",
      "-t",
      "305",
      "-c:a",
      "pcm_s16le",
      "-y",
      sourcePath,
    ],
    { encoding: "utf8" }
  );
  assert.equal(generated.status, 0, generated.stderr);
  approveAudioPath(sourcePath);
  const scope = { controller: new AbortController() };
  const inputs = [];
  try {
    const result = await transcribeNimiFile(
      scope,
      { filePath: sourcePath, timestamps: true },
      {
        assertCurrent: (current) => current.controller.signal.throwIfAborted(),
        transcribe: async (_scope, input) => {
          inputs.push(input);
          return {
            jobId: "unit-job-" + inputs.length,
            transcript: {
              status: "transcribed",
              text: "你好。",
              language: "",
              words: [{ text: "你好", startSeconds: 1.1, endSeconds: 1.2 }],
            },
          };
        },
      }
    );
    assert.equal(inputs.length, 2);
    assert.ok(inputs.every((input) => input.audio.byteLength < 32 * 1024 * 1024));
    assert.equal(result.durationSeconds, 305);
    assert.deepEqual(
      result.segments.map((segment) => segment.start),
      [1.1, 301.1]
    );
    assert.deepEqual(
      result.segments.map((segment) => segment.end),
      [1.2, 301.2]
    );
    assert.equal(result.chunks[1].durationSeconds, 5);
    assert.equal(result.chunks[1].transcript.language, "");
  } finally {
    cleanupNimiFile(scope);
  }
});

test("cancellation after model completion prevents publishing the file result", async () => {
  const sourcePath = path.join(root, "305-seconds.wav");
  approveAudioPath(sourcePath);
  const scope = { controller: new AbortController() };
  try {
    await assert.rejects(
      transcribeNimiFile(
        scope,
        { filePath: sourcePath },
        {
          assertCurrent: (current) => current.controller.signal.throwIfAborted(),
          transcribe: async () => {
            scope.controller.abort();
            return {
              jobId: "unit-job",
              transcript: {
                status: "transcribed",
                text: "late unit result",
                language: "",
                words: [],
              },
            };
          },
        }
      ),
      (error) => error.name === "AbortError"
    );
    assert.equal(scope.fileResult, undefined);
  } finally {
    cleanupNimiFile(scope);
  }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test(
  "actual recorded Runtime ASR result replays through original file consumer without rewriting model words or intervals",
  { skip: !process.env.NIMI_TEST_ASR_RECORDED_RESULT || !process.env.NIMI_TEST_ASR_INPUT_WAV },
  async () => {
    const recorded = JSON.parse(fs.readFileSync(process.env.NIMI_TEST_ASR_RECORDED_RESULT, "utf8"));
    assert.equal(recorded.status, "SPEECH_TRANSCRIPT_STATUS_TRANSCRIBED");
    assert.equal(recorded.diarization.status, "SPEECH_DIARIZATION_STATUS_DIARIZED");
    // This is an explicit replay of a real completed isolated Runtime Job, not
    // a new protected App/model call. Only public enum projection is applied.
    const transcript = {
      ...recorded,
      status: "transcribed",
      diarization: { ...recorded.diarization, status: "diarized" },
    };
    const sourcePath = process.env.NIMI_TEST_ASR_INPUT_WAV;
    approveAudioPath(sourcePath);
    const { readPcmWavInfo, readPcmWavWindow } = require("../../src/helpers/nimiPcmWav");
    const fd = fs.openSync(sourcePath, "r"),
      info = readPcmWavInfo(fd);
    const actual = readPcmWavWindow(fd, info, 0, info.frameCount);
    fs.closeSync(fd);
    const scope = { controller: new AbortController() };
    try {
      const result = await transcribeNimiFile(
        scope,
        { filePath: sourcePath, timestamps: true, diarization: true },
        {
          assertCurrent: (current) => current.controller.signal.throwIfAborted(),
          transcribe: async (_current, input) => {
            assert.deepEqual(input.audio, actual);
            assert.equal(input.diarization, true);
            const speakerMap = Object.fromEntries(
              recorded.diarization.intervals.map((interval) => [
                interval.speakerId,
                "recorded-job:" + interval.speakerId,
              ])
            );
            return {
              jobId: "actual-recorded-replay",
              transcript,
              speakerMap,
              speakerMatching: Object.fromEntries(
                Object.values(speakerMap).map((id) => [id, "unavailable"])
              ),
            };
          },
        }
      );
      assert.equal(result.text, recorded.text);
      assert.equal(result.segments.length, recorded.words.length);
      assert.deepEqual(
        result.chunks[0].transcript.diarization.intervals,
        recorded.diarization.intervals
      );
      assert.deepEqual(
        result.segments.map((segment) => [segment.text, segment.start, segment.end]),
        recorded.words.map((word) => [word.text, word.startSeconds, word.endSeconds])
      );
    } finally {
      cleanupNimiFile(scope);
    }
  }
);
