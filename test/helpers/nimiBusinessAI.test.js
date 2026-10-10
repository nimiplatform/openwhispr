const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWorkspacePolicyManager } = require("../../src/helpers/workspacePolicyManager");
let state = { token: null, generation: 0 };
const loader = Module._load;
Module._load = function (name, parent, main) {
  if (name === "electron")
    return { app: { getPath: () => process.cwd(), isReady: () => false, isPackaged: false } };
  if (name === "./tokenStore")
    return {
      getState: () => ({ ...state }),
      getGeneration: () => state.generation,
      subscribe() {},
    };
  if (name === "./i18nMain") return { i18nMain: { t: (key) => key } };
  return loader.call(this, name, parent, main);
};
const guard = require("../../src/helpers/nimiBusinessAI");
const { NimiEmbeddings } = require("../../src/helpers/nimiEmbeddings");
const ai = require("../../src/helpers/nimiAI");
Module._load = loader;

test("guest and explicitly unmanaged business identities keep AI access", async () => {
  state = { token: null, generation: 0 };
  guard.configure(undefined);
  await guard.assertAllowed();
  state = { token: "business-fixture", generation: 1 };
  guard.configure(async () => ({
    success: true,
    managed: false,
    endpointSupported: true,
    status: "current",
  }));
  await guard.assertAllowed();
});
test("managed, unresolved and failed business policy cannot admit Nimi execution", async () => {
  state = { token: "business-fixture", generation: 1 };
  guard.configure(async () => ({
    success: true,
    managed: true,
    policy: { llm: { allowedModes: ["local"] } },
  }));
  await assert.rejects(guard.assertAllowed(), { code: "BUSINESS_AI_POLICY_UNSUPPORTED" });
  for (const context of [null, { success: false }, { success: true }]) {
    guard.configure(async () => context);
    await assert.rejects(guard.assertAllowed(), { code: "BUSINESS_AI_POLICY_UNRESOLVED" });
  }
  guard.configure(async () => {
    throw new Error("network failure");
  });
  await assert.rejects(guard.assertAllowed(), { code: "BUSINESS_AI_POLICY_UNRESOLVED" });
});
test("an account generation replacement during policy lookup never adopts its answer", async () => {
  state = { token: "business-fixture", generation: 1 };
  guard.configure(async () => {
    state = { token: "replacement", generation: 2 };
    return { success: true, managed: false, endpointSupported: true, status: "current" };
  });
  await assert.rejects(guard.assertAllowed(), { code: "BUSINESS_AI_POLICY_UNRESOLVED" });
});
test("background embedding refresh sends no model request under managed policy", async () => {
  state = { token: "business-fixture", generation: 1 };
  guard.configure(async () => ({ success: true, managed: true }));
  let executions = 0;
  const embeddings = new NimiEmbeddings();
  embeddings.bind({
    aiConfig: {
      get: async () => ({
        config: { capabilities: [] },
        effectiveSelections: [
          {
            capabilityContract: "text.embed",
            state: "ready",
            resource: {
              oneofKind: "local",
              local: { loadoutRef: "fixture", implementation: {}, configuredFeatures: [] },
            },
          },
        ],
      }),
    },
    ai: {
      scenario: {
        execute: async () => {
          executions++;
          throw new Error("must not execute");
        },
      },
    },
  });
  await assert.rejects(embeddings.embedTexts(["existing note"]), {
    code: "BUSINESS_AI_POLICY_UNSUPPORTED",
  });
  assert.equal(executions, 0);
});

test("Host editing, transcription and CLI cannot dispatch model work for managed policy", async () => {
  state = { token: "business-fixture", generation: 1 };
  guard.configure(async () => ({ success: true, managed: true }));
  let executions = 0;
  ai.bindServices({
    ai: {
      scenario: {
        execute: async () => {
          executions++;
          throw new Error("must not execute");
        },
      },
      scenarioJobs: {
        submit: async () => {
          executions++;
          throw new Error("must not submit");
        },
      },
    },
  });
  const event = { sender: { id: 44 } };
  await assert.rejects(
    ai.commandHandlers["openwhispr.ai.edit-text"]({
      event,
      payload: { requestId: "managed-edit", text: "note", systemPrompt: "edit" },
    }),
    { code: "BUSINESS_AI_POLICY_UNSUPPORTED" }
  );
  await assert.rejects(
    ai.commandHandlers["openwhispr.ai.transcribe"]({
      event,
      payload: { requestId: "managed-asr", audio: new Uint8Array([1]), mimeType: "audio/wav" },
    }),
    { code: "BUSINESS_AI_POLICY_UNSUPPORTED" }
  );
  await assert.rejects(ai.commandHandlers["openwhispr.business.ai-access"]({ payload: {} }), {
    code: "BUSINESS_AI_POLICY_UNSUPPORTED",
  });
  await assert.rejects(ai.transcribeCliFile({ filePath: "not-read-under-denial.wav" }), {
    code: "BUSINESS_AI_POLICY_UNSUPPORTED",
  });
  assert.equal(executions, 0);
  ai.invalidate();
});

test("real unsupported policy endpoint replies never grant model execution", async (t) => {
  state = { token: "business-fixture", generation: 1 };
  let executions = 0;
  ai.bindServices({
    ai: {
      scenario: {
        execute: async () => {
          executions++;
          throw new Error("must not execute");
        },
      },
    },
  });
  for (const status of [404, 501]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimi-policy-unsupported-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const manager = createWorkspacePolicyManager({
      cachePath: path.join(dir, "policy.json"),
      getApiUrl: () => "https://business.example",
      getAppVersion: () => "1.10.2",
      proxyFetch: async () => new Response("{}", { status }),
      tokenStore: { getState: () => ({ ...state }) },
      logger: { error() {}, warn() {} },
    });
    const request = { accountId: "business-account", expectedAuthGeneration: 1 };
    const reply = await manager.getPolicy(request);
    assert.equal(reply.success, true);
    assert.equal(reply.managed, false);
    assert.equal(reply.endpointSupported, false);
    guard.configure(() => manager.getPolicy(request));
    await assert.rejects(
      ai.commandHandlers["openwhispr.ai.edit-text"]({
        event: { sender: { id: 55 } },
        payload: { requestId: `unsupported-${status}`, text: "note", systemPrompt: "edit" },
      }),
      { code: "BUSINESS_AI_POLICY_UNRESOLVED" }
    );
  }
  assert.equal(executions, 0);
  ai.invalidate();
});
