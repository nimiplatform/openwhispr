const test = require("node:test");
const assert = require("node:assert/strict");

test("Chinese alignment becomes readable paragraphs without changing raw words or clocks", async () => {
  const { groupImportedTranscript } = await import("../../src/utils/importedTranscript.ts");
  const text = "这是测试。下面继续。";
  const units = Array.from(text, (text, i) => ({
    id: String(i),
    text,
    timestamp: 1000 + i * 100,
    endTimestamp: 1100 + i * 100,
  }));
  const snapshot = JSON.stringify(units);
  const groups = groupImportedTranscript(units, text);
  assert.deepEqual(
    groups.map((g) => g.text),
    ["这是测试。", "下面继续。"]
  );
  assert.deepEqual(
    groups.flatMap((g) => g.units),
    units
  );
  assert.equal(JSON.stringify(units), snapshot);
  assert.ok(
    groups
      .flatMap((g) => g.units)
      .every((unit) => unit.source === undefined && unit.speaker === undefined)
  );
});

test("presentation retains original whitespace and speaker/lock boundaries", async () => {
  const { groupImportedTranscript } = await import("../../src/utils/importedTranscript.ts");
  const units = [
    { id: "a", text: "Hello", speaker: "voice-a", timestamp: 1000, endTimestamp: 1400 },
    { id: "b", text: "world.", speaker: "voice-a", timestamp: 1300, endTimestamp: 1700 },
    { id: "c", text: "Next.", speaker: "voice-b", timestamp: 1800, endTimestamp: 2400 },
    { id: "d", text: "Name", speaker: "voice-b", speakerName: "林遥", speakerLocked: true },
  ];
  const groups = groupImportedTranscript(units, "Hello  world.\nNext. Name");
  assert.equal(groups.map((g) => g.text).join(""), "Hello  world.\nNext. Name");
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups[0].units.map((s) => s.id),
    ["a", "b"]
  );
  assert.equal(groups[1].units[0].speaker, "voice-b");
  assert.equal(groups[2].units[0].speakerName, "林遥");
  assert.equal(groups[0].units[1].timestamp, 1300);
});

test("unassigned omitted punctuation uses the actual transcript without guessing voices", async () => {
  const { groupImportedTranscript } = await import("../../src/utils/importedTranscript.ts");
  const units = [
    { id: "a", text: "Hello" },
    { id: "b", text: "world" },
  ];
  const groups = groupImportedTranscript(units, "Hello, world!");
  assert.equal(groups[0].text, "Hello, world!");
  assert.equal(groups[0].units.length, 2);
  assert.equal(groups[0].units[0].speaker, undefined);
  assert.deepEqual(groupImportedTranscript([], ""), []);
});
