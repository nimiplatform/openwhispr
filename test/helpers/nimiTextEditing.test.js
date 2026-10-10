const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const load = Module._load;
Module._load = function (name, parent, main) {
  if (name === "electron")
    return { app: { getPath: () => process.cwd(), isReady: () => false, isPackaged: false } };
  if (name === "./tokenStore")
    return {
      getState: () => ({ token: null, generation: 0 }),
      getGeneration: () => 0,
      subscribe() {},
    };
  return load.call(this, name, parent, main);
};
const ai = require("../../src/helpers/nimiAI");
Module._load = load;
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function publicImageClient(execute, upload) {
  const { createNimiLocalAppAIConsumptionClient } = await import("@nimiplatform/sdk");
  const unused = () => Promise.reject(new Error("Unexpected fixture operation"));
  return createNimiLocalAppAIConsumptionClient({
    text: { streamTurn: unused },
    scenarioJobs: { submit: unused, get: unused, subscribe: unused, cancel: unused },
    artifacts: { read: unused, upload },
    voiceAssets: { list: unused, delete: unused },
    scenario: { execute },
  });
}

const imageInput = {
  mediaType: "image/png",
  data: Buffer.from("declared image bytes").toString("base64"),
};

test("Nimi selection edit carries the same image from the renderer branch through Main and public SDK", async (t) => {
  installBrowserGlobals(t);
  const uploads = [],
    calls = [],
    payloads = [];
  let outputMode = "complete";
  ai.bindServices({
    ai: await publicImageClient(
      async (spec, options) => {
        calls.push({ spec, options });
        const marker = spec.messages[0].text.match(
          /__OPENWHISPR_SELECTION_COMPLETE_[0-9a-f-]+__/
        )[0];
        return {
          traceId: "fixture-selection-image",
          output: {
            type: "text-generate",
            items: [
              {
                type: "text",
                text: `declared replacement${outputMode === "missing-marker" ? "" : marker}`,
              },
            ],
            finishReason: outputMode === "clipped" ? "length" : "stop",
          },
        };
      },
      async (input) => {
        uploads.push(input);
        return {
          artifactId: "fixture-image",
          mimeType: input.mimeType,
          sizeBytes: input.bytes.length,
        };
      }
    ),
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "nimi-selection-image-chain-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
      "/stores/settingsStore": `export const getSettings=()=>({uiLanguage:'en', preferredLanguage:'en', customDictionary:[], customPrompts:{}});export const useSettingsStore={getState:getSettings};`,
      nimiClient: `export const runNimiRequest=(...args)=>globalThis.__nimiSelectionInvoke(...args);export const invokeNimiBusiness=()=>{};export const getNimiClient=()=>{};export const prepareNimiAIWork=async()=>{};export const assertNimiBusinessAIAllowed=async()=>{};`,
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });
  const { createNimiRequestRunner } = await vite.ssrLoadModule("/services/nimiRequest.ts");
  globalThis.__nimiSelectionInvoke = createNimiRequestRunner(async (command, payload) => {
    if (command === "openwhispr.ai.edit-text") payloads.push(payload);
    return ai.commandHandlers[command]({ event: { sender: { id: 8 } }, payload });
  });
  t.after(() => {
    delete globalThis.__nimiSelectionInvoke;
    ai.invalidate();
  });
  const { default: AudioManager } = await vite.ssrLoadModule("/helpers/audioManager.js");
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isProcessing: true,
    voiceAgentRequested: true,
    screenContextPromise: Promise.resolve(imageInput),
    consumeSelectionCapture: async () => ({
      status: "selected",
      text: "selected original",
      sessionId: "real-selection-owner-fixture",
    }),
    assertAgentAllowedByPolicy() {},
  });
  const result = await manager.processTranscriptionWithNimi(
    "edit using the screen",
    () => false,
    new AbortController().signal
  );
  assert.equal(result, "declared replacement");
  assert.deepEqual(manager.pendingSelectionEdit, { sessionId: "real-selection-owner-fixture" });
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0].screenContext, imageInput);
  assert.equal(payloads[0].requireCompleteOutput, true);
  assert.equal(uploads.length, 1);
  assert.deepEqual(Buffer.from(uploads[0].bytes), Buffer.from(imageInput.data, "base64"));
  assert.equal(calls.length, 1);
  assert.match(calls[0].spec.messages[0].text, /screenshot/i);
  assert.match(calls[0].spec.messages[0].text, /SELECTION EDITING MODE/);
  assert.match(calls[0].spec.messages[0].text, /__OPENWHISPR_SELECTION_COMPLETE_/);
  assert.deepEqual(calls[0].spec.messages[1], {
    role: "user",
    text: "",
    parts: [
      {
        type: "text",
        text: JSON.stringify({
          spokenInstruction: "edit using the screen",
          selectedText: "selected original",
        }),
      },
      { type: "artifact-ref", artifactId: "fixture-image", mediaType: "image/png" },
    ],
  });
  assert.equal(calls[0].options.timeoutMs, 120000);
  manager.screenContextPromise = null;
  await manager.processTranscriptionWithNimi(
    "text-only command",
    () => false,
    new AbortController().signal
  );
  assert.equal(payloads[1].screenContext, undefined);
  assert.equal(uploads.length, 1);
  assert.equal(
    calls[1].spec.messages[1].text,
    JSON.stringify({ spokenInstruction: "text-only command", selectedText: "selected original" })
  );
  assert.doesNotMatch(calls[1].spec.messages[0].text, /screenshot/i);
  for (outputMode of ["clipped", "missing-marker"]) {
    manager.screenContextPromise = Promise.resolve(imageInput);
    manager.pendingSelectionEdit = null;
    const before = calls.length;
    await assert.rejects(
      manager.processTranscriptionWithNimi("edit", () => false, new AbortController().signal),
      { code: "SELECTION_EDIT_REASONING_FAILED" }
    );
    assert.equal(manager.pendingSelectionEdit, null);
    assert.equal(
      calls.length,
      before + 1,
      "incomplete image output is not replayed without the image"
    );
  }
});

