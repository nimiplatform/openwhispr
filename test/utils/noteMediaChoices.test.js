const test = require("node:test");
const assert = require("node:assert/strict");
const { getNoteMediaChoices } = require("../../src/utils/noteMediaChoices.ts");

test("single imported media uses the existing note selection", () => {
  assert.deepEqual(getNoteMediaChoices({ originalPath: "imports/file/source.wav" }), [
    { key: "original", selection: {} },
  ]);
});
test("an uploaded original and later recording tracks are both offered", () => {
  const choices = getNoteMediaChoices({
    originalName: "uploaded.wav",
    originalPath: "imports/upload/source.wav",
    recordings: [
      {
        sessionId: "after-upload",
        status: "canceled",
        tracks: [
          {
            source: "system",
            path: "imports/later/system.wav",
            frameCount: 16000,
            sampleRate: 24000,
          },
        ],
      },
    ],
  });
  assert.deepEqual(choices[0].selection, {});
  assert.equal(choices[0].key, "original");
  assert.deepEqual(choices[1].selection, { sessionId: "after-upload", source: "system" });
});
test("all retained recording statuses and tracks retain their own identity", () => {
  const choices = getNoteMediaChoices({
    originalPath: "imports/0/mic.wav",
    recordings: ["completed", "canceled", "failed"].map((status, index) => ({
      sessionId: "recording-" + index,
      status,
      tracks: ["mic", "system"].map((source) => ({
        source,
        path: "imports/" + index + "/" + source + ".wav",
        frameCount: 16000,
        sampleRate: 24000,
      })),
    })),
  });
  assert.equal(choices.length, 6);
  assert.deepEqual(choices[3].selection, { sessionId: "recording-1", source: "system" });
  assert.equal(choices[3].recordingNumber, 2);
  assert.equal(choices[3].status, "canceled");
  assert.equal(choices[3].durationSeconds, 16000 / 24000);
  assert.deepEqual(Object.keys(choices[3].selection).sort(), ["sessionId", "source"]);
});
test("missing or invalid geometry does not invent a duration", () => {
  for (const geometry of [
    {},
    { frameCount: 10, sampleRate: 0 },
    { frameCount: -1, sampleRate: 24000 },
  ]) {
    const choices = getNoteMediaChoices({
      recordings: [
        {
          sessionId: "unknown-duration",
          status: "failed",
          tracks: [{ source: "mic", path: "imports/file.wav", ...geometry }],
        },
      ],
    });
    assert.equal(choices[0].durationSeconds, undefined);
  }
  assert.deepEqual(getNoteMediaChoices({ recordings: null }), []);
});
