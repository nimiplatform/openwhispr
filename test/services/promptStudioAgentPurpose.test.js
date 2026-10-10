const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("Prompt Studio uses Nimi configuration, immutable drafts and request cancellation", async (t) => {
  const saved = {
    cleanup: "saved cleanup",
    dictationAgent: "saved agent",
    translate: "saved translate",
  };
  const harness = {
    saved,
    calls: [],
    getConfig: async () => ({
      effectiveSelections: [
        { capabilityContract: "text.generate", state: "ready", resource: null },
      ],
    }),
    generate: async () => "actual test fixture",
  };
  globalThis.__nimiPromptTest = harness;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-prompt-test-"));
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: path.resolve(__dirname, "../../src"),
    configFile: false,
    cacheDir,
    appType: "custom",
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true },
    plugins: [
      {
        name: "prompt-test-owner-dependencies",
        enforce: "pre",
        resolveId(source) {
          if (source.endsWith("/config/prompts"))
            return path.resolve(__dirname, "../../src/config/prompts/index.ts");
          for (const [suffix, id] of [
            ["/nimiClient", "client"],
            ["/ReasoningService", "reasoning"],
            ["/stores/settingsStore", "settings"],
            ["/utils/languageSupport", "language"],
            ["/utils/snippets", "dictionary"],
            ["/i18n", "i18n"],
          ])
            if (source.endsWith(suffix)) return "\0prompt-test-" + id;
        },
        load(id) {
          if (id === "\0prompt-test-client")
            return "export const getNimiClient=()=>({aiConfig:{get:()=>globalThis.__nimiPromptTest.getConfig()}});";
          if (id === "\0prompt-test-reasoning")
            return "export default {processText:async(...args)=>{globalThis.__nimiPromptTest.calls.push(args);return globalThis.__nimiPromptTest.generate(...args)}};";
          if (id === "\0prompt-test-settings")
            return "export const useSettingsStore={getState:()=>({customPrompts:globalThis.__nimiPromptTest.saved})};";
          if (id === "\0prompt-test-language")
            return "export const getLanguageLabel=x=>x; export const getLanguageInstruction=x=>x?'Language: '+x:'';";
          if (id === "\0prompt-test-dictionary")
            return "export const getDictionaryHintWords=s=>s.customDictionary;";
          if (id === "\0prompt-test-i18n")
            return "export const normalizeUiLanguage=x=>x;export default {getFixedT:()=>((k,o)=>o.defaultValue)};";
        },
      },
    ],
    server: { middlewareMode: true },
  });
  t.after(async () => {
    await vite.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
    delete globalThis.__nimiPromptTest;
  });
  const { testNimiPrompt } = await vite.ssrLoadModule("/services/nimiPromptTest.ts");
  const settings = {
    uiLanguage: "en",
    preferredLanguage: "zh",
    customDictionary: ["OpenWhispr"],
    translationTargetLanguage: "French",
    cleanupModel: "",
    dictationAgentModel: "",
    translationModel: "",
    cleanupDisableThinking: false,
    translationDisableThinking: true,
    dictationAgentDisableThinking: false,
  };
  const input = (kind, signal = new AbortController().signal) => ({
    kind,
    text: "  original input  ",
    draft: "{{agentName}} draft {{targetLanguage}}",
    agentName: "River",
    settings,
    signal,
    noModelMessage: "Nimi model unavailable",
  });
  for (const [kind, scope] of [
    ["cleanup", "dictationCleanup"],
    ["dictationAgent", "dictationAgent"],
    ["translate", "dictationTranslation"],
  ])
    await t.test(kind + " ignores retired empty provider/model fields", async () => {
      harness.calls.length = 0;
      const result = await testNimiPrompt(input(kind));
      assert.equal(result.text, "actual test fixture");
      assert.equal(harness.calls.length, 1);
      const [text, model, name, config] = harness.calls[0];
      assert.equal(model, "");
      assert.equal(name, "River");
      assert.equal(config.inferenceScope, scope);
      assert.equal(config.requiresAgent, kind === "dictationAgent");
      assert.equal(config.disableThinking, kind === "translate");
      assert.match(config.systemPrompt, /River draft/);
      assert.match(config.systemPrompt, /OpenWhispr/);
      if (kind === "translate") assert.match(config.systemPrompt, /French/);
      assert.equal(
        text,
        kind === "cleanup"
          ? "<transcript>\n  original input  \n</transcript>\n\nOutput only the cleaned transcript."
          : "  original input  "
      );
      assert.deepEqual(saved, {
        cleanup: "saved cleanup",
        dictationAgent: "saved agent",
        translate: "saved translate",
      });
    });
  await t.test("unavailable Nimi selection never dispatches", async () => {
    harness.calls.length = 0;
    harness.getConfig = async () => ({ effectiveSelections: [] });
    await assert.rejects(testNimiPrompt(input("cleanup")), /Nimi model unavailable/);
    assert.equal(harness.calls.length, 0);
  });
  await t.test("cancellation during config read never dispatches", async () => {
    harness.calls.length = 0;
    let resolveConfig;
    harness.getConfig = () =>
      new Promise((r) => {
        resolveConfig = r;
      });
    const controller = new AbortController();
    const pending = testNimiPrompt(input("translate", controller.signal));
    controller.abort();
    resolveConfig({
      effectiveSelections: [{ capabilityContract: "text.generate", state: "ready" }],
    });
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(harness.calls.length, 0);
  });
  await t.test("a late model result after cancel is discarded", async () => {
    harness.getConfig = async () => ({
      effectiveSelections: [{ capabilityContract: "text.generate", state: "ready" }],
    });
    let resolveModel, started;
    const ready = new Promise((r) => {
      started = r;
    });
    harness.generate = (text, model, name, config) =>
      new Promise((r) => {
        resolveModel = r;
        started(config);
      });
    const controller = new AbortController();
    const pending = testNimiPrompt(input("dictationAgent", controller.signal));
    const config = await ready;
    assert.equal(config.signal, controller.signal);
    controller.abort();
    resolveModel("late real return fixture");
    await assert.rejects(pending, { name: "AbortError" });
    assert.deepEqual(saved, {
      cleanup: "saved cleanup",
      dictationAgent: "saved agent",
      translate: "saved translate",
    });
  });
  await t.test("Nimi session errors are preserved without dispatch", async () => {
    harness.calls.length = 0;
    harness.getConfig = async () => {
      throw new Error("runtime-unauthenticated");
    };
    await assert.rejects(testNimiPrompt(input("cleanup")), /runtime-unauthenticated/);
    assert.equal(harness.calls.length, 0);
  });
});
