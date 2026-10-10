const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const keys = [
  "DICTATION_KEY",
  "VOICE_AGENT_KEY",
  "CHAT_AGENT_KEY",
  "TRANSLATION_KEY",
  "UI_LANGUAGE",
  "OPENAI_API_KEY",
  "OPENWHISPR_API_URL",
];
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-business-env-"));
  const snapshot = new Map(keys.map((k) => [k, process.env[k]]));
  const filename = require.resolve("../../src/helpers/environment");
  const original = require.cache[filename],
    loader = Module._load;
  delete require.cache[filename];
  Module._load = function (request, parent, main) {
    if (request === "./appData" && parent?.filename === filename)
      return { getAppDataDirectory: () => dir };
    if (request === "./i18nMain" && parent?.filename === filename)
      return { normalizeUiLanguage: (v) => v };
    return loader.call(this, request, parent, main);
  };
  let Environment;
  try {
    Environment = require(filename);
  } finally {
    Module._load = loader;
  }
  t.after(() => {
    for (const [k, v] of snapshot) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (original) require.cache[filename] = original;
    else delete require.cache[filename];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, Environment };
}
test("loads business settings while leaving historical provider keys unconsumed", (t) => {
  const { dir, Environment } = setup(t);
  delete process.env.OPENAI_API_KEY;
  fs.writeFileSync(
    path.join(dir, ".env"),
    'DICTATION_KEY="Control_R"\nOPENWHISPR_API_URL=https://business.example\nOPENAI_API_KEY=old-test-secret\n'
  );
  const env = new Environment();
  assert.equal(env.getDictationKey(), "Control_R");
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  assert.equal(process.env.OPENWHISPR_API_URL, "https://business.example");
  assert.equal(env.getOpenAIKey, undefined);
});
test("saving business preferences preserves unknown lines and encrypted historical files", async (t) => {
  const { dir, Environment } = setup(t);
  const lines =
    "# preserved comment\nOPENAI_API_KEY=historical-test-value\nCUSTOM_SETTING=keep me\nDICTATION_KEY=old\n";
  fs.writeFileSync(path.join(dir, ".env"), lines);
  fs.mkdirSync(path.join(dir, "secure-keys"));
  fs.writeFileSync(path.join(dir, "secure-keys", "old.enc"), "historical bytes");
  const env = new Environment();
  env.saveDictationKey('Control+中文;"quoted"');
  await env.saveAllKeysToEnvFile();
  const saved = fs.readFileSync(path.join(dir, ".env"), "utf8");
  assert.ok(saved.includes("OPENAI_API_KEY=historical-test-value\n"));
  assert.ok(saved.includes("CUSTOM_SETTING=keep me\n"));
  assert.ok(saved.includes("# preserved comment\n"));
  assert.equal(require("dotenv").parse(saved).DICTATION_KEY, 'Control+中文;"quoted"');
  assert.equal(
    fs.readFileSync(path.join(dir, "secure-keys", "old.enc"), "utf8"),
    "historical bytes"
  );
});
test("an old chat-agent key never installs a new voice hotkey", (t) => {
  const { Environment } = setup(t);
  delete process.env.VOICE_AGENT_KEY;
  process.env.CHAT_AGENT_KEY = "Control+;";
  const env = new Environment();
  assert.equal(env.getVoiceAgentKey(), "");
  assert.equal(process.env.CHAT_AGENT_KEY, "Control+;");
});
test("explicit device erasure is confined to the selected business root", async (t) => {
  const { dir, Environment } = setup(t);
  fs.writeFileSync(path.join(dir, ".env"), "START_MINIMIZED=true");
  fs.mkdirSync(path.join(dir, "secure-keys"));
  fs.writeFileSync(path.join(dir, "secure-keys", "old.enc"), "x");
  await new Environment().clearAllPersistedData();
  assert.equal(fs.existsSync(path.join(dir, ".env")), false);
  assert.equal(fs.existsSync(path.join(dir, "secure-keys")), false);
});
