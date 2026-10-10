const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function load(t) {
  installBrowserGlobals(t);
  globalThis.__readyPolicy = {
    status: "unmanaged",
    managed: false,
    accountId: "A",
    authGeneration: 1,
  };
  globalThis.__readyCalls = [];
  globalThis.__readyStatus = async () => ({ sessionBound: true });
  t.after(() => {
    delete globalThis.__readyPolicy;
    delete globalThis.__readyCalls;
    delete globalThis.__readyStatus;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-session-readiness-",
    noExternal: ["@nimiplatform/kit", "@nimiplatform/sdk"],
    mockModules: {
      "/stores/policyStore": "export const usePolicyStore={getState:()=>globalThis.__readyPolicy};",
      "/i18n": "export default {t:(key,params)=>key+(params?.reason ? ': '+params.reason : '')};",
      "@nimiplatform/kit/shell/renderer/bridge":
        "export const createNimiLocalAppStandardShellSurface=()=>({}); export const invoke=async(command,input)=>{globalThis.__readyCalls.push(command);return {allowed:true};};",
      "@nimiplatform/sdk":
        "export const createNimiClient=()=>({auth:{status:()=>{globalThis.__readyCalls.push('status');return globalThis.__readyStatus();}},aiConfig:{get:async()=>{globalThis.__readyCalls.push('config');return {effectiveSelections:[]};}}});",
    },
  });
  return vite.ssrLoadModule("/services/nimiClient.ts");
}

test("new recording checks current readiness, while append cannot recover an old scope", async (t) => {
  const client = await load(t);
  await client.runNimiRequest("openwhispr.recording.begin", {
    requestId: "recording",
    mimeType: "audio/webm",
  });
  assert.deepEqual(globalThis.__readyCalls, [
    "openwhispr.business.ai-access",
    "status",
    "openwhispr.business.ai-access",
    "openwhispr.recording.begin",
  ]);
  globalThis.__readyCalls.length = 0;
  await client.runNimiRequest("openwhispr.recording.append", { requestId: "recording" });
  assert.deepEqual(globalThis.__readyCalls, ["openwhispr.recording.append"]);
});

test("a failed status preserves its reason and only a new explicit task probes again", async (t) => {
  const client = await load(t);
  globalThis.__readyStatus = async () => {
    throw Object.assign(new Error("native unavailable"), {
      reasonCode: "runtime-service-unavailable",
    });
  };
  await assert.rejects(client.runNimiRequest("openwhispr.history.retry", { id: 5 }), (error) => {
    assert.equal(error.code, "NIMI_SESSION_UNAVAILABLE");
    assert.equal(error.messageParams.reason, "runtime-service-unavailable");
    assert.doesNotMatch(error.message, /sign in|login/i);
    return true;
  });
  assert.equal(globalThis.__readyCalls.includes("openwhispr.history.retry"), false);
  await Promise.resolve();
  assert.equal(globalThis.__readyCalls.filter((v) => v === "status").length, 1);
  globalThis.__readyStatus = async () => ({ sessionBound: true });
  await client.runNimiRequest("openwhispr.history.retry", { id: 5 });
  assert.equal(globalThis.__readyCalls.filter((v) => v === "openwhispr.history.retry").length, 1);
});

test("cancellation while status is pending cannot dispatch a new business request", async (t) => {
  const client = await load(t);
  let settle, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  globalThis.__readyStatus = () => {
    entered();
    return new Promise((resolve) => {
      settle = resolve;
    });
  };
  const controller = new AbortController();
  const work = client.runNimiRequest("openwhispr.recording.begin", {}, controller.signal);
  await started;
  controller.abort();
  settle({ sessionBound: true });
  await assert.rejects(work, { name: "AbortError" });
  assert.equal(globalThis.__readyCalls.includes("openwhispr.recording.begin"), false);
});

test("account ABA, changed policy and unresolved policy cannot cross readiness", async (t) => {
  const client = await load(t);
  globalThis.__readyStatus = async () => {
    globalThis.__readyPolicy = { ...globalThis.__readyPolicy, accountId: "B", authGeneration: 2 };
    globalThis.__readyPolicy = { ...globalThis.__readyPolicy, accountId: "A", authGeneration: 3 };
    return { sessionBound: true };
  };
  await assert.rejects(client.runNimiRequest("openwhispr.ai.edit-text", {}), {
    code: "NIMI_SESSION_CHANGED",
  });
  assert.equal(globalThis.__readyCalls.includes("openwhispr.ai.edit-text"), false);
  globalThis.__readyStatus = async () => {
    globalThis.__readyPolicy = { ...globalThis.__readyPolicy, status: "managed", managed: true };
    return { sessionBound: true };
  };
  await assert.rejects(client.runNimiRequest("openwhispr.ai.edit-text", {}), {
    code: "BUSINESS_AI_POLICY_UNSUPPORTED",
  });
  globalThis.__readyCalls.length = 0;
  globalThis.__readyPolicy = { ...globalThis.__readyPolicy, status: "loading", managed: false };
  await assert.rejects(client.runNimiRequest("openwhispr.ai.edit-text", {}), {
    code: "BUSINESS_AI_POLICY_UNRESOLVED",
  });
  assert.deepEqual(globalThis.__readyCalls, []);
});

test("upload configuration distinguishes connection failure from an actual unconfigured snapshot", async (t) => {
  const client = await load(t);
  globalThis.__readyStatus = async () => {
    throw Object.assign(new Error("unavailable"), { reasonCode: "runtime-service-unavailable" });
  };
  await assert.rejects(client.readNimiAIConfig(), { code: "NIMI_SESSION_UNAVAILABLE" });
  assert.equal(globalThis.__readyCalls.includes("config"), false);
  globalThis.__readyStatus = async () => ({ sessionBound: true });
  assert.deepEqual(await client.readNimiAIConfig(), { effectiveSelections: [] });
  assert.deepEqual(globalThis.__readyCalls.slice(-2), ["status", "config"]);
  const controller = new AbortController();
  globalThis.__readyStatus = async () => {
    controller.abort();
    return { sessionBound: true };
  };
  const count = globalThis.__readyCalls.filter((v) => v === "config").length;
  await assert.rejects(client.readNimiAIConfig(controller.signal), { name: "AbortError" });
  assert.equal(globalThis.__readyCalls.filter((v) => v === "config").length, count);
});
