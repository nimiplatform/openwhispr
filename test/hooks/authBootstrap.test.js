const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

for (const { userId, refused } of [null, "business-account"].flatMap((userId) =>
  [false, true].map((refused) => ({ userId, refused }))
)) {
  test(`a fresh ${userId ? "signed-in" : "guest"} account scope ${refused ? "stays closed after a failed Host transition" : "finishes authentication bootstrap"}`, async (t) => {
    const session = userId ? { user: { id: userId } } : null;
    globalThis.__authBootstrapTest = { purges: 0, verifies: 0, session };
    t.after(() => {
      delete globalThis.__authBootstrapTest;
    });
    const scopes = [];
    const { storage } = installBrowserGlobals(t, {
      window: {
        location: { origin: "http://localhost:5183" },
        electronAPI: {
          authGetTokenState: async () => ({ token: userId ? "fixture" : null, generation: 1 }),
          setActiveAccountScope: async (userId, generation) => {
            scopes.push({ userId, generation });
            return { success: !refused, ...(refused ? { error: "scope unavailable" } : {}) };
          },
        },
      },
    });
    const container = installHookDom(t);
    const vite = await createRendererServer(t, {
      cachePrefix: "openwhispr-auth-bootstrap-",
      mockModules: {
        "/lib/auth": `export const authClient = { useSession: () => ({ data: globalThis.__authBootstrapTest.session, isPending: false, error: null, refetch: async () => null }) }; export const isWithinGracePeriod = () => false; export const getGracePeriodRemainingMs = () => 0;`,
        "/utils/logger": `export default { debug() {}, error() {} };`,
        "/services/SyncService.js": `export const syncService = { purgeTeamSpacesForSignOut: async () => { globalThis.__authBootstrapTest.purges++; }, verifyTeamSpacesForAccount: async () => { globalThis.__authBootstrapTest.verifies++; return 0; } };`,
        "/lib/spaceRosterCache": `export const invalidateSpaceRoster = () => {};`,
        "/stores/noteStore": `export const resetForAccountChange = () => {};`,
        "/stores/workspaceStore": `export const useWorkspaceStore = { getState: () => ({ resetForAccountChange() {} }) };`,
        "/stores/settingsStore": `export const useSettingsStore = { getState: () => ({ setInsightsSyncEnabled() {}, setIsSignedIn() {} }) };`,
        "/stores/policyStore": `export const usePolicyStore = { getState: () => ({ suspendPolicy() {}, clearPolicy() {}, fetchPolicy: async () => {} }) };`,
        "/stores/enterpriseIdentityStore": `export const useEnterpriseIdentityStore = { getState: () => ({ clear() {} }) };`,
        "/stores/leaderboardParticipationStore": `export const useLeaderboardParticipationStore = { getState: () => ({ reset() {} }) };`,
      },
    });
    const context = await vite.ssrLoadModule("/lib/authRequestContext.ts");
    const accountScope = await vite.ssrLoadModule("/lib/authAccountScope.ts");
    const request = await context.prepareAuthRequest({
      url: "https://auth.example.test/get-session",
    });
    await context.handleAuthRequestSuccess({
      request,
      data: session,
      response: new Response(null, { status: 200 }),
    });
    const { useAuth } = await vite.ssrLoadModule("/hooks/useAuth.ts");
    let state;
    const root = createRoot(container);
    function Harness() {
      state = useAuth();
      return null;
    }
    try {
      await React.act(async () => {
        root.render(React.createElement(Harness));
      });
      for (
        let attempt = 0;
        attempt < 100 && (refused ? scopes.length === 0 : !state.isLoaded);
        attempt++
      ) {
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
      assert.ok(
        scopes.length > 0,
        "resolved authentication must reach the Host-owned account scope"
      );
      assert.ok(scopes.every((scope) => scope.userId === userId && scope.generation === 1));
      assert.equal(state.isSignedIn, Boolean(userId) && !refused);
      assert.equal(state.isLoaded, !refused);
      assert.equal(storage.getItem("openwhispr:accountScopeValidated"), refused ? null : "true");
      assert.equal(globalThis.__authBootstrapTest.purges, 0);
      assert.equal(globalThis.__authBootstrapTest.verifies, userId && !refused ? 1 : 0);
      assert.equal(context.getValidatedAuthGeneration(), userId && !refused ? 1 : null);
    } finally {
      await React.act(async () => {
        root.unmount();
      });
      accountScope.resetAccountScopeRetry();
    }
  });
}
