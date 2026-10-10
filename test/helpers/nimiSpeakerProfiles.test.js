const test = require("node:test");
const assert = require("node:assert/strict");
const { labelSpeakerProfiles } = require("../../src/helpers/nimiSpeakerProfiles");
const representation = { vector: [1, 0], spaceId: "declared-fixture-space" };
const segment = {
  id: "actual-word",
  text: "unchanged word",
  timestamp: 1200,
  endTimestamp: 1600,
  speaker: "session:speaker_0",
  speakerMatching: "matched-space",
};
const profile = { id: 1, display_name: "Alice", representations: [representation] };
const reps = { [segment.speaker]: representation };

test("compatible actual note voice confirms a saved name without changing words/times or training a profile", () => {
  const [result] = labelSpeakerProfiles([segment], reps, [profile]);
  assert.equal(result.speakerName, "Alice");
  assert.equal(result.speakerStatus, "confirmed");
  assert.equal(result.text, segment.text);
  assert.equal(result.timestamp, segment.timestamp);
  assert.deepEqual(profile.representations, [representation]);
  assert.equal(segment.speakerName, undefined);
});
test("foreign spaces, dimension changes and overflow voices cannot become a known person", () => {
  for (const value of [
    { ...representation, spaceId: "foreign" },
    { ...representation, vector: [1, 0, 0] },
  ]) {
    assert.equal(
      labelSpeakerProfiles([segment], { [segment.speaker]: value }, [profile])[0].speakerName,
      undefined
    );
  }
  assert.equal(
    labelSpeakerProfiles([{ ...segment, speakerMatching: "count-constrained" }], reps, [profile])[0]
      .speakerName,
    undefined
  );
});
test("ambiguous people are suggestions, and manual note locks always win", () => {
  const [suggested] = labelSpeakerProfiles([segment], reps, [
    profile,
    { ...profile, id: 2, display_name: "Bob" },
  ]);
  assert.equal(suggested.speakerName, undefined);
  assert.equal(suggested.speakerStatus, "suggested");
  const locked = { ...segment, speakerName: "Explicit user name", speakerLocked: true };
  assert.deepEqual(labelSpeakerProfiles([locked], reps, [profile]), [locked]);
  const [mapped] = labelSpeakerProfiles(
    [segment],
    reps,
    [profile],
    [{ speaker_id: segment.speaker, display_name: "User mapping" }]
  );
  assert.equal(mapped.speakerName, "User mapping");
});
