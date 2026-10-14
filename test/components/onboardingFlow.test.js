const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/flow.ts");

test("account flow includes the complete guided setup", async () => {
  const { getOnboardingRoute } = await load();
  assert.deepEqual(
    getOnboardingRoute({ authPath: "account", setupMode: null, agentAllowed: true }),
    [
      "auth",
      "permissions",
      "languages",
      "use-cases",
      "dictation-hotkey",
      "dictation-demo",
      "notes",
      "assistant-hotkey",
      "assistant-demo",
      "setup-choice",
    ]
  );
});

// The assistant demo offers to suggest meeting times from a connected calendar,
// so the Notes step that connects one has to come first.
test("notes precedes the assistant steps on the account route", async () => {
  const { getOnboardingRoute } = await load();
  const route = getOnboardingRoute({ authPath: "account", setupMode: null, agentAllowed: true });
  assert.ok(route.indexOf("notes") < route.indexOf("assistant-hotkey"));
  assert.equal(route.indexOf("assistant-demo"), route.indexOf("assistant-hotkey") + 1);
});

test("macOS accessibility features stay deferred until the permissions screen", async () => {
  const { shouldInitializeMacAccessibilityFeatures } = await load();

  assert.equal(shouldInitializeMacAccessibilityFeatures("auth"), false);
  assert.equal(shouldInitializeMacAccessibilityFeatures("required-models"), false);
  assert.equal(shouldInitializeMacAccessibilityFeatures("permissions"), true);
  assert.equal(shouldInitializeMacAccessibilityFeatures("dictation-hotkey"), true);
  assert.equal(shouldInitializeMacAccessibilityFeatures("notes"), true);
});

test("onboarding permission checks use the resolved macOS feature gate", () => {
  const source = readFileSync("src/components/OnboardingFlow.tsx", "utf8");

  assert.ok(
    source.indexOf("const currentStepId = reconcileStepWithRoute") <
      source.indexOf("const permissions = usePermissions")
  );
  assert.ok(
    source.includes(
      "macAccessibilityChecksEnabled: shouldInitializeMacAccessibilityFeatures(currentStepId)"
    )
  );
});

test("policy removes assistant states", async () => {
  const { getOnboardingRoute } = await load();
  const route = getOnboardingRoute({ authPath: "account", setupMode: null, agentAllowed: false });
  assert.equal(route.includes("assistant-hotkey"), false);
  assert.equal(route.includes("assistant-demo"), false);
  assert.equal(route.at(-1), "setup-choice");
});

test("the setup decision step is whichever step precedes setup choice", async () => {
  const { getOnboardingRoute, isSetupDecisionStep } = await load();
  const withChoice = getOnboardingRoute({
    authPath: "account",
    setupMode: null,
    agentAllowed: true,
  });
  assert.equal(isSetupDecisionStep("assistant-demo", withChoice), true);
  assert.equal(isSetupDecisionStep("notes", withChoice), false);

  const managed = getOnboardingRoute({
    authPath: "account",
    setupMode: null,
    agentAllowed: false,
    skipSetupChoice: true,
  });
  assert.equal(isSetupDecisionStep("notes", managed), true);

  // Provider steps finish their own setup mode; workspace resolution is moot there.
  const byok = getOnboardingRoute({ authPath: "account", setupMode: "byok", agentAllowed: true });
  assert.equal(isSetupDecisionStep("byok-assistant", byok), false);
  assert.equal(isSetupDecisionStep("assistant-demo", byok), true);
});

test("notes starts with Skip and switches to Continue after a calendar connects", async () => {
  const { getNotesFooterAction } = await load();

  assert.equal(
    getNotesFooterAction({ setupDecisionPending: false, hasConnectedCalendar: false }),
    "skip"
  );
  assert.equal(
    getNotesFooterAction({ setupDecisionPending: false, hasConnectedCalendar: true }),
    "continue"
  );
  // Naming this state rather than returning null: the footer has to keep showing a
  // Continue while workspaces resolve, disabled and loading. Reading it as "no
  // action" left the step with nothing but Back and no explanation.
  assert.equal(
    getNotesFooterAction({ setupDecisionPending: true, hasConnectedCalendar: true }),
    "loading"
  );
  assert.equal(
    getNotesFooterAction({ setupDecisionPending: true, hasConnectedCalendar: false }),
    "loading"
  );
});

test("enterprise workspace entitlement requires a current paid entitlement", async () => {
  const { isEnterpriseWorkspaceEntitled } = await load();
  assert.equal(isEnterpriseWorkspaceEntitled({ plan: "enterprise", status: "active" }), true);
  assert.equal(isEnterpriseWorkspaceEntitled({ plan: "enterprise", status: "trialing" }), true);
  assert.equal(isEnterpriseWorkspaceEntitled({ plan: "enterprise", status: "past_due" }), false);
  assert.equal(isEnterpriseWorkspaceEntitled({ plan: "pro", status: "active" }), false);
  assert.equal(isEnterpriseWorkspaceEntitled(null), false);
});

