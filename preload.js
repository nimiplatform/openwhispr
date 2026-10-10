const { contextBridge, ipcRenderer, webUtils } = require("electron");
const {
  installNimiElectronRuntimeBridge,
} = require("@nimiplatform/kit/shell/electron/preload-cjs");
installNimiElectronRuntimeBridge({ contextBridge, ipcRenderer });

/**
 * Helper to register an IPC listener and return a cleanup function.
 * Ensures renderer code can easily remove listeners to avoid leaks.
 */
const registerListener = (channel, handlerFactory) => {
  return (callback) => {
    if (typeof callback !== "function") {
      return () => {};
    }

    const listener =
      typeof handlerFactory === "function"
        ? handlerFactory(callback)
        : (event, ...args) => callback(event, ...args);

    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
};

contextBridge.exposeInMainWorld("electronAPI", {
  setOnboardingWindowMode: (mode) => ipcRenderer.invoke("onboarding-set-window-mode", mode),
  setOnboardingActive: (active) => ipcRenderer.invoke("onboarding-set-active", active),
  openPermissionGuide: (state) => ipcRenderer.invoke("permission-guide-open", state),
  closePermissionGuide: () => ipcRenderer.invoke("permission-guide-close"),
  getPermissionGuideState: () => ipcRenderer.invoke("permission-guide-state"),
  permissionGuideAction: (action) => ipcRenderer.send("permission-guide-action", action),
  startPermissionGuideDrag: (target) => ipcRenderer.send("permission-guide-drag", target),
  onPermissionGuideState: registerListener(
    "permission-guide-state-changed",
    (callback) => (_event, state) => callback(state)
  ),
  onPermissionGuideAction: registerListener(
    "permission-guide-action",
    (callback) => (_event, action) => callback(action)
  ),
  markMacAccessibilityFeaturesReady: (expectedAccountScope) =>
    expectedAccountScope
      ? ipcRenderer.send("mac-accessibility-features-ready", expectedAccountScope)
      : ipcRenderer.send("mac-accessibility-features-ready"),
  beginOnboardingDemo: (session) => ipcRenderer.invoke("onboarding-demo-begin", session),
  endOnboardingDemo: (id) => ipcRenderer.invoke("onboarding-demo-end", id),
  stopOnboardingDemo: (id) => ipcRenderer.invoke("onboarding-demo-stop", id),
  publishOnboardingDemoEvent: (event) => ipcRenderer.invoke("onboarding-demo-publish", event),
  onOnboardingDemoEvent: registerListener(
    "onboarding-demo-event",
    (callback) => (_event, payload) => callback(payload)
  ),

  pasteText: (text, options) => ipcRenderer.invoke("paste-text", text, options),
  captureSelectedText: (options) => ipcRenderer.invoke("capture-selected-text", options),
  replaceSelectedText: (sessionId, text, options) =>
    ipcRenderer.invoke("replace-selected-text", sessionId, text, options),
  pasteAtCapturedTarget: (sessionId, text, options) =>
    ipcRenderer.invoke("paste-at-captured-target", sessionId, text, options),
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  showDictationPanel: () => ipcRenderer.invoke("show-dictation-panel"),
  openSettingsSection: (section) => ipcRenderer.invoke("open-settings-section", section),
  captureDictationTarget: () => ipcRenderer.invoke("capture-dictation-target"),
  onToggleDictation: registerListener("toggle-dictation", (callback) => () => callback()),
  onToggleVoiceAgent: registerListener("toggle-voice-agent", (callback) => () => callback()),
  onToggleTranslation: registerListener("toggle-translation", (callback) => () => callback()),
  onOpenAssistantPanel: registerListener("open-assistant-panel", (callback) => () => callback()),
  onStartDictation: registerListener("start-dictation", (callback) => () => callback()),
  onStopDictation: registerListener("stop-dictation", (callback) => () => callback()),
  onPrepareDictation: registerListener(
    "prepare-dictation",
    (callback) => (_event, options) => callback(options)
  ),
  onCancelDictationPreparation: registerListener(
    "cancel-dictation-preparation",
    (callback) => () => callback()
  ),
  onCancelDictation: registerListener("cancel-dictation", (callback) => () => callback()),
  onDictationForceStopped: registerListener(
    "dictation-force-stopped",
    (callback) => (_event, payload) => callback(payload)
  ),
  micWarmHoldChanged: (active) => ipcRenderer.send("mic-warm-hold-changed", active),
  dictationLifecycleStateChanged: (state, inputKind) =>
    ipcRenderer.send("dictation-lifecycle-state-changed", state, inputKind),
  dictationAudioLevelChanged: (level) => ipcRenderer.send("dictation-audio-level-changed", level),
  toggleAgentPanelDictation: () => ipcRenderer.invoke("toggle-agent-panel-dictation"),
  cancelAgentPanelDictation: () => ipcRenderer.invoke("cancel-agent-panel-dictation"),
  getAgentDictationPillState: () => ipcRenderer.invoke("get-agent-dictation-pill-state"),
  resizeAgentDictationPillToContent: (surfaceHeight) =>
    ipcRenderer.invoke("resize-agent-dictation-pill-to-content", surfaceHeight),
  setAgentDictationPillInteractivity: (interactive) =>
    ipcRenderer.invoke("set-agent-dictation-pill-interactivity", interactive),
  onAgentDictationPillStateChanged: registerListener(
    "agent-dictation-pill-state-changed",
    (callback) => (_event, state) => callback(state)
  ),
  onAgentDictationPillAudioLevelChanged: registerListener(
    "agent-dictation-pill-audio-level-changed",
    (callback) => (_event, level) => callback(level)
  ),
  showAgentDictationFinalTranscript: (text) =>
    ipcRenderer.send("show-agent-dictation-final-transcript", text),
  onAgentDictationPillFinalTranscript: registerListener(
    "agent-dictation-pill-final-transcript",
    (callback) => (_event, text) => callback(text)
  ),

  // Database functions
  saveTranscription: (text, rawText, options) =>
    ipcRenderer.invoke("db-save-transcription", text, rawText, options),
  getTranscriptions: (limit, options) =>
    ipcRenderer.invoke("db-get-transcriptions", limit, options),
  recordAnalyticsEvent: (input) => ipcRenderer.invoke("analytics-record-event", input),
  getAnalyticsSummary: () => ipcRenderer.invoke("analytics-get-summary"),
  getPendingAnalyticsEvents: (limit, context) =>
    ipcRenderer.invoke("analytics-get-pending", limit, context),
  markAnalyticsEventsSynced: (eventIds, context) =>
    ipcRenderer.invoke("analytics-mark-synced", eventIds, context),
  getPendingAnalyticsDeletes: (limit, context) =>
    ipcRenderer.invoke("analytics-get-pending-deletes", limit, context),
  hardDeleteAnalyticsEvents: (eventIds, context) =>
    ipcRenderer.invoke("analytics-hard-delete", eventIds, context),
  getPendingAnalyticsClear: (context) => ipcRenderer.invoke("analytics-get-pending-clear", context),
  completeAnalyticsClear: (clearedThrough, context) =>
    ipcRenderer.invoke("analytics-complete-clear", clearedThrough, context),
  countUnclaimedAnalyticsEvents: (context) =>
    ipcRenderer.invoke("analytics-count-unclaimed", context),
  countAnalyticsEventsAwaitingUpload: (context) =>
    ipcRenderer.invoke("analytics-count-awaiting-upload", context),
  claimAnonymousAnalyticsEvents: (accountId, expectedAuthGeneration) =>
    ipcRenderer.invoke("analytics-claim-anonymous", accountId, expectedAuthGeneration),
  clearTranscriptions: () => ipcRenderer.invoke("db-clear-transcriptions"),
  deleteTranscription: (id) => ipcRenderer.invoke("db-delete-transcription", id),

  // Audio storage functions
  saveTranscriptionAudio: (id, audioBuffer, metadata) =>
    ipcRenderer.invoke("save-transcription-audio", id, audioBuffer, metadata),
  mergeAudioSegments: (segments) => ipcRenderer.invoke("merge-audio-segments", segments),
  getAudioPath: (id) => ipcRenderer.invoke("get-audio-path", id),
  showAudioInFolder: (id) => ipcRenderer.invoke("show-audio-in-folder", id),
  getAudioBuffer: (id) => ipcRenderer.invoke("get-audio-buffer", id),
  deleteTranscriptionAudio: (id) => ipcRenderer.invoke("delete-transcription-audio", id),
  getAudioStorageUsage: () => ipcRenderer.invoke("get-audio-storage-usage"),
  deleteAllAudio: () => ipcRenderer.invoke("delete-all-audio"),
  syncRetentionSettings: (settings) => ipcRenderer.send("retention-settings-changed", settings),
  updateTranscriptionText: (id, text, rawText) =>
    ipcRenderer.invoke("update-transcription-text", id, text, rawText),
  getTranscriptionById: (id) => ipcRenderer.invoke("get-transcription-by-id", id),

  // Dictionary functions
  getDictionary: () => ipcRenderer.invoke("db-get-dictionary"),
  setDictionary: (words) => ipcRenderer.invoke("db-set-dictionary", words),
  applyDictionaryChanges: (changes) => ipcRenderer.invoke("db-apply-dictionary-changes", changes),
  onDictionaryUpdated: (callback) => {
    const listener = (_event, words) => callback?.(words);
    ipcRenderer.on("dictionary-updated", listener);
    return () => ipcRenderer.removeListener("dictionary-updated", listener);
  },
  getSnippets: () => ipcRenderer.invoke("db-get-snippets"),
  setSnippets: (snippets) => ipcRenderer.invoke("db-set-snippets", snippets),
  onSnippetsUpdated: (callback) => {
    const listener = (_event, snippets) => callback?.(snippets);
    ipcRenderer.on("snippets-updated", listener);
    return () => ipcRenderer.removeListener("snippets-updated", listener);
  },
  setAutoLearnEnabled: (enabled) => ipcRenderer.send("auto-learn-changed", enabled),
  onCorrectionsLearned: (callback) => {
    const listener = (_event, words) => callback?.(words);
    ipcRenderer.on("corrections-learned", listener);
    return () => ipcRenderer.removeListener("corrections-learned", listener);
  },
  undoLearnedCorrections: (words) => ipcRenderer.invoke("undo-learned-corrections", words),

  // Note functions
  saveNote: (title, content, noteType, sourceFile, audioDuration, folderId, spaceId) =>
    ipcRenderer.invoke(
      "db-save-note",
      title,
      content,
      noteType,
      sourceFile,
      audioDuration,
      folderId,
      spaceId
    ),
  getNote: (id) => ipcRenderer.invoke("db-get-note", id),
  getNotes: (noteType, limit, folderId, spaceId) =>
    ipcRenderer.invoke("db-get-notes", noteType, limit, folderId, spaceId),
  getSpaceNotes: (spaceId, limit) => ipcRenderer.invoke("db-get-space-notes", spaceId, limit),
  updateNote: (id, updates) => ipcRenderer.invoke("db-update-note", id, updates),
  deleteNote: (id) => ipcRenderer.invoke("db-delete-note", id),
  exportNote: (noteId, format) => ipcRenderer.invoke("export-note", noteId, format),
  exportTranscript: (noteId, format, source) =>
    ipcRenderer.invoke("export-transcript", noteId, format, source),
  exportDictionary: (words) => ipcRenderer.invoke("export-dictionary", words),
  searchNotes: (query, limit, spaceId, folderId) =>
    ipcRenderer.invoke("db-search-notes", query, limit, spaceId, folderId),
  updateNoteCloudId: (id, cloudId) => ipcRenderer.invoke("db-update-note-cloud-id", id, cloudId),
  updateNoteShareState: (id, state) => ipcRenderer.invoke("db-update-note-share-state", id, state),

  // Folder functions
  getFolders: (spaceId) => ipcRenderer.invoke("db-get-folders", spaceId),
  createFolder: (name, spaceId) => ipcRenderer.invoke("db-create-folder", name, spaceId),
  deleteFolder: (id) => ipcRenderer.invoke("db-delete-folder", id),
  renameFolder: (id, name) => ipcRenderer.invoke("db-rename-folder", id, name),
  moveFolderToSpace: (id, spaceId) => ipcRenderer.invoke("db-move-folder-to-space", id, spaceId),
  getFolderNoteCounts: () => ipcRenderer.invoke("db-get-folder-note-counts"),

  // Space functions
  getSpaces: () => ipcRenderer.invoke("db-get-spaces"),
  setActiveAccountScope: (accountId, expectedAuthGeneration) =>
    ipcRenderer.invoke("set-active-account-scope", accountId, expectedAuthGeneration),
  getActiveAccountScope: () => ipcRenderer.invoke("get-active-account-scope"),
  onActiveAccountScopeChanged: registerListener(
    "active-account-scope-changed",
    (callback) => (_event, scope) => callback(scope)
  ),
  deleteAccountData: (accountId, expectedAuthGeneration, options) =>
    ipcRenderer.invoke("delete-account-data", accountId, expectedAuthGeneration, options),
  updateSpace: (id, updates) => ipcRenderer.invoke("db-update-space", id, updates),
  purgeSpace: (id, options) => ipcRenderer.invoke("db-purge-space", id, options),
  upsertSpaceFromCloud: (space) => ipcRenderer.invoke("db-upsert-space-from-cloud", space),
  setSpaceSyncStatus: (id, status) => ipcRenderer.invoke("db-set-space-sync-status", id, status),
  onSpacePurged: (callback) => {
    const listener = (_event, payload) => callback?.(payload);
    ipcRenderer.on("space-purged", listener);
    return () => ipcRenderer.removeListener("space-purged", listener);
  },
  onSpaceSynced: (callback) => {
    const listener = (_event, space) => callback?.(space);
    ipcRenderer.on("space-synced", listener);
    return () => ipcRenderer.removeListener("space-synced", listener);
  },

  // Note files (markdown mirror) functions
  noteFilesSetEnabled: (enabled, customPath, options) =>
    ipcRenderer.invoke("note-files-set-enabled", enabled, customPath, options),
  noteFilesSetPath: (path) => ipcRenderer.invoke("note-files-set-path", path),
  noteFilesRebuild: () => ipcRenderer.invoke("note-files-rebuild"),
  noteFilesGetDefaultPath: () => ipcRenderer.invoke("note-files-get-default-path"),
  noteFilesPickFolder: () => ipcRenderer.invoke("note-files-pick-folder"),
  granolaImportPickAndPreview: () => ipcRenderer.invoke("granola-import-pick-and-preview"),
  granolaImportRun: () => ipcRenderer.invoke("granola-import-run"),
  showNoteFile: (noteId) => ipcRenderer.invoke("show-note-file", noteId),
  showFolderInExplorer: (folderName) => ipcRenderer.invoke("show-folder-in-explorer", folderName),

  // Action functions
  getActions: () => ipcRenderer.invoke("db-get-actions"),
  getAction: (id) => ipcRenderer.invoke("db-get-action", id),
  createAction: (name, description, prompt, icon, fields) =>
    ipcRenderer.invoke("db-create-action", name, description, prompt, icon, fields),
  updateAction: (id, updates) => ipcRenderer.invoke("db-update-action", id, updates),
  deleteAction: (id) => ipcRenderer.invoke("db-delete-action", id),

  // Audio file operations
  selectAudioFile: (options) => ipcRenderer.invoke("select-audio-file", options),
  getFileSize: (filePath) => ipcRenderer.invoke("get-file-size", filePath),

  getPathForFile: (file) => {
    const filePath = webUtils.getPathForFile(file);
    // Register real dropped-file paths so the main-process audio allowlist accepts them.
    if (filePath) ipcRenderer.send("approve-audio-path", filePath);
    return filePath;
  },

  // URL audio download
  downloadUrlAudio: (url, downloadId) => ipcRenderer.invoke("download-url-audio", url, downloadId),
  cancelUrlDownload: (downloadId) => ipcRenderer.invoke("cancel-url-download", downloadId),
  deleteTempFile: (filePath) => ipcRenderer.invoke("delete-temp-file", filePath),
  onUrlDownloadProgress: registerListener(
    "url-download-progress",
    (callback) => (_event, data) => callback(data)
  ),

  onNoteAdded: (callback) => {
    const listener = (_event, note) => callback?.(note);
    ipcRenderer.on("note-added", listener);
    return () => ipcRenderer.removeListener("note-added", listener);
  },
  onNoteUpdated: (callback) => {
    const listener = (_event, note) => callback?.(note);
    ipcRenderer.on("note-updated", listener);
    return () => ipcRenderer.removeListener("note-updated", listener);
  },
  onNoteDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("note-deleted", listener);
    return () => ipcRenderer.removeListener("note-deleted", listener);
  },
  onNoteSynced: (callback) => {
    const listener = (_event, note) => callback?.(note);
    ipcRenderer.on("note-synced", listener);
    return () => ipcRenderer.removeListener("note-synced", listener);
  },
  onFolderSynced: (callback) => {
    const listener = (_event, folder) => callback?.(folder);
    ipcRenderer.on("folder-synced", listener);
    return () => ipcRenderer.removeListener("folder-synced", listener);
  },
  onFolderDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("folder-deleted", listener);
    return () => ipcRenderer.removeListener("folder-deleted", listener);
  },
  emitSyncEvent: (name, payload) => ipcRenderer.invoke("broadcast-sync-event", name, payload),
  onSyncEvent: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("sync-event", listener);
    return () => ipcRenderer.removeListener("sync-event", listener);
  },

  onActionCreated: (callback) => {
    const listener = (_event, action) => callback?.(action);
    ipcRenderer.on("action-created", listener);
    return () => ipcRenderer.removeListener("action-created", listener);
  },
  onActionUpdated: (callback) => {
    const listener = (_event, action) => callback?.(action);
    ipcRenderer.on("action-updated", listener);
    return () => ipcRenderer.removeListener("action-updated", listener);
  },
  onActionDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("action-deleted", listener);
    return () => ipcRenderer.removeListener("action-deleted", listener);
  },

  onTranscriptionAdded: (callback) => {
    const listener = (_event, transcription) => callback?.(transcription);
    ipcRenderer.on("transcription-added", listener);
    return () => ipcRenderer.removeListener("transcription-added", listener);
  },
  onTranscriptionDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("transcription-deleted", listener);
    return () => ipcRenderer.removeListener("transcription-deleted", listener);
  },
  onTranscriptionsCleared: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("transcriptions-cleared", listener);
    return () => ipcRenderer.removeListener("transcriptions-cleared", listener);
  },
  onTranscriptionUpdated: (callback) => {
    const listener = (_event, transcription) => callback?.(transcription);
    ipcRenderer.on("transcription-updated", listener);
    return () => ipcRenderer.removeListener("transcription-updated", listener);
  },
  onAnalyticsChanged: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("analytics-changed", listener);
    return () => ipcRenderer.removeListener("analytics-changed", listener);
  },

  // BYOK API keys (get/save for every provider in the secretKeys manifest)

  // Clipboard functions
  checkAccessibilityPermission: (silent) =>
    ipcRenderer.invoke("check-accessibility-permission", silent),
  promptAccessibilityPermission: () => ipcRenderer.invoke("prompt-accessibility-permission"),
  readClipboard: () => ipcRenderer.invoke("read-clipboard"),
  writeClipboard: (text) => ipcRenderer.invoke("write-clipboard", text),
  copyLeaderboardImage: (dataUrl) => ipcRenderer.invoke("leaderboard-copy-image", dataUrl),
  saveLeaderboardImage: (dataUrl, suggestedName) =>
    ipcRenderer.invoke("leaderboard-save-image", dataUrl, suggestedName),
  checkPasteTools: () => ipcRenderer.invoke("check-paste-tools"),

  // Voice drafts (chat input recordings)
  saveTempAudio: (buffer) => ipcRenderer.invoke("save-temp-audio", buffer),
  deleteTempAudio: (tempPath) => ipcRenderer.invoke("delete-temp-audio", tempPath),

  // Local Whisper functions (whisper.cpp)

  checkFFmpegAvailability: () => ipcRenderer.invoke("check-ffmpeg-availability"),

  // Whisper server functions (faster repeated transcriptions)

  // CUDA GPU acceleration
  listGpus: () => ipcRenderer.invoke("list-gpus"),

  getGpuDeviceIndex: (purpose) => ipcRenderer.invoke("get-gpu-device-index", purpose),
  detectGpu: () => ipcRenderer.invoke("detect-gpu"),

  // Vulkan GPU acceleration (whisper on AMD/Intel GPUs)

  // Main changed the installed packs or the remembered GPU failure (#1736)

  // One-time "GPU pack needs re-downloading" notice from the legacy-layout migration

  // Local Parakeet (NVIDIA) functions

  // Parakeet server functions (faster repeated transcriptions)

  // Diarization (speaker identification) functions
  // Speaker name mapping
  getSpeakerMappings: (noteId) => ipcRenderer.invoke("get-speaker-mappings", noteId),
  setSpeakerMapping: (noteId, speakerId, displayName, email, profileId) =>
    ipcRenderer.invoke("set-speaker-mapping", noteId, speakerId, displayName, email, profileId),
  removeSpeakerMapping: (noteId, speakerId) =>
    ipcRenderer.invoke("remove-speaker-mapping", noteId, speakerId),
  getSpeakerProfiles: () => ipcRenderer.invoke("get-speaker-profiles"),
  attachSpeakerEmail: (profileId, email) =>
    ipcRenderer.invoke("attach-speaker-email", profileId, email),

  // Window control functions
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  snapToMeetingMode: () => ipcRenderer.invoke("snap-to-meeting-mode"),
  restoreFromMeetingMode: () => ipcRenderer.invoke("restore-from-meeting-mode"),
  getPlatform: () => process.platform,

  // Cleanup function
  cleanupApp: () => ipcRenderer.invoke("cleanup-app"),
  relaunchApp: () => ipcRenderer.invoke("relaunch-app"),
  updateHotkey: (hotkey) => ipcRenderer.invoke("update-hotkey", hotkey),
  setHotkeyListeningMode: (enabled) => ipcRenderer.invoke("set-hotkey-listening-mode", enabled),
  getHotkeyModeInfo: (hotkey) => ipcRenderer.invoke("get-hotkey-mode-info", hotkey),
  getHyprlandConfigStatus: () => ipcRenderer.invoke("get-hyprland-config-status"),
  startWindowDrag: () => ipcRenderer.invoke("start-window-drag"),
  stopWindowDrag: () => ipcRenderer.invoke("stop-window-drag"),
  startControlPanelDrag: () => ipcRenderer.invoke("start-control-panel-drag"),
  stopControlPanelDrag: () => ipcRenderer.invoke("stop-control-panel-drag"),
  getMainWindowHorizontalDirection: () =>
    ipcRenderer.invoke("get-main-window-horizontal-direction"),
  onMainWindowHorizontalDirectionChanged: registerListener(
    "main-window-horizontal-direction-changed",
    (callback) => (_event, direction) => callback(direction)
  ),
  onMainWindowWillResize: registerListener(
    "main-window-will-resize",
    (callback) => (_event, resize) => callback(resize)
  ),
  ackMainWindowResizeMask: (token) => ipcRenderer.send("main-window-resize-mask-ready", token),
  setMainWindowInteractivity: (interactive) =>
    ipcRenderer.invoke("set-main-window-interactivity", interactive),
  setMainWindowInputRegion: (region) => ipcRenderer.invoke("set-main-window-input-region", region),
  onMainWindowVisibilityChanged: registerListener(
    "main-window-visibility-changed",
    (callback) => (_event, visible) => callback(visible)
  ),
  setNotificationInteractivity: (interactive) =>
    ipcRenderer.invoke("set-notification-interactivity", interactive),
  resizeMainWindow: (sizeKey) => ipcRenderer.invoke("resize-main-window", sizeKey),
  resizeAssistantWindowToContent: (surfaceHeight) =>
    ipcRenderer.invoke("resize-assistant-window-to-content", surfaceHeight),
  resizeDictationErrorWindowToContent: (surfaceHeight) =>
    ipcRenderer.invoke("resize-dictation-error-window-to-content", surfaceHeight),
  setAssistantPanelOpen: (open) => ipcRenderer.invoke("set-assistant-panel-open", open),
  setAssistantPanelBusy: (busy) => ipcRenderer.invoke("set-assistant-panel-busy", busy),

  // Update functions

  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getPostMigrationState: () => ipcRenderer.invoke("get-post-migration-state"),
  getOAuthProtocolRegistered: () => ipcRenderer.invoke("get-oauth-protocol-registered"),
  getOAuthProtocol: () => ipcRenderer.invoke("get-oauth-protocol"),
  markBundleMigrated: () => ipcRenderer.invoke("mark-bundle-migrated"),
  markBundleMigrationDismissed: () => ipcRenderer.invoke("mark-bundle-migration-dismissed"),

  // Update event listeners
  onUpdateAvailable: registerListener("update-available"),
  onUpdateNotAvailable: registerListener("update-not-available"),
  onUpdateDownloaded: registerListener("update-downloaded"),
  onUpdateDownloadProgress: registerListener("update-download-progress"),
  onUpdateError: registerListener("update-error"),

  // Audio event listeners
  onCancelHotkeyPressed: registerListener("cancel-hotkey-pressed", (cb) => () => cb()),
  registerCancelHotkey: (key) => ipcRenderer.invoke("register-cancel-hotkey", key),
  unregisterCancelHotkey: () => ipcRenderer.invoke("unregister-cancel-hotkey"),

  // External link opener
  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  // Model management functions

  getUiLanguage: () => ipcRenderer.invoke("get-ui-language"),
  saveUiLanguage: (language) => ipcRenderer.invoke("save-ui-language", language),
  setUiLanguage: (language) => ipcRenderer.invoke("set-ui-language", language),

  // xAI / Mistral transcription proxies (keys handled by the manifest bridge)

  // Corti API

  // Custom endpoint API keys

  // Enterprise provider key management

  // Dictation key persistence (file-based for reliable startup)
  getDictationKey: () => ipcRenderer.invoke("get-dictation-key"),
  getActiveDictationKey: () => ipcRenderer.invoke("get-active-dictation-key"),
  getEffectiveDefaultHotkey: () => ipcRenderer.invoke("get-effective-default-hotkey"),
  saveDictationKey: (key) => ipcRenderer.invoke("save-dictation-key", key),

  // Activation mode persistence (file-based for reliable startup)
  getActivationMode: () => ipcRenderer.invoke("get-activation-mode"),
  saveActivationMode: (mode) => ipcRenderer.invoke("save-activation-mode", mode),

  saveAllKeysToEnv: () => ipcRenderer.invoke("save-all-keys-to-env"),

  // Local reasoning

  // Anthropic reasoning

  // Enterprise reasoning (Bedrock, Azure, Vertex) — runs in main process so
  // Node-only SDKs (AWS/Azure/Google credential providers) can resolve.

  onEnterpriseStreamPart: registerListener(
    "enterprise-stream-part",
    (callback) => (_event, payload) => callback(payload)
  ),

  getManagedEnterpriseConfig: (accountId, workspaceId, expectedAuthGeneration, forceRefresh) =>
    ipcRenderer.invoke(
      "get-managed-enterprise-config",
      accountId,
      workspaceId,
      expectedAuthGeneration,
      forceRefresh
    ),
  onManagedEnterpriseConfigChanged: registerListener(
    "managed-enterprise-config-changed",
    (callback) => (_event, snapshot) => callback(snapshot)
  ),
  clearManagedEnterpriseIdentity: () => ipcRenderer.invoke("clear-managed-enterprise-identity"),

  // llama.cpp

  // llama-server

  // Vulkan GPU acceleration
  detectVulkanGpu: () => ipcRenderer.invoke("detect-vulkan-gpu"),

  getLogLevel: () => ipcRenderer.invoke("get-log-level"),
  log: (entry) => ipcRenderer.invoke("app-log", entry),

  // ydotool status check
  getYdotoolStatus: () => ipcRenderer.invoke("get-ydotool-status"),

  // Debug logging management
  getDebugState: () => ipcRenderer.invoke("get-debug-state"),
  setDebugLogging: (enabled) => ipcRenderer.invoke("set-debug-logging", enabled),
  openLogsFolder: () => ipcRenderer.invoke("open-logs-folder"),

  // System settings helpers for microphone/audio permissions
  requestMicrophoneAccess: () => ipcRenderer.invoke("request-microphone-access"),
  checkMicrophoneAccess: () => ipcRenderer.invoke("check-microphone-access"),
  getSystemDefaultMicrophone: (options) =>
    ipcRenderer.invoke("get-system-default-microphone", options),
  checkSystemAudioAccess: () => ipcRenderer.invoke("check-system-audio-access"),
  verifySystemAudioAccess: () => ipcRenderer.invoke("permission-guide-verify-system-audio"),
  requestSystemAudioAccess: () => ipcRenderer.invoke("request-system-audio-access"),
  openMicrophoneSettings: () => ipcRenderer.invoke("open-microphone-settings"),
  openSoundInputSettings: () => ipcRenderer.invoke("open-sound-input-settings"),
  openAccessibilitySettings: () => ipcRenderer.invoke("open-accessibility-settings"),
  openSystemAudioSettings: () => ipcRenderer.invoke("open-system-audio-settings"),
  openScreenRecordingSettings: () => ipcRenderer.invoke("open-screen-recording-settings"),
  checkScreenRecordingAccess: () => ipcRenderer.invoke("check-screen-recording-access"),
  requestScreenRecordingAccess: () => ipcRenderer.invoke("request-screen-recording-access"),
  captureScreenContext: () => ipcRenderer.invoke("capture-screen-context"),
  setScreenContextEnabled: (enabled) => ipcRenderer.invoke("screen-context-set-enabled", enabled),
  toggleMediaPlayback: () => ipcRenderer.invoke("toggle-media-playback"),
  pauseMediaPlayback: () => ipcRenderer.invoke("pause-media-playback"),
  resumeMediaPlayback: () => ipcRenderer.invoke("resume-media-playback"),

  authClearSession: () => ipcRenderer.invoke("auth-clear-session"),
  authGetToken: () => ipcRenderer.invoke("auth-get-token"),
  authGetTokenState: () => ipcRenderer.invoke("auth-get-token-state"),
  authSetToken: (token, expectedGeneration) =>
    ipcRenderer.invoke("auth-set-token", token, expectedGeneration),
  onAuthTokenStateChanged: registerListener(
    "auth-token-state-changed",
    (callback) => (_event, state) => callback(state)
  ),

  // OpenWhispr Cloud API
  cloudHealthCheck: () => ipcRenderer.invoke("cloud-health-check"),

  cloudStreamingUsage: (text, audioDurationSeconds, opts) =>
    ipcRenderer.invoke("cloud-streaming-usage", text, audioDurationSeconds, opts),
  cloudUsage: () => ipcRenderer.invoke("cloud-usage"),
  cloudCheckout: (opts) => ipcRenderer.invoke("cloud-checkout", opts),
  cloudBillingPortal: () => ipcRenderer.invoke("cloud-billing-portal"),
  cloudSwitchPlan: (opts) => ipcRenderer.invoke("cloud-switch-plan", opts),
  cloudPreviewSwitch: (opts) => ipcRenderer.invoke("cloud-preview-switch", opts),
  cloudApiRequest: (opts) => ipcRenderer.invoke("cloud-api-request", opts),

  getWorkspacePolicy: (accountId, expectedAuthGeneration) =>
    ipcRenderer.invoke("get-workspace-policy", accountId, expectedAuthGeneration),
  onWorkspacePolicyChanged: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("workspace-policy-changed", listener);
    return () => ipcRenderer.removeListener("workspace-policy-changed", listener);
  },

  // Cloud audio file transcription

  cancelUploadTranscription: (requestId) =>
    ipcRenderer.invoke("cancel-upload-transcription", requestId),

  onUploadTranscriptionProgress: registerListener(
    "upload-transcription-progress",
    (callback) => (_event, data) => callback(data)
  ),

  // Referral stats
  getReferralStats: () => ipcRenderer.invoke("get-referral-stats"),
  sendReferralInvite: (email) => ipcRenderer.invoke("send-referral-invite", email),
  getReferralInvites: () => ipcRenderer.invoke("get-referral-invites"),

  // Assembly AI Streaming

  // Deepgram Streaming

  // Gemini Live Streaming

  // Corti streaming (BYOK)

  // Meeting transcription (streaming, dual-channel)
  meetingTranscriptionPrepare: (options) =>
    ipcRenderer.invoke("meeting-transcription-prepare", options),
  meetingTranscriptionStart: (options) =>
    ipcRenderer.invoke("meeting-transcription-start", options),
  meetingTranscriptionSend: (buffer, source, sessionId) =>
    ipcRenderer.send("meeting-transcription-send", buffer, source, sessionId),
  meetingTranscriptionSetSystemAudioAvailable: (sessionId, available) =>
    ipcRenderer.invoke("meeting-transcription-set-system-audio-available", sessionId, available),
  meetingTranscriptionStop: (expectedSessionId) =>
    ipcRenderer.invoke("meeting-transcription-stop", expectedSessionId),
  meetingTranscriptionCancel: (sessionId) =>
    ipcRenderer.invoke("meeting-transcription-cancel", sessionId),
  onMeetingTranscriptionSegment: registerListener(
    "meeting-transcription-segment",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSpeakerIdentified: registerListener(
    "meeting-speaker-identified",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSpeakersMerged: registerListener(
    "meeting-speakers-merged",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSessionSpeakerConfigUpdated: registerListener(
    "meeting-session-speaker-config-updated",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingTranscriptionError: registerListener(
    "meeting-transcription-error",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingTranscriptionFatalError: registerListener(
    "meeting-transcription-fatal-error",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSystemAudioSilent: registerListener(
    "meeting-system-audio-silent",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSystemAudioDegraded: registerListener(
    "meeting-system-audio-degraded",
    (callback) => () => callback()
  ),
  onMeetingSystemAudioInterrupted: registerListener(
    "meeting-system-audio-interrupted",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSystemAudioResumed: registerListener(
    "meeting-system-audio-resumed",
    (callback) => () => callback()
  ),

  // Dictation realtime streaming

  // Usage limit events (for showing UpgradePrompt in ControlPanel)
  notifyLimitReached: (data) => ipcRenderer.send("limit-reached", data),
  onLimitReached: registerListener("limit-reached", (callback) => (_event, data) => callback(data)),

  // Workspace invitation deep link
  onWorkspaceInvitationToken: registerListener(
    "workspace-invitation-token",
    (callback) => (_event, token) => callback(token)
  ),
  getPendingInvitationToken: () => ipcRenderer.invoke("get-pending-invitation-token"),

  // Globe key listener for hotkey capture (macOS only)
  onGlobeKeyPressed: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("globe-key-pressed", listener);
    return () => ipcRenderer.removeListener("globe-key-pressed", listener);
  },
  onGlobeKeyReleased: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("globe-key-released", listener);
    return () => ipcRenderer.removeListener("globe-key-released", listener);
  },

  // Hotkey registration events (for notifying user when hotkey fails)
  onHotkeyFallbackUsed: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("hotkey-fallback-used", listener);
    return () => ipcRenderer.removeListener("hotkey-fallback-used", listener);
  },
  onHotkeyRegistrationFailed: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("hotkey-registration-failed", listener);
    return () => ipcRenderer.removeListener("hotkey-registration-failed", listener);
  },
  onSettingUpdated: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("setting-updated", listener);
    return () => ipcRenderer.removeListener("setting-updated", listener);
  },
  onDictationKeyActive: (callback) => {
    const listener = (_event, key) => callback?.(key);
    ipcRenderer.on("dictation-key-active", listener);
    return () => ipcRenderer.removeListener("dictation-key-active", listener);
  },
  onWindowsPushToTalkUnavailable: registerListener("windows-ptt-unavailable"),
  onLinuxPttPermissionDenied: registerListener(
    "linux-ptt-permission-denied",
    (callback) => () => callback()
  ),

  // Settings shortcut (Cmd+, / Ctrl+,)
  onShowSettings: registerListener("show-settings", (callback) => () => callback()),
  getPendingSettingsSection: () => ipcRenderer.invoke("get-pending-settings-section"),

  // Accessibility permission events (macOS)
  onAccessibilityMissing: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("accessibility-missing", listener);
    return () => ipcRenderer.removeListener("accessibility-missing", listener);
  },
  checkAccessibilityTrusted: () => ipcRenderer.invoke("check-accessibility-trusted"),

  // Notify main process of activation mode changes (for Windows Push-to-Talk)
  notifyActivationModeChanged: (mode) => ipcRenderer.send("activation-mode-changed", mode),
  notifyHotkeyChanged: (hotkey) => ipcRenderer.send("hotkey-changed", hotkey),
  registerMeetingHotkey: (hotkey) => ipcRenderer.invoke("register-meeting-hotkey", hotkey),

  // Floating icon auto-hide
  notifyFloatingIconAutoHideChanged: (enabled) =>
    ipcRenderer.send("floating-icon-auto-hide-changed", enabled),
  onFloatingIconAutoHideChanged: registerListener(
    "floating-icon-auto-hide-changed",
    (callback) => (_event, enabled) => callback(enabled)
  ),

  // Panel start position
  notifyPanelStartPositionChanged: (position) =>
    ipcRenderer.send("panel-start-position-changed", position),

  // Start minimized
  notifyStartMinimizedChanged: (enabled) => ipcRenderer.send("start-minimized-changed", enabled),

  // Auto-start management

  // Agent mode
  updateVoiceAgentHotkey: (hotkey) => ipcRenderer.invoke("update-voice-agent-hotkey", hotkey),
  getVoiceAgentKey: () => ipcRenderer.invoke("get-voice-agent-key"),
  updateTranslationHotkey: (hotkey) => ipcRenderer.invoke("update-translation-hotkey", hotkey),
  getTranslationKey: () => ipcRenderer.invoke("get-translation-key"),
  onPreviewText: registerListener("preview-text", (callback) => (_event, text) => callback(text)),
  onPreviewAppend: registerListener(
    "preview-append",
    (callback) => (_event, text) => callback(text)
  ),
  onPreviewHold: registerListener(
    "preview-hold",
    (callback) => (_event, payload) => callback(payload)
  ),
  onPreviewResult: registerListener(
    "preview-result",
    (callback) => (_event, payload) => callback(payload)
  ),
  onPreviewHide: registerListener("preview-hide", (callback) => () => callback()),
  startDictationPreview: (opts) => ipcRenderer.invoke("start-dictation-preview", opts),
  stopDictationPreview: (opts) => ipcRenderer.invoke("stop-dictation-preview", opts),
  dismissDictationPreview: () => ipcRenderer.invoke("dismiss-dictation-preview"),
  updateDictationPreview: (text) => ipcRenderer.invoke("update-dictation-preview", text),
  completeDictationPreview: (payload) => ipcRenderer.invoke("complete-dictation-preview", payload),
  hideDictationPreview: () => ipcRenderer.invoke("hide-dictation-preview"),
  acquireRecordingLock: (pipeline) => ipcRenderer.invoke("acquire-recording-lock", pipeline),
  releaseRecordingLock: (pipeline) => ipcRenderer.invoke("release-recording-lock", pipeline),

  // Agent cloud streaming (event-based for real-time chunks)

  // Agent cloud tools
  agentWebSearch: (query, numResults) => ipcRenderer.invoke("agent-web-search", query, numResults),
  agentOpenNote: (noteId) => ipcRenderer.invoke("agent-open-note", noteId),

  // Agent conversation persistence
  createAgentConversation: (title, noteId, spaceId, folderId) =>
    ipcRenderer.invoke("db-create-agent-conversation", title, noteId, spaceId, folderId),
  getAgentConversations: (limit) => ipcRenderer.invoke("db-get-agent-conversations", limit),
  getAgentConversation: (id) => ipcRenderer.invoke("db-get-agent-conversation", id),
  deleteAgentConversation: (id) => ipcRenderer.invoke("db-delete-agent-conversation", id),
  updateAgentConversationTitle: (id, title) =>
    ipcRenderer.invoke("db-update-agent-conversation-title", id, title),
  addAgentMessage: (conversationId, role, content, metadata) =>
    ipcRenderer.invoke("db-add-agent-message", conversationId, role, content, metadata),
  getAgentMessages: (conversationId) => ipcRenderer.invoke("db-get-agent-messages", conversationId),
  getAgentConversationsWithPreview: (limit, offset, includeArchived) =>
    ipcRenderer.invoke("db-get-agent-conversations-with-preview", limit, offset, includeArchived),
  searchAgentConversations: (query, limit) =>
    ipcRenderer.invoke("db-search-agent-conversations", query, limit),
  getConversationsForNote: (noteId, limit) =>
    ipcRenderer.invoke("db-get-conversations-for-note", noteId, limit),
  getConversationsForContainer: (spaceId, folderId, limit) =>
    ipcRenderer.invoke("db-get-conversations-for-container", spaceId, folderId, limit),
  archiveAgentConversation: (id) => ipcRenderer.invoke("db-archive-agent-conversation", id),
  unarchiveAgentConversation: (id) => ipcRenderer.invoke("db-unarchive-agent-conversation", id),
  updateAgentConversationCloudId: (id, cloudId) =>
    ipcRenderer.invoke("db-update-agent-conversation-cloud-id", id, cloudId),

  // Sync operations
  getPendingNotes: (spaceKind) => ipcRenderer.invoke("db-get-pending-notes", spaceKind),
  getPendingNoteDeletes: () => ipcRenderer.invoke("db-get-pending-note-deletes"),
  getNoteByClientId: (clientNoteId) => ipcRenderer.invoke("db-get-note-by-client-id", clientNoteId),
  upsertNoteFromCloud: (cloudNote, localFolderId, localSpaceId) =>
    ipcRenderer.invoke("db-upsert-note-from-cloud", cloudNote, localFolderId, localSpaceId),
  acknowledgeNoteCreate: (id, snapshot, cloudId, cloudUpdatedAt, ownerUserId, settleIfUnchanged) =>
    ipcRenderer.invoke(
      "db-acknowledge-note-create",
      id,
      snapshot,
      cloudId,
      cloudUpdatedAt,
      ownerUserId,
      settleIfUnchanged
    ),
  markNoteSyncedIfUnchanged: (id, snapshot, expectedCloudId, cloudUpdatedAt, ownerUserId) =>
    ipcRenderer.invoke(
      "db-mark-note-synced-if-unchanged",
      id,
      snapshot,
      expectedCloudId,
      cloudUpdatedAt,
      ownerUserId
    ),
  setNoteCloudBase: (id, cloudUpdatedAt) =>
    ipcRenderer.invoke("db-set-note-cloud-base", id, cloudUpdatedAt),
  setNoteOwnerFromCloud: (id, ownerUserId) =>
    ipcRenderer.invoke("db-set-note-owner-from-cloud", id, ownerUserId),
  countTeamNotesMissingOwner: () => ipcRenderer.invoke("db-count-team-notes-missing-owner"),
  markNoteSyncError: (id) => ipcRenderer.invoke("db-mark-note-sync-error", id),
  restoreNoteAfterDeniedDelete: (id) =>
    ipcRenderer.invoke("db-restore-note-after-denied-delete", id),
  hardDeleteNote: (id) => ipcRenderer.invoke("db-hard-delete-note", id),

  getPendingFolders: (spaceKind) => ipcRenderer.invoke("db-get-pending-folders", spaceKind),
  getFolderByClientId: (clientFolderId) =>
    ipcRenderer.invoke("db-get-folder-by-client-id", clientFolderId),
  upsertFolderFromCloud: (cloudFolder, localSpaceId) =>
    ipcRenderer.invoke("db-upsert-folder-from-cloud", cloudFolder, localSpaceId),
  acknowledgeFolderCreate: (
    id,
    snapshot,
    expectedCloudId,
    responseClientFolderId,
    cloudId,
    cloudUpdatedAt
  ) =>
    ipcRenderer.invoke(
      "db-acknowledge-folder-create",
      id,
      snapshot,
      expectedCloudId,
      responseClientFolderId,
      cloudId,
      cloudUpdatedAt
    ),
  markFolderSyncedIfUnchanged: (id, snapshot, expectedCloudId) =>
    ipcRenderer.invoke("db-mark-folder-synced-if-unchanged", id, snapshot, expectedCloudId),
  getFolderIdMap: () => ipcRenderer.invoke("db-get-folder-id-map"),
  getPendingFolderDeletes: () => ipcRenderer.invoke("db-get-pending-folder-deletes"),
  restoreFolderAfterDeniedDelete: (id) =>
    ipcRenderer.invoke("db-restore-folder-after-denied-delete", id),
  hardDeleteFolder: (id) => ipcRenderer.invoke("db-hard-delete-folder", id),
  relocateRevokedFolder: (id, privateSpaceId, preserveFolder) =>
    ipcRenderer.invoke("db-relocate-revoked-folder", id, privateSpaceId, preserveFolder),

  getPendingConversations: () => ipcRenderer.invoke("db-get-pending-conversations"),
  getPendingConversationDeletes: () => ipcRenderer.invoke("db-get-pending-conversation-deletes"),
  getConversationByClientId: (clientId) =>
    ipcRenderer.invoke("db-get-conversation-by-client-id", clientId),
  upsertConversationFromCloud: (cloudConv, messages) =>
    ipcRenderer.invoke("db-upsert-conversation-from-cloud", cloudConv, messages),
  acknowledgeConversationCreate: (id, snapshot, cloudId) =>
    ipcRenderer.invoke("db-acknowledge-conversation-create", id, snapshot, cloudId),
  markConversationSynced: (id, cloudId) =>
    ipcRenderer.invoke("db-mark-conversation-synced", id, cloudId),
  hardDeleteConversation: (id) => ipcRenderer.invoke("db-hard-delete-conversation", id),

  getPendingTranscriptions: () => ipcRenderer.invoke("db-get-pending-transcriptions"),
  getTranscriptionByClientId: (clientId) =>
    ipcRenderer.invoke("db-get-transcription-by-client-id", clientId),
  upsertTranscriptionFromCloud: (cloudTranscription) =>
    ipcRenderer.invoke("db-upsert-transcription-from-cloud", cloudTranscription),
  markTranscriptionSynced: (id, cloudId) =>
    ipcRenderer.invoke("db-mark-transcription-synced", id, cloudId),
  getPendingTranscriptionDeletes: () => ipcRenderer.invoke("db-get-pending-transcription-deletes"),
  hardDeleteTranscription: (id) => ipcRenderer.invoke("db-hard-delete-transcription", id),

  getPendingDictionary: () => ipcRenderer.invoke("db-get-pending-dictionary"),
  getPendingDictionaryDeletes: () => ipcRenderer.invoke("db-get-pending-dictionary-deletes"),
  getDictionaryByClientId: (clientDictId) =>
    ipcRenderer.invoke("db-get-dictionary-by-client-id", clientDictId),
  upsertDictionaryFromCloud: (cloudEntry) =>
    ipcRenderer.invoke("db-upsert-dictionary-from-cloud", cloudEntry),
  markDictionarySynced: (id, cloudId) =>
    ipcRenderer.invoke("db-mark-dictionary-synced", id, cloudId),
  hardDeleteDictionary: (id) => ipcRenderer.invoke("db-hard-delete-dictionary", id),
  clearDictionaryCloudId: (id) => ipcRenderer.invoke("db-clear-dictionary-cloud-id", id),
  broadcastDictionaryUpdated: () => ipcRenderer.invoke("db-broadcast-dictionary-updated"),

  getPendingSnippets: () => ipcRenderer.invoke("db-get-pending-snippets"),
  getPendingSnippetDeletes: () => ipcRenderer.invoke("db-get-pending-snippet-deletes"),
  getSnippetForCloudMerge: (cloudEntry) =>
    ipcRenderer.invoke("db-get-snippet-for-cloud-merge", cloudEntry),
  upsertSnippetFromCloud: (cloudEntry) =>
    ipcRenderer.invoke("db-upsert-snippet-from-cloud", cloudEntry),
  markSnippetSynced: (id, cloudId, serverUpdatedAt, expectedTrigger, expectedReplacement) =>
    ipcRenderer.invoke(
      "db-mark-snippet-synced",
      id,
      cloudId,
      serverUpdatedAt,
      expectedTrigger,
      expectedReplacement
    ),
  hardDeleteSnippet: (id) => ipcRenderer.invoke("db-hard-delete-snippet", id),
  clearSnippetCloudId: (id) => ipcRenderer.invoke("db-clear-snippet-cloud-id", id),
  broadcastSnippetsUpdated: () => ipcRenderer.invoke("db-broadcast-snippets-updated"),

  // Google Calendar
  gcalStartOAuth: () => ipcRenderer.invoke("gcal-start-oauth"),
  gcalDisconnect: (email) => ipcRenderer.invoke("gcal-disconnect", email),
  gcalGetConnectionStatus: () => ipcRenderer.invoke("gcal-get-connection-status"),
  gcalGetCalendars: () => ipcRenderer.invoke("gcal-get-calendars"),
  gcalSetCalendarSelection: (calendarId, isSelected) =>
    ipcRenderer.invoke("gcal-set-calendar-selection", calendarId, isSelected),
  gcalSetPrimaryOnly: (value) => ipcRenderer.invoke("gcal-set-primary-only", value),
  gcalSyncEvents: () => ipcRenderer.invoke("gcal-sync-events"),
  gcalGetUpcomingEvents: (windowMinutes) =>
    ipcRenderer.invoke("gcal-get-upcoming-events", windowMinutes),
  connectorStatus: () => ipcRenderer.invoke("connector-status"),
  connectorPrepare: (connectorId, action, args) =>
    ipcRenderer.invoke("connector-prepare", connectorId, action, args),
  connectorQuery: (connectorId, action, args) =>
    ipcRenderer.invoke("connector-query", connectorId, action, args),
  connectorCommit: (actionId, edits) => ipcRenderer.invoke("connector-commit", actionId, edits),
  connectorCancel: (actionId, reason) => ipcRenderer.invoke("connector-cancel", actionId, reason),
  connectorRunDirect: (connectorId, action, args, runId) =>
    ipcRenderer.invoke("connector-run-direct", connectorId, action, args, runId),
  connectorRecentActions: (connectorId, limit) =>
    ipcRenderer.invoke("connector-recent-actions", connectorId, limit),
  connectorFindContacts: (query) => ipcRenderer.invoke("connector-find-contacts", query),
  connectorNoteAttendees: (request) => ipcRenderer.invoke("connector-note-attendees", request),
  connectorConnect: (connectorId) => ipcRenderer.invoke("connector-connect", connectorId),
  connectorCancelConnect: (connectorId) =>
    ipcRenderer.invoke("connector-cancel-connect", connectorId),
  connectorDisconnect: (connectorId) => ipcRenderer.invoke("connector-disconnect", connectorId),
  onConnectorStatusChanged: (callback) => {
    const listener = (_event, statuses) => callback(statuses);
    ipcRenderer.on("connector-status-changed", listener);
    return () => ipcRenderer.removeListener("connector-status-changed", listener);
  },
  // A connect's progress, such as the code GitHub's device flow shows.
  onConnectorConnectProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("connector-connect-progress", listener);
    return () => ipcRenderer.removeListener("connector-connect-progress", listener);
  },
  calendarGetAvailability: (request) => ipcRenderer.invoke("calendar-get-availability", request),
  gcalGetEvent: (eventId) => ipcRenderer.invoke("gcal-get-event", eventId),

  // Microsoft Calendar
  mcalStartOAuth: () => ipcRenderer.invoke("mcal-start-oauth"),
  mcalDisconnect: (email) => ipcRenderer.invoke("mcal-disconnect", email),
  mcalGetConnectionStatus: () => ipcRenderer.invoke("mcal-get-connection-status"),
  mcalSetPrimaryOnly: (value) => ipcRenderer.invoke("mcal-set-primary-only", value),

  // Apple Calendar (macOS EventKit)
  acalConnect: () => ipcRenderer.invoke("acal-connect"),
  acalDisconnect: () => ipcRenderer.invoke("acal-disconnect"),
  acalGetConnectionStatus: () => ipcRenderer.invoke("acal-get-connection-status"),
  openCalendarPrivacySettings: () => ipcRenderer.invoke("open-calendar-privacy-settings"),

  // Contacts
  searchContacts: (query) => ipcRenderer.invoke("search-contacts", query),
  upsertContact: (contact) => ipcRenderer.invoke("upsert-contact", contact),
  getMD5Hash: (text) => ipcRenderer.invoke("get-md5-hash", text),

  // Google Calendar event listeners
  onGcalConnectionChanged: registerListener(
    "gcal-connection-changed",
    (callback) => (_event, data) => callback(data)
  ),
  onGcalEventsSynced: registerListener(
    "gcal-events-synced",
    (callback) => (_event, data) => callback(data)
  ),

  // Microsoft Calendar event listeners
  onMcalConnectionChanged: registerListener(
    "mcal-connection-changed",
    (callback) => (_event, data) => callback(data)
  ),
  onMcalEventsSynced: registerListener(
    "mcal-events-synced",
    (callback) => (_event, data) => callback(data)
  ),

  // Apple Calendar event listeners
  onAcalConnectionChanged: registerListener(
    "acal-connection-changed",
    (callback) => (_event, data) => callback(data)
  ),
  onAcalEventsSynced: registerListener(
    "acal-events-synced",
    (callback) => (_event, data) => callback(data)
  ),

  // Meeting detection
  syncNotificationPreferences: (prefs) =>
    ipcRenderer.invoke("sync-notification-preferences", prefs),
  setSpeakerDiarizationEnabled: (enabled) =>
    ipcRenderer.invoke("meeting-set-speaker-diarization-enabled", { enabled }),
  setMeetingSessionSpeakerConfig: (config) =>
    ipcRenderer.invoke("meeting-set-session-speaker-config", config),

  onMeetingNotificationData: registerListener(
    "meeting-notification-data",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingAutoEndRequested: registerListener(
    "meeting-auto-end-requested",
    (callback) => (_event, data) => callback(data)
  ),
  getMeetingNotificationDestination: () =>
    ipcRenderer.invoke("get-meeting-notification-destination"),
  selectMeetingNotificationFolder: (folder) =>
    ipcRenderer.invoke("select-meeting-notification-folder", folder),
  createMeetingNotificationFolder: (request) =>
    ipcRenderer.invoke("create-meeting-notification-folder", request),
  onMeetingNotificationFolderCreated: registerListener(
    "meeting-notification-folder-created",
    (callback) => (_event, data) => callback(data)
  ),
  setMeetingNotificationSurface: (state) =>
    ipcRenderer.invoke("set-meeting-notification-surface", state),
  onMeetingNotificationSurfaceClosed: registerListener(
    "meeting-notification-surface-closed",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingNotificationSurfaceResized: registerListener(
    "meeting-notification-surface-resized",
    (callback) => (_event, data) => callback(data)
  ),
  getMeetingNotificationData: () => ipcRenderer.invoke("get-meeting-notification-data"),
  meetingNotificationReady: () => ipcRenderer.invoke("meeting-notification-ready"),
  meetingNotificationRespond: (detectionId, action, options) =>
    ipcRenderer.invoke("meeting-notification-respond", detectionId, action, options),
  confirmMeetingNoteNavigation: (navigationId, status) =>
    ipcRenderer.invoke("confirm-meeting-note-navigation", navigationId, status),
  joinCalendarMeeting: (eventId) => ipcRenderer.invoke("join-calendar-meeting", eventId),
  startManualMeeting: () => ipcRenderer.invoke("start-manual-meeting"),
  getPendingMeetingNoteNavigation: () => ipcRenderer.invoke("get-pending-meeting-note-navigation"),
  onMeetingNoteNavigationPending: registerListener(
    "meeting-note-navigation-pending",
    (callback) => () => callback()
  ),
  getPendingNoteNavigation: () => ipcRenderer.invoke("get-pending-note-navigation"),
  onNoteNavigationPending: registerListener(
    "note-navigation-pending",
    (callback) => () => callback()
  ),
});
