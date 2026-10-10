const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

test("actual dictation processor converts, emits full buffers, flushes partial samples and retires", async () => {
  const { PCM_WORKLET_SOURCE } = await import("../../src/helpers/pcmWorklet.js");
  let Processor;
  const messages = [];
  vm.runInNewContext(PCM_WORKLET_SOURCE, {
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (data) => messages.push(data) };
      }
    },
    registerProcessor: (name, ctor) => {
      assert.equal(name, "pcm-streaming-processor");
      Processor = ctor;
    },
    Int16Array,
  });
  const processor = new Processor();
  processor.process([[new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2])]]);
  processor.port.onmessage({ data: "stop" });
  assert.deepEqual(
    [...new Int16Array(messages[0])],
    [-32768, -32768, -16384, 0, 16383, 32767, 32767]
  );
  assert.equal(messages[1], "flushed");
  assert.equal(processor.process([[new Float32Array([1])]]), false);
  processor.port.onmessage({ data: "stop" });
  assert.equal(messages.length, 2);
  const full = new Processor();
  full.process([[new Float32Array(4100).fill(0.25)]]);
  assert.equal(new Int16Array(messages[2]).length, 4096);
  full.port.onmessage({ data: "stop" });
  assert.equal(new Int16Array(messages[3]).length, 4);
  assert.equal(messages[4], "flushed");
});