test("only a signed-in account with an uncommitted choice skips enterprise setup", async () => {
  const { shouldSkipOnboardingSetupChoice } = await load();
  const base = {
    isSignedIn: true,
    authPath: "account",
    setupMode: null,
    activeWorkspace: { plan: "enterprise", status: "active" },
  };

  assert.equal(shouldSkipOnboardingSetupChoice(base), true);
  assert.equal(shouldSkipOnboardingSetupChoice({ ...base, setupMode: "cloud" }), true);
  assert.equal(shouldSkipOnboardingSetupChoice({ ...base, setupMode: "local" }), false);
  assert.equal(shouldSkipOnboardingSetupChoice({ ...base, authPath: "guest" }), false);
  assert.equal(shouldSkipOnboardingSetupChoice({ ...base, isSignedIn: false }), false);
  assert.equal(shouldSkipOnboardingSetupChoice({ ...base, activeWorkspace: null }), false);
});

test("a fresh multi-workspace account resolves its enterprise workspace", async () => {
  const { resolveEnterpriseWorkspaceForOnboarding } = await load();
  const personal = { id: "personal", plan: "pro", status: "active" };
  const enterprise = { id: "enterprise", plan: "enterprise", status: "trialing" };

  assert.equal(resolveEnterpriseWorkspaceForOnboarding(null, [personal, enterprise]), enterprise);
  assert.equal(resolveEnterpriseWorkspaceForOnboarding(personal, [personal, enterprise]), null);
  assert.equal(
    resolveEnterpriseWorkspaceForOnboarding(enterprise, [personal, enterprise]),
    enterprise
  );
});

test("versioned sessions reject malformed or old data", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  assert.equal(parseOnboardingSession(null), null);
  assert.equal(parseOnboardingSession("not json"), null);
  assert.equal(parseOnboardingSession('{"version":1,"currentStepId":"auth"}'), null);

  const session = createOnboardingSession();
  assert.deepEqual(parseOnboardingSession(JSON.stringify(session)), session);

  const legacyV2 = { ...session };
  delete legacyV2.selfHostedRequested;
  delete legacyV2.screenContextRequested;
  delete legacyV2.resume;
  assert.equal(parseOnboardingSession(JSON.stringify(legacyV2)).selfHostedRequested, false);
  assert.equal(parseOnboardingSession(JSON.stringify(legacyV2)).screenContextRequested, false);
  assert.deepEqual(
    parseOnboardingSession(JSON.stringify(legacyV2)).resume,
    createOnboardingSession().resume
  );
  assert.equal(
    parseOnboardingSession(JSON.stringify({ ...session, selfHostedRequested: "yes" })),
    null
  );
  assert.equal(
    parseOnboardingSession(JSON.stringify({ ...session, screenContextRequested: "yes" })),
    null
  );
});

// The permissions step's Enable click must survive the quit-and-reopen macOS
// asks for after granting Screen Recording, or the OS permission lands with
// the Voice Assistant setting still off.
test("a session keeps the screen-context request latch across a relaunch", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  const session = { ...createOnboardingSession(), screenContextRequested: true };
  assert.equal(parseOnboardingSession(JSON.stringify(session)).screenContextRequested, true);
});

test("v2 sessions retain safe within-step state without accepting secrets", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  const session = createOnboardingSession();
  session.currentStepId = "byok-dictation";
  session.resume.dictationHotkeyConfirmed = true;
  session.resume.dictationDemoCompleted = true;
  session.resume.auth = {
    ...session.resume.auth,
    authMode: "sign-up",
    email: "person@example.com",
    fullName: "Person Example",
  };
  session.resume.byok["byok-dictation"] = {
    selectedProvider: "openai",
    selectedModel: "gpt-4o-mini-transcribe",
    baseUrl: "https://self-hosted.example.com",
    customModel: "whisper-local",
  };
  session.resume.localModels["local-assistant"] = {
    provider: "qwen",
    modelId: "qwen-9b",
  };

  const serialized = JSON.stringify(session);
  assert.doesNotMatch(serialized, /password|apiKey|cortiClientId|clientSecret/);
  assert.deepEqual(parseOnboardingSession(serialized), session);

  // Corti's client id is one of the safeStorage-encrypted secrets, so a draft
  // written by an older build has to be dropped rather than read back.
  const legacyDraft = JSON.parse(serialized);
  legacyDraft.resume.byok["byok-dictation"].cortiClientId = "client-id";
  assert.deepEqual(parseOnboardingSession(JSON.stringify(legacyDraft)), session);

  const malformedDraft = JSON.parse(serialized);
  malformedDraft.resume.auth.authMode = "unknown";
  malformedDraft.resume.byok["byok-dictation"].selectedProvider = 42;
  malformedDraft.resume.localModels["local-assistant"].modelId = false;
  const parsed = parseOnboardingSession(JSON.stringify(malformedDraft));
  assert.equal(parsed.resume.auth.authMode, null);
  assert.equal(parsed.resume.byok["byok-dictation"].selectedProvider, "");
  assert.equal(parsed.resume.localModels["local-assistant"].modelId, "");
});

