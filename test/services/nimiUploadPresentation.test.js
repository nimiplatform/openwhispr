const test = require("node:test");
const assert = require("node:assert/strict");

test("the real no-speech status has a specific upload reason", async () => {
  const { transcriptionErrorKey } = await import("../../src/components/notes/shared.ts");
  assert.equal(
    transcriptionErrorKey({ success: true, status: "no-speech", text: "" }),
    "noSpeechDetected"
  );
  assert.equal(
    transcriptionErrorKey({ success: false, code: "NO_SPEECH_DETECTED" }),
    "noSpeechDetected"
  );
  assert.equal(transcriptionErrorKey({ success: false, code: "OTHER_FAILURE" }), undefined);
});

test("a long Chinese or astral title fallback is bounded without changing the transcript", async () => {
  const { uploadTitleFallback } = await import("../../src/services/uploadNotes.ts");
  const transcript = "文".repeat(1500);
  assert.ok(Array.from(uploadTitleFallback(transcript, "long.wav")).length <= 121);
  assert.equal(transcript.length, 1500);
  const astral = uploadTitleFallback("𠮷".repeat(1500), "long.wav");
  assert.equal(Array.from(astral).length, 121);
  assert.equal(astral.endsWith("…"), true);
  assert.equal(astral.includes("\uFFFD"), false);
});
