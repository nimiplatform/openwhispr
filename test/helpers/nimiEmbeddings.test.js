const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const original = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "./tokenStore")
    return {
      getState: () => ({ token: null, generation: 0 }),
      getGeneration: () => 0,
      subscribe() {},
    };
  return original.call(this, request, parent, isMain);
};
const { NimiEmbeddings } = require("../../src/helpers/nimiEmbeddings");
Module._load = original;

test("retrieval purpose is carried unchanged for every batch without model-specific text", async () => {
  const h = harness();
  for (const purpose of ["retrieval-document", "retrieval-query"]) {
    const values = Array.from({ length: 17 }, (_, index) => `Actual text ${index}`);
    await h.embeddings.embedTexts(values, { purpose });
    const calls = h.calls.slice(-2);
    assert.deepEqual(
      calls.flatMap((call) => call.spec.inputs),
      values
    );
    assert.ok(calls.every((call) => call.spec.purpose === purpose));
  }
});
function harness() {
  let account = "a",
    auth = 0,
    revision = "1",
    loadoutRef = "selected",
    spaceId = "runtime-space-a";
  const calls = [];
  const services = {
    aiConfig: {
      get: async () => ({
        revision,
        effectiveSelections: [
          {
            capabilityContract: "text.embed",
            state: "ready",
            resource: {
              oneofKind: "local",
              local: {
                loadoutRef,
                implementation: {
                  implementationId: "embed",
                  driverId: "unit-driver",
                  driverDialect: "unit-dialect",
                },
                configuredFeatures: [],
              },
            },
          },
        ],
      }),
    },
    ai: {
      scenario: {
        execute: async (spec, options) => {
          calls.push({ spec, options });
          return {
            output: {
              type: "text-embed",
              spaceId,
              vectors: spec.inputs.map((input) => [input.length, 1, 2]),
            },
          };
        },
      },
    },
  };
  const embeddings = new NimiEmbeddings({
    getAccountId: () => account,
    getAuthGeneration: () => auth,
  });
  embeddings.bind(services);
  return {
    embeddings,
    calls,
    services,
    setAccount: (value) => {
      account = value;
    },
    setAuth: (value) => {
      auth = value;
    },
    setRevision: (value) => {
      revision = value;
    },
    setLoadout: (value) => {
      loadoutRef = value;
    },
    setSpace: (value) => {
      spaceId = value;
    },
  };
}
test("protected embedding batches retain input order and actual Runtime space/dimensions", async () => {
  const h = harness();
  const inputs = Array.from({ length: 35 }, (_, i) => "x".repeat(i + 1));
  const result = await h.embeddings.embedTexts(inputs);
  assert.deepEqual(
    h.calls.map((call) => call.spec.inputs.length),
    [16, 16, 3]
  );
  assert.deepEqual(
    result.vectors.map((vector) => vector[0]),
    inputs.map((text) => text.length)
  );
  assert.equal(result.spaceId, "runtime-space-a");
  assert.equal(result.dimensions, 3);
  assert.ok(
    h.calls.every(
      (call) =>
        call.spec.type === "text-embed" &&
        !Object.hasOwn(call.spec, "model") &&
        call.options.signal instanceof AbortSignal
    )
  );
});
test("space changes inside a multi-call batch reject the entire result", async () => {
  const h = harness();
  const execute = h.services.ai.scenario.execute;
  h.services.ai.scenario.execute = async (...args) => {
    const result = await execute(...args);
    h.setSpace("runtime-space-b");
    return result;
  };
  await assert.rejects(h.embeddings.embedTexts(Array(17).fill("note")), {
    code: "EMBEDDING_CONTEXT_CHANGED",
  });
});
test("selection edits and business-login ABA cannot publish late embeddings", async () => {
  for (const change of [
    (h) => h.setLoadout("replacement-loadout"),
    (h) => {
      h.setAccount(null);
      h.setAccount("a");
      h.setAuth(2);
    },
  ]) {
    const h = harness();
    const execute = h.services.ai.scenario.execute;
    h.services.ai.scenario.execute = async (...args) => {
      const result = await execute(...args);
      change(h);
      return result;
    };
    await assert.rejects(h.embeddings.embedText("note"), { code: "EMBEDDING_CONTEXT_CHANGED" });
  }
});
test("session retirement aborts the actual public SDK call and invalidates prior leases", async () => {
  const h = harness();
  const lease = await h.embeddings.embedText("saved note");
  h.services.ai.scenario.execute = (_spec, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    );
  const pending = h.embeddings.embedText("query");
  await new Promise((resolve) => setImmediate(resolve));
  h.embeddings.invalidate();
  await assert.rejects(pending, { name: "AbortError" });
  assert.throws(lease.assertCurrent, { code: "EMBEDDING_CONTEXT_CHANGED" });
});
test("malformed count, dimensions and nonfinite vectors fail rather than inventing an index", async () => {
  for (const vectors of [[], [[1], [2]], [[]], [[NaN]], [[Infinity]]]) {
    const h = harness();
    h.services.ai.scenario.execute = async () => ({
      output: { type: "text-embed", spaceId: "space", vectors },
    });
    await assert.rejects(h.embeddings.embedText("query"), /Invalid Nimi embedding/);
  }
});
test("absent configuration never starts inference and retired idle leases cannot write", async () => {
  const h = harness();
  const lease = await h.embeddings.embedText("query");
  await h.embeddings.unload();
  assert.throws(lease.assertCurrent, { code: "EMBEDDING_CONTEXT_CHANGED" });
  h.services.aiConfig.get = async () => ({ revision: "1", effectiveSelections: [] });
  await assert.rejects(h.embeddings.embedText("query"), /Configure an available/);
  assert.equal(h.calls.length, 1);
});

test("unrelated AIConfig CAS revision changes retain the same embedding execution and space", async () => {
  const h = harness();
  const execute = h.services.ai.scenario.execute;
  h.services.ai.scenario.execute = async (...args) => {
    const result = await execute(...args);
    h.setRevision("2");
    return result;
  };
  const result = await h.embeddings.embedText("note");
  await result.assertValid();
  assert.equal(result.spaceId, "runtime-space-a");
  assert.equal(h.calls.length, 1);
});

test("a caller cancellation reaches the protected SDK execute signal", async () => {
  const h = harness();
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  h.services.ai.scenario.execute = (_spec, { signal }) =>
    new Promise((_resolve, reject) => {
      entered();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  const pending = h.embeddings.embedText("query", { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("note embedding includes saved speech alongside manual/summary text without JSON metadata", () => {
  const raw = JSON.stringify([{ text: "独有的追加发言", id: "DO_NOT_INDEX_JOB" }]);
  const text = NimiEmbeddings.noteEmbedText("Title", "Manual", "Summary", raw);
  assert.match(text, /Title\nSummary\n独有的追加发言/);
  assert.doesNotMatch(text, /DO_NOT_INDEX_JOB|\{"/);
});
