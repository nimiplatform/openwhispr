const { version: appVersion } = require("./appIdentity");
const { approveAudioPath, resolveAllowedAudioPath } = require("./audioFileAccess");
const { getAppDataDirectory } = require("./appData");

const { ipcMain, shell, BrowserWindow, systemPreferences, net } = require("electron");
const path = require("path");
const fs = require("fs");
const microphoneAccess = require("./microphoneAccess");
const os = require("node:os");

const { isRestorablePasteTarget } = require("./windowsPasteTarget");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { ipcErrorFields } = require("./ipcErrorFields");
const { ANALYTICS_HISTORY_BACKFILL_VERSION } = require("./analytics");

const { broadcastToWindows } = require("./windowBroadcast");
const { openExternalUrl } = require("./externalUrlOpener");

const tokenStore = require("./tokenStore");
const accountScopeBinding = require("./accountScopeBinding");
const { createCloudApiRequestHandler } = require("./cloudApiRequest");
const { decodeLeaderboardPngDataUrl, leaderboardImageFilename } = require("./leaderboardImage");
const { withPolicyRequestHeaders } = require("./policyRequestHeaders");
const {
  createWorkspacePolicyManager,
  isScreenContextBlocked,
} = require("./workspacePolicyManager");
const { createEnterpriseIdentityManager } = require("./enterpriseIdentityManager");

const { readPolicyResponseError, toPolicyFailure } = require("./policyResponseError");
const { classifyAndLog } = require("./networkErrors");
const { resolveSystemDefaultMicrophone } = require("./systemDefaultMicrophone");

const { isProviderSettingsTarget } = require("./providerHttpErrors");
const {
  registerConnectorIpc,
  createConnectorPolicyResolver,
  createConnectorAuthLookup,
} = require("./connectors/connectorIpc");
const { createNoteAttendeesLookup, searchContacts } = require("./connectors/contactSearch");
// The renderer's ModelRegistry is not main-loadable; the raw registry data is
// packaged, and the route resolver only needs {id, baseUrl} per provider.

// Classified errors show the provider's display name; routes only carry its id.

// ipcMain.handle keeps only the message when a promise rejects, dropping custom
// props — proxy handlers return the classified fields so the renderer can
// rebuild the error.

// Analytics uploads cross two asynchronous boundaries: renderer -> main and
// main -> cloud. Pin every local queue operation to the same authenticated
// account generation so a delayed pass cannot adopt a replacement session.
function assertAnalyticsSyncContext(context) {
  if (context == null) return null;
  const state = tokenStore.getState();
  if (
    typeof context !== "object" ||
    typeof context.accountId !== "string" ||
    context.accountId.length === 0 ||
    !Number.isInteger(context.authGeneration) ||
    !state.token ||
    state.generation !== context.authGeneration
  ) {
    throw Object.assign(new Error("Authentication context changed during analytics sync"), {
      code: "AUTH_CONTEXT_CHANGED",
    });
  }
  return context.accountId;
}
// Which diarization dialect a resolved endpoint speaks, for Custom endpoints
// that front a known provider. Null when the host offers no known dialect.

const { i18nMain, changeLanguage } = require("./i18nMain");

const { ONBOARDING_DEMO_KINDS, ONBOARDING_DEMO_STATUSES } = require("./onboardingInputPolicy");
const { focusWindowsHotkeyCaptureWindow } = require("./hotkeyCaptureFocus");

const AudioStorageManager = require("./audioStorage");

const AgentStreamRequestRegistry = require("./agentStreamRequestRegistry");
const createMeetingTranscriptionLifecycle = require("./meetingTranscriptionLifecycle");

const MeetingEchoLeakDetector = require("./meetingEchoLeakDetector");
const createMeetingSystemAudioWatchdog = require("./meetingSystemAudioWatchdog");
const createMeetingSystemAudioHandover = require("./meetingSystemAudioHandover");

const {
  computeChunkStats,

  MEETING_MIC_SILENCE_RMS,
  MEETING_MIC_SILENCE_PEAK,
} = require("./meetingMicGate");
const { deriveDetectorPreferences } = require("./meetingDetectionPreferencePolicy");

const { applySmartSpacing } = require("./smartSpacing");
const { applyAutoLearnSetting } = require("./autoLearnSetting");
const {
  DEFAULT_RETENTION_SETTINGS,
  createRetentionSettingsHandler,
} = require("./retentionSettings");

const { applyConfirmedSpeaker, canAutoRelabelSpeaker } = require("./speakerAssignmentPolicy");
const { normalizeStoredSpeakerCount } = require("./speakerCount");
const postMigrationDetector = require("./postMigrationDetector");
const screenContextCapture = require("./screenContextCapture");
const {
  DEFAULT_EXPECTED_SPEAKER_COUNT,
  MAX_SPEAKER_COUNT,
} = require("../constants/speakerDetection.json");
const { UPLOAD_AUDIO_EXTENSIONS } = require("../constants/uploadAudioFormats.json");

const { getCalendarAvailability } = require("./calendarAvailabilityService");

// Meeting capture runs at 24 kHz (see meetingRecordingStore AudioContext); cloud
// streaming providers must be told the true PCM rate or they misread the audio.

// The realtime clients default to a 0.6 server-VAD threshold, raised in #630 to
// keep mic ambient noise from opening turns. The system loopback channel's noise
// floor is digital silence, so it keeps the original, more sensitive threshold —
// at 0.6 quiet remote speech may never trip the VAD and the whole channel
// transcribes to nothing.

// Debounce delay: wait for user to stop typing before processing corrections
const AUTO_LEARN_DEBOUNCE_MS = 1500;

// Route caps vary by provider (Gemini's inline-base64 limit is the lowest), so
// the message reports the cap that actually applied.

// The enterprise "Test Connection" probe only needs one word back, but the
// Azure Responses API rejects max_output_tokens below 16.

const { createUploadCancelRegistry } = require("./uploadCancelRegistry");

// Chunk retries need their own connection pool: recovering a wedged chunk pool
// must not abort an unrelated inline upload that has no collateral retry path.

// Counts initiated pool drops so a chunk can tell whether its failure was
// collateral from a teardown that happened while its body was on the wire.

// Canonicalize allowed dirs so realpath'd inputs match on macOS (/var -> /private/var).
// Deliberately narrow: user-picked paths anywhere else are approved individually via
// approvedAudioPaths, so a compromised renderer can't read arbitrary files.

// Cleanup toast wording for replies the main-process providers reject; mirror
// TRUNCATED_/EMPTY_OUTPUT_MESSAGE_KEY in services/ai/chatRequestBody.ts (#2091).

const {
  isMeetingFolderRef,
  resolveMeetingDestination,
  rememberMeetingDestination,
  meetingDestinationContext,
} = require("./meetingNotificationDestination");

class IPCHandlers {
  constructor(managers) {
    this.environmentManager = managers.environmentManager;
    this.databaseManager = managers.databaseManager;
    this.clipboardManager = managers.clipboardManager;
    this.windowManager = managers.windowManager;
    this.updateManager = managers.updateManager;
    this.windowsKeyManager = managers.windowsKeyManager;
    this.linuxKeyManager = managers.linuxKeyManager;
    this.textEditMonitor = managers.textEditMonitor;
    this.selectionManager = managers.selectionManager;
    this.getTrayManager = managers.getTrayManager;
    this.requestHostRestart = managers.requestHostRestart;
    this.googleCalendarManager = managers.googleCalendarManager;
    this.connectorManager = managers.connectorManager;
    this.microsoftCalendarManager = managers.microsoftCalendarManager;
    this.appleCalendarManager = managers.appleCalendarManager;
    this.meetingDetectionEngine = managers.meetingDetectionEngine;
    this.audioTapManager = managers.audioTapManager;
    this.linuxPortalAudioManager = managers.linuxPortalAudioManager;
    this.windowsLoopbackAudioManager = managers.windowsLoopbackAudioManager;
    this.meetingAecManager = managers.meetingAecManager;
    this.getSemanticSearch = managers.getSemanticSearch;
    this.oauthProtocolRegistered = managers.oauthProtocolRegistered === true;
    this.oauthProtocol = managers.oauthProtocol || "openwhispr";
    this.sessionId = crypto.randomUUID();
    // requestId -> AbortControllers for in-flight audio-upload work (cloud
    // upload, or local transcription + diarization sharing one id), so a
    // cancel can abort the exact job.
    this._uploadCancelRegistry = createUploadCancelRegistry();
    this._agentStreamRequests = new AgentStreamRequestRegistry();
    this._cloudReasonRequests = new AgentStreamRequestRegistry();
    this._cloudTranscriptionRequests = new AgentStreamRequestRegistry();
    this._enterpriseReasoningRequests = new AgentStreamRequestRegistry();
    // webContents id -> its release listener, for renderers holding the mic open.
    this._micHoldSenders = new Map();
    this.assemblyAiStreaming = null;
    this.deepgramStreaming = null;
    this.geminiStreaming = null;
    this.cortiStreaming = null;
    this._dictationStreaming = null;
    this._dictationConnectPromise = null;
    this._dictationIdleTimer = null;
    this._dictationPreviewEnabled = false;
    this._hotkeyCaptureMode = false;
    this._autoLearnEnabled = true; // Default on, synced from renderer
    this._autoLearnDebounceTimer = null;
    this._autoLearnLatestData = null;
    this._textEditHandler = null;
    this._activeRecordingPipeline = null;
    this._onboardingDemoSession = null;
    this.audioStorageManager = new AudioStorageManager();
    this._retentionCleanupInterval = null;
    this._retentionSettings = { ...DEFAULT_RETENTION_SETTINGS }; // Synced from renderer
    this._retentionSettingsSynced = false;
    this._noteFilesEnabled = false;
    this._granolaImportPending = null;
    this._analyticsHistoryBackfillPromise = null;
    this.speakerDiarizationEnabled = true;
    // Default for the saved process-detection toggle. The engine keeps both detectors
    // off until the renderer syncs (see meetingDetectionPreferencePolicy.js).
    this.meetingProcessDetection = true;
    this.activeMeetingSpeakerConfig = null;
    this._setupTextEditMonitor();
    this._setupRetentionCleanup();
    this._logDetectedGpus();
    // Warm the OS default mic answer before the first hotkey press (~2s on Windows).
    resolveSystemDefaultMicrophone();
    this.setupHandlers();
    // Lives for the app's lifetime; IPCHandlers has no teardown path.
    tokenStore.subscribe((state) => this._handleAuthTokenChange(state));
  }

  createFolderWithEffects(name, spaceId) {
    const result = this.databaseManager.createFolder(name, spaceId);
    if (result?.success && result?.folder) {
      setImmediate(() => {
        broadcastToWindows("folder-created", result.folder);
        if (this._noteFilesEnabled) {
          const markdownMirror = require("./markdownMirror");
          markdownMirror.ensureFolder(result.folder.name);
        }
      });
    }
    return result;
  }

  getMeetingNotificationDestination(owner) {
    if (!this.windowManager.isMeetingNotificationOwner(owner))
      return { success: false, code: "STALE_NOTIFICATION" };
    try {
      const context = meetingDestinationContext(
        this.databaseManager,
        owner,
        this.windowManager.meetingRecentDestinations
      );
      this.windowManager.meetingRecentDestinations = context.recentDestinations;
      return { success: true, value: context };
    } catch (error) {
      return {
        success: false,
        code: error.code === "NOTE_UNAVAILABLE" ? error.code : "FOLDERS_UNAVAILABLE",
      };
    }
  }

  selectMeetingNotificationFolder(owner, ref) {
    const result = this.getMeetingNotificationDestination(owner);
    if (!result.success) return result;
    if (result.value.existingNote)
      return { success: false, code: "LINKED_NOTE_CHANGED", context: result.value };
    if (!isMeetingFolderRef(ref)) return { success: false, code: "INVALID_REQUEST" };
    const folder = result.value.folders.find(
      (f) => f.id === ref.folderId && f.space_id === ref.spaceId
    );
    if (!folder) return { success: false, code: "FOLDER_UNAVAILABLE" };
    owner.selectedDestination = { folderId: folder.id, spaceId: folder.space_id };
    this.windowManager.meetingRecentDestinations = rememberMeetingDestination(
      this.windowManager.meetingRecentDestinations,
      owner.selectedDestination
    );
    return {
      success: true,
      value: {
        ...result.value,
        selectedDestination: owner.selectedDestination,
        recentDestinations: this.windowManager.meetingRecentDestinations,
      },
    };
  }

  createMeetingNotificationFolder(owner, request) {
    if (!this.windowManager.isMeetingNotificationOwner(owner))
      return { success: false, code: "STALE_NOTIFICATION" };
    if (
      !request ||
      typeof request.requestId !== "string" ||
      !request.requestId.trim() ||
      request.requestId.length > 128 ||
      typeof request.name !== "string" ||
      !Number.isSafeInteger(request.spaceId) ||
      request.spaceId <= 0
    )
      return { success: false, code: "INVALID_REQUEST" };
    const name = request.name.trim();
    if (!name) return { success: false, code: "FOLDER_NAME_REQUIRED" };
    const cached = owner.createRequests.get(request.requestId);
    if (cached && (cached.name !== name || cached.spaceId !== request.spaceId))
      return { success: false, code: "INVALID_REQUEST" };
    // Bound per-prompt retry bookkeeping. Successful IDs stay stable for the prompt's lifetime.
    if (!cached && owner.createRequests.size >= 32)
      return { success: false, code: "INVALID_REQUEST" };
    const contextResult = this.getMeetingNotificationDestination(owner);
    if (!contextResult.success) return contextResult;
    if (contextResult.value.existingNote)
      return { success: false, code: "LINKED_NOTE_CHANGED", context: contextResult.value };
    if (!contextResult.value.spaces.some((space) => space.id === request.spaceId))
      return { success: false, code: "SPACE_UNAVAILABLE" };
    try {
      let ref = cached?.ref;
      if (ref) {
        if (!resolveMeetingDestination(this.databaseManager, ref))
          return { success: false, code: "FOLDER_UNAVAILABLE" };
      } else {
        const result = this.createFolderWithEffects(name, request.spaceId);
        if (!result?.success || !result.folder)
          return {
            success: false,
            code:
              result?.error === "A folder with that name already exists"
                ? "FOLDER_NAME_TAKEN"
                : result?.error === "Space not found"
                  ? "SPACE_UNAVAILABLE"
                  : "CREATE_FAILED",
          };
        ref = { folderId: result.folder.id, spaceId: result.folder.space_id };
        owner.createRequests.set(request.requestId, { name, spaceId: request.spaceId, ref });
        this.windowManager.sendToControlPanel("meeting-notification-folder-created", {
          folderId: ref.folderId,
        });
      }
      const refreshed = this.getMeetingNotificationDestination(owner);
      return refreshed.success
        ? { success: true, value: { ...refreshed.value, createdFolder: ref } }
        : refreshed;
    } catch {
      return { success: false, code: "CREATE_FAILED" };
    }
  }

  _handleAuthTokenChange({ generation, token }) {
    this.windowManager.retireMeetingNotificationScope();
    this.enterpriseIdentityManager?.clear();
    if (!token) {
      this.databaseManager.setActiveAccountId(null);
      accountScopeBinding.clear();
      broadcastToWindows("active-account-scope-changed", null);
      // As set-active-account-scope does: a connect can't outlive its account.
      this.connectorManager?.accountChanged();
    }
    broadcastToWindows("auth-token-state-changed", {
      generation,
      hasToken: Boolean(token),
    });
    // A sign-out or another account changes whose login shows.
    void this.connectorManager?.notifyStatusChanged();
  }

  // Reconstructing counters from the transcripts already on disk records exactly
  // what "keep local history" turns off, so it answers to the same switch the
  // live path checks in audioManager.saveTranscription. The main process boots
  // with defaults rather than the user's choice, so an unsynced setting is not
  // consent either -- the renderer's first sync is what starts this (#1370).
  _canReconstructAnalyticsHistory() {
    return this._retentionSettingsSynced && this._retentionSettings.dataRetentionEnabled;
  }

  /** Whether a signed-in account is bound to this install. */
  _hasActiveAccountScope() {
    return Boolean(accountScopeBinding.read());
  }

  // The switch alone is not enough to start: a managed workspace can force local
  // history off, and that policy arrives over the network while this scan takes
  // milliseconds, so the renderer reports the permissive personal default until
  // it lands. Waiting for the real answer is only possible where there is one --
  // signed out the policy store stays idle forever and the user's own preference
  // is the only authority there is. Mid-scan arrival needs no separate check:
  // a policy that resolves "always_off" flips the switch, which the loop reads.
  _mayStartAnalyticsHistoryReconstruction() {
    if (!this._canReconstructAnalyticsHistory()) return false;
    if (this._retentionSettings.localHistoryPolicyResolved === true) return true;
    return !this._hasActiveAccountScope();
  }

  // Reconciliation is best-effort. Analytics reads await it so later-eligible
  // history shows up before the numbers are read, which means a failure here
  // must never fail the read itself: a broken scan would otherwise blank an
  // Insights summary that SQLite could have answered perfectly well.
  async _ensureAnalyticsHistoryBackfilled() {
    if (!this._mayStartAnalyticsHistoryReconstruction()) return { inserted: 0, scanned: 0 };
    if (this._analyticsHistoryBackfillPromise) return this._analyticsHistoryBackfillPromise;
    // The failure is absorbed inside this promise rather than around the
    // creator's await, because callers that join an in-flight pass are handed
    // this promise directly and would otherwise receive the raw rejection --
    // which is every analytics read that arrives while the startup pass is
    // still scanning.
    const backfillPromise = (async () => {
      let inserted = 0;
      let scanned = 0;
      let skipped = 0;
      let stoppedEarly = false;
      const state = this.databaseManager.getAnalyticsHistoryBackfillState(
        ANALYTICS_HISTORY_BACKFILL_VERSION
      );
      if (state.scannedThroughId >= state.targetId) return { inserted, scanned };
      while (true) {
        // The database reads its persisted cursor again for every batch. An
        // older row made eligible while this pass yields can move that cursor
        // backward without being overwritten by stale in-memory progress.
        const batch = this.databaseManager.backfillAnalyticsHistoryBatch({
          throughId: state.targetId,
          checkpointVersion: ANALYTICS_HISTORY_BACKFILL_VERSION,
        });
        inserted += batch.inserted;
        scanned += batch.scanned;
        skipped += batch.skipped;
        if (batch.complete) break;
        await new Promise((resolve) => setImmediate(resolve));
        // The switch can be turned off while this pass yields -- by the user, or
        // by a managed policy that resolved after the renderer's first sync sent
        // the personal default. Re-reading it here stops the scan at the next
        // batch boundary instead of mining the rest of a history the user has
        // just opted out of.
        if (!this._canReconstructAnalyticsHistory()) {
          stoppedEarly = true;
          break;
        }
      }
      if (inserted > 0) broadcastToWindows("analytics-changed");
      if (scanned > 0) {
        debugLogger.info(
          stoppedEarly
            ? "Analytics history backfill stopped: local history was turned off mid-scan"
            : "Analytics history backfill complete",
          { inserted, skipped, scanned },
          "analytics"
        );
      }
      return { inserted, scanned };
    })().catch((error) => {
      debugLogger.error("Analytics history backfill failed", { error: error.message }, "analytics");
      return { inserted: 0, scanned: 0 };
    });
    this._analyticsHistoryBackfillPromise = backfillPromise;
    // Cleared after the assignment above, never inside the pass: a scan that
    // finishes without ever awaiting would otherwise strand its own resolved
    // promise here and every later read would join a pass that already ended.
    void backfillPromise.then(() => {
      if (this._analyticsHistoryBackfillPromise === backfillPromise) {
        this._analyticsHistoryBackfillPromise = null;
      }
    });
    return backfillPromise;
  }

  // The dictation slot reports its own changes from the renderer. Slots
  // registered through IPC have to announce theirs here so macOS can re-derive
  // which keys the native Globe listener owns.
  _notifyHotkeyChanged(hotkey) {
    ipcMain.emit("hotkey-changed", null, hotkey);
  }

  _releaseMicHold(sender) {
    const release = this._micHoldSenders.get(sender.id);
    if (!release) return;
    this._micHoldSenders.delete(sender.id);
    sender.off("destroyed", release);
    sender.off("did-finish-load", release);
    this.meetingDetectionEngine?.setMicWarmHold(this._micHoldSenders.size > 0);
  }

  // Shared by the upload IPC handler and the CLI bridge. `filePath` must
  // already have passed resolveAllowedAudioPath (or approveAudioPath).

  approveAudioPath(filePath) {
    approveAudioPath(filePath);
  }

  // Note writes are journaled by SQLite triggers (pending_vector_changes); this
  // only wakes an active semantic index to drain them.
  notifyVectorChanges() {
    this.getSemanticSearch?.()?.notifyChanges();
  }

  _mirrorDeleteFolderIfUnshared(folderName) {
    if (!this._noteFilesEnabled) return;
    // Folder names are only unique per space — a live same-named folder in
    // another space shares the mirror directory, so leave it on disk.
    const stillLive = this.databaseManager.db
      .prepare("SELECT 1 FROM folders WHERE name = ? AND deleted_at IS NULL")
      .get(folderName);
    if (stillLive) return;
    const markdownMirror = require("./markdownMirror");
    markdownMirror.deleteFolder(folderName);
  }

  _asyncMirrorWrite(note) {
    if (!this._noteFilesEnabled) {
      debugLogger.debug(
        "Mirror write skipped: note files disabled",
        { noteId: note.id },
        "note-files"
      );
      return;
    }
    setImmediate(() => {
      const markdownMirror = require("./markdownMirror");
      const folderName = this._getFolderName(note.folder_id);
      markdownMirror.writeNote(note, folderName);
      if (note.transcript) {
        markdownMirror.writeTranscript(note, folderName, this._buildSpeakerMappings(note.id));
      }
    });
  }

  _asyncMirrorDelete(noteId) {
    if (!this._noteFilesEnabled) {
      debugLogger.debug("Mirror delete skipped: note files disabled", { noteId }, "note-files");
      return;
    }
    setImmediate(() => {
      const markdownMirror = require("./markdownMirror");
      markdownMirror.deleteNote(noteId);
    });
  }

  _buildFolderMap() {
    const folders = this.databaseManager.getFolders();
    const map = {};
    for (const f of folders) {
      map[f.id] = f.name;
    }
    return map;
  }

  _buildSpeakerMappings(noteId) {
    const arr = this.databaseManager.getSpeakerMappings(noteId);
    const map = {};
    for (const m of arr) {
      map[m.speaker_id] = m.display_name;
    }
    return map;
  }

  _parseNonSelfParticipants(participantsJson) {
    if (!participantsJson) return [];
    let participants;
    try {
      participants = JSON.parse(participantsJson);
    } catch (_) {
      return [];
    }
    if (!Array.isArray(participants) || participants.length === 0) return [];
    const googleEmails = new Set(
      this.databaseManager.getGoogleAccounts().map((a) => a.email.toLowerCase())
    );
    return participants.filter(
      (p) => p && p.self !== true && !googleEmails.has((p.email || "").toLowerCase())
    );
  }

  _getNoteNonSelfParticipants(noteId) {
    if (!noteId) return [];
    try {
      const note = this.databaseManager.getNote(noteId);
      return this._parseNonSelfParticipants(note?.participants);
    } catch (_) {
      return [];
    }
  }

  _resolveOneOnOneOtherParticipant(participantsJson) {
    const others = this._parseNonSelfParticipants(participantsJson);
    if (others.length !== 1) return null;
    const displayName = others[0].displayName || others[0].email;
    if (!displayName) return null;
    const email = (others[0].email || "").toLowerCase().trim() || null;
    return { displayName, email };
  }

  _noteExpectedSpeakerCountOrNull(note) {
    const stored = normalizeStoredSpeakerCount(note?.expected_speaker_count);
    if (stored != null) {
      return stored;
    }
    const others = this._parseNonSelfParticipants(note?.participants).length;
    if (others > 0) {
      return Math.min(others + 1, MAX_SPEAKER_COUNT);
    }
    return null;
  }

  _resolveNoteExpectedSpeakerCount(note) {
    return this._noteExpectedSpeakerCountOrNull(note) ?? DEFAULT_EXPECTED_SPEAKER_COUNT;
  }

  _resolveInitialMeetingSpeakerConfig(noteId) {
    let note = null;
    if (noteId != null) {
      try {
        note = this.databaseManager.getNote(noteId);
      } catch (_) {
        note = null;
      }
    }
    const enabled =
      (note?.diarization_enabled == null
        ? this.speakerDiarizationEnabled
        : note.diarization_enabled !== 0) !== false;
    return { enabled, expectedCount: this._resolveNoteExpectedSpeakerCount(note) };
  }

