const test = require("node:test");
const assert = require("node:assert/strict");
const {
  groupMeetingTranscript,
  meetingGroupSelectionToggles,
} = require("../../src/utils/meetingTranscriptGroups.ts");

function word(text, index, overrides = {}) {
  return {
    id: `recording-a:system:0:${index}`,
    text,
    source: "system",
    timestamp: 1000 + index * 100,
    endTimestamp: 1100 + index * 100,
    clockBasis: "capture",
    speaker: "person-a",
    ...overrides,
  };
}

test("Chinese words form a readable turn without changing any member or raw evidence", () => {
  const recognition = { transcript: { text: "明天上午10点开会" } };
  const units = ["明", "天", "上", "午", "10", "点", "开", "会"].map((text, i) =>
    Object.freeze(word(text, i, i ? {} : { recognition }))
  );
  const before = JSON.stringify(units);
  Object.freeze(units);
  const groups = groupMeetingTranscript(units);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].text, "明天上午10点开会");
  assert.deepEqual(groups[0].units, units);
  assert.ok(groups[0].units.every((unit, i) => unit === units[i]));
  assert.equal(groups[0].units[0].recognition, recognition);
  assert.equal(JSON.stringify(units), before);
});

test("English spacing, original whitespace and punctuation remain readable", () => {
  const groups = groupMeetingTranscript(
    ["Hello", ",", " world", "!", "Next", "sentence", "."].map((text, i) => word(text, i))
  );
  assert.deepEqual(
    groups.map((group) => group.text),
    ["Hello, world!", "Next sentence."]
  );
});

test("simultaneous tracks form separate turns despite interleaved raw words", () => {
  const system = [word("Remote", 0), word("reply", 1)];
  const mic = [0, 1].map((i) =>
    word(["My", "reply"][i], i, {
      id: `recording-a:mic:0:${i}`,
      source: "mic",
      timestamp: 1050 + i * 100,
      endTimestamp: 1150 + i * 100,
    })
  );
  const groups = groupMeetingTranscript([system[0], mic[0], system[1], mic[1]]);
  assert.deepEqual(
    groups.map((group) => group.text),
    ["Remote reply", "My reply"]
  );
  assert.deepEqual(
    groups.map((group) => group.units),
    [system, mic]
  );
});

test("recording boundaries remain separate even for the same named person and clock", () => {
  const groups = groupMeetingTranscript(
    [word("first", 0), word("second", 1, { id: "recording-b:system:0:0" }), word("third", 2)],
    { "person-a": "Alice" }
  );
  assert.equal(groups.length, 3);
  assert.notEqual(groups[0].attribution, groups[1].attribution);
});

test("chunk boundaries alone do not split a continuous person on the same track", () => {
  const units = [word("hello", 0), word("there", 1, { id: "recording-a:system:240000:0" })];
  assert.equal(groupMeetingTranscript(units)[0].text, "hello there");
});

test("different raw people remain separate even when mapped to the same name", () => {
  const groups = groupMeetingTranscript(
    [word("one", 0), word("two", 1, { speaker: "person-b" }), word("three", 2)],
    { "person-a": "Alice", "person-b": "Alice" }
  );
  assert.equal(groups.length, 3);
});

test("speaker corrections, suggestions and matching states split attribution", () => {
  for (const patch of [
    { speakerName: "Bob", speakerLocked: true, speakerStatus: "locked" },
    { speakerMatching: "ambiguous-overlap" },
    { suggestedName: "Bob", suggestedProfileId: 2 },
    { speakerStatus: "provisional" },
    { speakerIsPlaceholder: true },
  ]) {
    assert.equal(groupMeetingTranscript([word("one", 0), word("two", 1, patch)]).length, 2);
  }
});

test("unknown and ambiguous words gain no invented speaker", () => {
  const units = [
    word("不", 0, { speaker: undefined, speakerMatching: "unassigned-interval" }),
    word("明", 1, { speaker: undefined, speakerMatching: "unassigned-interval" }),
    word("混音", 2, { speaker: undefined, speakerMatching: "ambiguous-overlap" }),
  ];
  const groups = groupMeetingTranscript(units);
  assert.deepEqual(
    groups.map((group) => group.text),
    ["不明", "混音"]
  );
  assert.ok(
    groups.flatMap((group) => group.units).every((unit) => !unit.speaker && !unit.speakerName)
  );
});

test("clear pauses, clock regressions or missing timing do not merge", () => {
  for (const patch of [
    { timestamp: 2601, endTimestamp: 2700 },
    { timestamp: 900, endTimestamp: 1000 },
    { timestamp: undefined },
    { endTimestamp: undefined },
    { endTimestamp: 1000 },
    { clockBasis: "arrival" },
  ]) {
    assert.equal(groupMeetingTranscript([word("one", 0), word("two", 1, patch)]).length, 2);
  }
});

test("whole-segment input stays intact and does not join nearby words", () => {
  const paragraph = word("A complete existing paragraph.", 1, { id: "whole-segment" });
  const groups = groupMeetingTranscript([word("before", 0), paragraph, word("after", 2)]);
  assert.equal(groups.length, 3);
  assert.equal(groups[1].units[0], paragraph);
  assert.equal(groups[1].text, paragraph.text);
});

test("selection targets all raw members, fills partial selection, then clears the group", () => {
  const group = groupMeetingTranscript([word("明", 0), word("天", 1), word("开会", 2)])[0];
  const ids = group.units.map((unit) => unit.id);
  assert.deepEqual(meetingGroupSelectionToggles(group, new Set()), ids);
  assert.deepEqual(
    meetingGroupSelectionToggles(group, new Set([ids[0], "unrelated"])),
    ids.slice(1)
  );
  assert.deepEqual(meetingGroupSelectionToggles(group, new Set(ids)), ids);
});
