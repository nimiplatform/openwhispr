const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("Nimi startup leaves historical model choices and valid business preferences intact", async (t) => {
  const dictionary = JSON.stringify(["Nimi", "项目专名"]);
  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      reasoningMode: "providers",
      cleanupMode: "providers",
      cleanupProvider: "tinfoil",
      cleanupModel: "glm-5-2",
      preferredLanguage: "en",
      customDictionary: dictionary,
      useCleanupModel: "true",
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-nimi-settings-hard-cut-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  assert.equal(storage.getItem("cleanupModel"), "glm-5-2");
  assert.equal(storage.getItem("_retiredTinfoilModelsMigrated2"), null);
  assert.equal(storage.getItem("_retiredGroqModelsMigrated"), null);
  assert.equal(storage.getItem("preferredLanguage"), "en");
  assert.equal(storage.getItem("customDictionary"), dictionary);
  assert.equal(useSettingsStore.getState().useCleanupModel, true);
});