  // Participants added mid-meeting must raise the speaker cap that was derived
  // from the note at recording start. A count the user set via the stepper
  // (explicit) is never overridden.
  //
  // Raise-only: lowering the cap below the clusters already discovered would make
  // _assignOrForceCluster fold every later voice onto an existing speaker — the
  // exact identity collapse this refresh exists to prevent. A roster that shrinks
  // (or empties) mid-meeting therefore leaves the cap where it is.
  _refreshMeetingSpeakerConfigFromNote(noteId, note) {
    const config = this.activeMeetingSpeakerConfig;
    if (!config || config.explicit) return;
    if (noteId == null || this._activeMeetingNoteId !== noteId) return;

    const expectedCount = this._noteExpectedSpeakerCountOrNull(note);
    if (expectedCount == null || expectedCount <= config.expectedCount) return;

    this.activeMeetingSpeakerConfig = { ...config, expectedCount };
    broadcastToWindows("meeting-session-speaker-config-updated", {
      enabled: config.enabled,
      expectedCount,
    });
    debugLogger.info(
      "Meeting speaker config refreshed from participants",
      { noteId, expectedCount },
      "speaker"
    );
  }

  _rebuildMirror(basePath) {
    const markdownMirror = require("./markdownMirror");
    if (basePath) markdownMirror.init(basePath);
    const notes = this.databaseManager.getNotes(null, 99999);
    const speakerMappingsMap = {};
    for (const note of notes) {
      if (note.transcript) {
        speakerMappingsMap[note.id] = this._buildSpeakerMappings(note.id);
      }
    }
    markdownMirror.rebuildAll(notes, this._buildFolderMap(), speakerMappingsMap);
  }

  _getFolderName(folderId) {
    if (!folderId) return "Personal";
    const folder = this.databaseManager.db
      .prepare("SELECT name FROM folders WHERE id = ?")
      .get(folderId);
    return folder?.name || "Personal";
  }

  _getDictionarySafe() {
    try {
      return this.databaseManager.getDictionary();
    } catch {
      return [];
    }
  }

  _cleanupTextEditMonitor() {
    if (this._autoLearnDebounceTimer) {
      clearTimeout(this._autoLearnDebounceTimer);
      this._autoLearnDebounceTimer = null;
    }
    this._autoLearnLatestData = null;
    if (this.textEditMonitor && this._textEditHandler) {
      this.textEditMonitor.removeListener("text-edited", this._textEditHandler);
      this._textEditHandler = null;
    }
  }

  async _logDetectedGpus() {
    const { listNvidiaGpus } = require("../utils/gpuDetection");
    const gpus = await listNvidiaGpus();
    if (gpus.length > 0) {
      debugLogger.info(
        "NVIDIA GPUs detected",
        {
          count: gpus.length,
          devices: gpus.map((g) => `[${g.index}] ${g.name} (${g.vramMb}MB) ${g.uuid}`),
        },
        "gpu"
      );
    } else {
      debugLogger.debug("No NVIDIA GPUs detected", {}, "gpu");
    }
  }

  _setupRetentionCleanup() {
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    // No sweep at startup: _retentionSettings still holds the 30-day default
    // until the renderer syncs, so sweeping here deletes audio a user set to
    // keep for 60/90 days or forever (#1370). The first sync runs the first
    // sweep instead.
    this._retentionCleanupInterval = setInterval(() => {
      if (this._retentionSettingsSynced) this._runRetentionCleanup();
    }, SIX_HOURS_MS);
  }

  _runRetentionCleanup() {
    const { audioRetentionDays, transcriptRetentionDays } = this._retentionSettings;
    try {
      if (transcriptRetentionDays > 0) {
        const { ids, analyticsPurged } =
          this.databaseManager.deleteTranscriptionsExpiredBefore(transcriptRetentionDays);
        for (const id of ids) {
          this.audioStorageManager.deleteAudio(id);
          broadcastToWindows("transcription-deleted", { id });
        }
        if (analyticsPurged > 0) broadcastToWindows("analytics-changed");
      }
      if (audioRetentionDays > 0) {
        this.audioStorageManager.cleanupExpiredAudio(audioRetentionDays, this.databaseManager);
      }
    } catch (error) {
      debugLogger.error("Retention cleanup failed", { error: error.message }, "audio-storage");
    }
  }

  _setupTextEditMonitor() {
    if (!this.textEditMonitor) return;

    this._textEditHandler = (data) => {
      if (
        !data ||
        typeof data.originalText !== "string" ||
        typeof data.newFieldValue !== "string"
      ) {
        debugLogger.debug("[AutoLearn] Invalid event payload, skipping");
        return;
      }

      const { originalText, newFieldValue } = data;

      debugLogger.debug("[AutoLearn] text-edited event", {
        originalPreview: originalText.substring(0, 80),
        newValuePreview: newFieldValue.substring(0, 80),
      });

      this._autoLearnLatestData = { originalText, newFieldValue };

      if (this._autoLearnDebounceTimer) {
        clearTimeout(this._autoLearnDebounceTimer);
      }

      this._autoLearnDebounceTimer = setTimeout(() => {
        this._processCorrections();
      }, AUTO_LEARN_DEBOUNCE_MS);
    };

    this.textEditMonitor.on("text-edited", this._textEditHandler);
  }

  _processCorrections() {
    this._autoLearnDebounceTimer = null;
    if (!this._autoLearnLatestData) return;
    if (!this._autoLearnEnabled) {
      debugLogger.debug("[AutoLearn] Disabled, skipping correction processing");
      this._autoLearnLatestData = null;
      return;
    }

    const { originalText, newFieldValue } = this._autoLearnLatestData;
    this._autoLearnLatestData = null;

    try {
      const { extractCorrections } = require("../utils/correctionLearner");
      const currentDict = this._getDictionarySafe();
      const corrections = extractCorrections(originalText, newFieldValue, currentDict);
      debugLogger.debug("[AutoLearn] Corrections result", {
        corrections,
        dictSize: currentDict.length,
      });

      if (corrections.length > 0) {
        const saveResult = this.databaseManager.applyDictionaryChanges(
          { add: corrections },
          "learned"
        );

        if (saveResult?.success === false) {
          debugLogger.debug("[AutoLearn] Failed to save dictionary", { error: saveResult.error });
          return;
        }

        // Broadcast the post-save normalized list, not the raw input (which
        // still has case-variant dupes), so renderers don't flash ghost rows.
        broadcastToWindows("dictionary-updated", this.databaseManager.getDictionary());

        // Show the overlay so the toast is visible (it may have been hidden after dictation)
        this.windowManager.showDictationPanel();
        broadcastToWindows("corrections-learned", corrections);
        debugLogger.debug("[AutoLearn] Saved corrections", { corrections });
      }
    } catch (error) {
      debugLogger.debug("[AutoLearn] Error processing corrections", { error: error.message });
    }
  }

  // Remember the failed backend, and the error line that explains it, so the
  // backend isn't re-attempted (and its model reload re-paid) on every launch
  // and the settings card can say why (#1736). Cleared by retry, re-download,
  // delete, and the once-per-upgrade reset. The reason is written in the same
  // .env write as the flag. A failure with no readable reason clears the older
  // one, so a stale cause is never shown.

  // Captured before a handler stops the server to touch pack files (stopServer
  // clears currentServerModel); tells _applyWhisperGpuPreference what to reload.

  // Apply a GPU pack change to the loaded server without blocking the caller's
  // IPC reply (a Vulkan cold start can take minutes); the renderer follows
  // progress by polling whisper-server-status. Returns whether a reload was
  // kicked off so the UI shows "activating" only when one is coming.

  // Mints a Corti access token from stored BYOK credentials. Shared by the
  // dictation streaming handlers and the meeting realtime-token resolver.

