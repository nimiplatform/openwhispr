const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { NimiMeetingAudio } = require("../../src/helpers/nimiMeetingAudio");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function root(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "nimi-meeting-unit-"));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}
// Declared ASR fixtures; the PCM spool, headers, scheduling and scope are actual App code.
test("meeting disk cursors retain long PCM while at most two jobs and one per source execute", async (t) => {
  const controller = new AbortController();
  const requests = [],
    results = [];
  const work = new NimiMeetingAudio({
    root: root(t),
    signal: controller.signal,
    assertCurrent() {},
    windowSeconds: 1,
    transcribe: (audio) => new Promise((resolve) => requests.push({ audio, resolve })),
    onResult: (value) => results.push(value),
  });
  const pcm = Buffer.alloc(24000 * 2 * 3, 1);
  work.push("mic", pcm, 1000);
  work.push("system", pcm, 1200);
  assert.equal(requests.length, 2);
  assert.equal(work.pending.size, 2);
  const completing = work.finish();
  let index = 0;
  while (index < 6) {
    assert.ok(work.pending.size <= 2);
    if (!requests[index]) {
      await tick();
      continue;
    }
    const request = requests[index++];
    assert.equal(request.audio.readUInt32LE(24), 24000);
    assert.equal(request.audio.readUInt32LE(40), 48000);
    request.resolve({ transcript: { text: "declared真实中文回包", words: [] }, jobId: "unit" });
    await tick();
  }
  const final = await completing;
  assert.equal(final.length, 6);
  assert.deepEqual(
    final.filter((value) => value.source === "mic").map((value) => value.startFrame),
    [0, 24000, 48000]
  );
  assert.ok(final.every((value) => value.clockBasis === "capture"));
  const directory = work.directory;
  await work.close();
  assert.equal(fs.existsSync(directory), false);
});
test("explicit finish includes the actual short tail and source clock offset", async (t) => {
  const controller = new AbortController();
  const work = new NimiMeetingAudio({
    root: root(t),
    signal: controller.signal,
    assertCurrent() {},
    transcribe: async (audio) => ({
      transcript: { text: "尾部", words: [] },
      length: audio.length,
    }),
  });
  work.push("mic", Buffer.alloc(2400 * 2), 7000);
  assert.equal(work.pending.size, 0);
  const results = await work.finish();
  assert.equal(results.length, 1);
  assert.equal(results[0].startFrame, 0);
  assert.equal(results[0].endFrame, 2400);
  assert.equal(results[0].anchorMs, 7000);
  await work.close();
});
test("retired meeting scope cannot publish a late result or replay queued audio", async (t) => {
  const controller = new AbortController();
  let finish;
  const delivered = [];
  const work = new NimiMeetingAudio({
    root: root(t),
    signal: controller.signal,
    assertCurrent() {},
    windowSeconds: 1,
    transcribe: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    onResult: (value) => delivered.push(value),
  });
  work.push("mic", Buffer.alloc(24000 * 2 * 4));
  controller.abort();
  finish({ transcript: { text: "late" } });
  await tick();
  await assert.rejects(work.finish(), { name: "AbortError" });
  assert.deepEqual(delivered, []);
  assert.equal(work.sources.get("mic").cursor, 24000);
  await work.close();
});

test("public no-speech window leaves the meeting open for actual later speech and retained full media", async (t) => {
  const controller = new AbortController();
  let count = 0;
  const { projectMeetingTranscript } = require("../../src/helpers/nimiMeetingTranscript");
  const segments = [];
  const directory = root(t);
  const work = new NimiMeetingAudio({
    root: directory,
    signal: controller.signal,
    assertCurrent() {},
    windowSeconds: 1,
    transcribe: async () => ({
      transcript:
        ++count === 1
          ? { status: "no-speech", text: "", language: "", words: [] }
          : {
              status: "transcribed",
              text: "后续语音",
              language: "zh",
              words: [{ text: "后续语音", startSeconds: 0.2, endSeconds: 0.8 }],
            },
    }),
    onResult: (chunk) => segments.push(...projectMeetingTranscript(chunk, "actual-scope-fixture")),
  });
  const quiet = Buffer.alloc(48000),
    speech = Buffer.alloc(48000, 3);
  work.push("mic", quiet, 1000);
  await tick();
  assert.equal(work.failure, null);
  assert.deepEqual(segments, []);
  work.push("mic", speech);
  const results = await work.finish();
  assert.equal(results.length, 2);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].timestamp, 2200);
  const retained = await work.retain(path.join(directory, "retained"));
  const audio = fs.readFileSync(retained.tracks[0].path);
  assert.deepEqual(audio.subarray(44), Buffer.concat([quiet, speech]));
  await Promise.all([work.close(), work.close()]);
  assert.equal(fs.existsSync(retained.tracks[0].path), true);
});
