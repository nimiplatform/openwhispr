import NimiAISettings from "./settings/NimiAISettings";
import { Button as NimiSetupButton } from "./ui/button";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "./icons";

import UseCaseStep from "./onboarding/UseCaseStep";
import { hasUseCaseIntent } from "./onboarding/useCases";
import OnboardingShell, { OnboardingStepHeader } from "./onboarding/OnboardingShell";
import CompactPermissionsStep from "./onboarding/CompactPermissionsStep";
import LanguageSelectionStep from "./onboarding/LanguageSelectionStep";
import ShortcutSetupStep from "./onboarding/ShortcutSetupStep";
import AssistantHotkeyPreview from "./onboarding/AssistantHotkeyPreview";
import DemoStep from "./onboarding/DemoStep";
import CalendarConnectionsStep from "./onboarding/CalendarConnectionsStep";

import { AlertDialog } from "./ui/dialog";
import { useAuth } from "../hooks/useAuth";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useScreenRecordingPermission } from "../hooks/useScreenRecordingPermission";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import { useSettings } from "../hooks/useSettings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { useHotkeyModeInfo } from "../hooks/useHotkeyModeInfo";
import { useWorkspace } from "../hooks/useWorkspace";

import { usePolicyStore } from "../stores/policyStore";
import { isAgentAllowed, isScreenContextAllowed } from "../stores/policyRules";
import { useSettingsStore } from "../stores/settingsStore";
import { getDefaultHotkey, parseHotkeyList, serializeHotkeyList } from "../utils/hotkeys";
import {
  DEFAULT_ASSISTANT_ONBOARDING_HOTKEY,
  formatHotkeyInstruction,
  getRecommendedDictationHotkeys,
  resolveOnboardingAssistantHotkey,
  resolveOnboardingDictationHotkey,
} from "./onboarding/hotkeyPresentation";
import { getValidationMessage } from "../utils/hotkeyValidator";
import { validateHotkeyForSlot } from "../utils/hotkeyValidation";
import { getPlatform } from "../utils/platform";
import { ACCESSIBILITY_SKIPPED_KEY, areRequiredPermissionsMet } from "../utils/permissions";
import { cloudPost } from "../services/cloudApi";
import { signOut } from "../lib/auth";
import logger from "../utils/logger";
import {
  COMPACT_STEPS,
  getNextOnboardingStep,
  getNotesFooterAction,
  getOnboardingProgress,
  getOnboardingRoute,
  isSetupDecisionStep,
  reconcileStepWithRoute,
  resetOnboardingProgress,
  resolveEnterpriseWorkspaceForOnboarding,
  shouldInitializeMacAccessibilityFeatures,
  shouldSkipOnboardingSetupChoice,
  type OnboardingAuthDraft,
  type OnboardingResumeState,
  type OnboardingSetupMode,
} from "./onboarding/flow";
import { useOnboardingSession } from "./onboarding/useOnboardingSession";
import { usePermissionGuide } from "./onboarding/usePermissionGuide";
import {
  requestMicrophoneForGuide,
  type GuidePermission,
} from "./onboarding/permissionGuideController";

import { resolveAssistantDemoScenario } from "./onboarding/assistantDemoScenario";
import { ActivationModeSelector } from "./ui/ActivationModeSelector";
import LinuxPttSetupInfo from "./ui/LinuxPttSetupInfo";

interface OnboardingFlowProps {
  onComplete: (options?: { openSettings?: boolean }) => void;
}

type OnboardingCompletionMode = Exclude<OnboardingSetupMode, null> | "managed";