  setupHandlers() {
    ipcMain.handle("onboarding-set-window-mode", (_event, mode) =>
      this.windowManager.setOnboardingWindowMode(mode)
    );

    ipcMain.handle("permission-guide-open", (event, state) =>
      this.windowManager.permissionGuide.open(event, state)
    );
    ipcMain.handle("permission-guide-close", (event) =>
      this.windowManager.permissionGuide.closeFromOwner(event)
    );
    ipcMain.handle("permission-guide-state", (event) =>
      this.windowManager.permissionGuide.stateFor(event)
    );
    ipcMain.on("permission-guide-action", (event, action) =>
      this.windowManager.permissionGuide.handleAction(event, action)
    );
    ipcMain.on("permission-guide-drag", (event, target) =>
      this.windowManager.permissionGuide.startDrag(event, target)
    );

    // WindowManager owns every teardown path for a demo (id-matched end,
    // onboarding-set-active(false), control panel closed); without this hook a
    // renderer crash mid-demo would leave the session set and broadcast every
    // later dictation's transcripts on onboarding-demo-event forever.
    this.windowManager.onOnboardingDemoTeardown = () => {
      this._onboardingDemoSession = null;
    };

    ipcMain.handle("onboarding-set-active", (_event, active) => {
      if (typeof active !== "boolean") return false;
      return this.windowManager.setOnboardingActive(active);
    });

    ipcMain.handle("onboarding-demo-begin", (_event, session) => {
      if (
        !session ||
        typeof session.id !== "string" ||
        session.id.length > 128 ||
        !ONBOARDING_DEMO_KINDS.has(session.kind)
      ) {
        return false;
      }
      this._onboardingDemoSession = {
        id: session.id,
        kind: session.kind,
        startedAt: Date.now(),
      };
      return this.windowManager.beginOnboardingDemo(session.kind);
    });

    ipcMain.handle("onboarding-demo-end", (_event, id) => {
      if (this._onboardingDemoSession?.id === id) {
        // Session cleanup rides on the teardown hook above.
        this.windowManager.endOnboardingDemo();
      }
      return true;
    });

    ipcMain.handle("onboarding-demo-stop", (_event, id) => {
      if (this._onboardingDemoSession?.id !== id) return false;
      return this.windowManager.stopOnboardingDemoRecording();
    });

    ipcMain.handle("onboarding-demo-publish", (_event, event) => {
      const session = this._onboardingDemoSession;
      if (!session || !event || event.kind !== session.kind) return false;
      if (!ONBOARDING_DEMO_STATUSES.has(event.status)) return false;
      const text = typeof event.text === "string" ? event.text.slice(0, 20000) : undefined;
      const message = typeof event.message === "string" ? event.message.slice(0, 500) : undefined;
      const tool = typeof event.tool === "string" ? event.tool.slice(0, 64) : undefined;
      const level = Number.isFinite(event.level)
        ? Math.min(1, Math.max(0, event.level))
        : undefined;
      broadcastToWindows("onboarding-demo-event", {
        demoId: session.id,
        kind: session.kind,
        status: event.status,
        text,
        message,
        tool,
        level,
      });
      return true;
    });

    ipcMain.handle("window-minimize", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.minimize();
      }
    });

    ipcMain.handle("window-maximize", () => {
      if (this.windowManager.controlPanelWindow) {
        if (this.windowManager.controlPanelWindow.isMaximized()) {
          this.windowManager.controlPanelWindow.unmaximize();
        } else {
          this.windowManager.controlPanelWindow.maximize();
        }
      }
    });

    ipcMain.handle("window-close", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.close();
      }
    });

    ipcMain.handle("window-is-maximized", () => {
      if (this.windowManager.controlPanelWindow) {
        return this.windowManager.controlPanelWindow.isMaximized();
      }
      return false;
    });

    ipcMain.handle("snap-to-meeting-mode", () => {
      this.windowManager.snapControlPanelToMeetingMode();
    });

    ipcMain.handle("restore-from-meeting-mode", () => {
      this.windowManager.restoreControlPanelFromMeetingMode();
      this.meetingDetectionEngine?.setMeetingModeActive(false);
    });

    ipcMain.handle("hide-window", () => {
      this.windowManager.hideDictationPanel();
    });

    ipcMain.handle("show-dictation-panel", () => {
      this.windowManager.showDictationPanel({ reposition: true });
    });

    ipcMain.handle("open-settings-section", async (_event, section) => {
      if (!isProviderSettingsTarget(section)) return { success: false };
      await this.windowManager.openSettings(section);
      return { success: true };
    });

    ipcMain.handle("capture-dictation-target", async () => {
      // Recording start awaits this handler, so the Linux/Windows window probe
      // runs in the background: a stalled AT-SPI peer would otherwise hold the
      // microphone for seconds (#1944). Its consumers wait for it themselves.
      void this.selectionManager?.captureTarget?.();
      const pid = (await this.textEditMonitor?.captureTargetPid?.()) ?? null;
      return { success: true, pid };
    });

    ipcMain.handle("force-stop-dictation", () => {
      if (this.windowManager?.forceStopMacCompoundPush) {
        this.windowManager.forceStopMacCompoundPush("manual");
      }
      return { success: true };
    });

    ipcMain.handle("set-main-window-interactivity", (event, shouldCapture) => {
      this.windowManager.setMainWindowInteractivity(Boolean(shouldCapture));
      return { success: true };
    });

    ipcMain.handle("set-main-window-input-region", (event, region) => {
      if (event.sender !== this.windowManager.mainWindow?.webContents) return null;
      return this.windowManager.setMainWindowInputRegion(region);
    });

    ipcMain.handle("get-main-window-horizontal-direction", () => {
      return this.windowManager.getMainWindowHorizontalDirection();
    });

    ipcMain.handle("set-notification-interactivity", (event, interactive) => {
      this.windowManager.setNotificationInteractivity(event.sender, Boolean(interactive));
      return { success: true };
    });

    ipcMain.handle("resize-main-window", (event, sizeKey) => {
      return this.windowManager.resizeMainWindow(sizeKey);
    });

    ipcMain.handle("resize-assistant-window-to-content", (event, surfaceHeight) => {
      return this.windowManager.resizeAssistantWindowToContent(surfaceHeight);
    });

    ipcMain.handle("resize-dictation-error-window-to-content", (event, surfaceHeight) => {
      return this.windowManager.resizeDictationErrorWindowToContent(surfaceHeight);
    });

    ipcMain.handle("db-save-transcription", async (event, text, rawText, options) => {
      const result = this.databaseManager.saveTranscription(text, rawText, options);
      if (result?.success && result?.transcription) {
        setImmediate(() => {
          broadcastToWindows("transcription-added", result.transcription);
        });
      }
      return result;
    });

    ipcMain.handle("db-get-transcriptions", async (event, limit = 50, options = {}) => {
      return this.databaseManager.getTranscriptions(limit, options);
    });

    ipcMain.handle("analytics-record-event", async (_event, input) => {
      // The renderer only warns when this write fails, then saves the
      // transcription as completed anyway -- leaving a row the backfill is
      // the only thing that will ever reconcile.
      const result = this.databaseManager.recordAnalyticsEvent(input);
      // Dictation and the control panel are separate renderers, so the
      // Insights view can only learn about a new event through the main process.
      if (result?.success && !result.ignored) {
        setImmediate(() => {
          broadcastToWindows("analytics-changed");
        });
      }
      return result;
    });

    ipcMain.handle("analytics-get-summary", async () => {
      await this._ensureAnalyticsHistoryBackfilled();
      return this.databaseManager.getAnalyticsSummary();
    });

    ipcMain.handle("analytics-get-pending", async (_event, limit, context) => {
      const accountId = assertAnalyticsSyncContext(context);
      await this._ensureAnalyticsHistoryBackfilled();
      return this.databaseManager.getPendingAnalyticsEvents(limit, accountId);
    });

    ipcMain.handle("analytics-mark-synced", async (_event, eventIds, context) => {
      const accountId = assertAnalyticsSyncContext(context);
      return this.databaseManager.markAnalyticsEventsSynced(eventIds, accountId);
    });

    ipcMain.handle("analytics-get-pending-deletes", async (_event, limit, context) => {
      const accountId = assertAnalyticsSyncContext(context);
      return this.databaseManager.getPendingAnalyticsDeletes(limit, accountId);
    });

    ipcMain.handle("analytics-hard-delete", async (_event, eventIds, context) => {
      const accountId = assertAnalyticsSyncContext(context);
      return this.databaseManager.hardDeleteAnalyticsEvents(eventIds, accountId);
    });

    ipcMain.handle("analytics-get-pending-clear", async (_event, context) => {
      const accountId = assertAnalyticsSyncContext(context);
      return this.databaseManager.getPendingAnalyticsClear(accountId);
    });

    ipcMain.handle("analytics-complete-clear", async (_event, clearedThrough, context) => {
      const accountId = assertAnalyticsSyncContext(context);
      return this.databaseManager.completeAnalyticsClear(clearedThrough, accountId);
    });

    ipcMain.handle("analytics-count-unclaimed", async (_event, context) => {
      assertAnalyticsSyncContext(context);
      await this._ensureAnalyticsHistoryBackfilled();
      return this.databaseManager.countUnclaimedAnalyticsEvents();
    });

    ipcMain.handle("analytics-count-awaiting-upload", async (_event, context) => {
      const accountId = assertAnalyticsSyncContext(context);
      await this._ensureAnalyticsHistoryBackfilled();
      return this.databaseManager.countAnalyticsEventsAwaitingUpload(accountId);
    });

    ipcMain.handle(
      "analytics-claim-anonymous",
      async (_event, accountId, expectedAuthGeneration) => {
        const state = tokenStore.getState();
        if (!state.token || state.generation !== expectedAuthGeneration) {
          return { success: false, claimed: 0, code: "AUTH_CONTEXT_CHANGED" };
        }
        const result = this.databaseManager.claimAnonymousAnalyticsEvents(accountId);
        // Claimed rows are only pushed by the Insights view's reload, and the
        // claim itself changes nothing it renders, so tell it to reload.
        if (result?.claimed > 0) {
          setImmediate(() => {
            broadcastToWindows("analytics-changed");
          });
        }
        return result;
      }
    );

    ipcMain.handle("db-clear-transcriptions", async (event) => {
      this.audioStorageManager.deleteAllAudio();
      const result = this.databaseManager.clearTranscriptions();
      if (result?.success) {
        setImmediate(() => {
          broadcastToWindows("transcriptions-cleared", {
            cleared: result.cleared,
          });
          broadcastToWindows("analytics-changed");
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-transcription", async (event, id) => {
      return this.deleteTranscriptionInternal(id);
    });

    // Audio storage handlers
    ipcMain.handle("save-transcription-audio", async (event, id, audioBuffer, metadata) => {
      const transcription = this.databaseManager.getTranscriptionById(id);
      const timestamp = transcription?.timestamp || null;
      const result = this.audioStorageManager.saveAudio(id, Buffer.from(audioBuffer), timestamp);
      if (result.success) {
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 1,
          audioDurationMs: metadata?.durationMs || null,
          provider: metadata?.provider || null,
          model: metadata?.model || null,
        });
        const updated = this.databaseManager.getTranscriptionById(id);
        if (updated) broadcastToWindows("transcription-updated", updated);
      }
      return result;
    });

    ipcMain.handle("merge-audio-segments", async (_event, segments) => {
      try {
        if (!Array.isArray(segments) || segments.length < 2 || segments.length > 100) {
          throw new Error("Invalid audio segment count");
        }
        const normalized = segments.map((segment) => {
          if (!segment?.buffer || typeof segment.mimeType !== "string") {
            throw new Error("Invalid audio segment");
          }
          return { buffer: Buffer.from(segment.buffer), mimeType: segment.mimeType };
        });
        const { mergeAudioSegments } = require("./ffmpegUtils");
        const buffer = await mergeAudioSegments(normalized);
        // Slice to a real ArrayBuffer: Buffers sent over IPC arrive as Uint8Array,
        // and pooled Buffers share a larger underlying allocation.
        return {
          success: true,
          buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
          mimeType: "audio/webm",
        };
      } catch (error) {
        debugLogger.error("Failed to merge recovered audio segments", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-audio-path", async (event, id) => {
      return this.audioStorageManager.getAudioPath(id);
    });

    ipcMain.handle("show-audio-in-folder", async (event, id) => {
      const filePath = this.audioStorageManager.getAudioPath(id);
      if (!filePath) return { success: false };
      shell.showItemInFolder(filePath);
      return { success: true };
    });

    ipcMain.handle("get-audio-buffer", async (event, id) => {
      const buffer = this.audioStorageManager.getAudioBuffer(id);
      return buffer ? buffer.buffer : null;
    });

    ipcMain.handle("delete-transcription-audio", async (event, id) => {
      const result = this.audioStorageManager.deleteAudio(id);
      if (result.success) {
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 0,
          audioDurationMs: null,
          provider: null,
          model: null,
        });
      }
      return result;
    });

    ipcMain.handle("get-audio-storage-usage", async () => {
      return this.audioStorageManager.getStorageUsage();
    });

    ipcMain.on(
      "retention-settings-changed",
      createRetentionSettingsHandler({
        getCurrentSettings: () => this._retentionSettings,
        getOwner: () => this.windowManager.mainWindow?.webContents,
        hasSynced: () => this._retentionSettingsSynced,
        onSettingsChanged: (settings) => {
          this._retentionSettings = settings;
          this._retentionSettingsSynced = true;
          this._runRetentionCleanup();
          // First point at which the local-history switch is known to be real.
          // After the sweep, so expired transcripts are gone before they can be
          // reconstructed into counters the sweep would only have to purge.
          void this._ensureAnalyticsHistoryBackfilled();
        },
      })
    );

    ipcMain.handle("delete-all-audio", async () => {
      const result = this.audioStorageManager.deleteAllAudio();
      try {
        const rows = this.databaseManager.db
          .prepare("SELECT id FROM transcriptions WHERE has_audio = 1")
          .all();
        if (rows.length > 0) {
          this.databaseManager.clearAudioFlags(rows.map((r) => r.id));
        }
      } catch (error) {
        debugLogger.error(
          "Failed to clear audio flags after delete-all",
          { error: error.message },
          "audio-storage"
        );
      }
      return result;
    });

    ipcMain.handle("get-transcription-by-id", async (event, id) => {
      return this.databaseManager.getTranscriptionById(id);
    });

    // Every window's AudioManager can hold the mic open outside a recording, so
    // gate the audio-evidence meeting detector until they all release. A
    // renderer that reloads or goes away releases implicitly — otherwise a
    // crash mid-hold would gate detection for the rest of the session.
    ipcMain.on("mic-warm-hold-changed", (event, active) => {
      if (!active) {
        this._releaseMicHold(event.sender);
        return;
      }
      if (this._micHoldSenders.has(event.sender.id)) return;
      const release = () => this._releaseMicHold(event.sender);
      this._micHoldSenders.set(event.sender.id, release);
      event.sender.on("destroyed", release);
      event.sender.on("did-finish-load", release);
      this.meetingDetectionEngine?.setMicWarmHold(true);
    });

    // Hotkey handlers run in main, while AudioManager owns the real lifecycle
    // in the dictation renderer. Only confirmed renderer state may change the
    // main-process recording gate; raw key presses are merely requests and can
    // be declined while a transcript is still being finalized.
    ipcMain.on("dictation-lifecycle-state-changed", (event, state, inputKind) => {
      const dictationWindow = this.windowManager.mainWindow;
      if (
        !dictationWindow ||
        dictationWindow.isDestroyed() ||
        event.sender !== dictationWindow.webContents
      ) {
        return;
      }
      this.windowManager.setDictationLifecycleState(state, inputKind);
    });

    ipcMain.on("show-agent-dictation-final-transcript", (event, text) => {
      const dictationWindow = this.windowManager.mainWindow;
      if (
        !dictationWindow ||
        dictationWindow.isDestroyed() ||
        event.sender !== dictationWindow.webContents
      ) {
        return;
      }
      if (typeof text !== "string" || !text.trim()) return;
      this.windowManager.showAgentDictationFinalTranscript(text);
    });

    ipcMain.on("dictation-audio-level-changed", (event, level) => {
      const dictationWindow = this.windowManager.mainWindow;
      if (
        !dictationWindow ||
        dictationWindow.isDestroyed() ||
        event.sender !== dictationWindow.webContents
      ) {
        return;
      }
      this.windowManager.setDictationAudioLevel(level);
    });

    // Dictionary handlers
    ipcMain.on("auto-learn-changed", (_event, enabled) => {
      // Both renderer windows re-sync this on mount — ignore same-value updates (#1080).
      const { changed, enabled: next } = applyAutoLearnSetting(this._autoLearnEnabled, enabled);
      if (!changed) return;
      this._autoLearnEnabled = next;
      if (!this._autoLearnEnabled) {
        if (this._autoLearnDebounceTimer) {
          clearTimeout(this._autoLearnDebounceTimer);
          this._autoLearnDebounceTimer = null;
        }
        this._autoLearnLatestData = null;
      }
      debugLogger.debug("[AutoLearn] Setting changed", { enabled: this._autoLearnEnabled });
    });

    ipcMain.handle("db-get-dictionary", async () => {
      return this.databaseManager.getDictionary();
    });

    ipcMain.handle("db-set-dictionary", async (event, words) => {
      if (!Array.isArray(words)) {
        throw new Error("words must be an array");
      }
      return this.databaseManager.setDictionary(words);
    });

    ipcMain.handle("db-apply-dictionary-changes", async (_event, changes) => {
      const { add, remove } = changes ?? {};
      if (add !== undefined && !Array.isArray(add)) {
        throw new Error("add must be an array");
      }
      if (remove !== undefined && !Array.isArray(remove)) {
        throw new Error("remove must be an array");
      }
      return this.databaseManager.applyDictionaryChanges({ add, remove });
    });

    ipcMain.handle("db-get-pending-dictionary", async () => {
      return this.databaseManager.getPendingDictionary();
    });

    ipcMain.handle("db-get-pending-dictionary-deletes", async () => {
      return this.databaseManager.getPendingDictionaryDeletes();
    });

    ipcMain.handle("db-get-dictionary-by-client-id", async (_event, clientDictId) => {
      return this.databaseManager.getDictionaryEntryByClientId(clientDictId);
    });

    ipcMain.handle("db-upsert-dictionary-from-cloud", async (_event, cloudEntry) => {
      return this.databaseManager.upsertDictionaryFromCloud(cloudEntry);
    });

    ipcMain.handle("db-mark-dictionary-synced", async (_event, id, cloudId) => {
      return this.databaseManager.markDictionaryEntrySynced(id, cloudId);
    });

    ipcMain.handle("db-hard-delete-dictionary", async (_event, id) => {
      return this.databaseManager.hardDeleteDictionaryEntry(id);
    });

    ipcMain.handle("db-clear-dictionary-cloud-id", async (_event, id) => {
      return this.databaseManager.clearDictionaryCloudId(id);
    });

    ipcMain.handle("db-broadcast-dictionary-updated", async () => {
      // Emit the normalized list straight from SQLite so renderers see the
      // post-dedupe truth, never a caller-supplied payload.
      const words = this.databaseManager.getDictionary();
      broadcastToWindows("dictionary-updated", words);
      return { success: true };
    });

    ipcMain.handle("db-get-snippets", async () => {
      return this.databaseManager.getSnippets();
    });

    ipcMain.handle("db-set-snippets", async (_event, snippets) => {
      if (!Array.isArray(snippets)) {
        throw new Error("snippets must be an array");
      }
      return this.databaseManager.setSnippets(snippets);
    });

    ipcMain.handle("db-get-pending-snippets", async () => {
      return this.databaseManager.getPendingSnippets();
    });

    ipcMain.handle("db-get-pending-snippet-deletes", async () => {
      return this.databaseManager.getPendingSnippetDeletes();
    });

    ipcMain.handle("db-get-snippet-for-cloud-merge", async (_event, cloudEntry) => {
      return this.databaseManager.getSnippetForCloudMerge(cloudEntry);
    });

    ipcMain.handle("db-upsert-snippet-from-cloud", async (_event, cloudEntry) => {
      return this.databaseManager.upsertSnippetFromCloud(cloudEntry);
    });

    ipcMain.handle(
      "db-mark-snippet-synced",
      async (_event, id, cloudId, serverUpdatedAt, expectedTrigger, expectedReplacement) => {
        return this.databaseManager.markSnippetSynced(
          id,
          cloudId,
          serverUpdatedAt,
          expectedTrigger,
          expectedReplacement
        );
      }
    );

    ipcMain.handle("db-hard-delete-snippet", async (_event, id) => {
      return this.databaseManager.hardDeleteSnippet(id);
    });

    ipcMain.handle("db-clear-snippet-cloud-id", async (_event, id) => {
      return this.databaseManager.clearSnippetCloudId(id);
    });

    ipcMain.handle("db-broadcast-snippets-updated", async () => {
      const snippets = this.databaseManager.getSnippets();
      broadcastToWindows("snippets-updated", snippets);
      return { success: true };
    });

    ipcMain.handle("undo-learned-corrections", async (_event, words) => {
      try {
        if (!Array.isArray(words) || words.length === 0) {
          return { success: false };
        }
        const validWords = words.filter((w) => typeof w === "string" && w.trim().length > 0);
        if (validWords.length === 0) {
          return { success: false };
        }
        const saveResult = this.databaseManager.applyDictionaryChanges({ remove: validWords });
        if (saveResult?.success === false) {
          debugLogger.debug("[AutoLearn] Undo failed to save dictionary", {
            error: saveResult.error,
          });
          return { success: false };
        }
        broadcastToWindows("dictionary-updated", this.databaseManager.getDictionary());
        debugLogger.debug("[AutoLearn] Undo: removed words", { words: validWords });
        return { success: true };
      } catch (err) {
        debugLogger.debug("[AutoLearn] Undo failed", { error: err.message });
        return { success: false };
      }
    });

    ipcMain.handle(
      "db-save-note",
      async (event, title, content, noteType, sourceFile, audioDuration, folderId, spaceId) => {
        const result = this.databaseManager.saveNote(
          title,
          content,
          noteType,
          sourceFile,
          audioDuration,
          folderId,
          spaceId
        );
        if (result?.success && result?.note) {
          setImmediate(() => broadcastToWindows("note-added", result.note));
          this.notifyVectorChanges();
          this._asyncMirrorWrite(result.note);
        }
        return result;
      }
    );

    ipcMain.handle("db-get-note", async (event, id) => {
      return this.databaseManager.getNote(id);
    });

    ipcMain.handle("db-get-notes", async (event, noteType, limit, folderId, spaceId) => {
      return this.databaseManager.getNotes(noteType, limit, folderId, spaceId);
    });

    ipcMain.handle("db-get-space-notes", async (event, spaceId, limit) => {
      return this.databaseManager.getNotesForSpace(spaceId, limit);
    });

    ipcMain.handle("db-update-note", async (event, id, updates) => {
      // A delayed renderer save must not remove a newer finite Job's already
      // committed words while this main-process recording still owns the note.
      if (
        id === meetingNoteId &&
        typeof updates.transcript === "string" &&
        updates.transcript.startsWith("[")
      ) {
        const current = this.databaseManager.getNote(id);
        const saved = current?.transcript?.startsWith("[") ? JSON.parse(current.transcript) : [];
        const incoming = JSON.parse(updates.transcript);
        const byId = new Map(
          saved.filter((segment) => segment.id).map((segment) => [segment.id, segment])
        );
        for (const segment of incoming)
          if (segment.id) byId.set(segment.id, { ...byId.get(segment.id), ...segment });
        const unkeyed = incoming.filter((segment) => !segment.id);
        updates = {
          ...updates,
          transcript: JSON.stringify(
            [...byId.values(), ...unkeyed].sort(
              (a, b) => (a.timestamp ?? Infinity) - (b.timestamp ?? Infinity)
            )
          ),
        };
      }
      const result = this.databaseManager.updateNote(id, updates);
      if (result?.success && result?.note) {
        setImmediate(() => broadcastToWindows("note-updated", result.note));
        this.notifyVectorChanges();
        this._asyncMirrorWrite(result.note);
        if (updates.participants) {
          this._tryAutoLabelOneOnOne(id);
          this._refreshMeetingSpeakerConfigFromNote(id, result.note);
        }
      }
      return result;
    });

    ipcMain.handle("db-delete-note", async (event, id) => {
      return this.deleteNoteInternal(id);
    });

    ipcMain.handle("db-search-notes", async (event, query, limit, spaceId, folderId) => {
      return this.databaseManager.searchNotes(query, limit, spaceId, folderId);
    });

    ipcMain.handle("db-update-note-cloud-id", async (event, id, cloudId) => {
      return this.databaseManager.updateNoteCloudId(id, cloudId);
    });

    ipcMain.handle("db-update-note-share-state", async (event, id, state) => {
      const note = this.databaseManager.updateNoteShareState(id, state);
      if (note) {
        setImmediate(() => broadcastToWindows("note-updated", note));
      }
      return note;
    });

    ipcMain.handle("db-get-folders", async (event, spaceId) => {
      return this.databaseManager.getFolders(spaceId);
    });

    ipcMain.handle("db-create-folder", (_event, name, spaceId) =>
      this.createFolderWithEffects(name, spaceId)
    );

    ipcMain.handle("db-delete-folder", async (event, id) => {
      const folderName = this._noteFilesEnabled ? this._getFolderName(id) : null;
      const result = this.databaseManager.deleteFolder(id);
      if (result?.success) {
        this.notifyVectorChanges();
        // Other accounts' notes were released to the space root; their mirror
        // files leave with the folder directory, so rewrite the live ones.
        for (const note of result.relocatedNotes ?? []) {
          if (!note.deleted_at) this._asyncMirrorWrite(note);
        }
        setImmediate(() => {
          broadcastToWindows("folder-deleted", { id });
          if (folderName) this._mirrorDeleteFolderIfUnshared(folderName);
        });
      }
      return result;
    });

    ipcMain.handle("db-rename-folder", async (event, id, name) => {
      const oldName = this._noteFilesEnabled ? this._getFolderName(id) : null;
      const result = this.databaseManager.renameFolder(id, name);
      if (result?.success && result?.folder) {
        setImmediate(() => {
          broadcastToWindows("folder-renamed", result.folder);
          if (this._noteFilesEnabled && oldName) {
            const markdownMirror = require("./markdownMirror");
            markdownMirror.renameFolder(oldName, name);
          }
        });
      }
      return result;
    });

    ipcMain.handle("db-move-folder-to-space", async (event, id, spaceId) => {
      const result = this.databaseManager.moveFolderToSpace(id, spaceId);
      if (result?.success) {
        // Qdrant payloads carry space_id — the triggers journaled the moved notes.
        this.notifyVectorChanges();
        if (result.folder) {
          setImmediate(() => broadcastToWindows("folder-synced", result.folder));
        }
      }
      return result;
    });

    ipcMain.handle("db-get-folder-note-counts", async () => {
      return this.databaseManager.getFolderNoteCounts();
    });

    ipcMain.handle("db-get-spaces", async () => {
      return this.databaseManager.getSpaces();
    });

    ipcMain.handle("set-active-account-scope", async (_event, accountId, expectedGeneration) => {
      const state = tokenStore.getState();
      const verdict = accountScopeBinding.evaluateScopeRequest({
        accountId,
        expectedGeneration,
        token: state.token,
        generation: state.generation,
      });
      if (!verdict.ok) {
        return {
          success: false,
          code: verdict.code,
          error:
            verdict.code === "INVALID_ACCOUNT"
              ? "Invalid account scope"
              : "Authentication context changed before account scoping",
        };
      }
      const previousScope = accountScopeBinding.resolveActiveAccountScope({
        ...state,
        binding: accountScopeBinding.read(),
      });
      if (
        this.databaseManager.activeAccountId !== accountId ||
        (accountId !== null && previousScope?.accountId !== accountId)
      ) {
        this.windowManager.retireMeetingNotificationScope();
      }
      this.databaseManager.setActiveAccountId(accountId);
      if (accountId !== null) accountScopeBinding.persist(accountId, state.token);
      else accountScopeBinding.clear();
      broadcastToWindows(
        "active-account-scope-changed",
        accountId !== null ? { accountId, authGeneration: state.generation } : null
      );
      this.connectorManager?.accountChanged();
      void this.connectorManager?.notifyStatusChanged();
      return { success: true };
    });

    ipcMain.handle("get-active-account-scope", () =>
      accountScopeBinding.resolveActiveAccountScope({
        ...tokenStore.getState(),
        binding: accountScopeBinding.read(),
      })
    );

    ipcMain.handle(
      "delete-account-data",
      async (_event, accountId, expectedGeneration, options) => {
        const state = tokenStore.getState();
        if (
          typeof accountId !== "string" ||
          accountId.trim().length === 0 ||
          !state.token ||
          state.generation !== expectedGeneration
        ) {
          return {
            success: false,
            code: "AUTH_CONTEXT_CHANGED",
            error: "Authentication context changed before local account cleanup",
          };
        }
        try {
          // Best effort; each revoke has a 5s deadline (connectorManager.js).
          // Erasing the device takes the calendar logins with it, so a grant
          // Gmail shares with a calendar is revoked too: cleanup-app runs
          // after this and finds no Gmail login left to revoke.
          await this.connectorManager?.disconnectAll({
            erasingDevice: options?.erasingDevice === true,
          });
          const result = this.databaseManager.deleteAccountData(accountId);
          this.notifyVectorChanges();
          for (const noteId of result.deletedNoteIds) {
            this._asyncMirrorDelete(noteId);
          }
          return { success: true, ...result };
        } catch (error) {
          return { success: false, code: "LOCAL_ACCOUNT_CLEANUP_FAILED", error: error.message };
        }
      }
    );

    ipcMain.handle("db-update-space", async (event, id, updates) => {
      const result = this.databaseManager.updateSpace(id, updates);
      if (result?.success && result.space) {
        setImmediate(() => broadcastToWindows("space-synced", result.space));
      }
      return result;
    });

    ipcMain.handle("db-purge-space", async (event, id, options) => {
      if (options?.expectedAuthGeneration !== undefined) {
        const state = tokenStore.getState();
        if (!state.token || state.generation !== options.expectedAuthGeneration) {
          return {
            success: false,
            error: "Authentication context changed before account cleanup",
            code: "AUTH_CONTEXT_CHANGED",
          };
        }
      }
      const result = this.databaseManager.purgeSpace(id, options);
      if (result?.success) {
        if (!result.preservedForOtherAccounts) {
          // The purge row and the relocated notes' trigger rows drain together.
          this.databaseManager.addPendingVectorPurge(result.spaceId);
          this.notifyVectorChanges();
          for (const note of result.relocatedNotes ?? []) {
            this._asyncMirrorWrite(note);
          }
          for (const noteId of result.noteIds ?? []) {
            this._asyncMirrorDelete(noteId);
          }
        }
        setImmediate(() => {
          broadcastToWindows("space-purged", { spaceId: result.spaceId });
          for (const folderName of result.folderNames ?? []) {
            this._mirrorDeleteFolderIfUnshared(folderName);
          }
        });
      }
      return result;
    });

    ipcMain.handle("db-get-actions", async () => {
      return this.databaseManager.getActions();
    });

    ipcMain.handle("db-get-action", async (event, id) => {
      return this.databaseManager.getAction(id);
    });

    ipcMain.handle("db-create-action", async (event, name, description, prompt, icon, fields) => {
      const result = this.databaseManager.createAction(name, description, prompt, icon, fields);
      if (result?.success && result?.action) {
        setImmediate(() => {
          broadcastToWindows("action-created", result.action);
        });
      }
      return result;
    });

    ipcMain.handle("db-update-action", async (event, id, updates) => {
      const result = this.databaseManager.updateAction(id, updates);
      if (result?.success && result?.action) {
        setImmediate(() => {
          broadcastToWindows("action-updated", result.action);
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-action", async (event, id) => {
      const result = this.databaseManager.deleteAction(id);
      if (result?.success) {
        setImmediate(() => {
          broadcastToWindows("action-deleted", { id });
        });
      }
      return result;
    });

    // Agent conversation handlers
    ipcMain.handle(
      "db-create-agent-conversation",
      async (event, title, noteId, spaceId, folderId) => {
        return this.databaseManager.createAgentConversation(title, noteId, spaceId, folderId);
      }
    );

    ipcMain.handle("db-get-conversations-for-note", async (event, noteId, limit) => {
      return this.databaseManager.getConversationsForNote(noteId, limit);
    });

    ipcMain.handle(
      "db-get-conversations-for-container",
      async (event, spaceId, folderId, limit) => {
        return this.databaseManager.getConversationsForContainer(spaceId, folderId, limit);
      }
    );

    ipcMain.handle("db-get-agent-conversations", async (event, limit) => {
      return this.databaseManager.getAgentConversations(limit);
    });

    ipcMain.handle("db-get-agent-conversation", async (event, id) => {
      return this.databaseManager.getAgentConversation(id);
    });

    ipcMain.handle("db-delete-agent-conversation", async (event, id) => {
      const result = this.databaseManager.deleteAgentConversation(id);
      this.getSemanticSearch?.()?.notifyConversationChanges();
      return result;
    });

    ipcMain.handle("db-update-agent-conversation-title", async (event, id, title) => {
      const result = this.databaseManager.updateAgentConversationTitle(id, title);
      this.getSemanticSearch?.()?.notifyConversationChanges();
      return result;
    });

    ipcMain.handle(
      "db-add-agent-message",
      async (event, conversationId, role, content, metadata) => {
        const result = this.databaseManager.addAgentMessage(
          conversationId,
          role,
          content,
          metadata
        );
        if (result) this.getSemanticSearch?.()?.notifyConversationChanges();
        return result;
      }
    );

    ipcMain.handle("db-get-agent-messages", async (event, conversationId) => {
      return this.databaseManager.getAgentMessages(conversationId);
    });

    ipcMain.handle(
      "db-get-agent-conversations-with-preview",
      async (event, limit, offset, includeArchived) => {
        return this.databaseManager.getAgentConversationsWithPreview(
          limit,
          offset,
          includeArchived
        );
      }
    );

    ipcMain.handle("db-search-agent-conversations", async (event, query, limit) => {
      return this.databaseManager.searchAgentConversations(query, limit);
    });

    ipcMain.handle("db-archive-agent-conversation", async (event, id) => {
      return this.databaseManager.archiveAgentConversation(id);
    });

    ipcMain.handle("db-unarchive-agent-conversation", async (event, id) => {
      return this.databaseManager.unarchiveAgentConversation(id);
    });

    ipcMain.handle("db-update-agent-conversation-cloud-id", async (event, id, cloudId) => {
      return this.databaseManager.updateAgentConversationCloudId(id, cloudId);
    });

    // Notes sync
    ipcMain.handle("db-get-pending-notes", (_, spaceKind) =>
      this.databaseManager.getPendingNotes(spaceKind)
    );
    ipcMain.handle("db-get-pending-note-deletes", () =>
      this.databaseManager.getPendingNoteDeletes()
    );
    ipcMain.handle("db-get-note-by-client-id", (_, clientNoteId) =>
      this.databaseManager.getNoteByClientId(clientNoteId)
    );
    ipcMain.handle("db-upsert-note-from-cloud", (_, cloudNote, localFolderId, localSpaceId) => {
      const note = this.databaseManager.upsertNoteFromCloud(cloudNote, localFolderId, localSpaceId);
      if (note) {
        setImmediate(() => broadcastToWindows("note-synced", note));
        this.notifyVectorChanges();
      }
      return note;
    });
    ipcMain.handle(
      "db-acknowledge-note-create",
      (_, id, snapshot, cloudId, cloudUpdatedAt, ownerUserId, settleIfUnchanged) =>
        this.databaseManager.acknowledgeNoteCreate(
          id,
          snapshot,
          cloudId,
          cloudUpdatedAt,
          ownerUserId,
          settleIfUnchanged
        )
    );
    ipcMain.handle(
      "db-mark-note-synced-if-unchanged",
      (_, id, snapshot, expectedCloudId, cloudUpdatedAt, ownerUserId) =>
        this.databaseManager.markNoteSyncedIfUnchanged(
          id,
          snapshot,
          expectedCloudId,
          cloudUpdatedAt,
          ownerUserId
        )
    );
    ipcMain.handle("db-set-note-cloud-base", (_, id, cloudUpdatedAt) =>
      this.databaseManager.setNoteCloudBase(id, cloudUpdatedAt)
    );
    ipcMain.handle("db-set-note-owner-from-cloud", (_, id, ownerUserId) =>
      this.databaseManager.setNoteOwnerFromCloud(id, ownerUserId)
    );
    ipcMain.handle("db-count-team-notes-missing-owner", () =>
      this.databaseManager.countTeamNotesMissingOwner()
    );
    ipcMain.handle("db-mark-note-sync-error", (_, id) =>
      this.databaseManager.markNoteSyncError(id)
    );
    ipcMain.handle("db-restore-note-after-denied-delete", (_, id) =>
      this.databaseManager.restoreNoteAfterDeniedDelete(id)
    );
    ipcMain.handle("db-hard-delete-note", (_, id) => {
      const result = this.databaseManager.hardDeleteNote(id);
      if (result?.success) {
        this.notifyVectorChanges();
        this._asyncMirrorDelete(id);
        setImmediate(() => broadcastToWindows("note-deleted", { id }));
      }
      return result;
    });

    // Folders sync
    ipcMain.handle("db-get-pending-folders", (_, spaceKind) =>
      this.databaseManager.getPendingFolders(spaceKind)
    );
    ipcMain.handle("db-get-folder-by-client-id", (_, clientFolderId) =>
      this.databaseManager.getFolderByClientId(clientFolderId)
    );
    ipcMain.handle("db-upsert-folder-from-cloud", (_, cloudFolder, localSpaceId) => {
      const folder = this.databaseManager.upsertFolderFromCloud(cloudFolder, localSpaceId);
      if (folder) setImmediate(() => broadcastToWindows("folder-synced", folder));
      return folder;
    });
    ipcMain.handle(
      "db-acknowledge-folder-create",
      (_, id, snapshot, expectedCloudId, responseClientFolderId, cloudId, cloudUpdatedAt) =>
        this.databaseManager.acknowledgeFolderCreate(
          id,
          snapshot,
          expectedCloudId,
          responseClientFolderId,
          cloudId,
          cloudUpdatedAt
        )
    );
    ipcMain.handle("db-mark-folder-synced-if-unchanged", (_, id, snapshot, expectedCloudId) =>
      this.databaseManager.markFolderSyncedIfUnchanged(id, snapshot, expectedCloudId)
    );
    ipcMain.handle("db-get-folder-id-map", () => this.databaseManager.getFolderIdMap());
    ipcMain.handle("db-get-pending-folder-deletes", () =>
      this.databaseManager.getPendingFolderDeletes()
    );
    ipcMain.handle("db-restore-folder-after-denied-delete", (_, id) => {
      const result = this.databaseManager.restoreFolderAfterDeniedDelete(id);
      if (result?.success) {
        this.notifyVectorChanges();
        for (const note of result.notes ?? []) {
          this._asyncMirrorWrite(note);
        }
        setImmediate(() => {
          if (result.folder) broadcastToWindows("folder-synced", result.folder);
          for (const note of result.notes ?? []) {
            broadcastToWindows("note-synced", note);
          }
        });
      }
      return result;
    });
    ipcMain.handle("db-hard-delete-folder", (_, id) => {
      const result = this.databaseManager.hardDeleteFolder(id);
      if (result?.success) {
        this.notifyVectorChanges();
        // Other accounts' notes were released to the space root; their mirror
        // files leave with the folder directory, so rewrite the live ones.
        for (const note of result.relocatedNotes ?? []) {
          if (!note.deleted_at) this._asyncMirrorWrite(note);
        }
        setImmediate(() => {
          broadcastToWindows("folder-deleted", { id });
          if (result.name) this._mirrorDeleteFolderIfUnshared(result.name);
        });
      }
      return result;
    });
    ipcMain.handle("db-relocate-revoked-folder", (_, id, privateSpaceId, preserveFolder) => {
      const result = this.databaseManager.relocateRevokedFolder(id, privateSpaceId, preserveFolder);
      if (result?.success) {
        // The triggers journaled the relocated and deleted notes. Mirror files live by
        // folder, so rewrite the relocated notes and drop the server-owned ones.
        this.notifyVectorChanges();
        for (const note of result.relocatedNotes ?? []) {
          this._asyncMirrorWrite(note);
        }
        for (const noteId of result.deletedNoteIds ?? []) {
          this._asyncMirrorDelete(noteId);
        }
        setImmediate(() => {
          if (result.folder) broadcastToWindows("folder-synced", result.folder);
          else broadcastToWindows("folder-deleted", { id });
          for (const note of result.relocatedNotes ?? []) {
            broadcastToWindows("note-updated", note);
          }
          for (const noteId of result.deletedNoteIds ?? []) {
            broadcastToWindows("note-deleted", { id: noteId });
          }
          const folderGone = !result.folder || result.folder.name !== result.folderName;
          if (result.folderName && folderGone) {
            this._mirrorDeleteFolderIfUnshared(result.folderName);
          }
        });
      }
      return result;
    });

    // Renderer-side sync events (conflicts, revocation toasts, …) happen in
    // whichever window ran the pass — rebroadcast them to ALL windows.
    ipcMain.handle("broadcast-sync-event", (_, name, payload) => {
      broadcastToWindows("sync-event", { name, payload });
      return { success: true };
    });

    // Spaces sync
    ipcMain.handle("db-upsert-space-from-cloud", (_, cloudSpace) => {
      const space = this.databaseManager.upsertSpaceFromCloud(cloudSpace);
      if (space) setImmediate(() => broadcastToWindows("space-synced", space));
      return space;
    });
    ipcMain.handle("db-set-space-sync-status", (_, id, status) => {
      const result = this.databaseManager.setSpaceSyncStatus(id, status);
      if (result?.success && result.space) {
        // Live skeleton toggling: the tree keys pending/synced off this flag.
        setImmediate(() => broadcastToWindows("space-synced", result.space));
      }
      return result;
    });

    // Conversations sync
    ipcMain.handle("db-get-pending-conversations", () =>
      this.databaseManager.getPendingConversations()
    );
    ipcMain.handle("db-get-pending-conversation-deletes", () =>
      this.databaseManager.getPendingConversationDeletes()
    );
    ipcMain.handle("db-get-conversation-by-client-id", (_, clientId) =>
      this.databaseManager.getConversationByClientId(clientId)
    );
    ipcMain.handle("db-upsert-conversation-from-cloud", (_, cloudConv, messages) =>
      this.databaseManager.upsertConversationFromCloud(cloudConv, messages)
    );
    ipcMain.handle("db-acknowledge-conversation-create", (_, id, snapshot, cloudId) =>
      this.databaseManager.acknowledgeConversationCreate(id, snapshot, cloudId)
    );
    ipcMain.handle("db-mark-conversation-synced", (_, id, cloudId) =>
      this.databaseManager.markConversationSynced(id, cloudId)
    );
    ipcMain.handle("db-hard-delete-conversation", (_, id) => {
      const result = this.databaseManager.hardDeleteConversation(id);
      if (result?.success) {
        setImmediate(() => broadcastToWindows("conversation-deleted", { id }));
      }
      return result;
    });

    // Transcriptions sync
    ipcMain.handle("db-get-pending-transcriptions", () =>
      this.databaseManager.getPendingTranscriptions()
    );
    ipcMain.handle("db-get-transcription-by-client-id", (_, clientId) =>
      this.databaseManager.getTranscriptionByClientId(clientId)
    );
    ipcMain.handle("db-upsert-transcription-from-cloud", (_, cloudTranscription) => {
      return this.databaseManager.upsertTranscriptionFromCloud(cloudTranscription);
    });
    ipcMain.handle("db-mark-transcription-synced", (_, id, cloudId) =>
      this.databaseManager.markTranscriptionSynced(id, cloudId)
    );
    ipcMain.handle("db-get-pending-transcription-deletes", () =>
      this.databaseManager.getPendingTranscriptionDeletes()
    );
    ipcMain.handle("db-hard-delete-transcription", (_, id) => {
      const result = this.databaseManager.hardDeleteTranscription(id);
      if (result?.success) {
        setImmediate(() => broadcastToWindows("transcription-deleted", { id }));
      }
      return result;
    });

    ipcMain.handle("export-note", async (event, noteId, format) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        if (!note) return { success: false, error: "Note not found" };

        const { dialog } = require("electron");
        const fs = require("fs");
        const exportFormat =
          format === "txt"
            ? { name: "Text", extension: "txt" }
            : { name: "Markdown", extension: "md" };
        const safeName = (note.title || "Untitled").replace(/[/\\?%*:|"<>]/g, "-");

        const result = await dialog.showSaveDialog({
          defaultPath: `${safeName}.${exportFormat.extension}`,
          filters: [{ name: exportFormat.name, extensions: [exportFormat.extension] }],
        });

        if (result.canceled || !result.filePath) return { success: false };

        let exportContent;
        if (format === "txt") {
          const { markdownToPlainText } = await import("./markdownToPlainText.ts");
          exportContent = markdownToPlainText(note.content || "");
        } else {
          exportContent = note.enhanced_content || note.content;
        }

        fs.writeFileSync(result.filePath, exportContent, "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting note", { error: error.message }, "notes");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("export-transcript", async (event, noteId, format, source) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        if (!note) return { success: false, error: "Note not found" };

        const segments = JSON.parse(note.transcript || "[]");
        if (!segments.length) return { success: false, error: "No transcript available" };

        const speakerMappings = this._buildSpeakerMappings(noteId);
        if (!["txt", "srt", "md", "json"].includes(format))
          throw new Error("Invalid transcript export format");
        if (source !== undefined && format !== "srt")
          throw new Error("Source selection is only valid for subtitle export");
        // Validate media clocks before opening a native picker. A mixed note
        // has no implicit concatenated audio timeline.
        const transcriptFormatter = require("./transcriptFormatter");
        const exportContent =
          format === "txt"
            ? transcriptFormatter.formatTxt(note, segments, speakerMappings)
            : format === "srt"
              ? transcriptFormatter.formatSrt(segments, speakerMappings, note, source)
              : format === "md"
                ? transcriptFormatter.formatMd(note, segments, speakerMappings)
                : transcriptFormatter.formatJson(note, segments, speakerMappings);

        const { dialog } = require("electron");
        const fs = require("fs");
        const exportFormats = {
          txt: { name: "Text", extension: "txt" },
          srt: { name: "SubRip Subtitles", extension: "srt" },
          json: { name: "JSON", extension: "json" },
          md: { name: "Markdown", extension: "md" },
        };
        const exportFormat = exportFormats[format] || exportFormats.txt;
        let safeName = (note.title || "Untitled").replace(/[/\\?%*:|"<>]/g, "-");
        if (source) {
          const selected = require("../utils/transcriptMedia.mjs").selectTranscriptSource(
            segments,
            note.source_media,
            source
          ).source;
          safeName +=
            selected.kind === "original"
              ? "-original"
              : `-recording-${selected.recordingNumber}-${selected.source}`;
        }

        const result = await dialog.showSaveDialog({
          defaultPath: `${safeName}.${exportFormat.extension}`,
          filters: [{ name: exportFormat.name, extensions: [exportFormat.extension] }],
        });

        if (result.canceled || !result.filePath) return { success: false };

        fs.writeFileSync(result.filePath, exportContent, "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting transcript", { error: error.message }, "notes");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("export-dictionary", async (event, words) => {
      try {
        const { dialog } = require("electron");
        const fs = require("fs");

        const result = await dialog.showSaveDialog({
          defaultPath: "dictionary.txt",
          filters: [{ name: "Text", extensions: ["txt"] }],
        });

        if (result.canceled || !result.filePath) return { success: false };

        fs.writeFileSync(result.filePath, words.join("\n"), "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting dictionary", { error: error.message }, "dictionary");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("select-audio-file", async (event, options = {}) => {
      const { dialog } = require("electron");
      const properties = ["openFile"];
      if (options.multiple === true) properties.push("multiSelections");
      const result = await dialog.showOpenDialog({
        properties,
        filters: [{ name: "Audio and Video Files", extensions: UPLOAD_AUDIO_EXTENSIONS }],
      });
      if (result.canceled || !result.filePaths.length) {
        return { canceled: true };
      }
      result.filePaths.forEach(approveAudioPath);
      if (options.multiple === true) {
        return { canceled: false, filePaths: result.filePaths };
      }
      return { canceled: false, filePath: result.filePaths[0] };
    });

    // Fired by the preload's getPathForFile for real drag-dropped files; a
    // renderer-constructed File yields "" there, so this can't be forged.
    ipcMain.on("approve-audio-path", (_event, filePath) => {
      approveAudioPath(filePath);
    });

    ipcMain.handle("get-file-size", async (_event, filePath) => {
      const fs = require("fs");
      try {
        if (typeof filePath !== "string") return 0;
        const real = resolveAllowedAudioPath(filePath);
        if (!real) return 0;
        const stats = fs.statSync(real);
        return stats.size;
      } catch {
        return 0;
      }
    });

    const activeUrlDownloads = new Map();
    let urlDownloadSeq = 0;

    // Sweep ow-url-*/ow-diarize-* orphans from crashes or windows closed mid-download.
    require("./urlAudioDownloader").sweepStaleTempArtifacts();

    ipcMain.handle("download-url-audio", async (event, url, downloadId) => {
      if (typeof url !== "string" || url.length > 2048) {
        return { success: false, error: "Invalid URL", code: "INVALID_URL" };
      }
      const { download } = require("./urlAudioDownloader");

      const id =
        typeof downloadId === "string" && downloadId ? downloadId : `dl-${++urlDownloadSeq}`;
      const abortController = new AbortController();
      activeUrlDownloads.set(id, abortController);

      try {
        const result = await download(
          url,
          (progress) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("url-download-progress", { ...progress, downloadId: id });
            }
          },
          abortController.signal
        );
        return { success: true, ...result };
      } catch (error) {
        debugLogger.error("URL audio download error", { error: error.message, code: error.code });
        return { success: false, error: error.message, code: error.code || "DOWNLOAD_FAILED" };
      } finally {
        if (activeUrlDownloads.get(id) === abortController) {
          activeUrlDownloads.delete(id);
        }
      }
    });

    // With an id, cancels that download; without, cancels all (unmount cleanup).
    ipcMain.handle("cancel-url-download", async (_event, downloadId) => {
      if (typeof downloadId === "string" && downloadId) {
        const controller = activeUrlDownloads.get(downloadId);
        if (!controller) return { success: false };
        controller.abort();
        activeUrlDownloads.delete(downloadId);
        return { success: true };
      }
      if (activeUrlDownloads.size === 0) return { success: false };
      for (const controller of activeUrlDownloads.values()) controller.abort();
      activeUrlDownloads.clear();
      return { success: true };
    });

    ipcMain.handle("delete-temp-file", async (event, filePath) => {
      try {
        if (typeof filePath !== "string") {
          return { success: false, error: "Invalid file path" };
        }
        const { getSafeTempDir } = require("./safeTempDir");
        const resolved = path.resolve(filePath);
        const basename = path.basename(resolved);
        if (!basename.startsWith("ow-url-") && !basename.startsWith("ow-diarize-")) {
          return { success: false, error: "Not an OpenWhispr temp file" };
        }
        const real = fs.realpathSync(resolved);
        let tempDir = getSafeTempDir();
        try {
          tempDir = fs.realpathSync(tempDir);
        } catch {}
        const rel = path.relative(tempDir, real);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          return { success: false, error: "Not an OpenWhispr temp file" };
        }
        fs.unlinkSync(real);
        return { success: true };
      } catch (error) {
        debugLogger.warn("Failed to delete temp file", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("capture-selected-text", async (event, options = {}) => {
      if (!this.selectionManager) {
        return { status: "unavailable", code: "selection_manager_unavailable" };
      }
      return this.selectionManager.captureSelectedText({
        probeEditable: options.probeEditable === true,
      });
    });

    ipcMain.handle("replace-selected-text", async (event, sessionId, text, options = {}) => {
      if (!this.selectionManager) {
        return { success: false, code: "selection_manager_unavailable" };
      }
      return this.selectionManager.replaceSelectedText(sessionId, text, {
        restoreClipboard: options.restoreClipboard !== false,
        allowClipboardFallback: options.allowClipboardFallback === true,
        webContents: event.sender,
      });
    });

    ipcMain.handle("paste-at-captured-target", async (event, sessionId, text, options = {}) => {
      if (!this.selectionManager) {
        return { success: false, code: "selection_manager_unavailable" };
      }
      return this.selectionManager.pasteAtCapturedTarget(sessionId, text, {
        restoreClipboard: options.restoreClipboard !== false,
        allowClipboardFallback: options.allowClipboardFallback === true,
        webContents: event.sender,
      });
    });

    ipcMain.handle("paste-text", async (event, text, options) => {
      // An onboarding demo already puts the transcript in its own textarea from
      // the demo event, and that textarea is what has focus — pasting on top of
      // it appends the same sentence a second time. This is a successful no-op,
      // not a completed paste, so callers can avoid reporting paste-dependent
      // fallbacks as if text reached another application.
      if (this.windowManager?.isOnboardingDemoActive()) {
        return { success: true, pasted: false, reason: "onboarding-demo" };
      }

      const mainWindow = this.windowManager?.mainWindow;
      const targetPid = this.textEditMonitor?.lastTargetPid || null;

      // Activating the target by PID is more reliable than hide()'s implicit
      // focus hand-off for Chromium apps like Claude desktop and Brave (#668).
      let activated = false;
      if (process.platform === "darwin" && this.textEditMonitor) {
        activated = await this.textEditMonitor.activateTargetPid();
      }

      if (!activated && mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {
        if (process.platform === "darwin") {
          mainWindow.hide();
          await new Promise((resolve) => setTimeout(resolve, 120));
          mainWindow.showInactive();
        } else {
          mainWindow.blur();
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
      }

      // Smart spacing (#856): append a trailing space so the next paste's leading
      // space self-corrects the gap. Reading the char before the cursor to space
      // the front instead would take a macOS Accessibility read costing hundreds
      // of ms — too slow for the paste hot path.
      const textToPaste = applySmartSpacing(text);

      // Windows: restore the foreground window captured at record start so the
      // paste lands in the field the user was dictating into, not wherever focus
      // drifted during transcription (#859). macOS handles this via
      // activateTargetPid above; Linux re-detects the target inside pasteLinux.
      const winTarget =
        process.platform === "win32"
          ? ((await this.selectionManager?.getWinTarget?.()) ?? null)
          : null;
      const targetWindow =
        winTarget &&
        isRestorablePasteTarget({
          target: winTarget,
          ownExeName: path.basename(process.execPath),
          ownWindowHandles: BrowserWindow.getAllWindows()
            .filter((win) => !win.isDestroyed())
            .map((win) => win.getNativeWindowHandle()),
        })
          ? winTarget.id
          : null;

      let pasteResult;
      try {
        pasteResult = await this.clipboardManager.pasteText(textToPaste, {
          ...options,
          webContents: event.sender,
          targetWindow,
          targetProcessId: targetWindow ? winTarget.processId : null,
          targetProcessStarted: targetWindow ? winTarget.processStarted : null,
          silentAccessibilityCheck: true,
        });
      } catch (error) {
        if (error?.code !== "ACCESSIBILITY_PERMISSION_REQUIRED" || error.clipboardCopied !== true) {
          throw error;
        }
        return {
          success: false,
          pasted: false,
          code: "ACCESSIBILITY_PERMISSION_REQUIRED",
          clipboardCopied: true,
        };
      }
      const pasted =
        process.platform === "win32" ? pasteResult?.pasted === true : pasteResult?.pasted !== false;
      debugLogger.debug("[AutoLearn] Paste completed", {
        autoLearnEnabled: this._autoLearnEnabled,
        hasMonitor: !!this.textEditMonitor,
        targetPid,
        pasted,
      });
      if (pasted && this.textEditMonitor && this._autoLearnEnabled) {
        setTimeout(() => {
          try {
            debugLogger.debug("[AutoLearn] Starting monitoring", {
              textPreview: text.substring(0, 80),
            });
            this.textEditMonitor.startMonitoring(text, 30000, { targetPid });
          } catch (err) {
            debugLogger.debug("[AutoLearn] Failed to start monitoring", { error: err.message });
          }
        }, 500);
      }
      // ClipboardManager returns `restoreComplete` so main-process callers can
      // serialize subsequent clipboard work behind its delayed restore. A
      // Promise cannot cross Electron's IPC boundary, though, and renderer
      // callers need to know whether text was pasted, but not the delayed
      // clipboard restoration promise. Successful platform paths predate the
      // explicit `pasted` outcome; only the clipboard-only fallback and a paste
      // held back for still-held modifiers (which carries a `reason`) set false.
      return {
        success: pasted,
        pasted,
        ...(pasteResult?.reason ? { reason: pasteResult.reason } : {}),
      };
    });

    ipcMain.handle("check-accessibility-permission", async (_event, silent = false) => {
      return this.clipboardManager.checkAccessibilityPermissions(silent);
    });

    // Passes `true` to isTrustedAccessibilityClient to trigger the macOS system prompt
    ipcMain.handle("prompt-accessibility-permission", async () => {
      if (process.platform !== "darwin") return true;
      return systemPreferences.isTrustedAccessibilityClient(true);
    });

    ipcMain.handle("read-clipboard", async (event) => {
      return this.clipboardManager.readClipboard();
    });

    ipcMain.handle("write-clipboard", async (event, text) => {
      return this.clipboardManager.writeClipboard(text, event.sender);
    });

    ipcMain.handle("leaderboard-copy-image", async (_event, dataUrl) => {
      try {
        const { clipboard, nativeImage } = require("electron");
        const image = nativeImage.createFromBuffer(decodeLeaderboardPngDataUrl(dataUrl));
        if (image.isEmpty()) throw new Error("Leaderboard image could not be decoded");
        clipboard.writeImage(image);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to copy leaderboard image",
          { error: error.message },
          "analytics"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("leaderboard-save-image", async (event, dataUrl, suggestedName) => {
      try {
        const { dialog } = require("electron");
        const parentWindow = BrowserWindow.fromWebContents(event.sender);
        const options = {
          defaultPath: leaderboardImageFilename(suggestedName),
          filters: [{ name: "PNG image", extensions: ["png"] }],
        };
        const result = parentWindow
          ? await dialog.showSaveDialog(parentWindow, options)
          : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return { success: true, canceled: true };
        await fs.promises.writeFile(result.filePath, decodeLeaderboardPngDataUrl(dataUrl));
        return { success: true, canceled: false };
      } catch (error) {
        debugLogger.error(
          "Failed to save leaderboard image",
          { error: error.message },
          "analytics"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("check-paste-tools", async () => {
      return this.clipboardManager.checkPasteTools();
    });

    // Voice drafts (chat input): persist a recorded buffer so the file-based
    // transcription pipeline (all providers) can consume it, then delete it.
    ipcMain.handle("save-temp-audio", async (_event, buffer) => {
      const tempPath = path.join(
        os.tmpdir(),
        `ow-voice-draft-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.webm`
      );
      fs.writeFileSync(tempPath, Buffer.from(buffer));
      return { success: true, path: tempPath };
    });

    ipcMain.handle("delete-temp-audio", async (_event, tempPath) => {
      // Only files this handler family created are deletable.
      const resolved = path.resolve(tempPath);
      const validPrefix = path.join(os.tmpdir(), "ow-voice-draft-");
      if (!resolved.startsWith(validPrefix)) {
        return { success: false, error: "Invalid temp path" };
      }
      try {
        fs.unlinkSync(resolved);
      } catch {
        // Already gone — fine.
      }
      return { success: true };
    });

    ipcMain.handle("detect-gpu", async () => {
      const { detectNvidiaGpu } = require("../utils/gpuDetection");
      return detectNvidiaGpu();
    });

    ipcMain.handle("list-gpus", async () => {
      const { listNvidiaGpus } = require("../utils/gpuDetection");
      return listNvidiaGpus();
    });

    ipcMain.handle("get-gpu-device-index", async (_event, purpose) => {
      if (purpose !== "transcription" && purpose !== "intelligence") {
        return "";
      }
      const key = purpose === "intelligence" ? "INTELLIGENCE_GPU_UUID" : "TRANSCRIPTION_GPU_UUID";
      return process.env[key] || "";
    });

    // One-time "GPU pack needs re-downloading" notice recorded by the
    // legacy-layout migration before any window existed. See #1606.

    // Clears the remembered GPU failure and reloads the server with the GPU
    // backend re-enabled (Retry on the "GPU could not be activated" state)

    ipcMain.handle("check-ffmpeg-availability", async (event) => {
      const ffmpegPath = require("./ffmpegUtils").getFFmpegPath();
      return ffmpegPath
        ? { available: true, path: ffmpegPath }
        : { available: false, error: "FFmpeg not found" };
    });

    // The current supervised child requests replacement; Desktop owns launch.
    ipcMain.handle("relaunch-app", async () => {
      if (
        this._activeRecordingPipeline ||
        this._activeMeetingNoteId ||
        this.windowManager._dictationLifecycleState !== "idle"
      ) {
        throw new Error(i18nMain.t("nimi.restartBusy"));
      }
      this.requestHostRestart();
    });

    ipcMain.handle("cleanup-app", async (event) => {
      const fs = require("fs");

      const errors = [];
      const mainWindow = this.windowManager.mainWindow;

      // Stop services before deleting files they hold open
      try {
        this.googleCalendarManager?.stop();
      } catch (e) {
        errors.push(`GCal stop: ${e.message}`);
      }
      try {
        this.microsoftCalendarManager?.stop();
      } catch (e) {
        errors.push(`MCal stop: ${e.message}`);
      }
      try {
        this.appleCalendarManager?.stop();
      } catch (e) {
        errors.push(`ACal stop: ${e.message}`);
      }
      try {
        await this.getSemanticSearch?.()?.stop();
      } catch (e) {
        errors.push(`Vector index stop: ${e.message}`);
      }

      // Revoke Google OAuth tokens before DB is closed
      try {
        await this.googleCalendarManager?.revokeAllTokens();
      } catch (e) {
        errors.push(`GCal revoke: ${e.message}`);
      }

      // Revoke every connector login stored on this device (Slack, Gmail) at
      // its provider, for every account: Settings signs out before this
      // runs, so there may be no signed-in account left. It must run before
      // the connectors directory is deleted below. Best effort: the revokes
      // run in parallel under a 5 s deadline and never block the reset.
      try {
        await this.connectorManager?.revokeAllStored();
      } catch (e) {
        const { describeError } = require("./connectors/errorSummary");
        const { errorName, errorCode } = describeError(e);
        errors.push(`Connector revoke: ${errorCode ?? errorName}`);
      }

      // Close DB connection before deleting the file
      try {
        this.databaseManager?.db?.close();
      } catch (e) {
        errors.push(`DB close: ${e.message}`);
      }

      // Delete audio files
      try {
        this.audioStorageManager.deleteAllAudio();
      } catch (e) {
        errors.push(`Audio delete: ${e.message}`);
      }

      // Delete downloaded models
      // Explicit device erasure owns this fork's imported media, not upstream caches.
      try {
        require("./appData").eraseAppOwnedImports();
      } catch (error) {
        errors.push("Imported media: " + error.message);
      }
      try {
        require("./appData").eraseAppOwnedSearchIndexes();
      } catch (error) {
        errors.push("Semantic indexes: " + error.message);
      }

      // Delete database file + WAL/SHM
      try {
        const dbPath = path.join(
          getAppDataDirectory(),
          process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db"
        );
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        if (fs.existsSync(dbPath + "-wal")) fs.unlinkSync(dbPath + "-wal");
        if (fs.existsSync(dbPath + "-shm")) fs.unlinkSync(dbPath + "-shm");
      } catch (e) {
        errors.push(`DB file: ${e.message}`);
      }

      // Delete device-wide settings and encrypted credentials.
      try {
        await this.environmentManager?.clearAllPersistedData();
      } catch (e) {
        errors.push(`Environment settings: ${e.message}`);
      }
      try {
        const tokenCleanup = tokenStore.clear();
        if (!tokenCleanup.success) throw new Error("Could not clear the stored bearer token");
      } catch (e) {
        errors.push(`Authentication token: ${e.message}`);
      }
      try {
        this.enterpriseIdentityManager?.clear();
      } catch (e) {
        errors.push(`Enterprise settings: ${e.message}`);
      }
      try {
        for (const fileName of [
          "workspace-policy.json",
          "managed-enterprise-config.json",
          "globe-preference-state.json",
          ".system-audio-permission",
          "account-scope-binding.json",
        ]) {
          fs.rmSync(path.join(getAppDataDirectory(), fileName), { force: true });
        }
      } catch (e) {
        errors.push(`Device setting files: ${e.message}`);
      }
      // "connectors" holds encrypted connector logins (Slack, Gmail), all
      // revoked above.
      for (const directoryName of ["connectors"]) {
        try {
          fs.rmSync(path.join(getAppDataDirectory(), directoryName), {
            recursive: true,
            force: true,
          });
        } catch (e) {
          errors.push(`${directoryName} runtime: ${e.message}`);
        }
      }

      // Clear browser-held account/session state, including cookies, IndexedDB,
      // Cache Storage and localStorage persisted by any app window.
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
          await win.webContents.session.clearStorageData();
          await win.webContents.session.clearCache();
        }
      } catch (e) {
        errors.push(`Browser data: ${e.message}`);
      }

      // Clear localStorage
      if (mainWindow?.webContents) {
        try {
          await mainWindow.webContents.executeJavaScript("localStorage.clear()");
        } catch (e) {
          errors.push(`localStorage: ${e.message}`);
        }
      }

      if (errors.length > 0) {
        debugLogger.warn("Cleanup completed with errors", { errors }, "cleanup");
      }

      return { success: errors.length === 0, message: "Cleanup completed", errors };
    });

    ipcMain.handle("update-hotkey", async (event, hotkey) => {
      return await this.windowManager.updateHotkey(hotkey);
    });

    ipcMain.handle("set-hotkey-listening-mode", async (event, enabled) => {
      if (enabled) {
        const captureWindow = BrowserWindow.fromWebContents(event.sender);
        // Only the control panel owns editable hotkey fields. Refocusing the
        // sender before the idempotence check also repairs a stale capture-mode
        // flag after Windows has moved foreground focus to another window.
        if (captureWindow === this.windowManager.controlPanelWindow) {
          focusWindowsHotkeyCaptureWindow(captureWindow);
        }
      }
      if (this._hotkeyCaptureMode === enabled) return { success: true, skipped: true };
      this._hotkeyCaptureMode = enabled;
      this.windowManager.setHotkeyListeningMode(enabled);
      ipcMain.emit("hotkey-listening-mode-changed", null, enabled);
      const hotkeyManager = this.windowManager.hotkeyManager;

      // Restore from slot state only. A freshly captured hotkey is registered by
      // its own update IPC (invoked before this one); re-binding it here would
      // overwrite the primary on DE backends or leak untracked registrations.
      const effectiveHotkey = hotkeyManager.getCurrentHotkey();

      const {
        isGlobeLikeHotkey,
        isModifierOnlyHotkey,
        isRightSideModifier,
        isMouseButtonHotkey,
      } = require("./hotkeyManager");
      const usesNativeListener = (hotkey) =>
        !hotkey ||
        isGlobeLikeHotkey(hotkey) ||
        isMouseButtonHotkey(hotkey) ||
        isModifierOnlyHotkey(hotkey) ||
        isRightSideModifier(hotkey);

      if (enabled) {
        // Entering capture mode — unregister ALL slots so none intercept keypresses.
        // Dictation is always active; meeting and agent may or may not be set.
        const allSlots = hotkeyManager.slots;
        for (const [slot, info] of allSlots) {
          // Native-listener entries (null accelerator) are handled by stopping
          // the key listeners below.
          for (const accel of info?.accelerators || []) {
            if (!accel) continue;
            debugLogger.log(
              `[IPC] Unregistering globalShortcut "${accel}" (slot "${slot}") for capture mode`
            );
            const { globalShortcut } = require("electron");
            try {
              globalShortcut.unregister(accel);
            } catch {}
          }
        }

        // On Windows, stop the Windows key listener
        if (process.platform === "win32" && this.windowsKeyManager) {
          debugLogger.log("[IPC] Stopping Windows key listener for hotkey capture mode");
          this.windowsKeyManager.stop();
        }

        // On Linux, stop the Linux key listener
        if (process.platform === "linux" && this.linuxKeyManager) {
          debugLogger.log("[IPC] Stopping Linux key listener for hotkey capture mode");
          this.linuxKeyManager.stop();
        }

        // On GNOME, unregister all native keybindings during capture
        if (hotkeyManager.isUsingGnome() && hotkeyManager.gnomeManager) {
          await hotkeyManager.gnomeManager.unregisterPushToTalk();
          for (const slot of [...hotkeyManager.gnomeManager.registeredSlots]) {
            debugLogger.log(
              `[IPC] Unregistering GNOME keybinding (slot "${slot}") for capture mode`
            );
            await hotkeyManager.gnomeManager.unregisterKeybinding(slot).catch((err) => {
              debugLogger.warn(`[IPC] Failed to unregister GNOME slot "${slot}":`, err.message);
            });
          }
        }

        // On Hyprland Wayland, unregister the keybinding during capture
        if (hotkeyManager.isUsingHyprland() && hotkeyManager.hyprlandManager) {
          debugLogger.log("[IPC] Unregistering Hyprland keybinding for hotkey capture mode");
          const unregistered = await hotkeyManager.hyprlandManager
            .unregisterKeybinding()
            .catch((err) => {
              debugLogger.warn("[IPC] Failed to unregister Hyprland keybinding:", err.message);
              return false;
            });
          if (!unregistered) {
            debugLogger.warn("[IPC] Hyprland keybinding remained active during capture");
          }
        }
      } else {
        // Exiting capture mode - re-register globalShortcut if not already registered
        // Skip for KDE/GNOME/Hyprland — updateHotkey handles re-registration via native path
        const usesNativePath =
          hotkeyManager.isUsingKDE() ||
          hotkeyManager.isUsingGnome() ||
          hotkeyManager.isUsingHyprland();
        if (!usesNativePath) {
          const { globalShortcut } = require("electron");
          // Re-register every globalShortcut-backed dictation hotkey (the slot
          // may hold several).
          for (const hk of hotkeyManager.getSlotHotkeys("dictation")) {
            if (!hk || usesNativeListener(hk)) continue;
            const accelerator = hk;
            if (!globalShortcut.isRegistered(accelerator)) {
              debugLogger.log(
                `[IPC] Re-registering globalShortcut "${accelerator}" after capture mode`
              );
              const callback = this.windowManager.createHotkeyCallback();
              const registered = globalShortcut.register(accelerator, () => callback(hk));
              if (!registered) {
                debugLogger.warn(
                  `[IPC] Failed to re-register globalShortcut "${accelerator}" after capture mode`
                );
              }
            }
          }
        }

        // Re-sync native key listeners (Windows/Linux) across all hotkey slots now
        // that capture is done. Idempotent — reads the current slot hotkeys.
        this.windowManager.reconcileNativeKeyListeners();

        // On GNOME, re-register the keybinding with the effective hotkey
        if (hotkeyManager.isUsingGnome() && hotkeyManager.gnomeManager && effectiveHotkey) {
          debugLogger.log(
            `[IPC] Re-registering GNOME keybinding "${effectiveHotkey}" after capture mode`
          );
          await hotkeyManager.registerGnomeDictationHotkey(
            effectiveHotkey,
            this.windowManager.createHotkeyCallback()
          );
        }

        // On Hyprland Wayland, re-register the keybinding with the effective hotkey
        if (hotkeyManager.isUsingHyprland() && hotkeyManager.hyprlandManager && effectiveHotkey) {
          debugLogger.log(
            `[IPC] Re-registering Hyprland keybinding "${effectiveHotkey}" after capture mode`
          );
          await hotkeyManager.hyprlandManager.registerKeybinding(
            effectiveHotkey,
            this.windowManager.getActivationMode() === "push"
          );
        }

        // On KDE (X11 or Wayland), re-register the keybinding with the effective hotkey
        if (hotkeyManager.isUsingKDE() && hotkeyManager.kdeManager && effectiveHotkey) {
          debugLogger.log(
            `[IPC] Re-registering KDE keybinding "${effectiveHotkey}" after capture mode`
          );
          const callback = this.windowManager.createHotkeyCallback();
          const result = await hotkeyManager.kdeManager.registerKeybinding(
            effectiveHotkey,
            "dictation",
            callback,
            this.windowManager.getActivationMode() === "push"
          );
          if (result !== true) {
            debugLogger.warn(
              `[IPC] Failed to re-register KDE keybinding "${effectiveHotkey}" after capture mode`,
              { result }
            );
          }
        }

        // Re-register non-dictation slots (meeting, agent) that were unregistered on capture enter
        for (const [slot, info] of hotkeyManager.slots) {
          const hotkeys = info?.hotkeys || [];
          if (slot === "dictation" || slot === "cancel" || hotkeys.length === 0 || !info?.callback)
            continue;
          debugLogger.log(
            `[IPC] Re-registering slot "${slot}" ("${hotkeys.join(", ")}") after capture mode`
          );
          const result = await hotkeyManager
            .registerSlot(slot, hotkeys, info.callback)
            .catch((err) => {
              debugLogger.warn(`[IPC] Failed to re-register slot "${slot}":`, err.message);
              return { success: false };
            });
          if (!result.success) {
            debugLogger.warn(`[IPC] Slot "${slot}" was not restored after capture`);
          }
        }
      }

      return { success: true };
    });

    ipcMain.handle("get-hotkey-mode-info", async (_event, requestedHotkey) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const hotkey =
        typeof requestedHotkey === "string" && requestedHotkey.trim()
          ? requestedHotkey.split(",")[0].trim()
          : hotkeyManager.getCurrentHotkey();
      const isUsingNativeShortcut = this.windowManager.isUsingNativeShortcutHotkeys();
      const supportsPushToTalk = hotkeyManager.supportsPushToTalk(hotkey);

      return {
        isUsingGnome: this.windowManager.isUsingGnomeHotkeys(),
        isUsingHyprland: this.windowManager.isUsingHyprlandHotkeys(),
        isUsingKDE: this.windowManager.isUsingKDEHotkeys(),
        isUsingNativeShortcut,
        supportsPushToTalk,
        pushToTalkUnavailableReason: supportsPushToTalk
          ? null
          : hotkeyManager.getPushToTalkUnavailableReason(hotkey),
        // Lets the renderer show the setup box outside push mode, where the
        // disabled-Hold tooltip is the only other place this surfaces. Desktop
        // backends see their own hotkeys, so access matters only without one.
        linuxInputAccessDenied:
          hotkeyManager.reliesOnLinuxKeyListener() &&
          hotkeyManager.nativeListenerProbe().reason === "input_access_denied",
      };
    });

    ipcMain.handle("get-hyprland-config-status", async () => {
      if (!this.windowManager.isUsingHyprlandHotkeys()) return null;
      return this.windowManager.getHyprlandConfigStatus();
    });

    ipcMain.handle("register-cancel-hotkey", async (event, key) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const mainWindow = this.windowManager.mainWindow;
      return hotkeyManager.registerSlot("cancel", key, () => {
        mainWindow?.webContents?.send("cancel-hotkey-pressed");
      });
    });

    ipcMain.handle("unregister-cancel-hotkey", async () => {
      this.windowManager.hotkeyManager.unregisterSlot("cancel");
      return { success: true };
    });

    ipcMain.handle("start-window-drag", async (event) => {
      return await this.windowManager.startWindowDrag();
    });

    ipcMain.handle("stop-window-drag", async (event) => {
      return await this.windowManager.stopWindowDrag();
    });

    ipcMain.handle("start-control-panel-drag", async () => {
      return await this.windowManager.startControlPanelDrag();
    });

    ipcMain.handle("stop-control-panel-drag", async () => {
      return await this.windowManager.stopControlPanelDrag();
    });

    ipcMain.handle("open-external", async (event, url) => {
      try {
        const { protocol } = new URL(url);
        if (!["http:", "https:", "mailto:"].includes(protocol)) {
          return { success: false, error: `Blocked URL scheme: ${protocol}` };
        }
        await openExternalUrl(url);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Enclave attestation is Node-only, so batch transcription is proxied through main.

    // Gemini's Interactions API takes JSON with inline base64 audio, not
    // OpenAI-compatible multipart, so batch transcription is proxied through main.

    // Enterprise provider key handlers

    // Enterprise provider test connection

    // Runs doStream for the renderer's enterprise chat model shim; parts are
    // relayed verbatim over enterprise-stream-part, ending with {done}/{error}.
    this.enterpriseStreamAborts = new Map();

    // Lists the text models the account serves in the selected region,
    // resolved to invocable IDs (bare on-demand or geo-scoped profile IDs).

    ipcMain.handle("get-dictation-key", async () => {
      return this.environmentManager.getDictationKey();
    });

    ipcMain.handle("save-dictation-key", async (event, key) => {
      return this.environmentManager.saveDictationKey(key);
    });

    ipcMain.handle("get-active-dictation-key", async () => {
      const hotkeys = this.windowManager?.hotkeyManager?.getSlotHotkeys?.("dictation") ?? [];
      return hotkeys.length > 0 ? hotkeys.join(",") : null;
    });

    ipcMain.handle("get-effective-default-hotkey", async () => {
      return this.windowManager?.hotkeyManager?.getEffectiveDefaultHotkey() ?? null;
    });

    ipcMain.handle("get-activation-mode", async () => {
      return this.environmentManager.getActivationMode();
    });

    ipcMain.handle("save-activation-mode", async (event, mode) => {
      return this.environmentManager.saveActivationMode(mode);
    });

    ipcMain.handle("get-ui-language", async () => {
      return this.environmentManager.getUiLanguage();
    });

    ipcMain.handle("save-ui-language", async (event, language) => {
      return this.environmentManager.saveUiLanguage(language);
    });

    ipcMain.handle("set-ui-language", async (event, language) => {
      const result = this.environmentManager.saveUiLanguage(language);
      process.env.UI_LANGUAGE = result.language;
      changeLanguage(result.language);
      this.windowManager?.refreshLocalizedUi?.();
      this.getTrayManager?.()?.updateTrayMenu?.();
      return { success: true, language: result.language };
    });

    ipcMain.handle("save-all-keys-to-env", async () => {
      return this.environmentManager.saveAllKeysToEnvFile();
    });

    // After a local refusal, the renderer plans a note's parts against this
    // number (#2142 part 3). It is the same ceiling runInference sizes against,
    // so a part the renderer judges to fit is one the main process will accept
    // without a restart it cannot afford.

    ipcMain.handle("detect-vulkan-gpu", async () => {
      try {
        const { detectVulkanGpu } = require("../utils/vulkanDetection");
        return await detectVulkanGpu();
      } catch (error) {
        return { available: false, error: error.message };
      }
    });

    ipcMain.handle("get-log-level", async () => {
      return debugLogger.getLevel();
    });

    ipcMain.handle("app-log", async (event, entry) => {
      debugLogger.logEntry(entry);
      return { success: true };
    });

    const SYSTEM_SETTINGS_URLS = {
      darwin: {
        microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        sound: "x-apple.systempreferences:com.apple.preference.sound?input",
        accessibility:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        systemAudio:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        screenRecording:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        calendars: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
        loginItems: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
      },
      win32: {
        microphone: "ms-settings:privacy-microphone",
        sound: "ms-settings:sound",
        loginItems: "ms-settings:startupapps",
      },
    };

    const openSystemSettings = async (settingType) => {
      const platform = process.platform;
      const urls = SYSTEM_SETTINGS_URLS[platform];
      const url = urls?.[settingType];

      if (!url) {
        // Platform doesn't support this settings URL
        const messages = {
          microphone: i18nMain.t("systemSettings.microphone"),
          sound: i18nMain.t("systemSettings.sound"),
          accessibility: i18nMain.t("systemSettings.accessibility"),
          systemAudio: i18nMain.t("systemSettings.systemAudio"),
          screenRecording: i18nMain.t("systemSettings.screenRecording"),
          loginItems: i18nMain.t("systemSettings.loginItems"),
        };
        return {
          success: false,
          error:
            messages[settingType] || `${settingType} settings are not available on this platform.`,
        };
      }

      try {
        await shell.openExternal(url);
        return { success: true };
      } catch (error) {
        debugLogger.error(`Failed to open ${settingType} settings:`, error);
        return { success: false, error: error.message };
      }
    };

    ipcMain.handle("open-microphone-settings", () => openSystemSettings("microphone"));
    ipcMain.handle("open-sound-input-settings", () => openSystemSettings("sound"));
    ipcMain.handle("get-system-default-microphone", (_event, options = {}) =>
      resolveSystemDefaultMicrophone({ refresh: options?.refresh === true })
    );
    ipcMain.handle("open-accessibility-settings", () => openSystemSettings("accessibility"));
    ipcMain.handle("open-system-audio-settings", () => openSystemSettings("systemAudio"));
    ipcMain.handle("open-screen-recording-settings", () => openSystemSettings("screenRecording"));

    ipcMain.handle("capture-screen-context", async (event) => {
      // Capture immediately so the screenshot reflects the invocation moment;
      // the policy verdict resolves concurrently and decides whether to
      // return it. A signed-out user has no workspace and no policy; managed
      // users are gated even if a stale renderer asks. null matches capture's
      // contract — a screenshot must never break the dictation it accompanies.
      // The target's window rect picks the display it is on rather than the one
      // under the cursor, and the panel reposition has normally cached it already.
      // A failed rect read falls back to the cursor rather than rejecting: the
      // policy branch below can abandon this promise, and capture's contract is
      // to yield null, never to throw.
      const targetPid = this.textEditMonitor?.lastTargetPid;
      const capturePromise = Promise.resolve(
        targetPid ? this.textEditMonitor.getTargetWindowBounds?.(targetPid) : null
      )
        .catch(() => null)
        .then((targetBounds) => screenContextCapture.captureActiveDisplay(targetBounds));
      const authHeaders = await getAuthHeader(event);
      if (authHeaders.Authorization || authHeaders.Cookie) {
        // Bound the verdict wait: a lapsed policy TTL on a degraded network
        // must not stall an allowed user's capture past the renderer's 3s
        // consume race. The renderer gate already fails closed while policy
        // is unresolved, so this defense-in-depth gate lets an unresolved
        // verdict through while the refresh completes in flight — a resolved
        // denial (cached or fresh) still blocks.
        const snapshot = await Promise.race([
          workspacePolicyManager.getPolicy({
            expectedAuthGeneration: tokenStore.getState().generation,
            authHeaders,
          }),
          new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
        if (snapshot && isScreenContextBlocked(snapshot)) {
          debugLogger.warn(
            "Screen context capture blocked by org policy",
            { code: snapshot.code ?? null },
            "screenContext"
          );
          return null;
        }
      }
      return capturePromise;
    });

    // Snapshot the launch-time TCC status so a mid-session grant (which macOS
    // only honors after a relaunch) is detectable even if the renderer never
    // checked before the user granted.
    screenContextCapture.getAccessStatus();

    ipcMain.handle("check-screen-recording-access", () => screenContextCapture.getAccessResult());

    ipcMain.handle("request-screen-recording-access", async () => {
      const status = await screenContextCapture.requestAccess();
      if (process.platform === "darwin" && status !== "granted") {
        await openSystemSettings("screenRecording");
      }
      return screenContextCapture.getAccessResult();
    });

    // Preserve the renderer setting while app-wide content protection is
    // temporarily disabled for screen recording.
    ipcMain.handle("screen-context-set-enabled", (event, enabled) => {
      this.windowManager?.setScreenContextProtection(enabled);
      return { success: true };
    });

    // Panel open: window becomes focusable so follow-up keyboard input works.
    // Only the dictation renderer may flip main-window focusability.
    ipcMain.handle("set-assistant-panel-open", (event, open) => {
      const dictationWindow = this.windowManager?.mainWindow;
      if (
        !dictationWindow ||
        dictationWindow.isDestroyed() ||
        event.sender !== dictationWindow.webContents
      ) {
        return { success: false, error: "Not the dictation window" };
      }
      this.windowManager.setAssistantPanelOpen(open);
      return { success: true };
    });

    // Busy state is enforced in the main process so a hotkey cannot trigger
    // native capture side effects before the renderer has a chance to reject it.
    ipcMain.handle("set-assistant-panel-busy", (event, busy) => {
      const dictationWindow = this.windowManager?.mainWindow;
      if (
        !dictationWindow ||
        dictationWindow.isDestroyed() ||
        event.sender !== dictationWindow.webContents
      ) {
        return { success: false, error: "Not the dictation window" };
      }
      this.windowManager.setAssistantPanelBusy(busy);
      return { success: true };
    });

    const isAgentDictationPill = (event) => {
      const pillWindow = this.windowManager?.agentDictationPillWindow;
      return pillWindow && !pillWindow.isDestroyed() && event.sender === pillWindow.webContents;
    };

    // The pill disables its own controls when an assistant or translation
    // capture owns the lifecycle, but that state travels by IPC — a click can
    // race it. Re-check here so a stale pill can never toggle or cancel a
    // recording it does not own.
    const isAgentDictationPillInteractive = () =>
      this.windowManager.getAgentDictationPillState().interactive;

    ipcMain.handle("toggle-agent-panel-dictation", (event) => {
      if (!isAgentDictationPill(event) || !isAgentDictationPillInteractive()) {
        return { success: false };
      }
      this.windowManager.sendToggleDictation();
      return { success: true };
    });

    ipcMain.handle("cancel-agent-panel-dictation", (event) => {
      if (!isAgentDictationPill(event) || !isAgentDictationPillInteractive()) {
        return { success: false };
      }
      this.windowManager.sendCancelActiveDictation();
      return { success: true };
    });

    ipcMain.handle("get-agent-dictation-pill-state", (event) => {
      return isAgentDictationPill(event)
        ? this.windowManager.getAgentDictationPillState()
        : { lifecycle: "idle", interactive: false, horizontalDirection: "left" };
    });

    ipcMain.handle("resize-agent-dictation-pill-to-content", (event, surfaceHeight = null) => {
      if (!isAgentDictationPill(event)) return { success: false };
      return this.windowManager.resizeAgentDictationPillToContent(surfaceHeight);
    });

    ipcMain.handle("set-agent-dictation-pill-interactivity", (event, interactive) => {
      if (!isAgentDictationPill(event)) return { success: false };
      this.windowManager.setAgentDictationPillInteractivity(Boolean(interactive));
      return { success: true };
    });

    ipcMain.handle("open-calendar-privacy-settings", () => openSystemSettings("calendars"));

    ipcMain.handle("toggle-media-playback", () => {
      const mediaPlayer = require("./mediaPlayer");
      return mediaPlayer.toggleMedia();
    });

    ipcMain.handle("pause-media-playback", () => {
      const mediaPlayer = require("./mediaPlayer");
      return mediaPlayer.pauseMedia();
    });

    ipcMain.handle("resume-media-playback", () => {
      const mediaPlayer = require("./mediaPlayer");
      return mediaPlayer.resumeMedia();
    });

    ipcMain.handle("request-microphone-access", async () => {
      return microphoneAccess.requestMicrophoneAccess(systemPreferences);
    });

    ipcMain.handle("check-microphone-access", () => {
      return microphoneAccess.readMicrophoneAccess(systemPreferences);
    });

    const buildSystemAudioAccess = (partial = {}) => ({
      granted: false,
      status: "unsupported",
      mode: "unsupported",
      supportsPersistentGrant: false,
      supportsPersistentPortalGrant: false,
      supportsNativeCapture: false,
      supportsOnboardingGrant: false,
      requiresRuntimeSharePrompt: false,
      strategy: "unsupported",
      restoreTokenAvailable: false,
      portalVersion: null,
      ...partial,
    });

    const getLinuxSystemAudioAccess = async () => {
      const capability = await this.linuxPortalAudioManager?.getCapability().catch((error) => ({
        available: false,
        supportsPersistentGrant: false,
        supportsPersistentPortalGrant: false,
        supportsSystemAudio: false,
        supportsNativeCapture: false,
        portalVersion: null,
        error: error.message,
      }));
      const available = !!capability?.available;
      const supportsSystemAudio = !!capability?.supportsSystemAudio;
      const supportsNativeCapture = !!capability?.supportsNativeCapture;
      const granted = available && supportsSystemAudio && supportsNativeCapture;
      const helperError =
        typeof capability?.error === "string" &&
        !capability.error.includes("helper binary not found")
          ? capability.error
          : undefined;

      return buildSystemAudioAccess({
        granted,
        status: granted ? "granted" : "unknown",
        mode: granted ? "loopback" : "unsupported",
        supportsNativeCapture,
        strategy: granted ? "pipewire-loopback" : "unsupported",
        portalVersion: capability?.portalVersion ?? null,
        error: helperError,
      });
    };

    // System audio is always capturable on Windows: via the native WASAPI
    // process-loopback helper when available (hears every output device),
    // otherwise via Chromium's default-device loopback in the renderer.
    const getWindowsSystemAudioAccess = async ({ refreshCapability = false } = {}) => {
      const capability = await this.windowsLoopbackAudioManager
        ?.getCapability({ force: refreshCapability })
        .catch(() => ({
          available: false,
        }));
      const helperAvailable = !!capability?.available;

      return buildSystemAudioAccess({
        granted: true,
        status: "granted",
        mode: "loopback",
        supportsNativeCapture: helperAvailable,
        strategy: helperAvailable ? "wasapi-loopback" : "loopback",
      });
    };

    const getSystemAudioAccess = async () => {
      if (process.platform === "win32") {
        return getWindowsSystemAudioAccess();
      }

      if (process.platform === "linux") {
        return getLinuxSystemAudioAccess();
      }

      if (!this.audioTapManager?.isSupported()) {
        return buildSystemAudioAccess();
      }

      const result = this.audioTapManager.checkAccess();
      return buildSystemAudioAccess({
        granted: result.granted,
        status: result.status,
        mode: "native",
        strategy: "native",
      });
    };

    ipcMain.handle("check-system-audio-access", () => getSystemAudioAccess());

    ipcMain.handle("permission-guide-verify-system-audio", async () => {
      if (!this.audioTapManager?.isSupported()) return buildSystemAudioAccess();
      const result = await this.audioTapManager.requestAccess();
      return buildSystemAudioAccess({ ...result, mode: "native", strategy: "native" });
    });

    ipcMain.handle("request-system-audio-access", async () => {
      if (process.platform === "win32") {
        return getWindowsSystemAudioAccess();
      }

      if (process.platform === "linux") {
        return getLinuxSystemAudioAccess();
      }

      if (!this.audioTapManager?.isSupported()) {
        return buildSystemAudioAccess();
      }

      try {
        const result = await this.audioTapManager.requestAccess();
        if (result.granted) {
          return buildSystemAudioAccess({
            granted: true,
            status: "granted",
            mode: "native",
            strategy: "native",
          });
        }
      } catch {
        // Falls through to opening System Settings
      }

      await openSystemSettings("systemAudio");
      const status = this.audioTapManager.getPermissionStatus();
      return buildSystemAudioAccess({
        granted: false,
        status,
        mode: "native",
        strategy: "native",
      });
    });

    ipcMain.handle("auth-clear-session", async (event) => {
      try {
        const tokenState = tokenStore.clear();
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
          await win.webContents.session.clearStorageData({ storages: ["cookies"] });
        }
        return {
          success: tokenState.success,
          tokenState,
          ...(tokenState.success ? {} : { error: "Could not clear persisted bearer token" }),
        };
      } catch (error) {
        debugLogger.error("Failed to clear auth session:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("auth-get-token", () => tokenStore.get());
    ipcMain.handle("auth-get-token-state", () => tokenStore.getState());
    ipcMain.handle("auth-set-token", (_event, token, expectedGeneration) => {
      if (typeof token !== "string" || !token) {
        // Surface silent rotation-to-empty so we can spot regressions where the
        // renderer thinks it's persisting a token but the value never lands.
        debugLogger.debug("auth-set-token ignored: empty or non-string token", {
          type: typeof token,
        });
        return {
          success: false,
          code: "AUTH_CONTEXT_UNVALIDATED",
          ...tokenStore.getState(),
        };
      }
      return tokenStore.setIfGeneration(token, expectedGeneration);
    });

    // In production, VITE_* env vars aren't available in the main process because
    // Vite only inlines them into the renderer bundle at build time. Load the
    // runtime-env.json that the Vite build writes to src/dist/ as a fallback.
    const runtimeEnv = (() => {
      const fs = require("fs");
      const envPath = path.join(__dirname, "..", "dist", "runtime-env.json");
      try {
        if (fs.existsSync(envPath)) return JSON.parse(fs.readFileSync(envPath, "utf8"));
      } catch {}
      return {};
    })();

    const getApiUrl = () =>
      process.env.OPENWHISPR_API_URL ||
      process.env.VITE_OPENWHISPR_API_URL ||
      runtimeEnv.VITE_OPENWHISPR_API_URL ||
      "";

    const getAuthUrl = () =>
      process.env.AUTH_URL ||
      process.env.VITE_AUTH_URL ||
      runtimeEnv.VITE_AUTH_URL ||
      "https://auth.openwhispr.com";

    const getSessionCookiesFromWindow = async (win) => {
      const scopedUrls = [getAuthUrl(), getApiUrl()].filter(Boolean);
      const cookiesByName = new Map();

      for (const url of scopedUrls) {
        try {
          const scopedCookies = await win.webContents.session.cookies.get({ url });
          for (const cookie of scopedCookies) {
            if (!cookiesByName.has(cookie.name)) {
              cookiesByName.set(cookie.name, cookie.value);
            }
          }
        } catch (error) {
          debugLogger.warn("Failed to read scoped auth cookies", {
            url,
            error: error.message,
          });
        }
      }

      // Fallback for older sessions where cookies are not URL-scoped as expected.
      if (cookiesByName.size === 0) {
        const allCookies = await win.webContents.session.cookies.get({});
        for (const cookie of allCookies) {
          if (!cookiesByName.has(cookie.name)) {
            cookiesByName.set(cookie.name, cookie.value);
          }
        }
      }

      const cookieHeader = [...cookiesByName.entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");

      debugLogger.debug(
        "Resolved auth cookies for cloud request",
        {
          cookieCount: cookiesByName.size,
          scopedUrls,
        },
        "auth"
      );

      return cookieHeader;
    };

    // Bearer auth is preferred. Cookie fallback covers the brief window before
    // main.js's startup migration bridge runs (or if it failed for this user).
    const getAuthHeaderFromWindow = async (win) => {
      const token = tokenStore.get();
      if (token) return { Authorization: `Bearer ${token}` };
      const cookieHeader = win ? await getSessionCookiesFromWindow(win) : "";
      return cookieHeader ? { Cookie: cookieHeader } : {};
    };

    const getAuthHeader = async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      return getAuthHeaderFromWindow(win);
    };

    // Honors system proxy via Electron's net stack. useSessionCookies:false so
    // Electron doesn't auto-attach jar cookies on top of our explicit headers.
    const proxyFetch = (url, init = {}) => net.fetch(url, { ...init, useSessionCookies: false });
    const withPolicyHeaders = (headers) => withPolicyRequestHeaders(headers, appVersion);
    const handleCloudApiRequest = createCloudApiRequestHandler({
      getApiUrl,
      getAppVersion: () => appVersion,
      proxyFetch,
      tokenStore,
      logger: debugLogger,
    });
    const workspacePolicyManager = createWorkspacePolicyManager({
      cachePath: path.join(getAppDataDirectory(), "workspace-policy.json"),
      getApiUrl,
      getAppVersion: () => appVersion,
      proxyFetch,
      tokenStore,
      broadcast: (snapshot) => broadcastToWindows("workspace-policy-changed", snapshot),
      logger: debugLogger,
    });
    require("./nimiBusinessAI").configure(async () => {
      const state = tokenStore.getState();
      const accountId = this.databaseManager.activeAccountId;
      if (!state.token)
        return accountId == null ? { success: true, managed: false, status: "guest" } : null;
      const scope = accountScopeBinding.resolveActiveAccountScope({
        ...state,
        binding: accountScopeBinding.read(),
      });
      if (!scope || scope.accountId !== accountId) return null;
      const policy = await workspacePolicyManager.getPolicy({
        accountId: scope.accountId,
        expectedAuthGeneration: state.generation,
        authHeaders: { Authorization: `Bearer ${state.token}` },
      });
      return this.databaseManager.activeAccountId === accountId ? policy : null;
    });
    if (this.connectorManager) {
      registerConnectorIpc({
        ipcMain,
        manager: this.connectorManager,
        getPolicyState: createConnectorPolicyResolver({
          getAuthHeader: createConnectorAuthLookup({
            hasBearerToken: () => Boolean(tokenStore.get()),
            windowFor: (event) => BrowserWindow.fromWebContents(event.sender),
            authHeaderFor: getAuthHeaderFromWindow,
          }),
          getPolicy: (options) => workspacePolicyManager.getPolicy(options),
          peekPolicy: (options) => workspacePolicyManager.peekPolicy(options),
          getAuthGeneration: () => tokenStore.getState().generation,
        }),
        // The account bound to the credential in use, the same binding
        // get-active-account-scope serves (not the separately synced
        // database scope, which lags a sign-in or account switch).
        getAccountScope: () =>
          accountScopeBinding.resolveActiveAccountScope({
            ...tokenStore.getState(),
            binding: accountScopeBinding.read(),
          }),
        findContacts: (query) =>
          searchContacts(this.databaseManager.getContactLookupSources(), query),
        noteAttendees: createNoteAttendeesLookup({
          getContactLookupSources: () => this.databaseManager.getContactLookupSources(),
          getCalendarEventById: (id) => this.databaseManager.getCalendarEventById(id),
          getSpeakerMappings: (noteId) => this.databaseManager.getSpeakerMappings(noteId),
          getSpeakerProfiles: () => this.databaseManager.getSpeakerProfiles(),
          getGmailAddress: async () =>
            (await this.connectorManager.connectorStatus("gmail"))?.accountLabel ?? null,
        }),
      });
    }
    this.enterpriseIdentityManager = createEnterpriseIdentityManager({
      cachePath: path.join(getAppDataDirectory(), "managed-enterprise-config.json"),
      getApiUrl,
      getAppVersion: () => appVersion,
      proxyFetch,
      tokenStore,
      broadcast: (snapshot) => broadcastToWindows("managed-enterprise-config-changed", snapshot),
      logger: debugLogger,
    });

    ipcMain.handle("cloud-health-check", async () => {
      const apiUrl = getApiUrl();
      if (!apiUrl) {
        return {
          ok: false,
          code: "NO_API_URL",
          messageKey: "streaming.errors.cloudUnreachable.generic",
        };
      }
      const url = `${apiUrl}/api/health`;
      try {
        const res = await proxyFetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(3000),
        });
        return { ok: res.ok, status: res.status };
      } catch (err) {
        const classified = classifyAndLog(err, url);
        if (classified.isNetworkError) {
          return { ok: false, code: classified.code, messageKey: classified.messageKey };
        }
        return {
          ok: false,
          code: "UNKNOWN",
          messageKey: "streaming.errors.cloudUnreachable.generic",
        };
      }
    });

    let meetingTranscriptionStartInProgress = false;
    const getMeetingSystemAudioCapabilityMode = () => {
      if (this.audioTapManager?.isSupported()) return "native";
      if (process.platform === "win32") return "loopback";
      if (process.platform === "linux") return "loopback";
      return "unsupported";
    };

    const getMeetingSystemAudioMode = () => getMeetingSystemAudioCapabilityMode();

    const getMeetingSystemAudioPlan = async ({ refreshWindowsCapability = false } = {}) => {
      const mode = getMeetingSystemAudioMode();
      if (mode === "unsupported") {
        return { mode, strategy: "unsupported" };
      }

      if (mode === "native") {
        return { mode, strategy: "native" };
      }

      if (process.platform === "linux") {
        const linuxAccess = await getLinuxSystemAudioAccess();
        return {
          mode: linuxAccess.mode,
          strategy: linuxAccess.strategy || "unsupported",
        };
      }

      if (process.platform === "win32") {
        const windowsAccess = await getWindowsSystemAudioAccess({
          refreshCapability: refreshWindowsCapability,
        });
        return { mode: windowsAccess.mode, strategy: windowsAccess.strategy };
      }

      // Unreachable today (loopback implies win32 or linux, both handled
      // above), but callers destructure the result, so never return undefined.
      return { mode, strategy: "unsupported" };
    };

    const hasNativeMeetingSystemAudio = () => getMeetingSystemAudioMode() === "native";

    const MEETING_MIC_REFERENCE_ALIGNMENT_MS = 320;

    const MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS = 45000;
    const MEETING_SYSTEM_AUDIO_TICK_MS = 2000;

    let meetingSystemAudioSilenceTimer = null;
    let meetingSystemAudioTicker = null;
    let meetingSystemAudioWatchdogWin = null;

    const meetingSystemAudioWatchdog = createMeetingSystemAudioWatchdog({
      onResumed: () => {
        const win = meetingSystemAudioWatchdogWin;
        if (win && !win.isDestroyed()) {
          win.webContents.send("meeting-system-audio-resumed");
        }
      },
      onInterrupted: (payload) => {
        // debugLogger.error flattens its arguments into one string, dropping
        // both the meta and the scope, so the give-up event would vanish from a
        // log filtered on "meeting", the one filter used to triage this bug.
        if (payload.recovering) {
          debugLogger.warn("Meeting system audio interrupted, restarting", payload, "meeting");
        } else {
          debugLogger.warn("Meeting system audio capture gave up", payload, "meeting");
        }
        const win = meetingSystemAudioWatchdogWin;
        if (win && !win.isDestroyed()) {
          win.webContents.send("meeting-system-audio-interrupted", payload);
        }
      },
    });
    const meetingEchoLeakDetector = new MeetingEchoLeakDetector();
    const meetingSystemAudioHandover = createMeetingSystemAudioHandover();
    let meetingConnectionOptions = null;
    let meetingConnectionWin = null;
    let meetingSessionId = null;
    let meetingOwnerId = null;
    let meetingNoteId = null;
    let meetingNimi = null;
    let meetingSegments = [];
    let meetingSystemAudioHeard = false;
    let meetingPendingMicChunks = [];
    let meetingAecEnabled = false;

    const notifyMeetingNote = (note) => {
      try {
        Promise.resolve(this._asyncMirrorWrite(note)).catch((error) =>
          debugLogger.warn("Meeting file mirror notification failed", { error: error.message })
        );
      } catch (error) {
        debugLogger.warn("Meeting file mirror notification failed", { error: error.message });
      }
      try {
        broadcastToWindows("note-updated", note);
      } catch (error) {
        debugLogger.warn("Meeting note notification failed", { error: error.message });
      }
    };

    const dispatchMeetingAudioBuffer = (buffer, source, synthetic = false, capturedAt = null) => {
      if (!meetingNimi) return;
      try {
        meetingNimi.work.push(source, buffer, capturedAt);
      } catch (error) {
        if (meetingConnectionWin && !meetingConnectionWin.isDestroyed())
          meetingConnectionWin.webContents.send(
            "meeting-transcription-fatal-error",
            ipcErrorFields(error)
          );
        void meetingTranscriptionLifecycle.stopSession(meetingSessionId, { cancel: true });
      }
    };

    const stopMeetingAec = async () => {
      meetingAecEnabled = false;
      if (this.meetingAecManager) {
        await this.meetingAecManager.stop().catch(() => {});
      }
    };

    const startMeetingAec = async (systemAudioMode) => {
      meetingAecEnabled = false;
      if (meetingConnectionOptions.aecEnabled !== true) {
        return false;
      }
      if (systemAudioMode === "unsupported" || !this.meetingAecManager?.isAvailable()) {
        return false;
      }

      const started = await this.meetingAecManager
        .start({
          onMicChunk: (chunk) => {
            dispatchMeetingAudioBuffer(chunk, "mic");
          },
          onError: (error) => {
            debugLogger.warn("Meeting AEC helper disabled", { error: error.message }, "meeting");
            meetingAecEnabled = false;
            void this.meetingAecManager.stop().catch(() => {});
          },
          onWarning: (warning) => {
            debugLogger.debug("Meeting AEC helper warning", warning, "meeting");
          },
        })
        .catch((error) => {
          debugLogger.warn("Meeting AEC helper start failed", { error: error.message }, "meeting");
          return false;
        });

      meetingAecEnabled = !!started;
      if (meetingAecEnabled) {
        debugLogger.info("Meeting AEC helper started", { systemAudioMode }, "meeting");
      }
      return meetingAecEnabled;
    };

    const flushPendingMeetingMicChunks = (force = false) => {
      if (!meetingPendingMicChunks.length) {
        return;
      }

      const now = Date.now();
      while (meetingPendingMicChunks.length > 0) {
        const next = meetingPendingMicChunks[0];
        if (!force && now - next.queuedAt < MEETING_MIC_REFERENCE_ALIGNMENT_MS) {
          break;
        }

        meetingPendingMicChunks.shift();
        const analysis = meetingEchoLeakDetector.analyzeMicChunk(next.buffer);
        if (next.analysisOnly) {
          continue;
        }
        if (analysis?.shouldMute && !meetingAecEnabled) {
          dispatchMeetingAudioBuffer(Buffer.alloc(next.buffer.length), "mic");
          continue;
        }

        dispatchMeetingAudioBuffer(next.buffer, "mic");
      }
    };

    const processMeetingMicWithAec = (buffer) => {
      if (!meetingAecEnabled) {
        return false;
      }

      const sent = this.meetingAecManager?.processMicBuffer(buffer);
      if (sent) {
        meetingPendingMicChunks.push({
          buffer,
          queuedAt: Date.now(),
          analysisOnly: true,
        });
        flushPendingMeetingMicChunks();
        return true;
      }

      meetingAecEnabled = false;
      return false;
    };

    let dictationPreviewSessionActive = false;
    let dictationPreviewDisplay = true;
    let dictationPreviewOperation = Promise.resolve();

    const queueDictationPreviewOperation = (operation) => {
      const result = dictationPreviewOperation.catch(() => {}).then(operation);
      dictationPreviewOperation = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    };

    const resetDictationPreviewState = ({ preserveSession = false } = {}) => {
      if (!preserveSession) dictationPreviewSessionActive = false;
      dictationPreviewDisplay = true;
    };

    const clearMeetingSystemAudioSilenceTimer = () => {
      if (meetingSystemAudioSilenceTimer) {
        clearTimeout(meetingSystemAudioSilenceTimer);
        meetingSystemAudioSilenceTimer = null;
      }
    };

    // One-shot: system capture is active but nothing audible has arrived by the
    // deadline, so tell the meeting window the remote side may be missing from
    // the transcript. Audio arriving before the deadline cancels it outright;
    // the toast itself is time-boxed by the renderer, not by later audio.
    const armMeetingSystemAudioSilenceTimer = (win, systemAudioStrategy) => {
      clearMeetingSystemAudioSilenceTimer();
      meetingSystemAudioSilenceTimer = setTimeout(() => {
        meetingSystemAudioSilenceTimer = null;
        if (meetingSystemAudioHeard) return;
        debugLogger.debug(
          "Meeting system audio still silent past warning window",
          { systemAudioStrategy, timeoutMs: MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS },
          "meeting"
        );
        if (win && !win.isDestroyed()) {
          win.webContents.send("meeting-system-audio-silent", { systemAudioStrategy });
        }
      }, MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS);
    };

    const clearMeetingSystemAudioTicker = () => {
      if (meetingSystemAudioTicker) {
        clearInterval(meetingSystemAudioTicker);
        meetingSystemAudioTicker = null;
      }
    };

    const stopMeetingSystemAudioWatchdog = () => {
      clearMeetingSystemAudioTicker();
      // Detaches the capture too, which strands any restart still in flight.
      meetingSystemAudioWatchdog.stop();
      meetingSystemAudioWatchdogWin = null;
    };

    // Rolling counterpart to the one-shot warning above, which only covers a
    // session that never produced audio and stops watching once any arrives.
    const startMeetingSystemAudioWatchdog = (win, systemAudioStrategy) => {
      // Deliberately not stopMeetingSystemAudioWatchdog(): capture is already
      // running and attached by this point, and detaching it here would leave a
      // watchdog that reports stalls it cannot recover from.
      clearMeetingSystemAudioTicker();
      meetingSystemAudioWatchdogWin = win;
      meetingSystemAudioWatchdog.start({
        systemAudioStrategy,
        // Only the macOS tap delivers a chunk every period regardless of what
        // is playing; a gap from the loopback helpers proves nothing.
        watchesDelivery: systemAudioStrategy === "native",
      });
      meetingSystemAudioTicker = setInterval(
        () => meetingSystemAudioWatchdog.tick(),
        MEETING_SYSTEM_AUDIO_TICK_MS
      );
    };

    const retireMeetingCapture = async () => {
      clearMeetingSystemAudioSilenceTimer();
      stopMeetingSystemAudioWatchdog();
      await this.audioTapManager?.stop().catch(() => {});
      await this.linuxPortalAudioManager?.stop().catch(() => {});
      await this.windowsLoopbackAudioManager?.stop().catch(() => {});
      flushPendingMeetingMicChunks(true);
      await stopMeetingAec();
    };
    const rollbackMeetingTranscriptionStart = async () => {
      await retireMeetingCapture();
      await meetingNimi?.close();
      meetingNimi = null;
      meetingSessionId = null;
      meetingOwnerId = null;
      meetingConnectionOptions = null;
      meetingPendingMicChunks = [];
      this._activeMeetingNoteId = null;
      this.activeMeetingSpeakerConfig = null;
    };

    // Capture preparation does not open provider sockets or select a model.
    ipcMain.handle("meeting-transcription-prepare", async () => {
      try {
        await getMeetingSystemAudioPlan();
        return { success: true };
      } catch (error) {
        return toPolicyFailure(error);
      }
    });
    const startMeetingTranscription = async (event, options = {}) => {
      if (meetingTranscriptionStartInProgress || meetingNimi)
        return { success: false, error: "Operation in progress" };
      meetingTranscriptionStartInProgress = true;
      const recordingSessionId = options.sessionId;
      meetingSessionId = recordingSessionId;
      meetingOwnerId = event.sender.id;
      meetingConnectionOptions = options;
      meetingConnectionWin = BrowserWindow.fromWebContents(event.sender);
      meetingSegments = [];
      meetingPendingMicChunks = [];
      meetingSystemAudioHeard = false;
      meetingSystemAudioHandover.reset();
      meetingEchoLeakDetector.reset();
      this._activeMeetingNoteId = options.noteId ?? null;
      const canNotify = () =>
        !event.sender.isDestroyed() && meetingSessionId === recordingSessionId;
      try {
        const note = this.databaseManager.getNote(options.noteId);
        if (!Number.isInteger(options.noteId) || !note || note.deleted_at)
          throw new Error("The recording note is unavailable");
        if (note.transcript && !note.transcript.startsWith("["))
          throw new Error(
            "The existing recording transcript needs one-time conversion before recording again"
          );
        if (
          typeof (options.prompt || "") !== "string" ||
          Buffer.byteLength(options.prompt || "", "utf8") > 4 * 1024
        )
          throw new Error("The transcription dictionary prompt exceeds Nimi's 4 KiB input budget");
        meetingNoteId = note.id;
        meetingNimi = require("./nimiAI").openMeetingWork(
          {
            event,
            payload: {
              requestId: recordingSessionId,
              language: options.language || "",
              prompt: options.prompt || "",
              diarization: options.diarization === true,
            },
          },
          {
            getDiarization: () =>
              this.activeMeetingSpeakerConfig?.enabled ?? options.diarization === true,
            getMaxSpeakers: () =>
              this.activeMeetingSpeakerConfig?.expectedCount ??
              this._resolveNoteExpectedSpeakerCount(note),
            onResult: (chunk) => {
              if (meetingNimi?.cancelRequested) return;
              const segments = require("./nimiMeetingTranscript").projectMeetingTranscript(
                chunk,
                recordingSessionId
              );
              if (segments.length) {
                const saved = this.databaseManager.saveMeetingNoteResult(
                  meetingNoteId,
                  segments,
                  null,
                  chunk.speakerRepresentations
                );
                const persisted = new Map(
                  JSON.parse(saved.note.transcript).map((segment) => [segment.id, segment])
                );
                for (let index = 0; index < segments.length; index++)
                  segments[index] = persisted.get(segments[index].id);
                notifyMeetingNote(saved.note);
              }
              meetingSegments.push(...segments);
              if (canNotify())
                for (const segment of segments)
                  event.sender.send("meeting-transcription-segment", {
                    ...segment,
                    type: "final",
                    sessionId: recordingSessionId,
                  });
            },
            onError: (error) => {
              if (meetingNimi?.cancelRequested) return;
              if (canNotify())
                event.sender.send("meeting-transcription-fatal-error", ipcErrorFields(error));
              void meetingTranscriptionLifecycle.stopSession(recordingSessionId);
            },
            onAbort: () => {
              void meetingTranscriptionLifecycle.stopSession(recordingSessionId, { cancel: true });
            },
          }
        );
        const current = meetingNimi;
        current.captureSaved = new Promise((resolve, reject) => {
          current.resolveCaptureSaved = resolve;
          current.rejectCaptureSaved = reject;
        });
        current.captureSaved.catch(() => {});
        let { mode: systemAudioMode, strategy: systemAudioStrategy } =
          await getMeetingSystemAudioPlan({ refreshWindowsCapability: true });
        meetingNimi.assertCurrent();
        await startMeetingAec(systemAudioMode);
        ({ systemAudioMode, systemAudioStrategy } = await startMeetingSystemAudio(
          event,
          systemAudioMode,
          systemAudioStrategy,
          "during Nimi meeting capture"
        ));
        meetingNimi.assertCurrent();
        await this.meetingDetectionEngine?.beginRecordingSession({
          sessionId: recordingSessionId,
          autoEndEligible: options.autoEndEligible === true,
          ownerWebContents: event.sender,
          noteId: options.noteId ?? null,
          systemAudioAvailable: false,
        });
        this.meetingDetectionEngine?.setUserRecording(true);
        if (systemAudioStrategy !== "unsupported") {
          armMeetingSystemAudioSilenceTimer(meetingConnectionWin, systemAudioStrategy);
          startMeetingSystemAudioWatchdog(meetingConnectionWin, systemAudioStrategy);
        }
        return {
          success: true,
          sessionId: recordingSessionId,
          systemAudioMode,
          systemAudioStrategy,
        };
      } catch (error) {
        await rollbackMeetingTranscriptionStart();
        this.meetingDetectionEngine?.endRecordingSession(recordingSessionId);
        this.meetingDetectionEngine?.setUserRecording(false);
        return toPolicyFailure(error);
      } finally {
        meetingTranscriptionStartInProgress = false;
      }
    };

    const sendMeetingAudio = (audioBuffer, source, synthetic = false, capturedAt = null) => {
      if (!meetingNimi) return;
      const buffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
      if (!synthetic) this.meetingDetectionEngine?.recordMeetingAudioChunk(source, buffer);
      if (source === "system") {
        if (!synthetic) {
          meetingEchoLeakDetector.recordSystemChunk(buffer, Date.now());
          if (meetingAecEnabled && !this.meetingAecManager?.processSystemBuffer(buffer))
            meetingAecEnabled = false;
          flushPendingMeetingMicChunks();
          const { rms, peak } = computeChunkStats(buffer);
          const audible = rms >= MEETING_MIC_SILENCE_RMS || peak >= MEETING_MIC_SILENCE_PEAK;
          meetingSystemAudioWatchdog.recordChunk(audible);
          if (audible) meetingSystemAudioHeard = true;
        }
        dispatchMeetingAudioBuffer(buffer, source, synthetic, capturedAt);
        return;
      }
      if (processMeetingMicWithAec(buffer)) return;
      if (!hasNativeMeetingSystemAudio()) {
        const analysis = meetingEchoLeakDetector.analyzeMicChunk(buffer);
        dispatchMeetingAudioBuffer(
          analysis?.shouldMute && !meetingAecEnabled ? Buffer.alloc(buffer.length) : buffer,
          source,
          synthetic,
          capturedAt
        );
      } else {
        meetingPendingMicChunks.push({ buffer, queuedAt: Date.now() });
        flushPendingMeetingMicChunks();
      }
    };

    // The Windows helper reports capture_silent when its own stream is silent
    // while a render endpoint is playing, which activation success cannot
    // detect. Start renderer loopback beside it; the handover decides whether
    // it takes the channel.
    const degradeMeetingSystemAudioToLoopback = (event) => {
      if (!meetingSystemAudioHandover.begin()) return;
      debugLogger.warn(
        "Windows system audio helper captured only silence, starting renderer loopback beside it",
        {},
        "meeting"
      );
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) {
        win.webContents.send("meeting-system-audio-degraded");
      }
    };

    const completeMeetingSystemAudioHandover = () => {
      debugLogger.info("Renderer loopback took over system audio capture", {}, "meeting");
      meetingSystemAudioWatchdog.detachCapture();
      void this.windowsLoopbackAudioManager?.stop().catch(() => {});
    };

    const startManagedMeetingSystemAudio = (event, manager, warningLabel, onWarningCode) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const timeline =
        manager === this.audioTapManager ? require("./meetingAudioTimeline")() : null;
      let captureStarted = false;
      const startCapture = () => {
        if (captureStarted) timeline?.markRestart();
        captureStarted = true;
        return manager.start({
          onChunk: (chunk) => {
            if (!meetingSystemAudioHandover.acceptNativeChunk(chunk)) return;
            if (timeline) {
              timeline.write(chunk, (buffer, synthetic, capturedAt) =>
                sendMeetingAudio(buffer, "system", synthetic, capturedAt)
              );
            } else {
              sendMeetingAudio(chunk, "system");
            }
          },
          onError: (error) => {
            if (win && !win.isDestroyed()) {
              win.webContents.send("meeting-transcription-error", error.message);
            }
          },
          onWarning: (warning) => {
            debugLogger.warn(
              warningLabel,
              { code: warning.code, message: warning.message },
              "meeting"
            );
            onWarningCode?.(warning.code);
          },
        });
      };

      // Keep the native sample timeline through recovery, including the stall
      // before detection and the helper restart. New sessions get a new timeline.
      meetingSystemAudioWatchdog.attachCapture({
        stop: () => manager.stop(),
        start: startCapture,
      });

      return startCapture();
    };

    const fallBackToMicOnly = async () => {
      stopMeetingSystemAudioWatchdog();
    };

    const startMeetingSystemAudio = async (
      event,
      systemAudioMode,
      systemAudioStrategy,
      context
    ) => {
      if (systemAudioMode === "native") {
        try {
          await startManagedMeetingSystemAudio(
            event,
            this.audioTapManager,
            "macOS system audio tap warning",
            (code) => {
              // The tap is pinned to the devices it saw at creation, so a route
              // change can strand it. Restart before the stall window elapses.
              if (code === "device_invalidated") {
                meetingSystemAudioWatchdog.reportDeviceInvalidated();
              }
            }
          );
          return { systemAudioMode, systemAudioStrategy };
        } catch (error) {
          debugLogger.warn(
            `Native system audio tap failed ${context}, falling back to mic-only`,
            { error: error.message },
            "meeting"
          );
          await fallBackToMicOnly("native");
          return { systemAudioMode: "unsupported", systemAudioStrategy: "unsupported" };
        }
      }

      if (systemAudioStrategy === "wasapi-loopback") {
        try {
          await startManagedMeetingSystemAudio(
            event,
            this.windowsLoopbackAudioManager,
            "Windows system audio warning",
            (code) => {
              if (code === "capture_silent") {
                degradeMeetingSystemAudioToLoopback(event);
              }
            }
          );
          return { systemAudioMode, systemAudioStrategy };
        } catch (error) {
          debugLogger.warn(
            `Windows system audio helper failed ${context}, falling back to renderer loopback`,
            { error: error.message },
            "meeting"
          );
          // The renderer captures via Chromium's display-media loopback when
          // it sees the downgraded strategy in the start result.
          return { systemAudioMode, systemAudioStrategy: "loopback" };
        }
      }

      if (systemAudioStrategy !== "pipewire-loopback") {
        return { systemAudioMode, systemAudioStrategy };
      }

      try {
        await startManagedMeetingSystemAudio(
          event,
          this.linuxPortalAudioManager,
          "Linux PipeWire system audio warning"
        );
        return { systemAudioMode, systemAudioStrategy };
      } catch (error) {
        debugLogger.warn(
          `Linux PipeWire helper failed ${context}, falling back to mic-only`,
          { error: error.message },
          "meeting"
        );
        await fallBackToMicOnly("PipeWire");
        return { systemAudioMode: "unsupported", systemAudioStrategy: "unsupported" };
      }
    };

    ipcMain.on("meeting-transcription-send", (event, audioBuffer, source, sessionId) => {
      if (event.sender.id !== meetingOwnerId || sessionId !== meetingSessionId || !meetingNimi)
        return;
      if (!["mic", "system"].includes(source)) return;
      const buffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
      if (!buffer.length || buffer.length > 2 * 1024 * 1024 || buffer.length % 2) return;
      if (source === "system") {
        const route = meetingSystemAudioHandover.acceptRendererChunk(buffer);
        if (route === "drop") return;
        if (route === "takeover") completeMeetingSystemAudioHandover();
      }
      sendMeetingAudio(buffer, source);
    });

    const commitMeetingCapture = async (current, segments, sessionId, status) => {
      current.assertCurrent();
      const appRoot = require("./appData").getAppDataDirectory();
      const retained =
        current.retainedMedia ?? (await current.work.retain(path.join(appRoot, "imports")));
      current.retainedMedia = retained;
      let committed = false;
      try {
        current.assertCurrent();
        if (retained.tracks.length) {
          const tracks = retained.tracks.map((track) => ({
            ...track,
            path: path.relative(appRoot, track.path).split(path.sep).join("/"),
          }));
          const saved = this.databaseManager.saveMeetingNoteResult(meetingNoteId, segments, {
            sessionId,
            ...status,
            originalPath: tracks[0].path,
            audioPath: tracks[0].path,
            tracks,
          });
          committed = true;
          current.mediaCommitted = true;
          notifyMeetingNote(saved.note);
        }
      } finally {
        if (!committed && !current.mediaCommitted)
          require("node:fs").rmSync(retained.directory, { recursive: true, force: true });
      }
    };

    const commitMeetingCancellation = (current, sessionId) => {
      current.cancelCommit ??= commitMeetingCapture(current, meetingSegments, sessionId, {
        status: "canceled",
      });
      return current.cancelCommit;
    };

    const canceledMeetingResult = async (current, sessionId) => {
      try {
        await commitMeetingCancellation(current, sessionId);
        return {
          success: false,
          reason: "canceled",
          mediaRetained: current.mediaCommitted === true,
        };
      } catch (error) {
        return { success: false, error: error.message, ...ipcErrorFields(error) };
      }
    };

    const stopMeetingTranscription = async (expectedSessionId, { cancel = false } = {}) => {
      if (meetingSessionId !== expectedSessionId || !meetingNimi)
        return { success: false, reason: "stale-session" };
      const current = meetingNimi;
      current.finalizing = true;
      this.meetingDetectionEngine?.endRecordingSession(expectedSessionId);
      this.meetingDetectionEngine?.setUserRecording(false);
      try {
        if (cancel) await current.close();
        await retireMeetingCapture();
        if (cancel) return { success: false, reason: "canceled" };
        // Capture is immutable now. Preserve it before waiting for model tails;
        // an explicit cancellation can then retire inference without losing audio.
        await commitMeetingCapture(current, meetingSegments, expectedSessionId, {
          status: "processing",
        });
        current.resolveCaptureSaved();
        if (current.cancelRequested) return await canceledMeetingResult(current, expectedSessionId);
        const recognition = await current.work.finish();
        if (current.cancelRequested) return await canceledMeetingResult(current, expectedSessionId);
        current.assertCurrent();
        const segments = [...meetingSegments].sort((a, b) => a.timestamp - b.timestamp);
        await commitMeetingCapture(current, segments, expectedSessionId, { status: "completed" });
        return {
          success: true,
          transcript: recognition
            .filter((c) => c.transcript.status === "transcribed")
            .sort(
              (a, b) =>
                a.anchorMs +
                (a.startFrame / a.sampleRate) * 1000 -
                (b.anchorMs + (b.startFrame / b.sampleRate) * 1000)
            )
            .map((c) => c.transcript.text)
            .join("\n"),
          segments,
          recognition,
          sessionId: expectedSessionId,
        };
      } catch (error) {
        current.rejectCaptureSaved?.(error);
        if (current.cancelRequested) return await canceledMeetingResult(current, expectedSessionId);
        // A failed inference is not a successful complete transcript. Keep its
        // actual capture for explicit recovery while the original scope lives.
        try {
          await Promise.allSettled([...current.work.pending]);
          current.assertCurrent();
          if (!cancel)
            await commitMeetingCapture(current, meetingSegments, expectedSessionId, {
              status: "failed",
              error: error.message,
            });
        } catch (retentionError) {
          debugLogger.warn("Failed meeting capture could not be retained", {
            error: retentionError.message,
          });
        }
        return { success: false, error: error.message, ...ipcErrorFields(error) };
      } finally {
        current.rejectCaptureSaved?.(new Error("Meeting capture retired"));
        await current.close();
        if (meetingNimi === current) {
          meetingNimi = null;
          meetingSessionId = null;
          meetingOwnerId = null;
          meetingNoteId = null;
          meetingPendingMicChunks = [];
          meetingConnectionOptions = null;
          this._activeMeetingNoteId = null;
        }
      }
    };

    const meetingTranscriptionLifecycle = createMeetingTranscriptionLifecycle({
      start: ({ sessionId, ownerWebContents, options }) =>
        startMeetingTranscription({ sender: ownerWebContents }, { ...options, sessionId }),
      stop: (sessionId, disposition) => stopMeetingTranscription(sessionId, disposition),
      cancel: (sessionId) => {
        if (meetingSessionId === sessionId)
          void meetingNimi
            ?.close()
            .catch((error) =>
              debugLogger.warn("Meeting canceled work cleanup failed", { error: error.message })
            );
      },
      onError: (error, sessionId) => {
        debugLogger.error(
          "Meeting transcription owner-loss teardown failed",
          { error: error?.message, sessionId },
          "meeting"
        );
      },
    });

    ipcMain.handle("meeting-transcription-start", (event, options = {}) => {
      const sessionId =
        typeof options.sessionId === "string" && options.sessionId.length > 0
          ? options.sessionId
          : crypto.randomUUID();
      return meetingTranscriptionLifecycle.startSession({
        sessionId,
        ownerWebContents: event.sender,
        options,
      });
    });

    ipcMain.handle("meeting-transcription-stop", (_event, expectedSessionId) =>
      meetingTranscriptionLifecycle.stopSession(expectedSessionId)
    );

    ipcMain.handle("meeting-transcription-cancel", async (event, expectedSessionId) => {
      const current = meetingNimi;
      if (!current || expectedSessionId !== meetingSessionId)
        return { success: false, reason: "stale-session" };
      if (event.sender.id !== meetingOwnerId) return { success: false, reason: "wrong-owner" };
      if (!current.finalizing) return { success: false, reason: "not-finalizing" };
      // Fence publication immediately; finish capture preservation before abort
      // retires the protected scope. Both paths share the same terminal write.
      current.cancelRequested = true;
      const stopped = meetingTranscriptionLifecycle.stopSession(expectedSessionId);
      try {
        await current.captureSaved;
        await commitMeetingCancellation(current, expectedSessionId);
        const cancellation = await current.cancel();
        await current.close();
        await stopped;
        if (cancellation.jobs.some((job) => job.stopOutcome === "unconfirmed"))
          throw Object.assign(new Error("Cancellation was requested, but the model has not confirmed it stopped."), { code: "NIMI_AUDIO_CANCEL_UNCONFIRMED" });
        return { success: true, reason: "cancel-requested", jobs: cancellation.jobs };
      } catch (error) {
        await current.close();
        await stopped;
        return { success: false, error: error.message, ...ipcErrorFields(error) };
      }
    });

    ipcMain.handle(
      "meeting-transcription-set-system-audio-available",
      async (event, sessionId, available) => {
        const updated = await this.meetingDetectionEngine?.setRecordingSystemAudioAvailable(
          sessionId,
          available === true,
          event.sender
        );
        return updated === true ? { success: true } : { success: false, reason: "stale-session" };
      }
    );

    ipcMain.handle("start-dictation-preview", async (_event, { display = true } = {}) =>
      queueDictationPreviewOperation(async () => {
        resetDictationPreviewState();
        dictationPreviewSessionActive = true;
        dictationPreviewDisplay = display;
        if (display) await this.windowManager.showTranscriptionPreview("");
        return { success: true };
      })
    );

    ipcMain.handle("dismiss-dictation-preview", () =>
      queueDictationPreviewOperation(async () => {
        resetDictationPreviewState();
        this.windowManager.hideTranscriptionPreview();
        return { success: true };
      })
    );

    ipcMain.handle("update-dictation-preview", (_event, text) =>
      queueDictationPreviewOperation(async () => {
        if (typeof text !== "string" || !text.trim()) {
          return { success: true };
        }
        if (!dictationPreviewSessionActive) {
          resetDictationPreviewState();
          dictationPreviewSessionActive = true;
          dictationPreviewDisplay = true;
        }
        await this.windowManager.showTranscriptionPreview(text);
        return { success: true };
      })
    );

    ipcMain.handle("complete-dictation-preview", (_event, { text } = {}) =>
      queueDictationPreviewOperation(async () => {
        if (!dictationPreviewSessionActive) {
          return { success: true };
        }
        if (typeof text === "string" && text.trim()) {
          this.windowManager.completeTranscriptionPreview(text);
        } else {
          resetDictationPreviewState();
          this.windowManager.hideTranscriptionPreview();
        }
        return { success: true };
      })
    );

    ipcMain.handle("hide-dictation-preview", () =>
      queueDictationPreviewOperation(async () => {
        resetDictationPreviewState();
        this.windowManager.hideTranscriptionPreview();
        return { success: true };
      })
    );

    ipcMain.handle("stop-dictation-preview", async (_event, options = {}) =>
      queueDictationPreviewOperation(async () => {
        const display = dictationPreviewDisplay;
        resetDictationPreviewState({ preserveSession: display });
        if (display && dictationPreviewSessionActive)
          this.windowManager.holdTranscriptionPreview(options);
        return { success: true, streamed: false, text: "" };
      })
    );

    ipcMain.handle("agent-open-note", async (_event, noteId) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        await this.windowManager.queueNoteNavigation({
          noteId,
          folderId: note?.folder_id ?? null,
        });
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open note from agent:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("agent-web-search", async (event, query, numResults = 5) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

        debugLogger.debug("Agent web search request", { query, numResults }, "cloud-api");

        const response = await proxyFetch(`${apiUrl}/api/agent/web-search`, {
          method: "POST",
          headers: withPolicyHeaders({
            "Content-Type": "application/json",
            ...authHeader,
          }),
          body: JSON.stringify({ query, numResults }),
        });

        if (!response.ok) {
          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          if (response.status === 503) {
            return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
          }

          return toPolicyFailure(
            await readPolicyResponseError(response, `API error: ${response.status}`)
          );
        }

        const data = await response.json();
        return { success: true, ...data };
      } catch (error) {
        debugLogger.error("Agent web search error:", error);
        return toPolicyFailure(error);
      }
    });

    ipcMain.handle(
      "cloud-streaming-usage",
      async (event, text, audioDurationSeconds, opts = {}) => {
        try {
          const apiUrl = getApiUrl();
          if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

          const authHeader = await getAuthHeader(event);
          if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

          const response = await proxyFetch(`${apiUrl}/api/streaming-usage`, {
            method: "POST",
            headers: withPolicyHeaders({
              "Content-Type": "application/json",
              ...authHeader,
            }),
            body: JSON.stringify({
              text,
              audioDurationSeconds,
              sessionId: this.sessionId,
              clientType: "desktop",
              appVersion: appVersion,
              clientVersion: appVersion,
              sttProvider: opts.sttProvider,
              sttModel: opts.sttModel,
              sttProcessingMs: opts.sttProcessingMs,
              sttLanguage: opts.sttLanguage,
              sttDetectedLanguage: opts.sttDetectedLanguage,
              sttDetectedLanguageConfidence: opts.sttDetectedLanguageConfidence,
              sttDetectedLanguageAudioSeconds: opts.sttDetectedLanguageAudioSeconds,
              sttDetectedLanguageStatus: opts.sttDetectedLanguageStatus,
              audioSizeBytes: opts.audioSizeBytes,
              audioFormat: opts.audioFormat,
              clientTotalMs: opts.clientTotalMs,
              sendLogs: opts.sendLogs,
              clientTranscriptionId: opts.clientTranscriptionId,
              localDate: opts.localDate,
              analyticsOccurredAt: opts.analyticsOccurredAt,
              analyticsWordCount: opts.analyticsWordCount,
              analyticsCounterVersion: opts.analyticsCounterVersion,
            }),
          });

          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          if (response.status === 503) {
            return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
          }
          if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
          }

          const data = await response.json();
          return { success: true, ...data };
        } catch (error) {
          debugLogger.error("Cloud streaming usage error", { error: error.message }, "cloud-api");
          return { success: false, error: error.message };
        }
      }
    );

    ipcMain.handle("cloud-usage", async (event) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

        // Never serve entitlement from Chromium's HTTP cache: a cached
        // response can outlive the account that produced it.
        const response = await proxyFetch(`${apiUrl}/api/usage`, {
          headers: authHeader,
          cache: "no-store",
        });

        if (!response.ok) {
          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          if (response.status === 503) {
            return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
          }
          const errorData = await response.json().catch(() => ({}));
          const message = errorData.error || `API error: ${response.status}`;
          debugLogger.error(`Cloud usage fetch error: ${message}`);
          return { success: false, error: message, code: errorData.code };
        }

        const data = await response.json();
        return { success: true, ...data };
      } catch (error) {
        debugLogger.error("Cloud usage fetch error:", error);
        return { success: false, error: error.message };
      }
    });

    const fetchStripeUrl = async (event, endpoint, errorPrefix, body) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

        const headers = { ...authHeader };
        const fetchOpts = { method: "POST", headers };
        if (body) {
          headers["Content-Type"] = "application/json";
          fetchOpts.body = JSON.stringify(body);
        }

        const response = await proxyFetch(`${apiUrl}${endpoint}`, fetchOpts);

        if (!response.ok) {
          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          if (response.status === 503) {
            return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
          }
          const errorData = await response.json().catch(() => ({}));
          const message = errorData.error || `API error: ${response.status}`;
          debugLogger.error(`${errorPrefix}: ${message}`);
          return { success: false, error: message, code: errorData.code };
        }

        const data = await response.json();
        return { success: true, url: data.url };
      } catch (error) {
        debugLogger.error(`${errorPrefix}: ${error.message}`);
        return { success: false, error: error.message };
      }
    };

    ipcMain.handle("cloud-checkout", (event, opts) =>
      fetchStripeUrl(event, "/api/stripe/checkout", "Cloud checkout error", opts || undefined)
    );

    ipcMain.handle("cloud-billing-portal", (event) =>
      fetchStripeUrl(event, "/api/stripe/portal", "Cloud billing portal error")
    );

    ipcMain.handle("cloud-switch-plan", async (event, opts) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

        const response = await proxyFetch(`${apiUrl}/api/stripe/switch-plan`, {
          method: "POST",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify(opts),
        });

        if (response.status === 401) {
          return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
        }
        if (response.status === 503) {
          return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
        }

        const data = await response.json();
        if (!response.ok) {
          return { success: false, error: data.error || "Failed to switch plan" };
        }
        return data;
      } catch (error) {
        debugLogger.error(`Cloud switch plan error: ${error.message}`);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cloud-preview-switch", async (event, opts) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("OpenWhispr API URL not configured");

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) throw new Error("Not authenticated");

        const response = await proxyFetch(`${apiUrl}/api/stripe/preview-switch`, {
          method: "POST",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify(opts),
        });

        if (response.status === 401) {
          return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
        }
        if (response.status === 503) {
          return { success: false, error: "Request timed out", code: "SERVER_ERROR" };
        }

        const data = await response.json();
        if (!response.ok) {
          return { success: false, error: data.error || "Failed to preview plan change" };
        }
        return { success: true, ...data };
      } catch (error) {
        debugLogger.error(`Cloud preview switch error: ${error.message}`);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cloud-api-request", (_event, opts) => handleCloudApiRequest(opts));

    ipcMain.handle("get-workspace-policy", async (event, accountId, expectedAuthGeneration) => {
      const authHeaders = await getAuthHeader(event);
      return workspacePolicyManager.getPolicy({ accountId, expectedAuthGeneration, authHeaders });
    });

    ipcMain.handle(
      "get-managed-enterprise-config",
      async (event, accountId, workspaceId, expectedAuthGeneration, forceRefresh = false) => {
        const authHeaders = await getAuthHeader(event);
        return this.enterpriseIdentityManager.getConfig({
          accountId,
          workspaceId,
          expectedAuthGeneration,
          authHeaders,
          forceRefresh,
        });
      }
    );
    ipcMain.handle("clear-managed-enterprise-identity", async () => {
      this.enterpriseIdentityManager.clear();
    });

    // Unknown ids are a no-op: BYOK providers don't register a controller,
    // and the renderer fires this for every cancel.
    ipcMain.handle("cancel-upload-transcription", async (_event, requestId) => {
      return { success: this._uploadCancelRegistry.cancel(requestId) > 0 };
    });

    ipcMain.handle("get-referral-stats", async (event) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) {
          throw new Error("OpenWhispr API URL not configured");
        }

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) {
          throw new Error("Not authenticated");
        }

        const response = await proxyFetch(`${apiUrl}/api/referrals/stats`, {
          headers: {
            ...authHeader,
          },
        });

        if (!response.ok) {
          if (response.status === 401) {
            throw new Error("Unauthorized - please sign in");
          }
          if (response.status === 503) {
            throw new Error("Service temporarily unavailable");
          }
          throw new Error(`Failed to fetch referral stats: ${response.status}`);
        }

        const data = await response.json();
        return data;
      } catch (error) {
        debugLogger.error("Error fetching referral stats:", error);
        throw error;
      }
    });

    ipcMain.handle("send-referral-invite", async (event, email) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) {
          throw new Error("OpenWhispr API URL not configured");
        }

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) {
          throw new Error("Not authenticated");
        }

        const response = await proxyFetch(`${apiUrl}/api/referrals/invite`, {
          method: "POST",
          headers: {
            ...authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email }),
        });

        if (!response.ok) {
          let errorMessage = `Failed to send invite: ${response.status}`;
          try {
            const errorData = await response.json();
            if (errorData.error) errorMessage = errorData.error;
          } catch (_) {}
          throw new Error(errorMessage);
        }

        const data = await response.json();
        return data;
      } catch (error) {
        debugLogger.error("Error sending referral invite:", error);
        throw error;
      }
    });

    ipcMain.handle("get-referral-invites", async (event) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) {
          throw new Error("OpenWhispr API URL not configured");
        }

        const authHeader = await getAuthHeader(event);
        if (!Object.keys(authHeader).length) {
          throw new Error("Not authenticated");
        }

        const response = await proxyFetch(`${apiUrl}/api/referrals/invites`, {
          headers: {
            ...authHeader,
          },
        });

        if (!response.ok) {
          if (response.status === 401) {
            throw new Error("Unauthorized - please sign in");
          }
          if (response.status === 503) {
            throw new Error("Service temporarily unavailable");
          }
          throw new Error(`Failed to fetch referral invites: ${response.status}`);
        }

        const data = await response.json();
        return data;
      } catch (error) {
        debugLogger.error("Error fetching referral invites:", error);
        throw error;
      }
    });

    ipcMain.handle("get-ydotool-status", () => {
      const { getYdotoolStatus } = require("./ensureYdotool");
      const { getLinuxSessionInfo } = require("./linuxSession");
      const { execFileSync } = require("child_process");
      const status = getYdotoolStatus();
      const { isKde } = getLinuxSessionInfo();
      let hasXclip = false;
      let hasXsel = false;
      if (isKde) {
        try {
          execFileSync("which", ["xclip"], { timeout: 1000 });
          hasXclip = true;
        } catch {}
        try {
          execFileSync("which", ["xsel"], { timeout: 1000 });
          hasXsel = true;
        } catch {}
      }
      return { ...status, hasXclip, hasXsel };
    });

    ipcMain.handle("get-debug-state", async () => {
      try {
        return {
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
          logLevel: debugLogger.getLevel(),
        };
      } catch (error) {
        debugLogger.error("Failed to get debug state:", error);
        return { enabled: false, logPath: null, logLevel: "info" };
      }
    });

    ipcMain.handle("set-debug-logging", async (event, enabled) => {
      try {
        const path = require("path");
        const fs = require("fs");
        const envPath = path.join(getAppDataDirectory(), ".env");

        // Read current .env content
        let envContent = "";
        if (fs.existsSync(envPath)) {
          envContent = fs.readFileSync(envPath, "utf8");
        }

        // Parse lines
        const lines = envContent.split("\n");
        const logLevelIndex = lines.findIndex((line) =>
          line.trim().startsWith("OPENWHISPR_LOG_LEVEL=")
        );

        if (enabled) {
          // Set to debug
          if (logLevelIndex !== -1) {
            lines[logLevelIndex] = "OPENWHISPR_LOG_LEVEL=debug";
          } else {
            // Add new line
            if (lines.length > 0 && lines[lines.length - 1] !== "") {
              lines.push("");
            }
            lines.push("# Debug logging setting");
            lines.push("OPENWHISPR_LOG_LEVEL=debug");
          }
        } else {
          // Remove or set to info
          if (logLevelIndex !== -1) {
            lines[logLevelIndex] = "OPENWHISPR_LOG_LEVEL=info";
          }
        }

        // Write back
        fs.writeFileSync(envPath, lines.join("\n"), "utf8");

        // Update environment variable
        process.env.OPENWHISPR_LOG_LEVEL = enabled ? "debug" : "info";

        // Refresh logger state
        debugLogger.refreshLogLevel();

        return {
          success: true,
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
        };
      } catch (error) {
        debugLogger.error("Failed to set debug logging:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("open-logs-folder", async () => {
      try {
        const logsDir = path.join(getAppDataDirectory(), "logs");
        await shell.openPath(logsDir);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open logs folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-app-version", async () => {
      return this.updateManager.getAppVersion();
    });

    ipcMain.handle("get-post-migration-state", () => ({
      justMigrated: postMigrationDetector.isReturningFromOldBundle(),
    }));

    ipcMain.handle("get-oauth-protocol-registered", () => this.oauthProtocolRegistered);

    ipcMain.handle("get-oauth-protocol", () => this.oauthProtocol);

    ipcMain.handle("mark-bundle-migrated", () => {
      postMigrationDetector.markBundleMigrated();
    });

    ipcMain.handle("mark-bundle-migration-dismissed", () => {
      postMigrationDetector.markBundleMigrationDismissed();
    });

    // Agent mode handlers
    ipcMain.handle("update-voice-agent-hotkey", async (_event, hotkey) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const voiceAgentCallback = this.windowManager._voiceAgentHotkeyCallback;
      if (!voiceAgentCallback) {
        return { success: false };
      }

      if (!hotkey) {
        const removed = await hotkeyManager.unregisterSlot("voiceAgent");
        if (removed === false) return { success: false };
        this.environmentManager.saveVoiceAgentKey?.("");
        this.windowManager.reconcileNativeKeyListeners();
        this._notifyHotkeyChanged("");
        return { success: true, message: "Voice agent hotkey cleared" };
      }

      const result = await hotkeyManager.registerSlot("voiceAgent", hotkey, voiceAgentCallback, {
        atomic: true,
      });
      this.windowManager.reconcileNativeKeyListeners();
      if (result.success) {
        this.environmentManager.saveVoiceAgentKey?.(hotkey);
        this._notifyHotkeyChanged(hotkey);
        return { success: true, message: `Voice agent hotkey updated to: ${hotkey}` };
      }

      return { success: false, message: result.error };
    });

    ipcMain.handle("get-voice-agent-key", async () => {
      return this.environmentManager.getVoiceAgentKey?.() || "";
    });

    ipcMain.handle("update-translation-hotkey", async (_event, hotkey) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const translationCallback = this.windowManager._translationHotkeyCallback;
      if (!translationCallback) {
        return { success: false };
      }

      if (!hotkey) {
        const removed = await hotkeyManager.unregisterSlot("translation");
        if (removed === false) return { success: false };
        this.environmentManager.saveTranslationKey?.("");
        this.windowManager.reconcileNativeKeyListeners();
        this._notifyHotkeyChanged("");
        return { success: true, message: "Translation hotkey cleared" };
      }

      const result = await hotkeyManager.registerSlot("translation", hotkey, translationCallback, {
        atomic: true,
      });
      this.windowManager.reconcileNativeKeyListeners();
      if (result.success) {
        this.environmentManager.saveTranslationKey?.(hotkey);
        this._notifyHotkeyChanged(hotkey);
        return { success: true, message: `Translation hotkey updated to: ${hotkey}` };
      }

      return { success: false, message: result.error };
    });

    ipcMain.handle("get-translation-key", async () => {
      return this.environmentManager.getTranslationKey?.() || "";
    });

    ipcMain.handle("acquire-recording-lock", async (_event, pipeline) => {
      if (this._activeRecordingPipeline && this._activeRecordingPipeline !== pipeline) {
        return { success: false, holder: this._activeRecordingPipeline };
      }
      this._activeRecordingPipeline = pipeline;
      return { success: true };
    });

    ipcMain.handle("release-recording-lock", async (_event, pipeline) => {
      if (this._activeRecordingPipeline === pipeline) {
        this._activeRecordingPipeline = null;
      }
      return { success: true };
    });

    // Provider-neutral availability over the shared calendar cache.
    ipcMain.handle("calendar-get-availability", async (_event, request) => {
      try {
        return {
          success: true,
          availability: getCalendarAvailability({
            request,
            databaseManager: this.databaseManager,
            calendarProviders: [
              { provider: "google", manager: this.googleCalendarManager },
              { provider: "microsoft", manager: this.microsoftCalendarManager },
              { provider: "apple", manager: this.appleCalendarManager },
            ],
          }),
        };
      } catch (error) {
        debugLogger.warn(
          "Calendar availability request failed",
          { error: error instanceof Error ? error.message : String(error) },
          "calendar"
        );
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to check calendar availability",
        };
      }
    });

    // Google Calendar
    ipcMain.handle("gcal-start-oauth", async () => {
      try {
        return await this.googleCalendarManager.startOAuth();
      } catch (error) {
        debugLogger.error("Google Calendar OAuth failed", { error: error.message }, "calendar");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-disconnect", async (_event, email) => {
      try {
        this.googleCalendarManager.disconnect(email);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Google Calendar disconnect failed",
          { error: error.message },
          "calendar"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-get-connection-status", async () => {
      try {
        return this.googleCalendarManager.getConnectionStatus();
      } catch (error) {
        return { connected: false, email: null };
      }
    });

    ipcMain.handle("gcal-get-calendars", async () => {
      try {
        return { success: true, calendars: this.googleCalendarManager.getCalendars() };
      } catch (error) {
        return { success: false, calendars: [] };
      }
    });

    ipcMain.handle("gcal-set-calendar-selection", async (_event, calendarId, isSelected) => {
      try {
        await this.googleCalendarManager.setCalendarSelection(calendarId, isSelected);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-set-primary-only", async (_event, value) => {
      try {
        await this.googleCalendarManager.setPrimaryOnly(value);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-sync-events", async () => {
      try {
        await this.googleCalendarManager.syncEvents();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-get-upcoming-events", async (_event, windowMinutes) => {
      try {
        return {
          success: true,
          events: await this.googleCalendarManager.getUpcomingEvents(windowMinutes),
        };
      } catch (error) {
        return { success: false, events: [] };
      }
    });

    ipcMain.handle("gcal-get-event", async (_event, eventId) => {
      try {
        const event = this.databaseManager.getCalendarEventById(eventId);
        return { success: true, event };
      } catch (error) {
        return { success: false, event: null };
      }
    });

    // Microsoft Calendar
    ipcMain.handle("mcal-start-oauth", async () => {
      try {
        return await this.microsoftCalendarManager.startOAuth();
      } catch (error) {
        debugLogger.error("Microsoft Calendar OAuth failed", { error: error.message }, "calendar");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("mcal-disconnect", async (_event, email) => {
      try {
        this.microsoftCalendarManager.disconnect(email);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Microsoft Calendar disconnect failed",
          { error: error.message },
          "calendar"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("mcal-get-connection-status", async () => {
      try {
        return this.microsoftCalendarManager.getConnectionStatus();
      } catch (error) {
        debugLogger.error(
          "Microsoft Calendar connection status failed",
          { error: error.message },
          "calendar"
        );
        return { connected: false, accounts: [] };
      }
    });

    ipcMain.handle("mcal-set-primary-only", async (_event, value) => {
      try {
        await this.microsoftCalendarManager.setPrimaryOnly(value);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Apple Calendar (macOS EventKit)
    ipcMain.handle("acal-connect", async () => {
      try {
        return await this.appleCalendarManager.connect();
      } catch (error) {
        debugLogger.error("Apple Calendar connect failed", { error: error.message }, "acal");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("acal-disconnect", async () => {
      try {
        return this.appleCalendarManager.disconnect();
      } catch (error) {
        debugLogger.error("Apple Calendar disconnect failed", { error: error.message }, "acal");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("acal-get-connection-status", async () => {
      try {
        return this.appleCalendarManager.getConnectionStatus();
      } catch (error) {
        debugLogger.error(
          "Apple Calendar connection status failed",
          { error: error.message },
          "acal"
        );
        return { connected: false, sourceNames: [] };
      }
    });

    ipcMain.handle("search-contacts", async (_event, query) => {
      try {
        const contacts = this.databaseManager.searchContacts(query);
        return { success: true, contacts };
      } catch (error) {
        return { success: false, contacts: [] };
      }
    });

    ipcMain.handle("upsert-contact", async (_event, contact) => {
      try {
        this.databaseManager.addManualContact(contact);
        return { success: true };
      } catch (error) {
        return { success: false };
      }
    });

    ipcMain.handle("get-md5-hash", (_event, text) => {
      return crypto.createHash("md5").update(text.toLowerCase().trim()).digest("hex");
    });

    const NOTIFICATION_PREF_KEYS = new Set([
      "notificationsEnabled",
      "notifyMeetingDetection",
      "notifyCalendarReminders",
    ]);

    ipcMain.handle("sync-notification-preferences", async (_event, prefs) => {
      try {
        if (!prefs || typeof prefs !== "object") {
          return { success: false, error: "Invalid preferences" };
        }
        for (const [key, value] of Object.entries(prefs)) {
          if (NOTIFICATION_PREF_KEYS.has(key)) {
            this.windowManager.notificationPrefs[key] = !!value;
          }
        }
        if (typeof prefs.meetingProcessDetection === "boolean") {
          this.meetingProcessDetection = prefs.meetingProcessDetection;
        }
        const { notificationsEnabled, notifyMeetingDetection } =
          this.windowManager.notificationPrefs;
        this.meetingDetectionEngine?.setPreferences(
          deriveDetectorPreferences({
            notificationsEnabled,
            notifyMeetingDetection,
            meetingProcessDetection: this.meetingProcessDetection,
          })
        );
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("meeting-set-speaker-diarization-enabled", async (_event, payload) => {
      try {
        this.speakerDiarizationEnabled = payload?.enabled !== false;
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("meeting-set-session-speaker-config", async (_event, payload) => {
      try {
        const enabled = payload?.enabled !== false;
        const expectedCount = Math.max(
          1,
          Math.min(
            MAX_SPEAKER_COUNT,
            Number(payload?.expectedCount) || DEFAULT_EXPECTED_SPEAKER_COUNT
          )
        );
        // Only a stepper-set count is explicit; the diarization toggle reuses this
        // channel and must not freeze the count against roster-driven refreshes.
        this.activeMeetingSpeakerConfig = {
          enabled,
          expectedCount,
          explicit: payload?.countIsExplicit === true,
        };
        // This is the whole meeting's cluster cap. Capture channels do not
        // identify people; both channels share the same session tracker.
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-meeting-notification-destination", (event) =>
      this.getMeetingNotificationDestination(
        this.windowManager.captureMeetingNotificationOwner(event.sender)
      )
    );
    ipcMain.handle("select-meeting-notification-folder", (event, ref) =>
      this.selectMeetingNotificationFolder(
        this.windowManager.captureMeetingNotificationOwner(event.sender),
        ref
      )
    );
    ipcMain.handle("create-meeting-notification-folder", (event, request) =>
      this.createMeetingNotificationFolder(
        this.windowManager.captureMeetingNotificationOwner(event.sender),
        request
      )
    );

    ipcMain.handle("set-meeting-notification-surface", (event, state) => {
      const owner = this.windowManager.captureMeetingNotificationOwner(event.sender);
      return this.windowManager.setMeetingNotificationSurface(owner, state);
    });

    ipcMain.handle("meeting-notification-respond", (event, detectionId, action, options) => {
      const owner = this.windowManager.captureMeetingNotificationOwner(event.sender);
      if (!owner || owner.prompt.detectionId !== detectionId)
        return { success: false, code: "STALE_NOTIFICATION" };
      return this.meetingDetectionEngine.handleNotificationResponse(
        detectionId,
        action,
        options,
        owner
      );
    });
    ipcMain.handle("confirm-meeting-note-navigation", (event, navigationId, status) =>
      this.windowManager.confirmMeetingNoteNavigation(event.sender, navigationId, status)
    );

    ipcMain.handle("join-calendar-meeting", async (_event, eventId) => {
      try {
        await this.meetingDetectionEngine.joinCalendarMeeting(eventId);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("start-manual-meeting", () => this.windowManager.startManualMeeting());

    ipcMain.handle("get-meeting-notification-data", async (event) => {
      if (this.windowManager?.notificationWindow?.webContents !== event.sender) return null;
      return this.windowManager?._pendingNotificationData ?? null;
    });

    ipcMain.handle("get-pending-meeting-note-navigation", async (event) => {
      return this.windowManager?.consumePendingMeetingNoteNavigation(event.sender) ?? null;
    });

    ipcMain.handle("get-pending-note-navigation", async () => {
      return this.windowManager?.consumePendingNoteNavigation() ?? null;
    });

    ipcMain.handle("get-pending-settings-section", async () => {
      return this.windowManager?.consumePendingSettingsSection() ?? null;
    });

    ipcMain.handle("meeting-notification-ready", async (event) => {
      this.windowManager?.showNotificationWindow(event.sender);
    });

    // Note files (markdown mirror) handlers
    ipcMain.handle("note-files-set-enabled", async (_event, enabled, customPath, options) => {
      try {
        this._noteFilesEnabled = !!enabled;
        if (!enabled) return { success: true };
        const basePath = customPath || path.join(getAppDataDirectory(), "notes");
        if (options?.skipRebuild) {
          require("./markdownMirror").init(basePath);
        } else {
          this._rebuildMirror(basePath);
        }
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to set note-files enabled",
          { error: error.message },
          "note-files"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-set-path", async (_event, newPath) => {
      try {
        if (!this._noteFilesEnabled) return { success: false, error: "Note files not enabled" };
        this._rebuildMirror(newPath);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to set note-files path", { error: error.message }, "note-files");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-rebuild", async () => {
      try {
        if (!this._noteFilesEnabled) return { success: false, error: "Note files not enabled" };
        this._rebuildMirror();
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to rebuild note files", { error: error.message }, "note-files");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-get-default-path", async () => {
      return path.join(getAppDataDirectory(), "notes");
    });

    ipcMain.handle("show-note-file", async (_event, noteId) => {
      try {
        const markdownMirror = require("./markdownMirror");
        const filePath = markdownMirror.getNotePath(noteId);
        if (!filePath) return { success: false };
        shell.showItemInFolder(filePath);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to show note file",
          { noteId, error: error.message },
          "note-files"
        );
        return { success: false };
      }
    });

    ipcMain.handle("show-folder-in-explorer", async (_event, folderName) => {
      try {
        const markdownMirror = require("./markdownMirror");
        const dirPath = markdownMirror.getFolderPath(folderName);
        if (!dirPath) return { success: false };
        await shell.openPath(dirPath);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to show folder",
          { folderName, error: error.message },
          "note-files"
        );
        return { success: false };
      }
    });

    ipcMain.handle("note-files-pick-folder", async () => {
      try {
        const { dialog } = require("electron");
        const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
        if (result.canceled || !result.filePaths.length) {
          return { canceled: true };
        }
        return { canceled: false, path: result.filePaths[0] };
      } catch (error) {
        debugLogger.error("Failed to pick folder", { error: error.message }, "note-files");
        return { canceled: true };
      }
    });

    ipcMain.handle("granola-import-pick-and-preview", async (event) => {
      try {
        const { dialog } = require("electron");
        // Parent the dialog so it opens as a sheet on the settings window —
        // a parentless panel can land invisible on another display/Space.
        const parentWindow = BrowserWindow.fromWebContents(event.sender);
        // Granola chunks large exports into numbered files (…-000.csv, -001, …),
        // so let the user grab the whole set in one pick.
        const dialogOptions = {
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "CSV", extensions: ["csv"] }],
        };
        const result = parentWindow
          ? await dialog.showOpenDialog(parentWindow, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);
        if (result.canceled || !result.filePaths.length) {
          return { canceled: true };
        }
        const filePaths = [...result.filePaths].sort();
        const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
        const { createGranolaNoteKeyAllocator, parseGranolaCsv } =
          await import("./granolaImport.js");
        const allocateNoteKey = createGranolaNoteKeyAllocator();
        const notes = [];
        const seenIds = new Set();
        let rowIssueCount = 0;
        for (const filePath of filePaths) {
          if (fs.statSync(filePath).size > MAX_IMPORT_BYTES) {
            return { canceled: false, success: false, error: "FILE_TOO_LARGE" };
          }
          const parsed = parseGranolaCsv(fs.readFileSync(filePath, "utf8"), {
            allocateNoteKey,
          });
          if (!parsed.ok) {
            return { canceled: false, success: false, error: parsed.error.code };
          }
          // File-level warnings (e.g. ignored columns) are expected on every
          // real export; only row-scoped problems belong in the issue count.
          rowIssueCount += parsed.warnings.filter((warning) => warning.row != null).length;
          for (const note of parsed.notes) {
            if (!seenIds.has(note.clientNoteId)) {
              seenIds.add(note.clientNoteId);
              notes.push(note);
            }
          }
        }
        const existing = new Set(
          this.databaseManager.getExistingClientNoteIds(notes.map((n) => n.clientNoteId))
        );
        const freshNotes = notes.filter((n) => !existing.has(n.clientNoteId));
        // The run handler only ever imports what this preview parsed — the
        // renderer never sends a file path across the bridge.
        this._granolaImportPending = { notes };
        return {
          canceled: false,
          success: true,
          fileName: filePaths.map((p) => path.basename(p)).join(", "),
          total: notes.length,
          newCount: freshNotes.length,
          duplicateCount: notes.length - freshNotes.length,
          sampleTitles: freshNotes.slice(0, 5).map((n) => n.title),
          rowIssueCount,
        };
      } catch (error) {
        debugLogger.error(
          "Granola import preview failed",
          { error: error.message },
          "granola-import"
        );
        return { canceled: false, success: false, error: "READ_FAILED" };
      }
    });

    ipcMain.handle("granola-import-run", async () => {
      const pending = this._granolaImportPending;
      this._granolaImportPending = null;
      if (!pending) return { success: false, error: "NO_PENDING_IMPORT" };
      try {
        const result = this.databaseManager.importNotes(pending.notes);
        if (result.imported > 0) {
          // One-shot side effects: a single index wake-up (the SQLite triggers
          // already journaled every imported note) and a single mirror rebuild —
          // never per-note work (sync storm / O(notes × files) mirror scans).
          setImmediate(() => {
            try {
              this.notifyVectorChanges();
              if (this._noteFilesEnabled) this._rebuildMirror();
            } catch (sideEffectError) {
              debugLogger.error(
                "Granola import side effects failed",
                { error: sideEffectError.message },
                "granola-import"
              );
            }
          });
        }
        return {
          success: true,
          imported: result.imported,
          skipped: result.skipped,
          errors: result.errors,
        };
      } catch (error) {
        debugLogger.error("Granola import failed", { error: error.message }, "granola-import");
        return { success: false, error: "IMPORT_FAILED" };
      }
    });

    ipcMain.handle("get-speaker-mappings", async (_event, noteId) => {
      return this.databaseManager.getSpeakerMappings(noteId);
    });

    ipcMain.handle(
      "set-speaker-mapping",
      async (_event, noteId, speakerId, displayName, email, profileId) => {
        return this._setSpeakerMapping(noteId, speakerId, displayName, email, profileId);
      }
    );

    ipcMain.handle("remove-speaker-mapping", async (_event, noteId, speakerId) => {
      this.databaseManager.removeSpeakerMapping(noteId, speakerId);
      return { success: true };
    });

    ipcMain.handle("get-speaker-profiles", async () => {
      return this.databaseManager.getSpeakerProfiles();
    });

    ipcMain.handle("attach-speaker-email", async (_event, profileId, email) => {
      try {
        const profile = this.databaseManager.attachEmailToProfile(profileId, email);
        this._retroactiveMapping(profile);
        return {
          success: true,
          profile: {
            id: profile.id,
            display_name: profile.display_name,
            email: profile.email,
            sample_count: profile.sample_count,
          },
        };
      } catch (error) {
        debugLogger.error(
          "Failed to attach email to speaker profile",
          { error: error.message },
          "speaker"
        );
        return { success: false, error: error.message };
      }
    });
  }

  _setSpeakerMapping(noteId, speakerId, displayName, email, profileId) {
    if (!this.databaseManager.getNote(noteId)) return { success: false, error: "Note not found" };
    const stored = this.databaseManager
      .getNoteSpeakerEmbeddings(noteId)
      .find((entry) => entry.speaker_id === speakerId);
    // A note's explicit naming can use only that note's persisted result, never
    // a global transient voice from a different note or recording generation.
    let resolvedProfileId = profileId ?? null;
    if (stored?.representation) {
      const profile = this.databaseManager.upsertSpeakerProfile(
        displayName,
        email || null,
        stored.representation,
        resolvedProfileId
      );
      resolvedProfileId = profile.id;
      this._retroactiveMapping(profile);
    }
    this.databaseManager.setSpeakerMapping(noteId, speakerId, resolvedProfileId, displayName);
    return { success: true, profileId: resolvedProfileId };
  }

  _retroactiveMapping(profile) {
    const account = this.databaseManager.activeAccountId,
      generation = tokenStore.getGeneration();
    setImmediate(async () => {
      try {
        if (
          account !== this.databaseManager.activeAccountId ||
          generation !== tokenStore.getGeneration()
        )
          return;
        const speakerEmbeddings = require("./speakerEmbeddings");
        const noteIds = this.databaseManager.getNotesWithUnmappedSpeakers();

        const profileRepresentations = profile.representations || [];
        if (!profileRepresentations.length) return;

        for (const noteId of noteIds) {
          const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
          const existing = this.databaseManager.getSpeakerMappings(noteId);
          const mappedSpeakers = new Set(existing.map((m) => m.speaker_id));
          for (const emb of embeddings) {
            if (mappedSpeakers.has(emb.speaker_id)) continue;

            const similarities = profileRepresentations
              .map((value) => speakerEmbeddings.cosineSimilarity(value, emb.representation))
              .filter((value) => value !== null);
            const similarity = similarities.length ? Math.max(...similarities) : null;

            if (similarity > 0.6) {
              this.databaseManager.setSpeakerMapping(
                noteId,
                emb.speaker_id,
                profile.id,
                profile.display_name
              );

              const note = this.databaseManager.getNote(noteId);
              if (note?.transcript) {
                try {
                  const segments = JSON.parse(note.transcript);
                  let changed = false;
                  for (const seg of segments) {
                    if (seg.speaker === emb.speaker_id && !seg.speakerName) {
                      if (canAutoRelabelSpeaker(seg)) {
                        applyConfirmedSpeaker(seg, {
                          speakerName: profile.display_name,
                          speakerIsPlaceholder: false,
                        });
                      } else {
                        seg.speakerName = profile.display_name;
                        seg.speakerIsPlaceholder = false;
                      }
                      changed = true;
                    }
                  }
                  if (changed) {
                    this.databaseManager.updateNote(noteId, {
                      transcript: JSON.stringify(segments),
                    });
                  }
                } catch (_) {}
              }
            }
          }
        }
      } catch (err) {
        debugLogger.warn("Retroactive speaker mapping failed", { error: err.message });
      }
    });
  }

  _tryAutoLabelOneOnOne(noteId) {
    const account = this.databaseManager.activeAccountId,
      generation = tokenStore.getGeneration();
    setImmediate(async () => {
      try {
        if (
          account !== this.databaseManager.activeAccountId ||
          generation !== tokenStore.getGeneration()
        )
          return;
        const note = this.databaseManager.getNote(noteId);
        const other = this._resolveOneOnOneOtherParticipant(note?.participants);
        if (!other) return;
        const { displayName, email } = other;

        const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
        if (!embeddings.length) return;

        const existingMappings = this.databaseManager.getSpeakerMappings(noteId);
        const mappedSpeakers = new Set(existingMappings.map((m) => m.speaker_id));

        const transcript = note.transcript ? JSON.parse(note.transcript) : [];
        const systemSpeakers = new Set(
          transcript.filter((s) => s.source !== "mic" && s.speaker).map((s) => s.speaker)
        );

        const unmapped = embeddings.filter(
          (e) => !mappedSpeakers.has(e.speaker_id) && systemSpeakers.has(e.speaker_id)
        );
        if (!unmapped.length) return;

        let profile = null;
        for (const emb of unmapped) {
          profile = this.databaseManager.upsertSpeakerProfile(
            displayName,
            email,
            emb.representation,
            profile?.id ?? null
          );
          this.databaseManager.setSpeakerMapping(noteId, emb.speaker_id, profile.id, displayName);
        }

        const unmappedSystemSpeakers = new Set(unmapped.map((e) => e.speaker_id));
        let changed = false;
        for (const seg of transcript) {
          if (!unmappedSystemSpeakers.has(seg.speaker)) continue;
          if (seg.speakerName && !seg.speakerIsPlaceholder) continue;
          if (canAutoRelabelSpeaker(seg)) {
            applyConfirmedSpeaker(seg, { speakerName: displayName, speakerIsPlaceholder: false });
          } else {
            seg.speakerName = displayName;
            seg.speakerIsPlaceholder = false;
          }
          changed = true;
        }

        if (changed) {
          this.databaseManager.updateNote(noteId, { transcript: JSON.stringify(transcript) });
          const updated = this.databaseManager.getNote(noteId);
          if (updated) broadcastToWindows("note-updated", updated);
        }

        if (profile) this._retroactiveMapping(profile);

        debugLogger.info(
          "Auto-labeled 1-on-1 meeting speakers",
          { noteId, displayName, speakerCount: unmapped.length },
          "speaker"
        );
      } catch (err) {
        debugLogger.warn("Auto-label 1-on-1 failed", { noteId, error: err.message }, "speaker");
      }
    });
  }

  deleteTranscriptionInternal(id) {
    this.audioStorageManager.deleteAudio(id);
    const result = this.databaseManager.deleteTranscription(id);
    if (result?.success) {
      setImmediate(() => {
        broadcastToWindows("transcription-deleted", { id });
      });
    }
    return result;
  }

  deleteNoteInternal(id) {
    const result = this.databaseManager.deleteNote(id);
    if (result?.success) {
      setImmediate(() => broadcastToWindows("note-deleted", { id }));
      this.notifyVectorChanges();
      this._asyncMirrorDelete(id);
    }
    return result;
  }
}

module.exports = IPCHandlers;