test("an explicit restart clears every persisted route choice and returns to auth", async () => {
  const { resetOnboardingProgress } = await load();
  const values = new Map([
    ["nimiOnboardingSession", '{"currentStepId":"permissions"}'],
    ["onboardingCompleted", "true"],
    ["authenticationSkipped", "true"],
    ["skipAuth", "true"],
    ["localSetupPending", "true"],
    ["pendingLocalModelSelectionsV1", '{"assistant":{"provider":"qwen","modelId":"qwen-9b"}}'],
    ["signInPromptedAt", "1700000000000"],
  ]);
  const storage = {
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };

  resetOnboardingProgress(storage);

  assert.equal(values.get("onboardingCurrentStep"), "0");
  assert.equal(values.has("nimiOnboardingSession"), false);
  assert.equal(values.has("onboardingCompleted"), false);
  assert.equal(values.has("authenticationSkipped"), false);
  assert.equal(values.has("skipAuth"), false);
  assert.equal(values.has("localSetupPending"), false);
  assert.equal(values.has("pendingLocalModelSelectionsV1"), false);
  assert.equal(values.has("signInPromptedAt"), false, "a restart is not a sign-in");
});

test("legacy numeric steps migrate conservatively", async () => {
  const { migrateLegacyOnboardingStep } = await load();
  assert.equal(migrateLegacyOnboardingStep(null), "auth");
  assert.equal(migrateLegacyOnboardingStep("0"), "auth");
  // Old steps 1-2 predate the old permissions step, so they must resume at
  // the new flow's permissions step rather than past it.
  assert.equal(migrateLegacyOnboardingStep("1"), "permissions");
  assert.equal(migrateLegacyOnboardingStep("2"), "permissions");
  assert.equal(migrateLegacyOnboardingStep("4"), "dictation-hotkey");
  assert.equal(migrateLegacyOnboardingStep("999"), "setup-choice");
});

test("an off-route assistant step clamps to its neighbour, not the end of the route", async () => {
  const { getOnboardingRoute, reconcileStepWithRoute } = await load();
  // agentAllowed false is what a failed policy fetch produces, and it drops both
  // assistant steps from the route. Clamping to route.at(-1) would teleport a
  // user on either step to the route's end; the nearest neighbour keeps them
  // where they were in the flow, with ties going to the earlier step.
  const route = getOnboardingRoute({
    authPath: "account",
    setupMode: null,
    agentAllowed: false,
  });
  assert.equal(route.includes("assistant-hotkey"), false);
  assert.equal(reconcileStepWithRoute("assistant-hotkey", route), "notes");
  assert.equal(reconcileStepWithRoute("assistant-demo", route), "setup-choice");
  assert.equal(
    reconcileStepWithRoute(
      "assistant-demo",
      getOnboardingRoute({
        authPath: "account",
        setupMode: null,
        agentAllowed: false,
        skipSetupChoice: true,
      })
    ),
    "setup-choice"
  );

  // With the agent allowed the steps are on the route and pass through untouched.
  const agentRoute = getOnboardingRoute({
    authPath: "account",
    setupMode: null,
    agentAllowed: true,
  });
  assert.equal(reconcileStepWithRoute("assistant-hotkey", agentRoute), "assistant-hotkey");
});

test("route helpers recover from ineligible steps", async () => {
  const { getNextOnboardingStep, getOnboardingRoute, reconcileStepWithRoute } = await load();
  const route = getOnboardingRoute({ authPath: "guest", setupMode: null, agentAllowed: true });
  assert.equal(reconcileStepWithRoute("assistant-demo", route), "assistant-demo");
  assert.equal(getNextOnboardingStep("auth", route), "permissions");
  assert.equal(getNextOnboardingStep("setup-choice", route), null);
});

test("progress counts every step the user is shown, once each", async () => {
  const { getOnboardingProgress, getOnboardingRoute } = await load();
  const route = getOnboardingRoute({ authPath: "account", setupMode: null, agentAllowed: true });

  // The compact steps render in a frame with no footer, so they carry no row and
  // must not inflate the total — landing on languages is "1 of 8", not "3 of 10".
  assert.equal(getOnboardingProgress("auth", route), null);
  assert.equal(getOnboardingProgress("permissions", route), null);

  const counted = route.filter((stepId) => getOnboardingProgress(stepId, route) !== null);
  assert.deepEqual(
    counted.map((stepId) => getOnboardingProgress(stepId, route).index),
    counted.map((_, index) => index)
  );
  assert.deepEqual(getOnboardingProgress("languages", route), { index: 0, total: 8 });
  assert.deepEqual(getOnboardingProgress("setup-choice", route), { index: 7, total: 8 });
});

