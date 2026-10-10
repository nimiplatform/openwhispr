const test = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("../lib/mixedTranscriptFixture");

test("mixed media keeps uploaded words before later capture without rebasing either clock", async () => {
  const { compareTranscriptSegments, resolveTranscriptSource, selectTranscriptSource } =
    await import("../../src/utils/transcriptMedia.mjs");
  const { imported, recorded, media, origin } = fixture();
  const units = [...imported, ...recorded];
  const snapshot = JSON.stringify(units);
  assert.deepEqual([...units].sort(compareTranscriptSegments), units);
  assert.equal(JSON.stringify(units), snapshot);
  assert.equal(resolveTranscriptSource(recorded[0], media).originMs, origin + 19000);
  assert.deepEqual(selectTranscriptSource(units, media, { type: "original" }).segments, imported);
  assert.deepEqual(
    selectTranscriptSource(units, media, {
      type: "recording",
      sessionId: "live-session",
      source: "mic",
    }).segments,
    [recorded[0]]
  );
  for (const selection of [
    { type: "recording", sessionId: "foreign", source: "mic" },
    { type: "original", path: "C:/arbitrary.wav" },
  ])
    assert.throws(() => selectTranscriptSource(units, media, selection), /selection|no transcript/);
});

test("unlabeled upload recovery cannot replace new unassigned recording words", async () => {
  const { groupImportedTranscript } = await import("../../src/utils/importedTranscript.ts");
  const { imported, recorded, media } = fixture();
  const groups = groupImportedTranscript(
    [imported[0], ...recorded, imported[1]],
    "Hello, world!",
    {},
    media
  );
  assert.deepEqual(
    groups.map((g) => g.text),
    ["Hello, world!", "新发言。", "New reply."]
  );
  assert.deepEqual(
    groups.flatMap((g) => g.units),
    [...imported, ...recorded]
  );
  assert.equal(
    groups[1].media.status,
    "canceled",
    "completed words of a canceled recording retain its status"
  );
  const missing = groupImportedTranscript(recorded, "", {}, { ...media, recordings: [] });
  assert.equal(missing[0].media.originMs, undefined, "no source clock is guessed from the import");
});
