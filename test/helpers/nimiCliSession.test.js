const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const load = Module._load;
let authGeneration = 0;
let policyDenied = false;
let fileCalls = 0;
let fileWork = async () => ({ text: "declared CLI fixture", chunks: [] });
const selection = [{ capabilityContract: "audio.transcribe", state: "ready" }];
const services = { aiConfig: { get: async () => ({ effectiveSelections: selection }) } };
Module._load = function (name, parent, main) {
  if (name === "electron")
    return { app: { getPath: () => process.cwd(), isReady: () => false, isPackaged: false } };
  if (name === "./tokenStore") return { getGeneration: () => authGeneration, subscribe() {} };
  if (name === "./nimiBusinessAI")
    return {
      assertAllowed: async () => {
        if (policyDenied)
          throw Object.assign(new Error("policy blocked"), {
            code: "BUSINESS_AI_POLICY_UNSUPPORTED",
          });
      },
    };
  if (name === "./nimiFileTranscription")
    return {
      transcribeNimiFile: async (...args) => {
        fileCalls++;
        return fileWork(...args);
      },
      cleanupNimiFile() {},
    };
  return load.call(this, name, parent, main);
};
const ai = require("../../src/helpers/nimiAI");
Module._load = load;
test.beforeEach(() => {
  ai.invalidate();
  ai.configureSessionPreparation(undefined);
  authGeneration = 0;
  policyDenied = false;
  fileCalls = 0;
  fileWork = async () => ({ text: "declared CLI fixture", chunks: [] });
});
test.after(() => {
  ai.invalidate();
  ai.configureSessionPreparation(undefined);
});

test("an explicit CLI request prepares the same Host before binding its new business scope", async () => {
  let checks = 0;
  ai.configureSessionPreparation(async () => {
    checks++;
    ai.bindServices(services);
  });
  assert.deepEqual(await ai.cliTranscriptionSelection(), selection);
  assert.equal(
    (await ai.transcribeCliFile({ filePath: "declared.wav" })).text,
    "declared CLI fixture"
  );
  assert.equal(checks, 2);
  assert.equal(fileCalls, 1);
});

test("unavailable and canceled preparation never dispatch CLI media or replay it later", async () => {
  const failure = Object.assign(new Error("runtime-service-unavailable"), {
    reasonCode: "runtime-service-unavailable",
    retryable: true,
  });
  ai.configureSessionPreparation(async () => {
    throw failure;
  });
  await assert.rejects(
    ai.transcribeCliFile({ filePath: "declared.wav" }),
    (error) => error === failure
  );
  assert.equal(fileCalls, 0);
  let settle, entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  ai.configureSessionPreparation(
    () =>
      new Promise((resolve) => {
        settle = resolve;
        entered();
      })
  );
  const controller = new AbortController();
  const pending = ai.transcribeCliFile({ filePath: "declared.wav" }, controller.signal);
  await waiting;
  controller.abort();
  ai.bindServices(services);
  settle();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(fileCalls, 0);
  ai.configureSessionPreparation(async () => {});
  await ai.transcribeCliFile({ filePath: "new-explicit-request.wav" });
  assert.equal(fileCalls, 1);
});

test("Host invalidation, account ABA and changed policy refuse a prepared old request", async () => {
  ai.configureSessionPreparation(async () => {
    ai.invalidate();
    ai.bindServices(services);
  });
  await assert.rejects(ai.transcribeCliFile({ filePath: "declared.wav" }), {
    code: "NIMI_SESSION_CHANGED",
  });
  ai.configureSessionPreparation(async () => {
    authGeneration += 2;
  });
  await assert.rejects(ai.transcribeCliFile({ filePath: "declared.wav" }), {
    code: "NIMI_SESSION_CHANGED",
  });
  ai.configureSessionPreparation(async () => {
    policyDenied = true;
  });
  await assert.rejects(ai.transcribeCliFile({ filePath: "declared.wav" }), {
    code: "BUSINESS_AI_POLICY_UNSUPPORTED",
  });
  assert.equal(fileCalls, 0);
});

test("disconnect cancellation reaches admitted CLI work and refuses its late output", async () => {
  ai.bindServices(services);
  ai.configureSessionPreparation(async () => {});
  let entered, finish, scope;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  fileWork = async (value, _input, dependencies) => {
    scope = value;
    entered();
    await new Promise((resolve) => {
      finish = resolve;
    });
    dependencies.assertCurrent(scope);
    return { text: "late output", chunks: [] };
  };
  const controller = new AbortController();
  const pending = ai.transcribeCliFile({ filePath: "declared.wav" }, controller.signal);
  await waiting;
  controller.abort();
  assert.equal(scope.controller.signal.aborted, true);
  finish();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(fileCalls, 1);
});
