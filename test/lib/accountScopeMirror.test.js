const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Mirror the validated Host account scope into business policy; Nimi owns AI routing.
const policy = {
  version: 1,
  transcription: {
    allowedModes: ["enterprise", "local"],
    allowedByokProviders: [],
    allowedEnterpriseProviders: ["azure"],
  },
  llm: { allowedModes: ["openwhispr"], allowedByokProviders: [], allowedEnterpriseProviders: [] },
  features: { agentEnabled: true, webSearchEnabled: false },
  sharing: { externalLinkSharing: "disabled" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: false,
  },
  minAppVersion: null,
};

function windowEvents() {
  const listeners = new Map();
  return {
    add: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    remove: (type, listener) =>
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((candidate) => candidate !== listener)
      ),
    dispatch: (type, event) => (listeners.get(type) ?? []).forEach((listener) => listener(event)),
    count: (type) => (listeners.get(type) ?? []).length,
  };
}

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function boot(t, { scope = null, activeWorkspaceId = null, readScope } = {}) {
  // Registered before installBrowserGlobals so the mirror detaches while `window` still exists.
  let stop = () => {};
  t.after(() => stop());
  const events = windowEvents();
  const calls = { policy: [], config: [] };
  let onScopeChanged = null;
  const electronAPI = {
    getAppVersion: async () => ({ version: "1.10.0" }),
    getActiveAccountScope: readScope ?? (async () => scope),
    onActiveAccountScopeChanged: (callback) => {
      onScopeChanged = callback;
      return () => {
        onScopeChanged = null;
      };
    },
    getWorkspacePolicy: async (accountId, authGeneration) => {
      calls.policy.push([accountId, authGeneration]);
      return {
        success: true,
        revision: calls.policy.length,
        accountId,
        authGeneration,
        managed: true,
        policy,
      };
    },
    getManagedEnterpriseConfig: async (accountId, workspaceId, authGeneration) => {
      calls.config.push([accountId, workspaceId, authGeneration]);
      return {
        success: true,
        status: "network",
        accountId,
        workspaceId,
        authGeneration,
        config: null,
      };
    },
    clearManagedEnterpriseIdentity: async () => {},
  };
  const { storage } = installBrowserGlobals(t, {
    initialStorage: activeWorkspaceId ? { activeWorkspaceId } : {},
    window: { electronAPI, addEventListener: events.add, removeEventListener: events.remove },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-account-scope-mirror-" });
  const { mirrorActiveAccountScope } = await vite.ssrLoadModule("/lib/accountScopeMirror.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  stop = mirrorActiveAccountScope();
  return {
    usePolicyStore,
    useEnterpriseIdentityStore,
    calls,
    events,
    stop,
    broadcast: (next) => onScopeChanged?.(next),
    listeningForBroadcasts: () => onScopeChanged !== null,
    // Browser semantics: the other window's write has landed before the event fires here.
    setActiveWorkspace: (id) => {
      storage.setItem("activeWorkspaceId", id);
      events.dispatch("storage", { key: "activeWorkspaceId", newValue: id });
    },
  };
}

test("a sandboxed window hydrates policy and refreshes it for a new credential generation", async (t) => {
  const h = await boot(t, { scope: { accountId: "account-a", authGeneration: 1 } });
  await waitFor(() => h.usePolicyStore.getState().status === "managed", "policy");
  assert.deepEqual(h.calls.policy, [["account-a", 1]]);
  assert.deepEqual(h.calls.config, []);
  h.broadcast({ accountId: "account-a", authGeneration: 2 });
  await waitFor(() => h.calls.policy.length === 2, "generation 2");
  assert.deepEqual(h.calls.policy.at(-1), ["account-a", 2]);
  h.broadcast(null);
  assert.equal(h.usePolicyStore.getState().status, "idle");
  assert.equal(h.useEnterpriseIdentityStore.getState().status, "idle");
  assert.equal(h.useEnterpriseIdentityStore.getState().accountId, null);
});

test("broadcasts hydrate policy without enabling an App-owned provider configuration", async (t) => {
  const h = await boot(t);
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.policy, []);
  h.broadcast({ accountId: "account-a", authGeneration: 1 });
  await waitFor(() => h.usePolicyStore.getState().status === "managed", "policy");
  h.setActiveWorkspace("workspace-a");
  assert.deepEqual(h.calls.config, []);
  assert.equal(h.events.count("storage"), 0);
});

test("a late boot read cannot overwrite a newer broadcast", async (t) => {
  let resolveRead;
  const h = await boot(t, {
    readScope: () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  });
  h.broadcast({ accountId: "account-a", authGeneration: 1 });
  await waitFor(() => h.usePolicyStore.getState().status === "managed", "policy");
  resolveRead(null);
  await new Promise(setImmediate);
  assert.equal(h.usePolicyStore.getState().status, "managed");
  assert.deepEqual(h.calls.policy, [["account-a", 1]]);
});

test("stopping the mirror detaches its Host broadcast listener", async (t) => {
  const h = await boot(t);
  assert.equal(h.listeningForBroadcasts(), true);
  h.stop();
  assert.equal(h.listeningForBroadcasts(), false);
  h.broadcast({ accountId: "account-b", authGeneration: 4 });
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.policy, []);
});