test("invalid images are refused before upload or inference within the existing screenshot budget", async () => {
  let uploads = 0,
    executions = 0;
  ai.bindServices({
    ai: await publicImageClient(
      async () => {
        executions++;
      },
      async () => {
        uploads++;
      }
    ),
  });
  try {
    for (const screenContext of [
      null,
      { ...imageInput, mediaType: "text/plain" },
      { ...imageInput, data: "@@@@" },
      { ...imageInput, data: "AA" },
      { ...imageInput, path: "C:/arbitrary" },
      { ...imageInput, data: Buffer.alloc(1500001).toString("base64") },
    ]) {
      await assert.rejects(
        ai.commandHandlers["openwhispr.ai.edit-text"]({
          event: { sender: { id: 8 } },
          payload: {
            requestId: "invalid-image",
            text: "original",
            systemPrompt: "instruction",
            screenContext,
          },
        }),
        /Invalid selection screen image/
      );
    }
    assert.equal(uploads, 0);
    assert.equal(executions, 0);
  } finally {
    ai.invalidate();
  }
});

test("cancellation or session invalidation during image upload cannot dispatch or publish a late edit", async () => {
  for (const invalidateSession of [false, true]) {
    let finishUpload,
      beganUpload,
      executions = 0;
    const began = new Promise((resolve) => {
      beganUpload = resolve;
    });
    ai.bindServices({
      ai: await publicImageClient(
        async () => {
          executions++;
        },
        (input) =>
          new Promise((resolve) => {
            finishUpload = () =>
              resolve({
                artifactId: "fixture-image",
                mimeType: input.mimeType,
                sizeBytes: input.bytes.length,
              });
            beganUpload();
          })
      ),
    });
    const input = {
      event: { sender: { id: 8 } },
      payload: {
        requestId: "retired-image",
        text: "original",
        systemPrompt: "instruction",
        screenContext: imageInput,
      },
    };
    const pending = ai.commandHandlers["openwhispr.ai.edit-text"](input);
    await began;
    if (invalidateSession) ai.invalidate();
    else ai.commandHandlers["openwhispr.ai.cancel"](input);
    finishUpload();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(executions, 0);
    ai.invalidate();
  }
});

