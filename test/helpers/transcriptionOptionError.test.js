const test = require("node:test");
const assert = require("node:assert/strict");
const { describeTranscriptionOptionError } = require("../../src/helpers/transcriptionOptionError");
const { ipcErrorFields } = require("../../src/helpers/ipcErrorFields");

test("typed unsupported options preserve the original reason and carry actionable App metadata", () => {
  const error = Object.assign(new Error("ai-media-option-unsupported"), {
    reasonCode: "AI_MEDIA_OPTION_UNSUPPORTED",
  });
  assert.equal(
    describeTranscriptionOptionError(error, { timestamps: true, diarization: true }),
    error
  );
  assert.equal(error.message, "ai-media-option-unsupported");
  assert.equal(error.reasonCode, "AI_MEDIA_OPTION_UNSUPPORTED");
  const event = ipcErrorFields(error);
  assert.equal(event.error, "ai-media-option-unsupported");
  assert.equal(event.messageKey, "nimi.transcriptionSpeakerOptionsUnsupported");
  assert.equal(event.settingsTarget, "speechToText");
  assert.deepEqual(event.messageParams, { reason: "ai-media-option-unsupported" });
  assert.deepEqual(event.technicalDetails, { underlyingError: "ai-media-option-unsupported" });
});

test("timing-only failures stay specific and unrelated or untyped errors are not reclassified", () => {
  const timing = Object.assign(new Error("actual timing refusal"), {
    code: "ai-media-option-unsupported",
  });
  describeTranscriptionOptionError(timing, { timestamps: true });
  assert.equal(timing.messageKey, "nimi.transcriptionTimingUnsupported");
  for (const error of [
    new Error("ai-media-option-unsupported"),
    Object.assign(new Error("actual unavailable"), { code: "runtime-service-unavailable" }),
  ]) {
    assert.equal(describeTranscriptionOptionError(error, { diarization: true }), error);
    assert.equal(error.messageKey, undefined);
  }
});
