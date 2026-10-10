const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("renderer business policy blocks model commands but leaves ordinary reads accessible", async (t) => {
  installBrowserGlobals(t);
  globalThis.__policyBoundaryState = { status: "managed", managed: true };
  globalThis.__policyBoundaryCalls = [];
  t.after(() => {
    delete globalThis.__policyBoundaryState;
    delete globalThis.__policyBoundaryCalls;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-nimi-business-ai-",
    noExternal: ["@nimiplatform/kit", "@nimiplatform/sdk"],
    mockModules: {
      "/stores/policyStore":
        "export const usePolicyStore={getState:()=>globalThis.__policyBoundaryState};",
      "/i18n": "export default {t:key=>key};",
      "@nimiplatform/kit/shell/renderer/bridge": `export const createNimiLocalAppStandardShellSurface=()=>({});export const invoke=async(command,input)=>{globalThis.__policyBoundaryCalls.push(command);return {allowed:true};};`,
      "@nimiplatform/sdk": "export const createNimiClient=()=>({auth:{status:async()=>({sessionBound:true})}});",
    },
  });
  const client = await vite.ssrLoadModule("/services/nimiClient.ts");
  await assert.rejects(client.runNimiRequest("openwhispr.ai.edit-text", { text: "note" }), {
    code: "BUSINESS_AI_POLICY_UNSUPPORTED",
  });
  assert.deepEqual(globalThis.__policyBoundaryCalls, []);
  for (const status of ["loading", "error"]) {
    globalThis.__policyBoundaryState = { status, managed: false };
    await assert.rejects(client.assertNimiBusinessAIAllowed(), {
      code: "BUSINESS_AI_POLICY_UNRESOLVED",
    });
  }
  await client.invokeNimiBusiness("openwhispr.storage.info", {});
  assert.deepEqual(globalThis.__policyBoundaryCalls, ["openwhispr.storage.info"]);
  globalThis.__policyBoundaryState = { status: "unmanaged", managed: false };
  await client.runNimiRequest("openwhispr.ai.edit-text", { text: "note" });
  assert.deepEqual(globalThis.__policyBoundaryCalls.slice(-2), [
    "openwhispr.business.ai-access",
    "openwhispr.ai.edit-text",
  ]);
});