function DemoHotkeyDescription({ text, hotkey }: { text: string; hotkey: string }) {
  const hotkeyStart = text.indexOf(hotkey);
  if (hotkeyStart < 0) return text;

  return (
    <>
      {text.slice(0, hotkeyStart)}
      <kbd className="mx-0.5 inline-flex rounded-md bg-[color-mix(in_srgb,var(--onboarding-accent)_12%,transparent)] px-1.5 py-0.5 font-semibold text-[var(--onboarding-accent)]">
        {hotkey}
      </kbd>
      {text.slice(hotkeyStart + hotkey.length)}
    </>
  );
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { t } = useTranslation();
  const platform = getPlatform();
  const { isSignedIn } = useAuth();
  const agentAllowed = usePolicyStore(isAgentAllowed);
  const screenContextAllowed = usePolicyStore(isScreenContextAllowed);
  const settings = useSettings();
  const settingsStore = useSettingsStore();
  const {
    session,
    setSession,
    goTo,
    goBack,
    setAuthPath,
    setSetupMode,
    setSelfHostedRequested,
    setScreenContextRequested,
    setPermissionGuide,
    clearSession,
  } = useOnboardingSession();

  const handleLogout = useCallback(async () => {
    await signOut();
    resetOnboardingProgress(localStorage);
    window.location.reload();
  }, []);
  // Set by Back on the permissions step: a signed-in user who asked to return to
  // the auth step gets the welcome screen (where Log out lives), not auto-advance.
  const [returnedToAuth, setReturnedToAuth] = useState(false);

  const { dictationHotkeyConfirmed, assistantHotkeyConfirmed } = session.resume;
  const [dictationHotkey, setDictationHotkey] = useState(() =>
    resolveOnboardingDictationHotkey({
      platform,
      savedHotkey: parseHotkeyList(settings.dictationKey)[0] ?? "",
      platformDefault: getDefaultHotkey(),
      confirmed: dictationHotkeyConfirmed,
    })
  );
  const [assistantHotkey, setAssistantHotkey] = useState(() =>
    resolveOnboardingAssistantHotkey(parseHotkeyList(settings.voiceAgentKey)[0] ?? "")
  );
  // Seeded from main rather than getDefaultHotkey(): main already knows when the
  // platform default can't bind (GNOME/X11 reject modifier-only combos) and
  // registered a fallback instead — recommending the unregistrable default would
  // make every confirm of it fail.
  const [recommendedDictationHotkey, setRecommendedDictationHotkey] = useState(getDefaultHotkey);
  const dictationDemoSuccess = session.resume.dictationDemoCompleted;
  const assistantDemoSuccess = session.resume.assistantDemoCompleted;
  const [stageReady, setStageReady] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [permissionAlert, setPermissionAlert] = useState<{
    title: string;
    description: string;
  } | null>(null);
  const [, setAccessibilitySkipped] = useLocalStorage(ACCESSIBILITY_SKIPPED_KEY, false);

  const updateResumeFlag = useCallback(
    (
      key: Extract<
        keyof OnboardingResumeState,
        | "dictationHotkeyConfirmed"
        | "assistantHotkeyConfirmed"
        | "dictationDemoCompleted"
        | "assistantDemoCompleted"
      >,
      value: boolean
    ) => {
      setSession((current) => ({
        ...current,
        resume: { ...current.resume, [key]: value },
      }));
    },
    [setSession]
  );
  const setDictationHotkeyConfirmed = useCallback(
    (confirmed: boolean) => updateResumeFlag("dictationHotkeyConfirmed", confirmed),
    [updateResumeFlag]
  );
  const setAssistantHotkeyConfirmed = useCallback(
    (confirmed: boolean) => updateResumeFlag("assistantHotkeyConfirmed", confirmed),
    [updateResumeFlag]
  );
  const setDictationDemoSuccess = useCallback(
    (successful: boolean) => updateResumeFlag("dictationDemoCompleted", successful),
    [updateResumeFlag]
  );
  const setAssistantDemoSuccess = useCallback(
    (successful: boolean) => updateResumeFlag("assistantDemoCompleted", successful),
    [updateResumeFlag]
  );
  const updateAuthResumeState = useCallback(
    (patch: Partial<OnboardingAuthDraft>) => {
      setSession((current) => ({
        ...current,
        resume: {
          ...current.resume,
          auth: { ...current.resume.auth, ...patch },
        },
      }));
    },
    [setSession]
  );

  useClipboard((dialog) =>
    setPermissionAlert({ title: dialog.title, description: dialog.description })
  );
  const systemAudio = useSystemAudioPermission();
  const {
    granted: screenRecordingGranted,
    needsRelaunch: screenRecordingNeedsRelaunch,
    loaded: screenRecordingLoaded,
    check: checkScreenRecording,
    request: requestScreenRecordingAccess,
  } = useScreenRecordingPermission();
  const {
    supportsPushToTalk,
    pushToTalkUnavailableReason,
    linuxInputAccessDenied,
    loaded: hotkeyModeLoaded,
  } = useHotkeyModeInfo("onboarding", dictationHotkey);
  const { activationMode, setActivationMode } = settings;
  // This hook also starts the membership fetch for already-authenticated users;
  // relying on the login transition alone would leave resumed onboarding stuck
  // waiting for workspace resolution after an app restart.
  const {
    active: activeWorkspace,
    workspaces,
    loaded: workspacesLoaded,
    setActive: setActiveWorkspace,
  } = useWorkspace();
  const enterpriseWorkspace = useMemo(
    () => resolveEnterpriseWorkspaceForOnboarding(activeWorkspace, workspaces),
    [activeWorkspace, workspaces]
  );
  const skipSetupChoiceForEnterprise = shouldSkipOnboardingSetupChoice({
    isSignedIn,
    authPath: session.authPath,
    setupMode: session.setupMode,
    activeWorkspace: enterpriseWorkspace,
  });

  useEffect(() => {
    if (
      workspacesLoaded &&
      !activeWorkspace &&
      skipSetupChoiceForEnterprise &&
      enterpriseWorkspace
    ) {
      setActiveWorkspace(enterpriseWorkspace.id);
    }
  }, [
    activeWorkspace,
    enterpriseWorkspace,
    setActiveWorkspace,
    skipSetupChoiceForEnterprise,
    workspacesLoaded,
  ]);

  const workspaceResolutionPending =
    isSignedIn &&
    session.authPath === "account" &&
    (!workspacesLoaded ||
      (!activeWorkspace && skipSetupChoiceForEnterprise && Boolean(enterpriseWorkspace)));
  const hasConnectedCalendar =
    settingsStore.gcalAccounts.length > 0 ||
    settingsStore.mcalAccounts.length > 0 ||
    (platform === "darwin" && settingsStore.appleCalendarConnected);

  // The setting turns on only once the permission is actually granted, so an
  // Enable click whose System Settings grant is abandoned can't leave screen
  // context armed to activate silently on some later grant. The latch lives in
  // the persisted session because macOS asks to quit and reopen the app after
  // the grant; it is cleared as soon as it is consumed.
  const screenContextRequested = session.screenContextRequested;

  const applyScreenContext = useCallback(() => {
    setScreenContextRequested(false);
    settingsStore.setVoiceAgentScreenContext(true);
    // Keeps the dictation overlay out of its own screenshots.
    void window.electronAPI?.setScreenContextEnabled?.(true);
  }, [setScreenContextRequested, settingsStore]);

  const enableScreenContext = useCallback(async () => {
    setScreenContextRequested(true);
    const granted = await requestScreenRecordingAccess();
    if (granted) applyScreenContext();
    return granted;
  }, [applyScreenContext, requestScreenRecordingAccess, setScreenContextRequested]);

  // macOS grants Screen Recording in System Settings, outside the app; the
  // permission hook re-checks on mount and window focus. When the grant lands,
  // complete the opt-in the Enable click started. A system grant alone must
  // not enable Screen Context without the user's explicit opt-in.
  useEffect(() => {
    if (!screenRecordingGranted || !agentAllowed || !screenContextAllowed) return;
    if (screenContextRequested) {
      applyScreenContext();
    }
  }, [
    agentAllowed,
    applyScreenContext,
    screenContextAllowed,
    screenContextRequested,
    screenRecordingGranted,
  ]);

  // Latched for the session once the step is entered (or resumed at), so a
  // mid-download policy refresh or the disk check settling can't rebuild the
  // route out from under the user. Seeded from the persisted session because
  // relaunching mid-download must resume on the step, not bounce off it while
  // the disk check is still pending.
  const requiredModelsLatchRef = useRef(false);
  const requiredModelsPending = false;

  const route = useMemo(
    () =>
      getOnboardingRoute({
        authPath: session.authPath,
        setupMode: session.setupMode,
        agentAllowed,
        requiredModelsPending,
        skipSetupChoice: skipSetupChoiceForEnterprise,
      }),
    [
      agentAllowed,
      requiredModelsPending,
      session.authPath,
      session.setupMode,
      skipSetupChoiceForEnterprise,
    ]
  );
  const currentStepId = reconcileStepWithRoute(session.currentStepId, route);
  const compact = COMPACT_STEPS.has(currentStepId);
  const setupDecisionPending =
    workspaceResolutionPending && isSetupDecisionStep(currentStepId, route);
  const notesFooterAction = getNotesFooterAction({ setupDecisionPending, hasConnectedCalendar });
  // Screen context only reaches the model once macOS has been relaunched after
  // the grant; until then the demo must not promise the assistant can see the card.
  const screenContextActive =
    agentAllowed &&
    screenContextAllowed &&
    settingsStore.voiceAgentScreenContext &&
    screenRecordingGranted &&
    !screenRecordingNeedsRelaunch;
  const permissions = usePermissions(
    (dialog) => setPermissionAlert({ title: dialog.title, description: dialog.description }),
    {
      macAccessibilityChecksEnabled: shouldInitializeMacAccessibilityFeatures(currentStepId),
    }
  );
  const openSettings =
    (open: () => Promise<{ success: boolean; error?: string }>) => async (): Promise<void> => {
      const result = await open();
      if (!result.success) throw new Error(result.error);
    };
  const openMicrophoneSettings = openSettings(window.electronAPI.openMicrophoneSettings);
  const openAccessibilitySettings = openSettings(window.electronAPI.openAccessibilitySettings);
  const guideRows: GuidePermission[] = [
    {
      id: "microphone",
      request: async () => {
        const result = await requestMicrophoneForGuide({
          requestAccess: window.electronAPI.requestMicrophoneAccess,
          checkAccess: window.electronAPI.checkMicrophoneAccess,
          openSettings: openMicrophoneSettings,
        });
        permissions.setMicPermissionGranted(result.granted);
      },
      check: async () => {
        const result = await window.electronAPI.checkMicrophoneAccess();
        permissions.setMicPermissionGranted(result.granted);
        return result;
      },
      openSettings: openMicrophoneSettings,
    },
    {
      id: "accessibility",
      request: openAccessibilitySettings,
      check: async () => {
        const granted = await window.electronAPI.checkAccessibilityPermission(true);
        permissions.setAccessibilityPermissionGranted(granted);
        return { granted };
      },
      openSettings: openAccessibilitySettings,
    },
  ];
  if (systemAudio.mode === "native")
    guideRows.push({
      id: "system-audio",
      request: systemAudio.request,
      check: async () => {
        await systemAudio.check();
        return window.electronAPI.checkSystemAudioAccess();
      },
      verify: async () => {
        const result = await window.electronAPI.verifySystemAudioAccess();
        await systemAudio.check();
        return result;
      },
      openSettings: openSettings(window.electronAPI.openSystemAudioSettings),
    });
  if (agentAllowed && screenContextAllowed)
    guideRows.push({
      id: "screen-context",
      request: async () => {
        setScreenContextRequested(true);
        return requestScreenRecordingAccess();
      },
      onGranted: applyScreenContext,
      check: async () => {
        const result = await window.electronAPI.checkScreenRecordingAccess();
        await checkScreenRecording();
        return result;
      },
      openSettings: openSettings(window.electronAPI.openScreenRecordingSettings),
    });
  const guideReady = platform === "darwin" && systemAudio.loaded && screenRecordingLoaded;
  const permissionGuide = usePermissionGuide({
    enabled: currentStepId === "permissions" && guideReady,
    progress: session.permissionGuide,
    save: setPermissionGuide,
    // Dismissing the guide withdraws the Screen Context opt-in; enabling
    // another permission while it is still pending does not.
    dismissed: () => setScreenContextRequested(false),
    rows: guideRows,
  });

  useEffect(() => {
    if (currentStepId !== "permissions" && session.permissionGuide) setPermissionGuide(null);
  }, [currentStepId, session.permissionGuide, setPermissionGuide]);

  useEffect(() => {
    if (currentStepId === "required-models") requiredModelsLatchRef.current = true;
  }, [currentStepId]);

  // New users default to hold-to-talk, but only where no mode was ever chosen
  // (the store's "tap" is a fallback) and once main has confirmed this desktop
  // supports it — the hook's placeholder says yes on every platform.
  useEffect(() => {
    if (currentStepId !== "dictation-hotkey" || !hotkeyModeLoaded) return;
    if (supportsPushToTalk && localStorage.getItem("activationMode") === null) {
      setActivationMode("push");
    }
  }, [currentStepId, hotkeyModeLoaded, setActivationMode, supportsPushToTalk]);

  // The auth step lands on "permissions" before the policy and disk checks
  // settle (AppRouter's policy gate remounts this component mid-transition),
  // so a persisted session can sit one step past the gate when the pending
  // flag arrives. Pull the user back — only from permissions, the immediate
  // post-auth screen, and only before the step was entered this session.
  useEffect(() => {
    if (
      requiredModelsPending &&
      currentStepId === "permissions" &&
      !requiredModelsLatchRef.current &&
      route.includes("required-models")
    ) {
      goTo("required-models");
    }
  }, [currentStepId, goTo, requiredModelsPending, route]);

  useEffect(() => {
    if (session.currentStepId !== currentStepId) {
      setSession((current) => ({ ...current, currentStepId }));
    }
  }, [currentStepId, session.currentStepId, setSession]);

  // AppRouter releases this only after it has committed the normal app. Keeping
  // the gate active across this component's unmount prevents a one-frame flash
  // of the dictation pill or another normal-app overlay at completion/error.
  useEffect(() => {
    void window.electronAPI?.setOnboardingActive?.(true);
  }, []);

  useEffect(() => {
    void window.electronAPI?.setOnboardingWindowMode?.(compact ? "compact" : "expanded");
  }, [compact]);

  useEffect(() => {
    if (platform === "darwin" && shouldInitializeMacAccessibilityFeatures(currentStepId)) {
      window.electronAPI?.markMacAccessibilityFeaturesReady?.();
    }
  }, [currentStepId, platform]);

  useEffect(() => {
    setStageReady(false);
  }, [currentStepId]);

  // Track main's actual registration: the platform default may be unregistrable
  // (GNOME gsettings and X11 reject modifier-only combos like Control+Super), in
  // which case main silently registered FALLBACK_HOTKEYS instead. Recommend and
  // teach the key that really works, not the one that always errors.
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI
      ?.getEffectiveDefaultHotkey?.()
      .then((key) => {
        const effective = key && parseHotkeyList(key)[0];
        if (cancelled || !effective) return;
        setRecommendedDictationHotkey(effective);
        // finalizeOnboarding registers dictationHotkey without further input on
        // routes that never show the hotkey step, so an unregistrable renderer
        // default has to be replaced here, not just in the recommendation.
        setDictationHotkey((current) => (current === getDefaultHotkey() ? effective : current));
      })
      .catch((error) =>
        logger.warn("Failed to read effective default hotkey", { error }, "onboarding")
      );
    const unsubscribe = window.electronAPI?.onHotkeyFallbackUsed?.((data) => {
      const fallback = parseHotkeyList(data?.fallback)[0];
      if (!fallback) return;
      setDictationHotkey(fallback);
      setRecommendedDictationHotkey(fallback);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const withExtraDictationHotkeys = useCallback(
    (primary: string) =>
      serializeHotkeyList([primary, ...parseHotkeyList(settings.dictationKey).slice(1)]),
    [settings.dictationKey]
  );

  const hotkeyErrorRef = useRef<string | null>(null);
  const { registerHotkey, isRegistering } = useHotkeyRegistration({
    onSuccess: (registered) => {
      const primary = parseHotkeyList(registered)[0] || registered;
      setDictationHotkey(primary);
      settings.setDictationKey(registered);
    },
    onError: (message) => {
      hotkeyErrorRef.current = message;
    },
    showSuccessToast: false,
    showErrorToast: false,
  });

  const validateDictationHotkey = useCallback(
    (value: string) => getValidationMessage(value, platform),
    [platform]
  );
  const validateAssistantHotkey = useCallback(
    (value: string) =>
      validateHotkeyForSlot(
        value,
        { "settingsPage.general.hotkey.title": withExtraDictationHotkeys(dictationHotkey) },
        t
      ),
    [dictationHotkey, t, withExtraDictationHotkeys]
  );

  const confirmDictationHotkey = useCallback(
    async (value: string) => {
      // A key the OS cannot see released falls back to Tap rather than failing
      // the pick; the card below shows Hold disabled with the reason.
      if (activationMode === "push") {
        const info = await window.electronAPI?.getHotkeyModeInfo?.(value);
        if (info && !info.supportsPushToTalk) setActivationMode("tap");
      }
      hotkeyErrorRef.current = null;
      const registered = await registerHotkey(withExtraDictationHotkeys(value));
      return registered ? null : (hotkeyErrorRef.current ?? t("onboarding.rehaul.hotkey.inUse"));
    },
    [activationMode, registerHotkey, setActivationMode, t, withExtraDictationHotkeys]
  );

  const confirmAssistantHotkey = useCallback(
    async (value: string) => {
      const result = await settings.setVoiceAgentKey(
        serializeHotkeyList([value, ...parseHotkeyList(settings.voiceAgentKey).slice(1)])
      );
      return result.success ? null : result.message || t("onboarding.rehaul.hotkey.inUse");
    },
    [settings, t]
  );

  const syncUseCases = useCallback(() => {
    if (!isSignedIn || session.authPath === "guest") return;
    cloudPost("/api/onboarding-intent", {
      useCases: settings.onboardingUseCases,
      note: settings.onboardingUseCaseNote || undefined,
      spokenLanguages: settings.spokenLanguages,
    }).catch((error) => logger.warn("Failed to sync onboarding intent", { error }, "onboarding"));
  }, [
    isSignedIn,
    session.authPath,
    settings.onboardingUseCaseNote,
    settings.onboardingUseCases,
    settings.spokenLanguages,
  ]);

  const finalizeOnboarding = useCallback(async () => {
    if (isFinishing) return;
    setFatalError(null);
    setIsFinishing(true);
    try {
      syncUseCases();
      if (!isSignedIn) localStorage.setItem("authenticationSkipped", "true");
      localStorage.setItem("onboardingCompleted", "true");
      clearSession();
      window.dispatchEvent(new Event("settings-changed"));
      onComplete();
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsFinishing(false);
    }
  }, [isFinishing, onComplete, syncUseCases, clearSession, isSignedIn]);

  // Sessions saved on the old setup-choice step reconcile back to the last
  // guided step once an Enterprise workspace is confirmed. Finish them without
  // writing provider or model settings, just as if that had been their final
  // step originally.
  useEffect(() => {
    if (!skipSetupChoiceForEnterprise || session.currentStepId !== "setup-choice" || isFinishing) {
      return;
    }
    void finalizeOnboarding();
  }, [finalizeOnboarding, isFinishing, session.currentStepId, skipSetupChoiceForEnterprise]);

  const continueFromCurrentStep = useCallback(async () => {
    // A banner from an earlier failed attempt must not outlive the retry.
    setFatalError(null);
    if (setupDecisionPending) return;
    if (currentStepId === "permissions") {
      if (platform === "darwin" && !permissions.accessibilityPermissionGranted) {
        setAccessibilitySkipped(true);
      }
    } else if (currentStepId === "languages") {
      settings.setPreferredLanguage(
        settings.spokenLanguages.length === 1 ? settings.spokenLanguages[0] : "auto"
      );
    } else if (currentStepId === "use-cases") {
      syncUseCases();
    } else if (currentStepId === "dictation-hotkey") {
      const registered = await registerHotkey(withExtraDictationHotkeys(dictationHotkey));
      if (!registered) {
        setFatalError(t("onboarding.hotkey.couldNotRegisterDescription"));
        return;
      }
      setDictationHotkeyConfirmed(true);
    } else if (currentStepId === "assistant-hotkey") {
      if (parseHotkeyList(settings.voiceAgentKey)[0] !== assistantHotkey) {
        const result = await settings.setVoiceAgentKey(
          serializeHotkeyList([
            assistantHotkey,
            ...parseHotkeyList(settings.voiceAgentKey).slice(1),
          ])
        );
        if (!result.success) {
          setFatalError(result.message || t("onboarding.rehaul.hotkey.inUse"));
          return;
        }
      }
    }

    const next = getNextOnboardingStep(currentStepId, route);
    if (next) {
      goTo(next);
      return;
    }

    if (skipSetupChoiceForEnterprise) {
      await finalizeOnboarding();
      return;
    }
    if (session.setupMode) await finalizeOnboarding();
  }, [
    assistantHotkey,
    currentStepId,
    dictationHotkey,
    finalizeOnboarding,
    goTo,
    permissions.accessibilityPermissionGranted,
    platform,
    registerHotkey,
    route,
    session.setupMode,
    setAccessibilitySkipped,
    setDictationHotkeyConfirmed,
    settings,
    settingsStore,
    syncUseCases,
    t,
    withExtraDictationHotkeys,
    setupDecisionPending,
    skipSetupChoiceForEnterprise,
  ]);

  const canContinue = (() => {
    switch (currentStepId) {
      case "permissions":
        return areRequiredPermissionsMet(permissions.micPermissionGranted);
      case "languages":
        return settings.spokenLanguages.length > 0;
      case "use-cases":
        return hasUseCaseIntent(settings.onboardingUseCases, settings.onboardingUseCaseNote);
      case "dictation-hotkey":
        return dictationHotkeyConfirmed;
      case "dictation-demo":
        return dictationDemoSuccess;
      case "assistant-hotkey":
        return assistantHotkeyConfirmed;
      case "assistant-demo":
        return assistantDemoSuccess;
      case "notes":
        return notesFooterAction === "continue";

      default:
        return true;
    }
  })();

  const renderStep = () => {
    switch (currentStepId) {
      case "auth":
        return (
          <div className="min-h-full w-full space-y-6 p-6">
            <OnboardingStepHeader
              title={t("nimi.modelsTitle")}
              description={t("nimi.modelsDescription")}
            />
            <NimiAISettings />
            <NimiSetupButton
              onClick={() => {
                setAuthPath("guest");
                goTo("permissions");
              }}
            >
              {t("common.continue")}
            </NimiSetupButton>
          </div>
        );

      case "permissions":
        return (
          <CompactPermissionsStep
            permissions={permissions}
            guide={{ ...permissionGuide, ready: guideReady }}
            systemAudio={systemAudio}
            screenContext={
              agentAllowed && screenContextAllowed
                ? {
                    enabled: settingsStore.voiceAgentScreenContext,
                    granted: screenRecordingGranted,
                    needsRelaunch: screenRecordingNeedsRelaunch,
                    request: enableScreenContext,
                  }
                : undefined
            }
            onBack={
              session.history.length > 0
                ? () => {
                    setReturnedToAuth(true);
                    goBack();
                  }
                : undefined
            }
            onContinue={() => void continueFromCurrentStep()}
            onDeferMicrophone={() => goTo("dictation-hotkey")}
          />
        );

      case "languages":
        return (
          <div className="flex h-full min-h-0 w-full flex-col pt-1">
            <OnboardingStepHeader
              title={t("onboarding.rehaul.languages.title")}
              titleLines={[
                t("onboarding.rehaul.languages.titleLineOne"),
                t("onboarding.rehaul.languages.titleLineTwo"),
              ]}
              description={t("onboarding.rehaul.languages.description")}
            />
            <LanguageSelectionStep
              selected={settings.spokenLanguages}
              onChange={settings.setSpokenLanguages}
              searchPlaceholder={t("languageSelector.searchPlaceholder")}
              noResultsLabel={t("languageSelector.noLanguagesFound")}
              selectedLabel={t("onboarding.rehaul.languages.title")}
            />
          </div>
        );

      case "use-cases":
        return (
          <div className="h-full w-full pt-1">
            <UseCaseStep
              useCases={settings.onboardingUseCases}
              onUseCasesChange={settings.setOnboardingUseCases}
              note={settings.onboardingUseCaseNote}
              onNoteChange={settings.setOnboardingUseCaseNote}
            />
          </div>
        );

      case "dictation-hotkey":
      case "assistant-hotkey": {
        const assistant = currentStepId === "assistant-hotkey";
        return (
          <div className="flex h-full min-h-0 w-full flex-col pt-2">
            <OnboardingStepHeader
              title={t(
                assistant
                  ? "onboarding.rehaul.assistantHotkey.title"
                  : "onboarding.rehaul.dictationHotkey.title"
              )}
              // The assistant step's preview image needs the room a two-line header takes.
              titleLines={
                assistant
                  ? undefined
                  : [
                      t("onboarding.rehaul.dictationHotkey.titleLineOne"),
                      t("onboarding.rehaul.dictationHotkey.titleLineTwo"),
                    ]
              }
              wideTitle={assistant}
              wideDescription={assistant}
              description={t(
                assistant
                  ? "onboarding.rehaul.assistantHotkey.description"
                  : "onboarding.rehaul.dictationHotkey.description"
              )}
            />
            {assistant && <AssistantHotkeyPreview />}
            <ShortcutSetupStep
              value={assistant ? assistantHotkey : dictationHotkey}
              initiallyConfirmed={assistant ? assistantHotkeyConfirmed : dictationHotkeyConfirmed}
              onChange={(value) => {
                if (assistant) {
                  setAssistantHotkey(value);
                  setAssistantHotkeyConfirmed(true);
                } else {
                  setDictationHotkey(value);
                  setDictationHotkeyConfirmed(true);
                }
              }}
              onClearSelection={() => {
                if (assistant) {
                  setAssistantHotkey("");
                  setAssistantHotkeyConfirmed(false);
                } else {
                  setDictationHotkey("");
                  setDictationHotkeyConfirmed(false);
                }
              }}
              recommended={
                assistant
                  ? DEFAULT_ASSISTANT_ONBOARDING_HOTKEY
                  : getRecommendedDictationHotkeys(platform, recommendedDictationHotkey)
              }
              captureLabel={t("onboarding.rehaul.hotkey.capture")}
              recommendedLabel={t("common.recommended")}
              chooseAnotherLabel={t("onboarding.rehaul.hotkey.chooseAnother")}
              validate={assistant ? validateAssistantHotkey : validateDictationHotkey}
              onConfirm={assistant ? confirmAssistantHotkey : confirmDictationHotkey}
              dense={assistant}
            />
            {!assistant && (
              <div className="mx-auto mt-8 w-full max-w-md rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 text-start">
                    <p className="text-sm font-medium leading-5 text-[var(--onboarding-text-primary)]">
                      {t("onboarding.rehaul.dictationHotkey.activation")}
                    </p>
                    <p className="text-sm leading-5 text-[var(--onboarding-text-secondary)]">
                      {t(
                        activationMode === "push"
                          ? "onboarding.activation.holdDescription"
                          : "onboarding.activation.tapDescription"
                      )}
                    </p>
                  </div>
                  <ActivationModeSelector
                    variant="onboarding"
                    value={activationMode}
                    onChange={setActivationMode}
                    pushDisabledReason={pushToTalkUnavailableReason ?? undefined}
                  />
                </div>
                {/* Denied input access gets the setup box below instead. */}
                {pushToTalkUnavailableReason && !linuxInputAccessDenied && (
                  <p className="mt-2 text-start text-xs leading-[1.4] text-[var(--onboarding-text-secondary)]">
                    {pushToTalkUnavailableReason}
                  </p>
                )}
                {platform === "linux" && (activationMode === "push" || linuxInputAccessDenied) && (
                  <LinuxPttSetupInfo isAvailable={!linuxInputAccessDenied} />
                )}
              </div>
            )}
          </div>
        );
      }

      case "dictation-demo":
      case "assistant-demo": {
        const assistant = currentStepId === "assistant-demo";
        const scenario = resolveAssistantDemoScenario({
          calendarConnected: hasConnectedCalendar,
          screenContextActive,
        });
        const hotkeyInstruction = formatHotkeyInstruction(
          assistant ? assistantHotkey : dictationHotkey
        );
        const description = t(
          assistant
            ? `onboarding.rehaul.assistantDemo.scenarios.${scenario}.description`
            : activationMode === "push"
              ? "onboarding.activation.holdHotkey"
              : "onboarding.rehaul.dictationDemo.description",
          // Formatted for reading: the raw accelerator would show internal
          // syntax like "GLOBE" or "CommandOrControl+Shift+Space".
          { hotkey: hotkeyInstruction }
        );
        return (
          <div className="h-full w-full pt-2">
            <OnboardingStepHeader
              title={t(
                assistant
                  ? "onboarding.rehaul.assistantDemo.title"
                  : "onboarding.rehaul.dictationDemo.title"
              )}
              // The assistant demo's card is tall, so its title runs one line.
              titleLines={
                assistant
                  ? undefined
                  : [
                      t("onboarding.rehaul.dictationDemo.titleLineOne"),
                      t("onboarding.rehaul.dictationDemo.titleLineTwo"),
                    ]
              }
              wideTitle={assistant}
              description={<DemoHotkeyDescription text={description} hotkey={hotkeyInstruction} />}
            />
            <DemoStep
              kind={assistant ? "assistant" : "dictation"}
              initialSuccessful={assistant ? assistantDemoSuccess : dictationDemoSuccess}
              firstMessage={t(
                assistant
                  ? "onboarding.rehaul.assistantDemo.email.body"
                  : "onboarding.rehaul.dictationDemo.founder"
              )}
              secondMessage={t(
                assistant
                  ? `onboarding.rehaul.assistantDemo.scenarios.${scenario}.prompt`
                  : "onboarding.rehaul.dictationDemo.prompt"
              )}
              placeholder={t("onboarding.rehaul.dictationDemo.placeholder")}
              listeningLabel={t("onboarding.rehaul.demo.listening")}
              processingLabel={t("onboarding.rehaul.demo.processing")}
              stopLabel={t("onboarding.rehaul.demo.stop")}
              retryLabel={t("common.retry")}
              onSuccessChange={assistant ? setAssistantDemoSuccess : setDictationDemoSuccess}
            />
          </div>
        );
      }

      case "notes":
        return (
          // Compact centred column; the calendar body owns short-window scrolling.
          <div className="flex h-full min-h-0 w-full flex-col items-center gap-5 pt-1">
            <header className="flex w-full shrink-0 flex-col items-center gap-3 text-center">
              <h1 className="onboarding-display-title text-[var(--onboarding-text-primary)]">
                <span className="block">{t("onboarding.rehaul.notes.titleLineOne")}</span>
                <span className="block">
                  {t("onboarding.rehaul.notes.titleLineTwoPrefix")}{" "}
                  {/* Caveat sits at the same 40px as the Inter run, per the spec. */}
                  <span className="brand-script">
                    {t("onboarding.rehaul.notes.titleLineTwoBrand")}
                  </span>
                </span>
              </h1>
              <p className="w-full max-w-xs text-sm leading-[1.5] text-[var(--onboarding-text-secondary)]">
                {t("onboarding.rehaul.notes.description")}
              </p>
            </header>
            {/* The hero panel and the connector list are both fixed-height, so on
                a short window they run past the footer. The shell never scrolls,
                so the content scrolls here instead — px-1/pb-1 keeps focus rings
                off the clip edge. */}
            <div className="onboarding-shell-scroll min-h-0 w-full flex-1 overflow-y-auto px-1 pb-1">
              <CalendarConnectionsStep />
            </div>
          </div>
        );

      case "setup-choice":
        return (
          <div className="h-full w-full space-y-6 p-6">
            <NimiAISettings />
            <NimiSetupButton disabled={isFinishing} onClick={() => void finalizeOnboarding()}>
              {t("common.continue")}
            </NimiSetupButton>
          </div>
        );
    }
  };

  const hasShellNavigation = !compact;
  const hotkeyStep = currentStepId === "dictation-hotkey" || currentStepId === "assistant-hotkey";
  const demoStep = currentStepId === "dictation-demo" || currentStepId === "assistant-demo";
  const notesStep = currentStepId === "notes";
  const inlineGatedStep = hotkeyStep || demoStep;
  const choiceStep = currentStepId === "setup-choice";
  const inlineProviderStep =
    currentStepId === "byok-dictation" ||
    currentStepId === "byok-assistant" ||
    currentStepId === "local-dictation" ||
    currentStepId === "local-assistant";
  // Choice/provider pages own their forward action. Hotkey/demo pages withhold
  // Continue until complete; Notes does the same until a calendar is connected.
  const showsContinue =
    hasShellNavigation &&
    !choiceStep &&
    !inlineProviderStep &&
    (!inlineGatedStep || canContinue || setupDecisionPending) &&
    (!notesStep || notesFooterAction !== "skip");
  // Practice remains skippable if it cannot complete. Calendar connections are
  // optional, so Notes starts with Skip and replaces it with Continue on connect.
  // While the setup decision is pending, a disabled Continue stands in for Skip.
  const showsSkip =
    !setupDecisionPending &&
    ((demoStep && !canContinue) || (notesStep && notesFooterAction === "skip"));

  return (
    <>
      <OnboardingShell
        compact={compact}
        stepKey={currentStepId}
        // History is the only Back gate. This preserves the branch's provider
        // escape path and also lets users return from setup choice/languages.
        // The required-models step is the exception: it is an org-mandated
        // blocker, so backing out of it (to auth) is suppressed.
        onBack={
          hasShellNavigation && session.history.length > 0 && currentStepId !== "required-models"
            ? goBack
            : undefined
        }
        onContinue={showsContinue ? () => void continueFromCurrentStep() : undefined}
        // Demos are optional practice, and calendar connections on Notes are
        // optional setup. Both advance through the same persisted route.
        onSkip={showsSkip ? () => void continueFromCurrentStep() : undefined}
        continueLabel={
          currentStepId === "use-cases"
            ? t("onboarding.useCase.proceedToSetup")
            : t("common.continue")
        }
        skipLabel={t("common.skip")}
        continueDisabled={!canContinue}
        continueLoading={isFinishing || isRegistering || setupDecisionPending}
        progress={getOnboardingProgress(currentStepId, route)}
        // Label Back only when it is the sole footer action. Unlike the source
        // commit, this branch also has demo Skip, so Back stays icon-only there.
        showBackLabel={!showsContinue && !showsSkip}
      >
        {fatalError && (
          <div
            role="alert"
            className="fixed left-1/2 top-14 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-destructive/20 bg-card px-4 py-2 text-sm text-destructive shadow-lg"
          >
            <AlertCircle className="size-4" />
            {fatalError}
          </div>
        )}
        {renderStep()}
      </OnboardingShell>

      <AlertDialog
        open={permissionAlert !== null}
        onOpenChange={(open) => !open && setPermissionAlert(null)}
        title={permissionAlert?.title ?? ""}
        description={permissionAlert?.description}
        onOk={() => setPermissionAlert(null)}
      />
    </>
  );
}
