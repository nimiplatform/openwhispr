const test = require("node:test");
const assert = require("node:assert/strict");
const load = () => import("../../src/helpers/nimiPreview.js");
const turn = () => new Promise((resolve) => setImmediate(resolve));
// Declared ASR fixtures verify the App's window/cancellation mechanics, never model quality.
test("preview keeps one job and a bounded latest window of actual PCM frames", async () => {
  const { NimiPreview } = await load();
  const requests = [],
    texts = [];
  const preview = new NimiPreview({
    windowSeconds: 3,
    intervalSeconds: 1,
    transcribe: (audio, signal) =>
      new Promise((resolve) => requests.push({ audio, signal, resolve })),
    onText: (text, span) => texts.push({ text, span }),
  });
  preview.push(new Int16Array(16000).fill(1));
  await turn();
  assert.equal(requests.length, 1);
  preview.push(new Int16Array(64000).fill(2));
  assert.equal(preview.stored, 48000);
  assert.equal(requests.length, 1);
  requests[0].resolve({ transcript: { text: "真实回包一" } });
  await turn();
  await turn();
  assert.equal(requests.length, 2);
  assert.equal(texts[0].text, "真实回包一");
  const data = new DataView(requests[1].audio.buffer);
  assert.equal(data.getUint32(24, true), 16000);
  assert.equal(data.getUint32(40, true), 48000 * 2);
  assert.equal(data.getInt16(44, true), 2);
  requests[1].resolve({ transcript: { text: "真实回包二" } });
  await turn();
  assert.deepEqual(texts[1].span, { startFrame: 32000, endFrame: 80000, sampleRate: 16000 });
  preview.close();
});
test("close aborts the SDK scope and drops an ignored-cancellation late response without replay", async () => {
  const { NimiPreview } = await load();
  let settle, signal;
  const texts = [];
  const preview = new NimiPreview({
    intervalSeconds: 1,
    transcribe: (_audio, value) => {
      signal = value;
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
    onText: (text) => texts.push(text),
  });
  preview.push(new Int16Array(16000));
  await turn();
  preview.close();
  assert.equal(signal.aborted, true);
  settle({ transcript: { text: "late" } });
  await turn();
  preview.push(new Int16Array(16000));
  assert.equal(preview.stored, 0);
  assert.deepEqual(texts, []);
});
test("an actual preview error emits no invented text and never loops on the same window", async () => {
  const { NimiPreview } = await load();
  const errors = [],
    texts = [];
  let calls = 0;
  const failure = new Error("declared-platform-error");
  const preview = new NimiPreview({
    intervalSeconds: 1,
    transcribe: async () => {
      calls++;
      throw failure;
    },
    onText: (value) => texts.push(value),
    onError: (value) => errors.push(value),
  });
  preview.push(new Int16Array(16000));
  await turn();
  await turn();
  assert.equal(calls, 1);
  assert.equal(errors[0], failure);
  assert.deepEqual(texts, []);
  preview.close();
});
