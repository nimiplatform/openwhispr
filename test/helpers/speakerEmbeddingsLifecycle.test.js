const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "./tokenStore")
    return {
      getState: () => ({ token: null, generation: 0 }),
      getGeneration: () => 0,
      subscribe() {},
    };
  if (request === "./debugLogger") return { warn() {}, debug() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const { SpeakerEmbeddings } = require("../../src/helpers/speakerEmbeddings");
Module._load = originalLoad;
const vectors = require("../../src/helpers/speakerRepresentation");
const actualFixture = {
  vector: [0.12345678901234, -0.25, 0.75],
  spaceId: "declared-fixture-space",
};
function harness() {
  const calls = [];
  let selected = "loadout-A",
    revision = "1",
    submitGate,
    result = actualFixture;
  const services = {
    aiConfig: {
      async get() {
        return {
          revision,
          config: { capabilities: [{ capabilityContract: "audio.speaker.embed", route: "local" }] },
          effectiveSelections: [
            {
              capabilityContract: "audio.speaker.embed",
              state: "ready",
              resource: { oneofKind: "local", local: { loadoutRef: selected } },
            },
          ],
        };
      },
    },
    ai: {
      scenarioJobs: {
        async submit(spec, options) {
          calls.push(["submit", spec, options]);
          if (submitGate) await submitGate;
          return { job: { jobId: "speaker-test-job", status: "queued" } };
        },
        async get(id) {
          calls.push(["get", id]);
          return { job: { jobId: id, status: "completed", speakerEmbedding: result } };
        },
        async cancel(id) {
          calls.push(["cancel", id]);
        },
        async subscribe(id) {
          calls.push(["subscribe", id]);
          return {
            async *[Symbol.asyncIterator]() {
              yield { job: { jobId: id, status: "completed" } };
            },
            async cancel() {
              calls.push(["close"]);
            },
          };
        },
      },
    },
  };
  const owner = new SpeakerEmbeddings();
  owner.bind(services);
  return {
    owner,
    calls,
    services,
    setSelection(value) {
      selected = value;
    },
    setRevision(value) {
      revision = value;
    },
    setGate(value) {
      submitGate = value;
    },
    setResult(value) {
      result = value;
    },
  };
}
const samples = () => Float32Array.from({ length: 16000 * 10 }, (_, i) => Math.sin(i / 10) * 0.3);
test("original float samples reach the bounded public speaker Job and actual persisted vector is preserved", async () => {
  const h = harness(),
    source = samples();
  const result = await h.owner.extractEmbeddingFromSamples(source);
  assert.deepEqual(result, actualFixture);
  const [, spec, options] = h.calls[0];
  assert.equal(spec.type, "audio-speaker-embed");
  assert.equal(spec.mimeType, "audio/wav");
  assert.deepEqual(options, { timeoutMs: 120000 });
  const wav = spec.audioSource.bytes;
  assert.equal(wav.readUInt16LE(20), 3);
  assert.equal(wav.length, 44 + 16000 * 8 * 4);
  assert.equal(wav.readFloatLE(44), source[16000 * 2]);
  assert.equal(wav.readFloatLE(wav.length - 4), source.at(-1));
  assert.equal(h.owner.pending.size, 0);
});
test("public subscription events are summaries and Get supplies the persisted final vector", async () => {
  const h = harness();
  let reads = 0;
  h.services.ai.scenarioJobs.get = async (id) => ({
    job:
      ++reads === 1
        ? { jobId: id, status: "running" }
        : { jobId: id, status: "completed", speakerEmbedding: actualFixture },
  });
  assert.deepEqual(await h.owner.extractEmbeddingFromSamples(samples()), actualFixture);
  assert.ok(h.calls.some(([method]) => method === "subscribe"));
  assert.ok(h.calls.some(([method]) => method === "close"));
});
test("cancel during submission retires the returned Job and cannot deliver an old result", async () => {
  const h = harness();
  let release;
  const controller = new AbortController();
  h.setGate(
    new Promise((resolve) => {
      release = resolve;
    })
  );
  const pending = h.owner.extractEmbeddingFromSamples(samples(), { signal: controller.signal });
  await new Promise(setImmediate);
  controller.abort();
  release();
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(h.calls.some(([method, id]) => method === "cancel" && id === "speaker-test-job"));
});
test("Host invalidation and business ABA generations refuse late vectors", async () => {
  for (const change of [
    (h) => h.owner.invalidate(),
    (h) => {
      h.generation++;
    },
  ]) {
    const h = harness();
    h.generation = 0;
    h.owner.getAuthGeneration = () => h.generation;
    let release;
    h.setGate(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const pending = h.owner.extractEmbeddingFromSamples(samples());
    await new Promise(setImmediate);
    change(h);
    release();
    await assert.rejects(pending);
    assert.equal(h.owner.pending.size, 0);
  }
});
test("only the speaker execution selection matters, and malformed results do not become success", async () => {
  const h = harness();
  h.services.ai.scenarioJobs.get = async (id) => {
    h.setRevision("unrelated-revision");
    return { job: { jobId: id, status: "completed", speakerEmbedding: actualFixture } };
  };
  assert.deepEqual(await h.owner.extractEmbeddingFromSamples(samples()), actualFixture);
  h.services.ai.scenarioJobs.get = async (id) => {
    h.setSelection("replacement-loadout");
    return { job: { jobId: id, status: "completed", speakerEmbedding: actualFixture } };
  };
  await assert.rejects(h.owner.extractEmbeddingFromSamples(samples()), {
    code: "SPEAKER_CONTEXT_CHANGED",
  });
  const bad = harness();
  bad.setResult({ vector: [0, 0], spaceId: "space" });
  await assert.rejects(bad.owner.extractEmbeddingFromSamples(samples()));
});
test("same-size foreign spaces and unmarked historical arrays cannot be compared or averaged", () => {
  const other = { ...actualFixture, spaceId: "foreign-fixture" };
  assert.equal(vectors.cosineSimilarity(actualFixture, other), null);
  assert.equal(vectors.cosineSimilarity(actualFixture, actualFixture.vector), null);
  assert.throws(() => vectors.computeCentroid([actualFixture, other]));
  assert.throws(() => vectors.computeCentroid([]));
  assert.deepEqual(vectors.computeCentroid([actualFixture, actualFixture]), actualFixture);
  assert.equal(
    vectors.cosineSimilarity(
      { vector: [1e300, 1e300], spaceId: "large" },
      { vector: [1e300, 1e300], spaceId: "large" }
    ),
    1
  );
});
