const test = require("node:test");
const assert = require("node:assert/strict");
const { projectMeetingTranscript } = require("../../src/helpers/nimiMeetingTranscript");
const chunk = {
  source: "mic",
  startFrame: 240000,
  endFrame: 288000,
  sampleRate: 24000,
  anchorMs: 1000,
  clockBasis: "arrival",
  transcript: {
    status: "transcribed",
    text: "你好！",
    words: [{ text: "你好！", startSeconds: 0.3, endSeconds: 1.4 }],
  },
};
test("meeting projection applies its frame offset once and preserves reported endpoints without a channel speaker", () => {
  const [result] = projectMeetingTranscript(chunk, "session");
  assert.equal(result.timestamp, 11300);
  assert.equal(result.endTimestamp, 12400);
  assert.equal(result.text, "你好！");
  assert.equal(result.source, "mic");
  assert.equal(result.clockBasis, "arrival");
  assert.equal(result.speaker, undefined);
  assert.deepEqual(projectMeetingTranscript(chunk, "session"), [result]);
});
test("missing actual speech alignment fails instead of distributing text through a capture window", () => {
  assert.throws(
    () =>
      projectMeetingTranscript(
        { ...chunk, transcript: { status: "transcribed", text: "text", words: [] } },
        "s"
      ),
    /actual word alignment/
  );
  assert.throws(
    () =>
      projectMeetingTranscript(
        {
          ...chunk,
          transcript: {
            ...chunk.transcript,
            words: [{ text: "text", startSeconds: 0, endSeconds: 3 }],
          },
        },
        "s"
      ),
    /word alignment/
  );
  assert.deepEqual(
    projectMeetingTranscript(
      { ...chunk, transcript: { status: "no-speech", text: "", words: [] } },
      "s"
    ),
    []
  );
});

test("real interval intersections preserve raw overlapping evidence and apply capture offset once", () => {
  const transcript = {
    ...chunk.transcript,
    words: [
      { text: "清晰", startSeconds: 0.1, endSeconds: 0.3 },
      { text: "重叠", startSeconds: 0.6, endSeconds: 0.8 },
    ],
    diarization: {
      status: "diarized",
      durationSeconds: 2,
      intervals: [
        { speakerId: "job-a", startSeconds: 0, endSeconds: 1 },
        { speakerId: "job-b", startSeconds: 0.5, endSeconds: 1.5 },
      ],
    },
  };
  const projected = projectMeetingTranscript(
    {
      ...chunk,
      transcript,
      speakerMap: { "job-a": "session:speaker_0", "job-b": "session:speaker_1" },
      speakerMatching: {
        "session:speaker_0": "matched-space",
        "session:speaker_1": "matched-space",
      },
    },
    "session"
  );
  assert.equal(projected[0].speaker, "session:speaker_0");
  assert.equal(projected[0].timestamp, 11100);
  assert.equal(projected[1].speaker, undefined);
  assert.equal(projected[1].speakerMatching, "ambiguous-overlap");
  assert.equal(projected[1].speakerStatus, "provisional");
  assert.deepEqual(projected[0].recognition.transcript, transcript);
});