test("the original note editing command passes the real public SDK deadline and input validation", async () => {
  const { createNimiLocalAppAIConsumptionClient } = await import("@nimiplatform/sdk");
  const calls = [];
  const unused = () => Promise.reject(new Error("Unexpected fixture operation"));
  const client = createNimiLocalAppAIConsumptionClient({
    text: { streamTurn: unused },
    scenarioJobs: { submit: unused, get: unused, subscribe: unused, cancel: unused },
    artifacts: { read: unused, upload: unused },
    voiceAssets: { list: unused, delete: unused },
    scenario: {
      execute: async (input, options) => {
        calls.push({ input, options });
        return {
          traceId: "fixture-note-validation",
          output: {
            type: "text-generate",
            items: [{ type: "text", text: "Declared edited output" }],
            finishReason: "stop",
          },
        };
      },
    },
  });
  ai.bindServices({
    ai: client,
  });
  const result = await ai.commandHandlers["openwhispr.ai.edit-text"]({
    event: { sender: { id: 8 } },
    payload: {
      requestId: "editing-fixture",
      text: "原始正文",
      systemPrompt: "declared instruction",
      maxTokens: 4096,
      temperature: 0.3,
      disableThinking: true,
      inferenceScope: "noteFormatting",
      requireCompleteOutput: true,
    },
  });
  assert.equal(result.text, "Declared edited output");
  assert.deepEqual(calls[0].input.messages, [
    { role: "system", text: "declared instruction" },
    { role: "user", text: "原始正文" },
  ]);
  assert.equal(calls[0].input.maxTokens, 4096);
  assert.equal(calls[0].input.temperature, 0.3);
  assert.deepEqual(calls[0].input.reasoning, { activation: "disabled" });
  assert.equal(calls[0].options.timeoutMs, 120000);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  await assert.rejects(client.scenario.execute(calls[0].input, { timeoutMs: 600000 }), {
    reasonCode: "SDK_LOCAL_APP_INPUT_INVALID",
  });
  assert.equal(calls.length, 1, "the unsupported deadline is rejected before transport");
  ai.invalidate();
});

test("required complete output refuses a real length terminal", async () => {
  ai.bindServices({
    ai: {
      scenario: {
        execute: async () => ({
          output: {
            type: "text-generate",
            items: [{ type: "text", text: "Declared clipped output" }],
            finishReason: "length",
          },
        }),
      },
    },
  });
  await assert.rejects(
    ai.commandHandlers["openwhispr.ai.edit-text"]({
      event: { sender: { id: 8 } },
      payload: {
        requestId: "clipped-fixture",
        text: "original",
        systemPrompt: "instruction",
        requireCompleteOutput: true,
      },
    }),
    (error) => error.code === "AI_TEXT_OUTPUT_INCOMPLETE"
  );
  ai.invalidate();
});

test("canceled editing cannot publish a late response", async () => {
  let complete;
  let started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  ai.bindServices({
    ai: {
      scenario: {
        execute: async () =>
          new Promise((resolve) => {
            complete = resolve;
            started();
          }),
      },
    },
  });
  const input = {
    event: { sender: { id: 8 } },
    payload: { requestId: "cancel-fixture", text: "original", systemPrompt: "instruction" },
  };
  const pending = ai.commandHandlers["openwhispr.ai.edit-text"](input);
  await began;
  ai.commandHandlers["openwhispr.ai.cancel"](input);
  complete({
    output: {
      type: "text-generate",
      items: [{ type: "text", text: "late output" }],
      finishReason: "stop",
    },
  });
  await assert.rejects(pending, { name: "AbortError" });
  ai.invalidate();
});
