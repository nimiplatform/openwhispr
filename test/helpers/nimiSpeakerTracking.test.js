const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NimiSpeakerTracking,
  cropVoice,
  speakerForWord,
} = require("../../src/helpers/nimiSpeakerTracking");
function wav(seconds = 10) {
  const result = Buffer.alloc(44 + seconds * 16000 * 2);
  result.write("RIFF");
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16000, 24);
  result.writeUInt32LE(32000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(result.length - 44, 40);
  result.fill(7, 44);
  return result;
}
const transcript = {
  status: "transcribed",
  text: "declared fixture",
  language: "",
  words: [],
  diarization: {
    status: "diarized",
    durationSeconds: 10,
    intervals: [{ speakerId: "speaker_0", startSeconds: 1, endSeconds: 4 }],
  },
};
test("actual original PCM intervals create scoped business matches across independent Job labels", async () => {
  const controller = new AbortController(),
    inputs = [];
  const tracker = new NimiSpeakerTracking({
    namespace: "meeting-one",
    signal: controller.signal,
    assertCurrent() {},
    extract: async (bytes) => {
      inputs.push(bytes);
      return { vector: [1, 0], spaceId: "declared-fixture-space" };
    },
  });
  const first = await tracker.apply({ jobId: "job-one", transcript }, wav());
  const second = await tracker.apply(
    {
      jobId: "job-two",
      transcript: {
        ...transcript,
        diarization: {
          ...transcript.diarization,
          intervals: [{ speakerId: "other-job-speaker", startSeconds: 2, endSeconds: 5 }],
        },
      },
    },
    wav()
  );
  assert.equal(first.speakerMap.speaker_0, second.speakerMap["other-job-speaker"]);
  assert.equal(inputs[0].length, 44 + 3 * 16000 * 2);
  assert.deepEqual(inputs[0].subarray(44), wav().subarray(44 + 16000 * 2, 44 + 4 * 16000 * 2));
  assert.deepEqual(first.speakerRepresentations[first.speakerMap.speaker_0], {
    vector: [1, 0],
    spaceId: "declared-fixture-space",
  });
});
test("foreign spaces cannot force a user count cap or train a different voice", async () => {
  const controller = new AbortController();
  let space = "A";
  const tracker = new NimiSpeakerTracking({
    namespace: "session",
    signal: controller.signal,
    assertCurrent() {},
    getMaxSpeakers: () => 1,
    extract: async () => ({ vector: [1, 0], spaceId: space }),
  });
  const first = await tracker.apply({ jobId: "a", transcript }, wav());
  space = "B";
  const second = await tracker.apply({ jobId: "b", transcript }, wav());
  assert.notEqual(first.speakerMap.speaker_0, second.speakerMap.speaker_0);
});
test("ambiguous overlap remains unnamed and mixed audio is never used as a clean profile", () => {
  const mixed = {
    ...transcript,
    diarization: {
      ...transcript.diarization,
      intervals: [
        { speakerId: "a", startSeconds: 1, endSeconds: 4 },
        { speakerId: "b", startSeconds: 2, endSeconds: 5 },
      ],
    },
  };
  assert.equal(speakerForWord(mixed, 2.5, 3, { a: "A", b: "B" }), null);
  assert.equal(cropVoice(wav(), mixed.diarization.intervals, "a"), null);
});
test("cancel during real task boundary cannot publish a replacement-session match", async () => {
  const controller = new AbortController();
  let release;
  const tracker = new NimiSpeakerTracking({
    namespace: "old",
    signal: controller.signal,
    assertCurrent() {
      controller.signal.throwIfAborted();
    },
    extract: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const pending = tracker.apply({ jobId: "a", transcript }, wav());
  await new Promise(setImmediate);
  controller.abort();
  release({ vector: [1, 0], spaceId: "A" });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(tracker.voices.size, 0);
});

test("at-cap unmatched voice stays anonymous and cannot borrow the known voice centroid", async () => {
  const controller = new AbortController();
  let vector = [1, 0];
  const tracker = new NimiSpeakerTracking({
    namespace: "scope",
    signal: controller.signal,
    assertCurrent() {},
    getMaxSpeakers: () => 1,
    extract: async () => ({ vector, spaceId: "fixture" }),
  });
  const first = await tracker.apply({ jobId: "one", transcript }, wav());
  const original = structuredClone(tracker.voices.get(first.speakerMap.speaker_0));
  vector = [0, 1];
  const second = await tracker.apply({ jobId: "two", transcript }, wav());
  assert.equal(second.speakerMap.speaker_0, "scope:two:speaker_0");
  assert.equal(second.speakerMatching[second.speakerMap.speaker_0], "count-constrained");
  assert.deepEqual(second.speakerRepresentations, {});
  assert.equal(tracker.voices.size, 1);
  assert.deepEqual(tracker.voices.get(first.speakerMap.speaker_0), original);
});

test("same model vectors in two recording scopes never share a speaker identity", async () => {
  const make = (namespace) =>
    new NimiSpeakerTracking({
      namespace,
      signal: new AbortController().signal,
      assertCurrent() {},
      extract: async () => ({ vector: [1, 0], spaceId: "fixture" }),
    });
  const one = await make("one").apply({ jobId: "same", transcript }, wav());
  const two = await make("two").apply({ jobId: "same", transcript }, wav());
  assert.notEqual(one.speakerMap.speaker_0, two.speakerMap.speaker_0);
});