test("an off-route required-models session clamps to a neighbour step", async () => {
  const { getOnboardingRoute, reconcileStepWithRoute } = await load();
  // The session latch normally keeps the step on-route; if a stale session
  // still names it after the requirement went away across restarts, it must
  // clamp next to auth/permissions rather than teleport down the route.
  const route = getOnboardingRoute({ authPath: "account", setupMode: null, agentAllowed: true });
  assert.ok(["auth", "permissions"].includes(reconcileStepWithRoute("required-models", route)));
});

test("the tray suppression predicate matches only an active required-models session", async () => {
  const { createOnboardingSession, isRequiredModelsOnboardingStepActive } = await load();

  assert.equal(isRequiredModelsOnboardingStepActive(null), false);
  assert.equal(isRequiredModelsOnboardingStepActive("not json"), false);

  const session = createOnboardingSession();
  assert.equal(isRequiredModelsOnboardingStepActive(JSON.stringify(session)), false);
  assert.equal(
    isRequiredModelsOnboardingStepActive(
      JSON.stringify({ ...session, currentStepId: "required-models" })
    ),
    true
  );
  // A completed/cleared session (the post-onboarding state) never suppresses.
  assert.equal(
    isRequiredModelsOnboardingStepActive(
      JSON.stringify({ ...session, currentStepId: "permissions" })
    ),
    false
  );
});

test("a session written before the resume flags infers its hotkey confirmations", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  const preResumeSession = (currentStepId) => {
    const { resume, ...session } = { ...createOnboardingSession(), currentStepId };
    void resume;
    return JSON.stringify({ ...session, authPath: "account" });
  };

  // The shipped build persists this shape. Read back as "never confirmed", a
  // macOS session resuming past the hotkey step lets finalizeOnboarding replace
  // the chord the user confirmed on that build, with no screen ever showing it.
  const past = parseOnboardingSession(preResumeSession("setup-choice"));
  assert.equal(past.resume.dictationHotkeyConfirmed, true);
  assert.equal(past.resume.assistantHotkeyConfirmed, true);

  // Notes now precedes the assistant steps, so a session standing there is
  // still ahead of the assistant hotkey and gets shown that step.
  const onNotes = parseOnboardingSession(preResumeSession("notes"));
  assert.equal(onNotes.resume.dictationHotkeyConfirmed, true);
  assert.equal(onNotes.resume.assistantHotkeyConfirmed, false);

  // Not yet reached is genuinely unconfirmed: the step still has to be shown, and
  // onboarding stays free to open it on the platform's onboarding chord.
  const before = parseOnboardingSession(preResumeSession("permissions"));
  assert.equal(before.resume.dictationHotkeyConfirmed, false);
  assert.equal(before.resume.assistantHotkeyConfirmed, false);

  // Standing on the step is not having finished it.
  const on = parseOnboardingSession(preResumeSession("dictation-hotkey"));
  assert.equal(on.resume.dictationHotkeyConfirmed, false);
  assert.equal(on.resume.assistantHotkeyConfirmed, false);

  // Nothing else is inferred — a demo the user never ran must still gate Continue.
  assert.equal(past.resume.dictationDemoCompleted, false);
  assert.equal(past.resume.assistantDemoCompleted, false);
});

test("Nimi setup keeps one guided route and never inserts retired provider downloads", async () => {
  const { getOnboardingRoute, getOnboardingProgress } = await load();
  for (const authPath of ["guest", "account"])
    for (const setupMode of [null, "cloud", "byok", "local"]) {
      const route = getOnboardingRoute({
        authPath,
        setupMode,
        agentAllowed: true,
        requiredModelsPending: true,
        skipSetupChoice: true,
      });
      assert.deepEqual(route, [
        "auth",
        "permissions",
        "languages",
        "use-cases",
        "dictation-hotkey",
        "dictation-demo",
        "notes",
        "assistant-hotkey",
        "assistant-demo",
        "setup-choice",
      ]);
      assert.deepEqual(getOnboardingProgress("setup-choice", route), { index: 7, total: 8 });
      assert.equal(getOnboardingProgress("required-models", route), null);
      assert.equal(getOnboardingProgress("byok-assistant", route), null);
    }
  const noAgent = getOnboardingRoute({ authPath: "guest", setupMode: null, agentAllowed: false });
  assert.deepEqual(getOnboardingProgress("setup-choice", noAgent), { index: 5, total: 6 });
});
