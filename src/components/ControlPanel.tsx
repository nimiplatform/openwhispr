import React, { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "./ui/button";
import { PAGE_CONTENT_WIDTH_CLASS } from "./ui/pageWidth";
import { cn } from "./lib/utils";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "./ui/BidiInterpolatedText";
import { Download, RefreshCw, Loader2, AlertTriangle } from "./icons";
import UpgradePrompt from "./UpgradePrompt";
import PostMigrationOnboarding from "./PostMigrationOnboarding";

import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { usePermissions } from "../hooks/usePermissions";
import { useHotkey } from "../hooks/useHotkey";
import { useToast } from "./ui/useToast";
import { NIMI_USER_CANCEL } from "../services/nimiRequest";

import { useSettings } from "../hooks/useSettings";
import { useAuth } from "../hooks/useAuth";
import { useJoinableWorkspaces } from "../hooks/useJoinableWorkspaces";
import { useWorkspace } from "../hooks/useWorkspace";
import { manageableWorkspaces, selectWorkspaceForSpaceCreation } from "../lib/workspaceSelection";
import { useUsage } from "../hooks/useUsage";
import { decideUpsell } from "../lib/upsell";
import { useCollapsibleSidebar } from "../hooks/useCollapsibleSidebar";
import {
  useTranscriptions,
  useShowDiscarded,
  initializeTranscriptions,
  removeTranscription as removeFromStore,
  updateTranscription as updateInStore,
  clearTranscriptions as clearStore,
} from "../stores/transcriptionStore";
import { getSettings, useSettingsStore } from "../stores/settingsStore";
import { usePolicyStore } from "../stores/policyStore";
import { usePolicySnapshot } from "../hooks/usePolicy";
import {
  isAgentAllowed,
  isControlPanelViewAllowed,
  isPolicyActionAllowed,
  isTranscriptionSelectionAllowed,
  isUpdateRequiredByOrg,
} from "../stores/policyRules";
import { getNimiClient, prepareNimiAIWork, runNimiRequest } from "../services/nimiClient";
import { resolvePrompt } from "../config/prompts";
import { getDictionaryHintWords } from "../utils/snippets";
import { getBaseLanguageCode, getLanguageLabel } from "../utils/languageSupport";
import {
  useIsMeetingMode,
  useIsNarrowWindow,
  useMeetingRecordingStore,
} from "../stores/meetingRecordingStore";
import ControlPanelSidebar from "./ControlPanelSidebar";
import ControlPanelTopBar from "./ControlPanelTopBar";
import { useControlPanelNavItems, type ControlPanelView } from "./controlPanelNav";
import {
  DEFAULT_INTEGRATIONS_SECTION,
  type IntegrationsSection,
} from "./integrations/integrationsSections";
import { navigateMeetingNotification } from "./meetingNotificationNavigation";
import MeetingRecordingMount from "./MeetingRecordingMount";
import MeetingRecordingPill from "./notes/MeetingRecordingPill";
import NewNoteMenu from "./notes/NewNoteMenu";

import { getCachedPlatform } from "../utils/platform";
import { isAccessibilitySkipped } from "../utils/permissions";

import { startRecordingForNote, useCreateNote } from "../hooks/useCreateNote";
import { useSignInCloudNudge } from "../hooks/useSignInCloudNudge";
import {
  setActiveNoteId,
  setActiveFolderId,
  navigateToContainer,
  useActiveNoteId,
  initializeNotes,
  subscribeMeetingNotificationFolders,
} from "../stores/noteStore";

import { shouldRunTranslateStep } from "../helpers/translationChain";
import { getAgentName } from "../utils/agentName";
import HistoryView from "./HistoryView";
import BackgroundActionToastListener from "./notes/BackgroundActionToastListener";

import SpaceSyncToastListener from "./notes/SpaceSyncToastListener";
import { syncService } from "../services/SyncService.js";
import logger from "../utils/logger";
import AcceptInvitationModal from "./AcceptInvitationModal";
import JoinYourTeamModal from "./JoinYourTeamModal";
import {
  consumePendingInvitationToken,
  clearPendingInvitationToken,
} from "../utils/pendingInvitationToken";

const platform = getCachedPlatform();

const SIDEBAR_WIDTH_PX = 192;

const SettingsModal = React.lazy(() => import("./SettingsModal"));
const ReferralModal = React.lazy(() => import("./ReferralModal"));
const InviteTeammateDialog = React.lazy(() => import("./InviteTeammateDialog"));
const PersonalNotesView = React.lazy(() => import("./notes/PersonalNotesView"));
const InsightsView = React.lazy(() => import("./InsightsView"));
const DictionaryView = React.lazy(() => import("./DictionaryView"));
const UploadAudioView = React.lazy(() => import("./notes/UploadAudioView"));
const IntegrationsView = React.lazy(() => import("./IntegrationsView"));
const ChatView = React.lazy(() => import("./chat/ChatView"));
const CommandSearch = React.lazy(() => import("./CommandSearch"));

interface ControlPanelProps {
  /** Open the settings modal at this section on mount (e.g. after onboarding). */
  initialSettingsSection?: string;
}

export default function ControlPanel({ initialSettingsSection }: ControlPanelProps = {}) {
  const { t } = useTranslation();
  useEffect(subscribeMeetingNotificationFolders, []);
  const history = useTranscriptions();
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(!!initialSettingsSection);
  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false);
  const [showPostMigration, setShowPostMigration] = useState(false);
  const [limitData, setLimitData] = useState<{ wordsUsed: number; limit: number } | null>(null);
  const hasShownUpgradePrompt = useRef(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>(
    initialSettingsSection
  );
  // Counts named show-settings requests, so asking again for the section the
  // modal was opened at still lands there after the user moved elsewhere in it.
  const [settingsRequest, setSettingsRequest] = useState(0);
  const [aiCTADismissed, setAiCTADismissed] = useState(
    () => localStorage.getItem("aiCTADismissed") === "true"
  );
  const [showReferrals, setShowReferrals] = useState(false);
  const [showInviteTeam, setShowInviteTeam] = useState(false);
  const [invitationToken, setInvitationToken] = useState<string | null>(null);
  const [invitationNotesEntry, setInvitationNotesEntry] = useState<{
    workspaceId: string;
    teamIds: string[];
    spaceIds: string[];
  } | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const showDiscarded = useShowDiscarded();
  const [activeView, setActiveView] = useState<ControlPanelView>("home");
  const [integrationsSection, setIntegrationsSection] = useState<IntegrationsSection>(
    DEFAULT_INTEGRATIONS_SECTION
  );
  const navItems = useControlPanelNavItems();
  const {
    collapsed: sidebarCollapsed,
    peek: sidebarPeek,
    toggle: toggleSidebar,
    showPeek: showSidebarPeek,
    hidePeek: hideSidebarPeek,
    leaveToggle: leaveSidebarToggle,
  } = useCollapsibleSidebar();
  const isMeetingMode = useIsMeetingMode();
  const isNarrowWindow = useIsNarrowWindow();
  const activeNoteId = useActiveNoteId();
  const isSidePanelLayout =
    isMeetingMode || (isNarrowWindow && activeView === "personal-notes" && activeNoteId != null);
  const recordingNoteId = useMeetingRecordingStore((s) => s.recordingNoteId);
  const recordingFolderId = useMeetingRecordingStore((s) => s.recordingFolderId);
  const [meetingRecordingRequest, setMeetingRecordingRequest] = useState<{
    noteId: number;
    folderId: number | null;
    event: any;
  } | null>(null);

  const updateReadyToastShown = useRef(false);
  const { hotkey } = useHotkey();
  const { toast } = useToast();
  const { useCleanupModel } = useSettings();
  const { isSignedIn, isLoaded: authLoaded, user } = useAuth();
  // Suppressed while a deep-linked invitation is open so the two never stack.
  const {
    joinable,
    dismiss: dismissJoinable,
    markRequested,
  } = useJoinableWorkspaces(user?.id ?? null, isSignedIn && !invitationToken);
  const { workspaces, active: activeWorkspace } = useWorkspace();
  // Invitations are owner/admin-only (server-enforced), so the sidebar row
  // only exists when the user can manage a workspace.
  const inviteWorkspace = selectWorkspaceForSpaceCreation(
    manageableWorkspaces(workspaces),
    activeWorkspace,
    null
  );
  const usage = useUsage();
  const upsell = decideUpsell({
    authLoaded,
    isSignedIn,
    hasPaidAccess: usage?.hasPaidAccess ?? null,
    isPastDue: usage?.isPastDue ?? false,
  });

  const openTranscriptionSettings = useCallback(() => {
    setSettingsSection("transcription");
    setShowSettings(true);
  }, []);
  useSignInCloudNudge(isSignedIn, openTranscriptionSettings);

  const agentAllowedByPolicy = usePolicyStore(isAgentAllowed);
  const { createNote } = useCreateNote();
  // The note is created before the view switches so Notes mounts with it already open.
  const handleNewNote = useCallback(async () => {
    await createNote();
    setActiveView("personal-notes");
  }, [createNote]);
  const policyActionsAllowed = usePolicyStore((state) => isPolicyActionAllowed(state));
  useEffect(() => {
    if (!isControlPanelViewAllowed(activeView, agentAllowedByPolicy, policyActionsAllowed)) {
      setActiveView("home");
    }
  }, [activeView, agentAllowedByPolicy, policyActionsAllowed]);
  const updateRequiredByOrg = usePolicyStore(isUpdateRequiredByOrg);
  const policyMinAppVersion = usePolicyStore((s) => s.policy?.minAppVersion ?? null);

  // Policy-effective, because the settings pane the GPU banner links to renders
  // the clamped mode — see eligibleGpuOffers.
  const policySnapshot = usePolicySnapshot();

  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    showAlertDialog,
    hideConfirmDialog,
    hideAlertDialog,
  } = useDialogs();
  const { micPermissionStatus } = usePermissions(showAlertDialog);

  const loadTranscriptions = useCallback(
    async (includeDiscarded?: boolean) => {
      try {
        setIsLoading(true);
        await initializeTranscriptions(undefined, includeDiscarded);
      } catch {
        showAlertDialog({
          title: t("controlPanel.history.couldNotLoadTitle"),
          description: t("controlPanel.history.couldNotLoadDescription"),
        });
      } finally {
        setIsLoading(false);
      }
    },
    [showAlertDialog, t]
  );

  useEffect(() => {
    loadTranscriptions();
  }, [loadTranscriptions]);

  useEffect(() => {
    const { noteFilesEnabled, noteFilesPath } = useSettingsStore.getState();
    if (!noteFilesEnabled) return;
    window.electronAPI?.noteFilesSetEnabled?.(true, noteFilesPath || undefined, {
      skipRebuild: true,
    });
  }, []);

  useEffect(() => {
    if (platform !== "darwin") return;
    window.electronAPI?.getPostMigrationState?.().then((state) => {
      if (state?.justMigrated) setShowPostMigration(true);
    });
  }, []);

  const dismissPostMigrationPermanently = useCallback(async () => {
    await window.electronAPI?.markBundleMigrated?.();
    setShowPostMigration(false);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = platform === "darwin" ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "k") {
        e.preventDefault();
        setShowSearch(true);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setShowSettings(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const dispose = window.electronAPI?.onLimitReached?.(
      (data: { wordsUsed: number; limit: number }) => {
        if (!hasShownUpgradePrompt.current) {
          hasShownUpgradePrompt.current = true;
          setLimitData(data);
          setShowUpgradePrompt(true);
        } else {
          toast({
            title: t("controlPanel.limit.weeklyTitle"),
            description: t("controlPanel.limit.weeklyDescription"),
            duration: 5000,
          });
        }
      }
    );

    return () => {
      dispose?.();
    };
  }, [toast, t]);

  useEffect(() => {
    if (!usage?.isPastDue) return;
    if (sessionStorage.getItem("pastDueNotified")) return;
    sessionStorage.setItem("pastDueNotified", "true");
    toast({
      title: t("controlPanel.billing.pastDueTitle"),
      description: t("controlPanel.billing.pastDueDescription"),
      variant: "destructive",
      duration: 8000,
    });
  }, [usage?.isPastDue, toast, t]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onWorkspaceInvitationToken?.((token) => {
      setInvitationToken(token);
      // Consume the main-process stash so a handled push isn't re-pulled on a
      // later remount.
      void window.electronAPI?.getPendingInvitationToken?.();
    });
    window.electronAPI?.getPendingInvitationToken?.().then((token) => {
      if (token) setInvitationToken(token);
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    // Also when signed out (the modal's "Sign in to accept" handles auth);
    // isSignedIn stays in the deps so a stored token resurfaces after sign-in.
    if (!authLoaded) return;
    const pending = consumePendingInvitationToken();
    if (pending) {
      setInvitationToken(pending);
      clearPendingInvitationToken();
    }
  }, [authLoaded, isSignedIn]);

  // A ref, not a per-run flag: StrictMode's remount must not cancel the first drain.
  const meetingNavigationMounted = useRef(false);
  useEffect(() => {
    meetingNavigationMounted.current = true;
    const isCurrent = () => meetingNavigationMounted.current;
    const drain = async () => {
      const data = await window.electronAPI?.getPendingMeetingNoteNavigation?.();
      if (!data) return;
      if (data.navigationId) {
        if (!isCurrent() || data.spaceId == null) {
          await window.electronAPI.confirmMeetingNoteNavigation(data.navigationId, "cancel");
          return;
        }
        setActiveView("personal-notes");
        await navigateMeetingNotification(
          { ...data, navigationId: data.navigationId, spaceId: data.spaceId },
          isCurrent,
          () => import("./notes/PersonalNotesView"),
          (note) => {
            void startRecordingForNote(note)
              .then((accepted) => {
                if (!accepted) void window.electronAPI?.restoreFromMeetingMode?.();
              })
              .catch((error) =>
                logger.warn(
                  "Failed to start notification recording",
                  { error: String(error) },
                  "meeting"
                )
              );
          }
        );
        return;
      }
      if (!isCurrent()) return;
      setActiveFolderId(data.folderId);
      setActiveNoteId(data.noteId);
      setActiveView("personal-notes");
      setMeetingRecordingRequest({
        noteId: data.noteId,
        folderId: data.folderId,
        event: data.event,
      });
      void initializeNotes(null, 50, data.folderId);
      if (
        data.trigger === "hotkey" &&
        useSettingsStore.getState().meetingHotkeyLayoutMode === "side-panel"
      ) {
        window.electronAPI?.snapToMeetingMode?.();
      }
    };
    const safeDrain = () => {
      void drain().catch((error) =>
        logger.warn("Failed to open meeting note", { error: String(error) }, "meeting")
      );
    };
    safeDrain();
    const cleanup = window.electronAPI?.onMeetingNoteNavigationPending?.(safeDrain);
    return () => {
      meetingNavigationMounted.current = false;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    const drain = async () => {
      const data = await window.electronAPI?.getPendingNoteNavigation?.();
      if (!data) return;
      if (data.folderId) {
        setActiveFolderId(data.folderId);
        initializeNotes(null, 50, data.folderId);
      }
      setActiveNoteId(data.noteId);
      setActiveView("personal-notes");
    };
    drain();
    const cleanup = window.electronAPI?.onNoteNavigationPending?.(drain);
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    // A named section waits in main (it can outrace this listener on a cold
    // start); a bare request (app-menu Cmd+,) keeps an open modal where it is.
    const drain = async (showAnyway: boolean) => {
      const section = await window.electronAPI?.getPendingSettingsSection?.();
      if (section) {
        setSettingsSection(section);
        setSettingsRequest((count) => count + 1);
      }
      if (section || showAnyway) setShowSettings(true);
    };
    drain(false);
    const cleanup = window.electronAPI?.onShowSettings?.(() => drain(true));
    return () => cleanup?.();
  }, []);

  // When accessibility is missing on macOS, open the permissions settings page
  useEffect(() => {
    const cleanup = window.electronAPI?.onAccessibilityMissing?.(async () => {
      if (isAccessibilitySkipped()) return;
      const migration = await window.electronAPI?.getPostMigrationState?.();
      if (migration?.justMigrated) return;
      setSettingsSection("privacyData");
      setShowSettings(true);
      toast({
        title: t("controlPanel.accessibilityMissing.title"),
        description: t("controlPanel.accessibilityMissing.description"),
        duration: 10000,
      });
    });
    return () => cleanup?.();
  }, [toast, t]);

  useEffect(() => {}, []);

  const handleMeetingRecordingRequestHandled = useCallback(
    () => setMeetingRecordingRequest(null),
    []
  );

  // The side-panel layout is shared by meeting mode and by a note opened in a
  // narrow window, so leaving it means different things in each case.
  const handleExitSidePanel = useCallback(() => {
    if (isMeetingMode) window.electronAPI?.restoreFromMeetingMode?.();
    else setActiveNoteId(null);
  }, [isMeetingMode]);

  const copyToClipboard = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast({
          title: t("controlPanel.history.copiedTitle"),
          description: t("controlPanel.history.copiedDescription"),
          variant: "success",
          duration: 2000,
        });
      } catch (err) {
        toast({
          title: t("controlPanel.history.couldNotCopyTitle"),
          description: t("controlPanel.history.couldNotCopyDescription"),
          variant: "destructive",
        });
      }
    },
    [toast, t]
  );

  const deleteTranscription = useCallback(
    async (id: number) => {
      showConfirmDialog({
        title: t("controlPanel.history.deleteTitle"),
        description: t("controlPanel.history.deleteDescription"),
        onConfirm: async () => {
          try {
            const result = await window.electronAPI.deleteTranscription(id);
            if (result.success) {
              removeFromStore(id);
              syncService.requestSyncAll("manual");
            } else {
              showAlertDialog({
                title: t("controlPanel.history.couldNotDeleteTitle"),
                description: t("controlPanel.history.couldNotDeleteDescription"),
              });
            }
          } catch {
            showAlertDialog({
              title: t("controlPanel.history.couldNotDeleteTitle"),
              description: t("controlPanel.history.couldNotDeleteDescriptionGeneric"),
            });
          }
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, showAlertDialog, t]
  );

  const clearAllTranscriptions = useCallback(() => {
    showConfirmDialog({
      title: t("controlPanel.history.clearAllTitle"),
      description: t(
        isSignedIn
          ? "controlPanel.history.clearAllDescription"
          : "controlPanel.history.clearAllDescriptionDevice"
      ),
      onConfirm: async () => {
        try {
          const result = await window.electronAPI.clearTranscriptions();
          if (result.success) {
            clearStore();
            syncService.requestSyncAll("manual");
            toast({
              title: t("controlPanel.history.clearAllSuccess"),
              variant: "success",
              duration: 2000,
            });
          } else {
            showAlertDialog({
              title: t("controlPanel.history.clearAllErrorTitle"),
              description: t("controlPanel.history.clearAllErrorDescription"),
            });
          }
        } catch {
          showAlertDialog({
            title: t("controlPanel.history.clearAllErrorTitle"),
            description: t("controlPanel.history.clearAllErrorDescription"),
          });
        }
      },
      variant: "destructive",
    });
  }, [isSignedIn, showConfirmDialog, showAlertDialog, toast, t]);

  const showAudioInFolder = useCallback(
    async (id: number) => {
      try {
        const result = await window.electronAPI.showAudioInFolder(id);
        if (!result?.success) {
          toast({
            title: t("controlPanel.history.audioNotFound"),
            variant: "destructive",
          });
        }
      } catch {
        toast({
          title: t("controlPanel.history.audioNotFound"),
          variant: "destructive",
        });
      }
    },
    [toast, t]
  );

  const historyRetryControllers = useRef(new Map<number, AbortController>());
  useEffect(
    () => () => {
      for (const controller of historyRetryControllers.current.values()) controller.abort();
      historyRetryControllers.current.clear();
    },
    [activeView]
  );

  const retryTranscription = useCallback(
    async (id: number, options?: { isRecover?: boolean }) => {
      if (historyRetryControllers.current.has(id)) return;
      const controller = new AbortController();
      historyRetryControllers.current.set(id, controller);
      try {
        await prepareNimiAIWork(controller.signal);
        const s = getSettings();
        const snapshot = await getNimiClient().aiConfig.get();
        controller.signal.throwIfAborted();
        const selection = snapshot.effectiveSelections.find(
          (value) => value.capabilityContract === "audio.transcribe"
        );
        if (selection?.state !== "ready")
          throw new Error(selection?.reasons.join(", ") || "AI_LOCAL_CONFIGURATION_NOT_CONFIGURED");
        const resource = selection.resource;
        const mode = resource?.oneofKind === "local" ? "local" : "providers";
        const provider = resource?.oneofKind === "cloud" ? resource.cloud.connector.provider : "";
        if (!isTranscriptionSelectionAllowed(usePolicyStore.getState(), { mode, provider })) {
          toast({ title: t("common.managedByOrg"), variant: "default" });
          return;
        }
        const agentName = getAgentName();
        const promptOptions = {
          agentName,
          language: s.preferredLanguage,
          customDictionary: getDictionaryHintWords(s),
          uiLanguage: s.uiLanguage,
        };
        const result = await runNimiRequest<{
          success: boolean;
          transcription: import("../types/electron").TranscriptionItem;
          warnings: Array<{ stage: string; message: string }>;
        }>(
          "openwhispr.history.retry",
          {
            id,
            preferredLanguage: s.preferredLanguage,
            language:
              s.preferredLanguage === "auto" ? "" : getBaseLanguageCode(s.preferredLanguage),
            prompt: getDictionaryHintWords(s).join(", "),
            cleanupPrompt: s.useCleanupModel ? resolvePrompt("cleanup", promptOptions) : "",
            translationPrompt:
              s.translationTargetLanguage &&
              shouldRunTranslateStep(s.translationSourceLanguage, s.translationTargetLanguage)
                ? resolvePrompt("translate", {
                    ...promptOptions,
                    targetLanguageLabel: getLanguageLabel(s.translationTargetLanguage),
                  })
                : "",
            translationSourceLanguage: s.translationSourceLanguage,
            translationTargetLanguage: s.translationTargetLanguage,
            chineseScriptPreference: s.chineseScriptPreference,
          },
          controller.signal
        );
        controller.signal.throwIfAborted();
        updateInStore(result.transcription);
        toast({
          title: t(
            options?.isRecover
              ? "controlPanel.history.discarded.recovered"
              : "controlPanel.history.retrySuccess"
          ),
        });
        for (const warning of result.warnings) {
          toast({
            title: t(
              warning.stage === "notification"
                ? "controlPanel.history.retryNotificationWarning"
                : "controlPanel.history.retryEditingWarning"
            ),
            description: warning.message,
            variant: "destructive",
          });
        }
      } catch (error) {
        if (
          !controller.signal.aborted ||
          (error as { audioCancellationFailed?: boolean })?.audioCancellationFailed
        )
          toast({
            title: t("controlPanel.history.retryError"),
            description: error instanceof Error ? error.message : String(error),
            variant: "destructive",
          });
      } finally {
        historyRetryControllers.current.delete(id);
      }
    },
    [toast, t]
  );

  const toggleShowDiscarded = useCallback(() => {
    loadTranscriptions(!showDiscarded);
  }, [loadTranscriptions, showDiscarded]);

  return (
    <div className="h-screen bg-surface-window flex flex-col">
      <MeetingRecordingMount />
      <MeetingRecordingPill
        activeView={activeView}
        activeNoteId={activeNoteId}
        onReturnToNote={() => {
          setActiveView("personal-notes");
          setActiveFolderId(recordingFolderId);
          setActiveNoteId(recordingNoteId);
        }}
      />
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={hideConfirmDialog}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={hideAlertDialog}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      <UpgradePrompt
        open={showUpgradePrompt}
        onOpenChange={setShowUpgradePrompt}
        wordsUsed={limitData?.wordsUsed}
        limit={limitData?.limit}
      />

      <PostMigrationOnboarding
        open={showPostMigration}
        onOpenChange={setShowPostMigration}
        onDone={dismissPostMigrationPermanently}
      />

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal
            // SettingsModal reads initialSection only on open, so a named request remounts it.
            key={`${settingsSection ?? "default"}-${settingsRequest}`}
            open={showSettings}
            onOpenChange={(open) => {
              setShowSettings(open);
              if (!open) setSettingsSection(undefined);
            }}
            initialSection={settingsSection}
          />
        </Suspense>
      )}

      {showReferrals && (
        <Suspense fallback={null}>
          <ReferralModal open={showReferrals} onOpenChange={setShowReferrals} />
        </Suspense>
      )}

      {showInviteTeam && inviteWorkspace && (
        <Suspense fallback={null}>
          <InviteTeammateDialog
            open={showInviteTeam}
            onOpenChange={setShowInviteTeam}
            workspaceId={inviteWorkspace.id}
            workspaceName={inviteWorkspace.name}
          />
        </Suspense>
      )}

      <AcceptInvitationModal
        token={invitationToken}
        onClose={() => setInvitationToken(null)}
        onAccepted={(entry) => {
          setInvitationNotesEntry(entry);
          setActiveView("personal-notes");
        }}
      />

      <JoinYourTeamModal
        joinable={joinable}
        domain={user?.email?.split("@")[1] ?? null}
        onDismiss={dismissJoinable}
        onRequested={markRequested}
        onJoined={() => setActiveView("personal-notes")}
      />

      {/* Always mounted so the palette chunk is warm and Radix can play its exit animation. */}
      <Suspense fallback={null}>
        <CommandSearch
          open={showSearch}
          onOpenChange={setShowSearch}
          transcriptions={history}
          onNoteSelect={(id, folderId, spaceId) => {
            if (folderId != null) setActiveFolderId(folderId);
            else if (spaceId != null) navigateToContainer(spaceId, null);
            setActiveNoteId(id);
            setActiveView("personal-notes");
          }}
          onContainerSelect={(spaceId, folderId) => {
            navigateToContainer(spaceId, folderId);
            setActiveView("personal-notes");
          }}
          onTranscriptSelect={() => {
            setActiveView("home");
          }}
        />
      </Suspense>

      <div className="flex flex-1 overflow-hidden relative">
        <div
          className="shrink-0 transition-[width] duration-300 ease-out"
          style={{ width: sidebarCollapsed || isSidePanelLayout ? 0 : SIDEBAR_WIDTH_PX }}
        />
        <div
          className={`absolute inset-y-0 start-0 z-30 transition-transform duration-300 ease-out ${
            !isSidePanelLayout && (!sidebarCollapsed || sidebarPeek)
              ? "translate-x-0"
              : "ltr:-translate-x-full rtl:translate-x-full"
          }${
            sidebarCollapsed && sidebarPeek && !isSidePanelLayout
              ? " shadow-[10px_0_40px_-18px_rgba(0,0,0,0.2)] rtl:shadow-[-10px_0_40px_-18px_rgba(0,0,0,0.2)]"
              : ""
          }`}
          onMouseEnter={sidebarCollapsed ? showSidebarPeek : undefined}
          onMouseLeave={sidebarCollapsed ? hideSidebarPeek : undefined}
        >
          <ControlPanelSidebar
            activeView={activeView}
            onViewChange={setActiveView}
            onOpenSettings={() => {
              setSettingsSection(undefined);
              setShowSettings(true);
            }}
            onOpenReferrals={() => setShowReferrals(true)}
            onInviteTeam={inviteWorkspace ? () => setShowInviteTeam(true) : undefined}
            onUpgrade={() => {
              setSettingsSection("plansBilling");
              setShowSettings(true);
            }}
            isOverLimit={usage?.isOverLimit ?? false}
            userName={user?.name}
            userEmail={user?.email}
            userImage={user?.image}
            isSignedIn={isSignedIn}
            authLoaded={authLoaded}
            upsell="hide"
          />
        </div>
        <main className="flex-1 flex flex-col overflow-hidden p-2">
          <div className="flex min-h-0 flex-1 flex-col overflow-clip rounded-(--radius-shell) border border-border bg-background dark:border-white/10">
            <ControlPanelTopBar
              title={navItems.find((item) => item.id === activeView)?.label ?? ""}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={toggleSidebar}
              onToggleMouseEnter={sidebarCollapsed ? showSidebarPeek : undefined}
              onToggleMouseLeave={sidebarCollapsed ? leaveSidebarToggle : undefined}
              onOpenSearch={() => setShowSearch(true)}
              isSidePanelLayout={isSidePanelLayout}
              onExitSidePanel={handleExitSidePanel}
              actions={
                <NewNoteMenu
                  onNewNote={handleNewNote}
                  onNewChat={agentAllowedByPolicy ? () => setActiveView("chat") : undefined}
                />
              }
            />
            <div className="scrollbar-hidden flex-1 overflow-y-auto">
              {updateRequiredByOrg && (
                <div className={cn(PAGE_CONTENT_WIDTH_CLASS, "px-6 mb-3")}>
                  <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 p-3">
                    <div className="flex items-start gap-3">
                      <div className="shrink-0 w-8 h-8 rounded-md bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center">
                        <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-amber-900 dark:text-amber-200 mb-0.5">
                          {t("controlPanel.updateRequiredByOrg.title")}
                        </p>
                        <p className="text-xs text-amber-700 dark:text-amber-300/80">
                          <BidiInterpolatedText
                            text={t("controlPanel.updateRequiredByOrg.description", {
                              version: BIDI_VALUE_TOKEN,
                            })}
                            value={policyMinAppVersion}
                          />
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {usage?.isPastDue && activeView === "home" && (
                <div className={cn(PAGE_CONTENT_WIDTH_CLASS, "px-6 mb-3")}>
                  <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 p-3">
                    <div className="flex items-start gap-3">
                      <div className="shrink-0 w-8 h-8 rounded-md bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center">
                        <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-amber-900 dark:text-amber-200 mb-0.5">
                          {t("controlPanel.billing.pastDueTitle")}
                        </p>
                        <p className="text-xs text-amber-700 dark:text-amber-300/80 mb-2">
                          {t("controlPanel.billing.bannerDescription", {
                            limit: usage.limit.toLocaleString(),
                          })}
                        </p>
                        <Button
                          variant="default"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => {
                            setSettingsSection("account");
                            setShowSettings(true);
                          }}
                        >
                          {t("controlPanel.billing.updatePayment")}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeView === "home" && (
                <>
                  {micPermissionStatus !== "granted" && (
                    <div
                      role="status"
                      className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-border p-4"
                    >
                      <p>
                        {t(
                          micPermissionStatus === "unknown"
                            ? "nimi.microphoneUnknown"
                            : "nimi.microphoneRequired"
                        )}
                      </p>
                      <Button
                        onClick={() => {
                          setSettingsSection("general");
                          setShowSettings(true);
                        }}
                      >
                        {t("nimi.microphoneSettings")}
                      </Button>
                    </div>
                  )}
                  <HistoryView
                    history={history}
                    isLoading={isLoading}
                    hotkey={hotkey}
                    aiCTADismissed={aiCTADismissed}
                    setAiCTADismissed={setAiCTADismissed}
                    useCleanupModel={useCleanupModel}
                    copyToClipboard={copyToClipboard}
                    deleteTranscription={deleteTranscription}
                    clearAllTranscriptions={clearAllTranscriptions}
                    onShowAudioInFolder={showAudioInFolder}
                    onRetryTranscription={retryTranscription}
                    onCancelRetry={(id) =>
                      historyRetryControllers.current.get(id)?.abort(NIMI_USER_CANCEL)
                    }
                    showDiscarded={showDiscarded}
                    onToggleDiscarded={toggleShowDiscarded}
                    userName={user?.name}
                    onOpenSettings={(section) => {
                      setSettingsSection(section);
                      setShowSettings(true);
                    }}
                    onOpenIntegrations={() => {
                      setIntegrationsSection("calendars");
                      setActiveView("integrations");
                    }}
                  />
                </>
              )}
              {activeView === "insights" && (
                <Suspense fallback={null}>
                  <InsightsView
                    onSignIn={() => {
                      setSettingsSection("account");
                      setShowSettings(true);
                    }}
                  />
                </Suspense>
              )}
              {activeView === "chat" && agentAllowedByPolicy && (
                <Suspense fallback={null}>
                  <ChatView />
                </Suspense>
              )}
              {activeView === "personal-notes" && (
                <Suspense fallback={null}>
                  <PersonalNotesView
                    onOpenSettings={(section) => {
                      setSettingsSection(section);
                      setShowSettings(true);
                    }}
                    meetingRecordingRequest={meetingRecordingRequest}
                    onMeetingRecordingRequestHandled={handleMeetingRecordingRequestHandled}
                    invitationEntry={invitationNotesEntry}
                    onInvitationEntryHandled={() => setInvitationNotesEntry(null)}
                  />
                </Suspense>
              )}
              {activeView === "dictionary" && (
                <Suspense fallback={null}>
                  <DictionaryView />
                </Suspense>
              )}
              {activeView === "upload" && policyActionsAllowed && (
                <Suspense fallback={null}>
                  <UploadAudioView
                    onNoteCreated={(noteId, folderId) => {
                      setActiveNoteId(noteId);
                      if (folderId) setActiveFolderId(folderId);
                      setActiveView("personal-notes");
                    }}
                    onOpenSettings={(section) => {
                      setSettingsSection(section);
                      setShowSettings(true);
                    }}
                  />
                </Suspense>
              )}
              {activeView === "integrations" && (
                <Suspense fallback={null}>
                  <IntegrationsView
                    isPaid={usage?.hasPaidAccessOptimistic ?? false}
                    onUpgrade={() => {
                      setSettingsSection("plansBilling");
                      setShowSettings(true);
                    }}
                    section={integrationsSection}
                    onSectionChange={setIntegrationsSection}
                  />
                </Suspense>
              )}
            </div>
          </div>
        </main>
      </div>
      <BackgroundActionToastListener />
      <SpaceSyncToastListener />
    </div>
  );
}
