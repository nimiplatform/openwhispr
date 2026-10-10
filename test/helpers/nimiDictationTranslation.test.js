const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

async function translationMethod(settings, translate) {
  const source = fs.readFileSync(require.resolve("../../src/helpers/audioManager.js"), "utf8");
  const parsed = ts.createSourceFile("audioManager.js", source, ts.ScriptTarget.Latest, true);
  const owner = parsed.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name.text === "AudioManager"
  );
  const method = owner.members.find(
    (node) => node.name?.getText(parsed) === "processTranscriptionWithNimi"
  );
  const { applyChineseScript, resolveChineseScriptTarget } =
    await import("../../src/utils/chineseScript");
  const context = vm.createContext({
    getSettings: () => settings,
    getAgentName: () => "Aria",
    getDictionaryHintWords: () => [],
    resolvePrompt: () => "translate",
    getLanguageLabel: (value) => value,
    shouldRunTranslateStep: (source, target) => source !== target,
    ReasoningService: { processText: translate },
  });
  const run = vm.runInContext(
    `({${method.getText(parsed)}}).processTranscriptionWithNimi`,
    context
  );
  const state = {
    translationRequested: true,
    translationApplied: false,
    finalizeChineseScript(text) {
      const language = this.translationApplied
        ? settings.translationTargetLanguage
        : settings.preferredLanguage;
      return applyChineseScript(text, resolveChineseScriptTarget(language, "auto", text));
    },
  };
  return { run: run.bind(state), state };
}

for (const [source, target, text] of [
  ["zh-TW", "zh-CN", "这个软件"],
  ["zh-CN", "zh-TW", "這個軟體"],
]) {
  test(`Nimi dictation translation retains target script: ${source} to ${target}`, async () => {
    const { run, state } = await translationMethod(
      {
        preferredLanguage: source,
        translationSourceLanguage: source,
        translationTargetLanguage: target,
      },
      async () => text
    );
    assert.equal(await run("原文", () => false), text);
    assert.equal(state.translationApplied, true);
  });
}

test("a rejected or canceled translation never confirms translated output", async () => {
  const settings = {
    preferredLanguage: "zh-TW",
    translationSourceLanguage: "zh-TW",
    translationTargetLanguage: "zh-CN",
  };
  const failed = await translationMethod(settings, async () => {
    throw new Error("Runtime refused");
  });
  await assert.rejects(
    failed.run("原文", () => false),
    /Runtime refused/
  );
  assert.equal(failed.state.translationApplied, false);
  const controller = new AbortController();
  const canceled = await translationMethod(settings, async () => {
    controller.abort();
    return "迟到输出";
  });
  await assert.rejects(
    canceled.run("原文", () => controller.signal.aborted, controller.signal),
    (error) => error.name === "AbortError"
  );
  assert.equal(canceled.state.translationApplied, false);
});
