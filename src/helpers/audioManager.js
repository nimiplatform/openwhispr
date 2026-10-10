import { runNimiRequest } from "../services/nimiClient";
import { NimiPreview } from "./nimiPreview";
import { transcribeNimiRecording } from "../services/nimiRecording";
import { NIMI_USER_CANCEL } from "../services/nimiRequest";
import ReasoningService from "../services/ReasoningService";
import logger from "../utils/logger";

import { getBaseLanguageCode, getLanguageLabel } from "../utils/languageSupport";

import {
  applyChineseScript,
  mergeWhisperPrompt,
  resolveChineseScriptTarget,
  resolveCleanupLanguage,
} from "../utils/chineseScript";
import {
  createLocalSpeechGateState,
  getLocalSpeechGateDecision,
  recordLocalSpeechWindow,
} from "./localSpeechGate";
import { reacquireIfDead } from "./micTrackHealth";
import { isMicWarm, WARMUP_ACQUIRE_TIMEOUT_MS } from "./micWarmState";
import {
  PreparedMicCapture,
  disposePreparedCapture,
  discardPreRoll,
  PRE_ROLL_MAX_AGE_MS,
} from "./preparedMicCapture";
import { MicStreamHold } from "./micStreamHold";
import { PcmTap } from "./pcmTap";
import { PCM_WORKLET_SOURCE } from "./pcmWorklet";
import { ActiveMicRecoveryController } from "./activeMicRecovery";
import { followsSystemDefaultMic } from "./micSelectionRecovery";
import { isCacheableMicrophoneResolution, resolvePreferredMicrophone } from "./microphoneSelection";
import { isStaleDeviceError } from "./staleMicDevice";
import { shouldSaveDiscardedRecording } from "./discardedRecording";
import { countSpokenWords, localDateKey, resolveAnalyticsMode } from "./analytics";
import { getSettings, useSettingsStore } from "../stores/settingsStore";

import {
  effectiveAudioRetentionDays,
  effectiveLocalHistoryEnabled,
  isAgentAllowed,
  isCloudBackupAllowed,
  isNimiBusinessAIAllowed,
} from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";

import { transcriptionFailureOutcome } from "./transcriptionFailureOutcome";

import { shouldRunTranslateStep } from "./translationChain";
import { detectAgentName, stripAgentAddress } from "../config/agentDetection";
import { resolveWakeWordLanguage } from "./dictationRouting";

import { appendScreenContextSuffix, resolvePrompt } from "../config/prompts";
import { syncService } from "../services/SyncService.js";
import { evaluateFinishedRecording, withSalvageWarning } from "./recordingValidation";
import { isEmptyRecording } from "./recordingGuard";
import { matchesDictionaryPrompt } from "../utils/dictionaryEchoFilter.js";

import { getDictionaryHintWords } from "../utils/snippets";
import { normalizeAgentSelectionContext } from "../utils/agentSelectionContext";
import { getAgentName } from "../utils/agentName";

import {
  buildSelectionEditSystemPrompt,
  buildSelectionEditUserPrompt,
  extractSelectionEditReplacement,
  getSelectionCaptureDisposition,
} from "./selectionEditing";

const REASONING_CACHE_TTL = 30000; // 30 seconds
// A server-side rollout change (a provider switched on or rolled back) must
// reach a long-running app without a restart.
const STT_CONFIG_TTL_MS = 15 * 60 * 1000;
const RECORDING_TIMESLICE_MS = 250; // flush chunks periodically so short recordings still carry audio frames. See #871.
// Failure detector only: fires when the worklet or audio graph is dead and never flushes.
const PREVIEW_FLUSH_WATCHDOG_MS = 1000;
const neverCancelled = () => false;
const MIN_SPARSE_RECORDING_DURATION_SECONDS = 3;
const MIN_UNIQUE_WORD_GAIN = 2;

const cleanupFailureFromError = (error) => ({
  message: error?.message || String(error),
  ...(error?.messageKey ? { messageKey: error.messageKey } : {}),
  ...(error?.messageParams ? { messageParams: error.messageParams } : {}),
  ...(error?.surface ? { surface: error.surface } : {}),
  ...(error?.settingsTarget ? { settingsTarget: error.settingsTarget } : {}),
  ...(error?.action ? { action: error.action } : {}),
  ...(error?.actionKey ? { actionKey: error.actionKey } : {}),
  ...(error?.copyCommand ? { copyCommand: error.copyCommand } : {}),
  ...(error?.technicalDetails ? { technicalDetails: error.technicalDetails } : {}),
});

const cloudSignInRequiredError = () => {
  const err = new Error(
    "OpenWhispr Cloud requires sign-in. Please sign in again or switch to BYOK mode."
  );
  err.code = "AUTH_REQUIRED";
  err.messageKey = "hooks.audioRecording.errorDescriptions.sessionExpired";
  return err;
};

const micDeviceKey = (settings) =>
  `${settings.microphoneSelectionMode}|${settings.selectedMicDeviceId}`;

function getEffectiveRetentionPreferences() {
  const settings = getSettings();
  const policyState = usePolicyStore.getState();
  return {
    dataRetentionEnabled: effectiveLocalHistoryEnabled(policyState, settings.dataRetentionEnabled),
    audioRetentionDays: effectiveAudioRetentionDays(policyState, settings.audioRetentionDays),
  };
}

// Insights sync is opt-in, so nothing analytics-only may ride along on a cloud
// request until the user has enabled it. History retention gates it too: the
// local write below the same gate is skipped, and the cloud must not keep rows
// the device never recorded. Managed workspaces that forbid cloud backup forbid
// these counters with it — they are user data leaving the device like any other.
function analyticsSyncEnabled(settings = getSettings()) {
  return (
    settings.isSignedIn &&
    settings.insightsSyncEnabled &&
    isCloudBackupAllowed(usePolicyStore.getState()) &&
    getEffectiveRetentionPreferences().dataRetentionEnabled
  );
}

// The agent route appends image grounding only when it carries the real image.
function dictationAgentPrompt(settings, agentName) {
  return resolvePrompt("dictationAgent", {
    agentName,
    language: settings.preferredLanguage,
    customDictionary: getDictionaryHintWords(settings),
    uiLanguage: settings.uiLanguage,
  });
}

// Realtime providers expose no finalize handshake (unlike Deepgram/AssemblyAI/
// Corti), so the transcript tail lands whenever it lands — wait, don't sleep.
const STREAMING_FINAL_QUIET_MS = 250;
const STREAMING_FINAL_CEILING_MS = 2000;

// Both realtime providers share the dictation realtime IPC surface and differ
// only in the token-provider id. Forcing `provider` here (even though
// buildStreamingSessionOptions already stamps it) is pinned by
// audioManagerStreamingRouting.test.js: the hardened main-process allowlist
// fails closed on an options object that lost the tag (#1624).

// Batch providers that must transcribe via a main-process proxy (CORS,
// non-Bearer auth, OAuth, or attested transport) instead of a renderer fetch.
function audioExtensionForMime(mimeType) {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

// Workspace-managed Azure STT: the Entra token lives in the main process, so
// dictation dispatches over IPC exactly like the proxied providers below.

class AudioManager {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.isProcessing = false;
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.onPartialTranscript = null;
    this.micCaptureStatus = "inactive";
    this.cachedApiKey = null;
    this.cachedApiKeyProvider = null;
    this._micWarmedAt = 0;
    this._startInProgress = false;
    this._micOpenReported = false;
    this.preparedMicCapture = new PreparedMicCapture({
      dispose: (prepared) => this._disposePrepared(prepared),
      onActiveChange: () => this._syncMicOpenGate(),
    });
    const micSettings = getSettings();
    this._micHoldSeconds = Number(micSettings.micWarmHoldSeconds) || 0;
    this._micDeviceKey = micDeviceKey(micSettings);
    this.micStreamHold = new MicStreamHold({
      holdSeconds: this._micHoldSeconds,
      onHoldChange: () => this._syncMicOpenGate(),
      isBusy: () =>
        this.isRecording ||
        this.isStreaming ||
        this.mediaRecorder?.state === "recording" ||
        this.preparedMicCapture.active,
    });

    // Every window owns an AudioManager (dictation and the agent overlay), so
    // the hold has to follow the setting here rather than in one window's hook.
    this._unsubscribeSettings = useSettingsStore.subscribe((state) => {
      const holdSeconds = Number(state.micWarmHoldSeconds) || 0;
      if (holdSeconds !== this._micHoldSeconds) {
        this._micHoldSeconds = holdSeconds;
        this.micStreamHold.setHoldSeconds(holdSeconds);
      }
      const deviceKey = micDeviceKey(state);
      if (deviceKey !== this._micDeviceKey) {
        this._micDeviceKey = deviceKey;
        this.cachedMicDeviceId = null;
        this.rejectedMicDeviceId = null;
        this._micWarmedAt = 0;
        this.cancelPreparedMicCapture();
        this.micStreamHold.drop();
      }
    });

    this._onApiKeyChanged = () => {
      this.cachedApiKey = null;
      this.cachedApiKeyProvider = null;
    };
    window.addEventListener("api-key-changed", this._onApiKeyChanged);

    // Invalidate the pinned mic device when the OS adds/removes/suspends inputs.
    // Otherwise wake-after-idle keeps requesting a stale deviceId that yields silence.
    this._onDeviceChange = () => {
      this.cachedMicDeviceId = null;
      this._micWarmedAt = 0;
      this.rejectedMicDeviceId = null;
      this.cancelPreparedMicCapture();
      this.micStreamHold.drop();
      // The main process keeps the OS default mic until told it changed, so
      // re-resolve now rather than on the next hotkey press (~2s on Windows).
      window.electronAPI?.getSystemDefaultMicrophone?.({ refresh: true })?.catch(() => {});
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", this._onDeviceChange);
    this.recordingStartTime = null;
    this.reasoningAvailabilityCache = { value: false, expiresAt: 0 };
    this.cachedReasoningPreference = null;
    this.isStreaming = false;
    this.streamingAudioContext = null;
    this.streamingSource = null;
    this.streamingAnalyser = null;
    this.streamingProcessor = null;
    this.streamingStream = null;
    this.streamingCleanupFns = [];
    this.streamingFinalText = "";
    this.streamingPartialText = "";
    this.streamingTextBump = null;
    this.streamingTextDebounce = null;
    this.cachedMicDeviceId = null;
    this.rejectedMicDeviceId = null;
    this.persistentAudioContext = null;
    this.workletModuleLoaded = false;
    this.workletBlobUrl = null;
    this.streamingStartInProgress = false;
    this._streamingStartSettlementWaiters = [];
    this.stopRequestedDuringStreamingStart = false;
    this._streamingStopPromise = null;
    this._streamingStopMode = null;
    this._streamingSessionGeneration = 0;
    this._streamingCancellationGeneration = 0;
    this._activeTranscriptionAbortController = null;
    this._nimiPreview = null;
    this._activeStreamingSessionId = null;
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.translationApplied = false;
    this.pendingSelectionEdit = null;
    this.pendingAssistantConversation = null;
    this.pendingCleanupFailure = null;
    this._processingCancellationGeneration = 0;
    this._activeProcessingPipeline = null;
    this.assistantSelectionContext = null;
    this.screenContextPromise = null;
    this.selectionCapturePromise = null;
    this.sttConfig = null;
    this.sttConfigFetchedAt = null;
    this.streamingFallbackReason = null;
    this._streamingFailoverReason = null;
    this._streamingSpeechGateState = null;
    this.warmupFailureStreak = 0;
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    this._localSpeechGateState = null;
    this._streamingCommitActive = false;
    this._previewFlushResolve = null;
    this._batchSegments = [];
    this._batchPcmTap = null;
    this._rotatingBatchRecorder = null;
    this._rotationResolve = null;
    this._stopRequestedDuringMicRecovery = false;
    this._cancelRequestedDuringMicRecovery = false;
    this._streamingFallbackSegments = [];
    this._streamingMicSwapPromise = null;
    this.micRecovery = new ActiveMicRecoveryController({
      mediaDevices: navigator.mediaDevices,
      acquire: async (reason) => {
        try {
          const constraints = await this.getAudioConstraints(
            false,
            reason === "devicechange" || reason === "devicechange-ended"
          );
          return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (error) {
          logger.debug(
            "Preferred mic unavailable during recovery, falling back to default",
            { error: error.message },
            "audio"
          );
          const fallback = await this.getAudioConstraints(true);
          return navigator.mediaDevices.getUserMedia(fallback);
        }
      },
      onRecovered: (replacement, previous) => this.replaceActiveMic(replacement, previous),
      onStatusChange: (status) => this.setMicCaptureStatus(status),
    });
  }

  getCustomDictionaryPrompt() {
    const words = getDictionaryHintWords(getSettings());
    return words.length > 0 ? words.join(", ") : null;
  }

  // Script conversion targets whatever the user ends up pasting: the translation
  // target when translating, otherwise the dictation language. Using the STT
  // language here would force zh-TW source audio back to Traditional even when
  // the user asked to translate into Simplified.
  //
  // Only a completed translate step actually moves text into the target language.
  // When translation is unreachable, skipped or fails, the source transcript is
  // what gets pasted, so it must be scripted as the STT language — otherwise a
  // failed ja → zh-CN run would run Japanese through OpenCC (会議の資料 → 会议の数据).
  getEffectiveOutputLanguage(settings) {
    if (this.translationRequested && this.translationApplied) {
      return settings.translationTargetLanguage || "auto";
    }
    return this.getEffectiveSttLanguage(settings);
  }

  // Whisper only accepts language "zh"; script (简体/繁體) is applied here. See #975.
  // No transcript exists yet, so only an explicit zh-CN/zh-TW may bias the prompt.

  // Cleanup runs before the translate step, so it still works in the STT language.
  getCleanupLanguage(settings) {
    return resolveCleanupLanguage(this.getEffectiveSttLanguage(settings));
  }

  finalizeChineseScript(text, settings = getSettings()) {
    return applyChineseScript(
      text,
      resolveChineseScriptTarget(
        this.getEffectiveOutputLanguage(settings),
        settings.chineseScriptPreference,
        text
      )
    );
  }

  // Check the dictionary on its own as well as the full prompt: the echo filter needs
  // 70% of the prompt's words to appear, and a Chinese script bias counts as one more
  // word, which alone pushes a one- or two-term dictionary under the threshold.

  setCallbacks({
    onStateChange,
    onError,
    // Optional: the agent overlay has no dictation toast surface.
    onNoAudio = undefined,
    onTranscriptionComplete,
    onPartialTranscript,
    onPreviewUnavailable,
    onStreamingCommit,
    onTranslationFallback,
  }) {
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.onNoAudio = onNoAudio;
    this.onTranscriptionComplete = onTranscriptionComplete;
    this.onPartialTranscript = onPartialTranscript;
    this.onPreviewUnavailable = onPreviewUnavailable;
    this.onStreamingCommit = onStreamingCommit;
    this.onTranslationFallback = onTranslationFallback;
  }

  // Fail-open: translation degraded/failed but raw text is still pasted. Surface why.
  notifyTranslationFallback(reason) {
    this.onTranslationFallback?.({ reason });
  }

  setMicCaptureStatus(status) {
    if (this.micCaptureStatus === status) return;
    this.micCaptureStatus = status;
    this.onStateChange?.({
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      isStreaming: this.isStreaming,
      micCaptureStatus: status,
    });
  }

  async beginMicRecovery(stream) {
    // A stop/cancel can land during the awaits between recorder start and this
    // call; never arm recovery for a recording that already ended.
    if (!this.isRecording) return;
    await this.micRecovery.start(stream, {
      followDefault: followsSystemDefaultMic(getSettings()),
    });
  }

  async replaceActiveMic(replacement, previous) {
    if (!this.isRecording) throw new Error("Recording is no longer active");
    await this.replaceBatchMic(replacement, previous);
  }

  async mergeRecordedSegments(segments) {
    // Header-only segments carry no audio frames and crash FFmpeg's concat (#871).
    const usable = segments.filter((segment) => segment && !isEmptyRecording(segment.size));
    if (usable.length === 0) return null;
    if (usable.length === 1) return usable[0];
    const payload = await Promise.all(
      usable.map(async (segment) => ({
        buffer: await segment.arrayBuffer(),
        mimeType: segment.type || "audio/webm",
      }))
    );
    const result = await window.electronAPI.mergeAudioSegments(payload);
    if (!result?.success) throw new Error(result?.error || "Failed to merge audio segments");
    return new Blob([result.buffer], { type: result.mimeType });
  }

  getLargestRecordedSegment(segments) {
    return segments
      .filter((segment) => segment && !isEmptyRecording(segment.size))
      .reduce(
        (largest, segment) => (segment.size > (largest?.size || 0) ? segment : largest),
        null
      );
  }

  setVoiceAgentRequested(requested) {
    this.voiceAgentRequested = requested;
    this.pendingSelectionEdit = null;
    this.pendingAssistantConversation = null;
    this.pendingCleanupFailure = null;
    this.assistantSelectionContext = null;
    // No recording must ever see a stale capture (e.g. left over from a
    // cancelled voice-agent recording, even after the setting was turned
    // off). A live voice-agent start re-captures right after this call.
    this.screenContextPromise = null;
    // Same for a prefetched selection: bounded to one recording, so a read taken
    // in an earlier app can never be edited in place by this command.
    this.selectionCapturePromise = null;
  }

  setAssistantSelectionContext(context) {
    this.assistantSelectionContext = normalizeAgentSelectionContext(context);
    if (this.assistantSelectionContext) this.selectionCapturePromise = null;
  }

  consumeAssistantSelectionContext() {
    const context = this.assistantSelectionContext;
    this.assistantSelectionContext = null;
    return context;
  }

  setTranslationRequested(requested) {
    this.translationRequested = requested;
    this.translationApplied = false;
  }

  // In translation mode the STT hint is the configured source language, not
  // the UI-wide preferred language; "auto" keeps whisper auto-detection.
  getEffectiveSttLanguage(settings) {
    if (this.translationRequested) {
      return settings.translationSourceLanguage || "auto";
    }
    return settings.preferredLanguage;
  }

  // Kicked off at voice-agent recording start (so the screenshot reflects the
  // invocation moment) and consumed after transcription by the reasoning route.
  beginScreenContextCapture() {
    this.screenContextPromise = window.electronAPI?.captureScreenContext?.() ?? null;
  }

  // Kicked off at voice-agent recording start, alongside the screenshot, so the
  // read resolves while the user is still speaking. The editable-caret probe
  // only matters when auto-paste could deliver to that caret, so the flag
  // spares the main process a binary spawn otherwise.
  beginSelectionCapture() {
    this.selectionCapturePromise =
      window.electronAPI?.captureSelectedText?.({
        probeEditable: Boolean(getSettings().autoPasteEnabled),
      }) ?? null;
    // Marks the stored promise handled without consuming it: a failure nobody is
    // awaiting yet must not surface as an unhandled rejection, and the awaiting
    // caller must still see the original error.
    this.selectionCapturePromise?.catch(() => {});
  }

  consumeSelectionCapture() {
    const pending = this.selectionCapturePromise;
    this.selectionCapturePromise = null;
    return (
      pending ??
      window.electronAPI?.captureSelectedText?.({
        probeEditable: Boolean(getSettings().autoPasteEnabled),
      })
    );
  }

  async consumeScreenContext() {
    const pending = this.screenContextPromise;
    this.screenContextPromise = null;
    if (!pending) return null;
    try {
      // Capture resolves in well under a second; the race only protects the
      // paste path if the IPC ever hangs.
      const image = await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (!image) logger.logReasoning("SCREEN_CONTEXT_UNAVAILABLE", {});
      return image;
    } catch {
      return null;
    }
  }

  // An agent-route failure pastes the spoken command verbatim into the focused
  // app — surface that. Cleanup failures stay quiet; raw text is a fine result.
  _notifyAgentReasoningFailed() {
    this.onError?.({
      code: "AGENT_REASONING_FAILED",
      title: "Agent Unavailable",
      messageKey: "hooks.audioRecording.errorDescriptions.agentReasoningFailed",
    });
  }

  isRecordingAllowedByPolicy() {
    const policyState = usePolicyStore.getState();
    return (
      isNimiBusinessAIAllowed(policyState) &&
      (!this.voiceAgentRequested || isAgentAllowed(policyState))
    );
  }

  assertAgentAllowedByPolicy() {
    if (isAgentAllowed(usePolicyStore.getState())) return;
    const error = new Error("AI agent use is restricted by your organization.");
    error.code = "POLICY_RESTRICTED";
    error.messageKey = "common.policyAgentRestricted";
    throw error;
  }

  async getAudioConstraints(forceDefaultMic = false, refreshSystemDefault = false) {
    const settings = getSettings();

    // All browser audio processing disabled to avoid OS-level side-effects.
    // AGC off: Chromium's AGC on Windows mutates the system mic volume via WASAPI (#476).
    // Echo cancellation and noise suppression off to avoid latency and speech distortion.
    // Stereo recording required — mono WebM breaks silence detection on Linux/PipeWire (#472).
    const noProcessing = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    };

    if (
      !forceDefaultMic &&
      !refreshSystemDefault &&
      this.cachedMicDeviceId &&
      this.cachedMicDeviceId !== this.rejectedMicDeviceId
    ) {
      return {
        audio: { deviceId: { exact: this.cachedMicDeviceId }, ...noProcessing },
      };
    }

    try {
      const resolution = await resolvePreferredMicrophone({
        settings,
        forceSystemDefault: forceDefaultMic,
        refreshSystemDefault: forceDefaultMic || refreshSystemDefault,
      });
      const deviceId = resolution.device?.deviceId;

      if (deviceId && deviceId !== this.rejectedMicDeviceId) {
        if (isCacheableMicrophoneResolution(resolution)) {
          this.cachedMicDeviceId = deviceId;
        }
        logger.debug(
          "Resolved microphone input",
          {
            mode: resolution.mode,
            status: resolution.status,
            label: resolution.device.label,
          },
          "audio"
        );
        return { audio: { deviceId: { exact: deviceId }, ...noProcessing } };
      }

      logger.debug(
        "Microphone selection could not be pinned; using browser fallback",
        { mode: resolution.mode, status: resolution.status },
        "audio"
      );
    } catch (error) {
      logger.debug(
        "Failed to resolve microphone selection; using browser fallback",
        { error: error.message },
        "audio"
      );
    }

    return { audio: noProcessing };
  }

  async cacheMicrophoneDeviceId() {
    if (this.cachedMicDeviceId) return; // Already cached

    try {
      const resolution = await resolvePreferredMicrophone({ settings: getSettings() });
      if (isCacheableMicrophoneResolution(resolution)) {
        this.cachedMicDeviceId = resolution.device.deviceId;
        logger.debug(
          "Microphone device ID pre-cached",
          { mode: resolution.mode, status: resolution.status },
          "audio"
        );
      }
    } catch (error) {
      logger.debug("Failed to pre-cache microphone device ID", { error: error.message }, "audio");
    }
  }

  // Open the mic the moment a dictation is likely (push-to-talk key-down,
  // toggle press) and hand the same stream — plus everything its pre-roll
  // recorder already captured — to the real recording. Replaces the one-shot
  // warmupMicDriver (#845): a raced warm-up never resolved before the
  // recording's own open, so it only ever added a concurrent double open.
  async prepareMicCapture() {
    // Preparing opens the device, so it answers to the same policy as the
    // recording it anticipates — otherwise a blocked user's key-down would
    // still light the mic and buffer pre-roll.
    if (!this.isRecordingAllowedByPolicy()) return null;
    // A start already awaiting the mic open leaves isRecording false for as long
    // as that open takes, so without this guard a second prepare would open the
    // device again and buffer a pre-roll no recording ever answers.
    if (
      this._startInProgress ||
      this.isRecording ||
      this.isProcessing ||
      this.isStreaming ||
      this._streamingStopPromise ||
      this.mediaRecorder?.state === "recording"
    ) {
      return null;
    }
    try {
      const prepared = await this.preparedMicCapture.prepare(async () => {
        // Built before the mic opens so its graph is rendering by the time the
        // pre-roll recorder starts; a tap attached later misses the first frames.
        const pcmTap = this._startPcmTap();
        try {
          const constraints = await this.getAudioConstraints();
          const stream = await this._acquireCaptureStream(constraints);
          const value = {
            stream,
            constraints,
            recorder: null,
            chunks: [],
            pcmTap: null,
            startedAt: Date.now(),
          };
          this._startPreRollRecorder(value, pcmTap);
          if (!value.pcmTap) pcmTap?.close();
          return value;
        } catch (error) {
          pcmTap?.close();
          throw error;
        }
      });
      if (prepared) {
        logger.debug("Microphone capture prepared", { preRoll: !!prepared.recorder }, "audio");
      }
      return prepared;
    } catch (e) {
      logger.debug("Mic capture preparation failed (non-critical)", { error: e.message }, "audio");
      return null;
    }
  }

  cancelPreparedMicCapture() {
    this.preparedMicCapture.cancel();
  }

  // Tells the main process whether this renderer is holding the mic open outside
  // a recording — an idle hold or a prepared capture. Recordings are gated by
  // setUserRecording instead. Without this the device-global macOS/Linux mic
  // signal reports our own capture as a meeting.
  _syncMicOpenGate() {
    const open = this.micStreamHold.active || this.preparedMicCapture.active;
    if (open === this._micOpenReported) return;
    this._micOpenReported = open;
    window.electronAPI?.micWarmHoldChanged?.(open);
  }

  _disposePrepared(prepared) {
    if (!prepared) return;
    disposePreparedCapture(prepared);
    this._markCaptureStreamReleased();
  }

  // Record from the instant the prepared stream delivers frames. If the hold
  // guard confirms a real dictation these chunks become the recording's opening;
  // a cancel discards them without the audio ever leaving the renderer.
  _startPreRollRecorder(prepared, pcmTap) {
    try {
      const recorder = new MediaRecorder(prepared.stream);
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) prepared.chunks.push(event.data);
      };
      recorder.start(RECORDING_TIMESLICE_MS);
      pcmTap?.attach(prepared.stream);
      prepared.recorder = recorder;
      prepared.pcmTap = pcmTap;
    } catch (e) {
      logger.debug("Pre-roll recorder unavailable", { error: e.message }, "audio");
    }
  }

  getWorkletBlobUrl() {
    if (!this.workletBlobUrl) {
      this.workletBlobUrl = URL.createObjectURL(
        new Blob([PCM_WORKLET_SOURCE], { type: "application/javascript" })
      );
    }
    return this.workletBlobUrl;
  }

  // The PCM shadow provides finite previews and a complete 16 kHz WAV when
  // coverage is verified. Otherwise the original MediaRecorder audio wins.
  _startPcmTap() {
    try {
      return new PcmTap(this.getWorkletBlobUrl());
    } catch (e) {
      logger.debug("PCM tap unavailable", { error: e.message }, "audio");
      return null;
    }
  }

  _closeBatchPcmTap() {
    this._batchPcmTap?.close();
    this._batchPcmTap = null;
  }

  _constraintsKey(constraints) {
    return JSON.stringify(constraints?.audio ?? constraints ?? {});
  }

  _stampMicWarm() {
    this._micWarmedAt = Date.now();
  }

  // Every capture-stream release funnels through here: the driver was
  // demonstrably open, so stamp warmth (a free warm window for the next open,
  // replacing #1284's post-transcription re-warm and its extra device open)
  // and restart the idle-hold countdown.
  _markCaptureStreamReleased() {
    this._stampMicWarm();
    this.micStreamHold.touch();
  }

  async _acquireCaptureStream(constraints) {
    const key = this._constraintsKey(constraints);
    const held = this.micStreamHold.acquireClone(key);
    if (held) {
      this._stampMicWarm();
      return held;
    }
    const stream = await this.acquireHealthyMicStream(
      await navigator.mediaDevices.getUserMedia(constraints),
      constraints
    );
    this._stampMicWarm();
    return this.micStreamHold.adoptAndClone(stream, key);
  }

  // TTL-gated warm-up used only by the streaming-connection warm-up. The
  // recording paths never warm-then-discard — they open once via
  // prepareMicCapture and keep the stream. A stream resolving past the deadline
  // still stamps warmth: the driver did come up, which is exactly what the
  // slowest machines need recorded (#845).
  async _warmMicDriverIfCold(logCategory) {
    // A held master already has the driver up; opening a second device to prove
    // it is the concurrent double open this replaced.
    if (this.micStreamHold.active) {
      this._stampMicWarm();
      return;
    }
    if (isMicWarm(this._micWarmedAt, Date.now())) return;
    try {
      const constraints = await this.getAudioConstraints();
      const streamPromise = navigator.mediaDevices.getUserMedia(constraints);
      streamPromise
        .then((stream) => {
          stream.getTracks().forEach((track) => track.stop());
          this._stampMicWarm();
        })
        .catch(() => {});
      let timer = null;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("mic warmup timed out")),
          WARMUP_ACQUIRE_TIMEOUT_MS
        );
      });
      try {
        await Promise.race([streamPromise, deadline]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      logger.debug("Microphone driver pre-warmed", {}, logCategory);
    } catch (e) {
      logger.debug("Mic driver warmup failed (non-critical)", { error: e.message }, logCategory);
    }
  }

  // Recovers a dead/muted capture: retries the same device, then hops to the OS default,
  // remembering a silent pinned device for the session. Throws MicUnusableError when no
  // input delivers audio. See #1152.
  async acquireHealthyMicStream(rawStream, constraints) {
    const pinnedMicDeviceId = constraints.audio?.deviceId?.exact ?? null;
    let fallbackMicUnusable = false;
    // Keep verifying after a rejection too, otherwise a muted default records silence unnoticed.
    const verifyMic = pinnedMicDeviceId !== null || this.rejectedMicDeviceId !== null;
    const stream = await reacquireIfDead(
      rawStream,
      () => {
        this.cachedMicDeviceId = null;
        return this.getAudioConstraints();
      },
      logger,
      verifyMic
        ? {
            getConstraints: () => this.getAudioConstraints(true),
            onDeviceRejected: () => {
              if (pinnedMicDeviceId) this.rejectedMicDeviceId = pinnedMicDeviceId;
            },
            onFallbackUnusable: () => {
              fallbackMicUnusable = true;
            },
          }
        : null
    );

    if (fallbackMicUnusable) {
      stream.getTracks().forEach((track) => track.stop());
      const micError = new Error("No microphone is delivering audio");
      micError.name = "MicUnusableError";
      throw micError;
    }

    return stream;
  }

  async startRecording(forceDefaultMic = false) {
    let prepared = null;
    let preparedAdopted = false;
    let freshTap = null;
    this._startInProgress = true;
    try {
      if (!this.isRecordingAllowedByPolicy()) {
        logger.warn("Recording blocked by workspace policy", {}, "audio");
        return false;
      }
      if (
        this.isRecording ||
        this.isProcessing ||
        this.isStreaming ||
        this._streamingStopPromise ||
        this.mediaRecorder?.state === "recording"
      ) {
        return false;
      }

      const startRequestedAt = performance.now();
      prepared = forceDefaultMic ? null : await this.preparedMicCapture.take();
      const constraints =
        prepared?.constraints ?? (await this.getAudioConstraints(forceDefaultMic));
      // Without a prepared capture the tap starts here, before the mic opens.
      freshTap = prepared ? null : this._startPcmTap();
      const micStream = prepared?.stream ?? (await this._acquireCaptureStream(constraints));
      const micReadyAt = performance.now();

      const audioTrack = micStream.getAudioTracks()[0];

      if (audioTrack) {
        const settings = audioTrack.getSettings();
        logger.info(
          "Recording started with microphone",
          {
            label: audioTrack.label,
            deviceId: settings.deviceId?.slice(0, 20) + "...",
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
            muted: audioTrack.muted,
            readyState: audioTrack.readyState,
          },
          "audio"
        );
      }

      try {
        this._silenceCtx = new AudioContext();
        if (this._silenceCtx.state === "suspended") {
          // Not awaited — resume() can hang when the output device is wedged.
          this._silenceCtx.resume().catch(() => {});
        }
        this._silenceAnalyser = this._silenceCtx.createAnalyser();
        this._silenceAnalyser.fftSize = 2048;
        this._silenceSource = this._silenceCtx.createMediaStreamSource(micStream);
        this._silenceSource.connect(this._silenceAnalyser);
        this._localSpeechGateState = createLocalSpeechGateState();
        const dataArray = new Uint8Array(this._silenceAnalyser.fftSize);
        this._silenceInterval = setInterval(() => {
          // A stalled context reads flat silence; recording no windows fails the gate open.
          if (this._silenceCtx?.state !== "running") return;
          this._silenceAnalyser.getByteTimeDomainData(dataArray);
          let sum = 0;
          let peak = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const v = (dataArray[i] - 128) / 128;
            sum += v * v;
            const abs = Math.abs(v);
            if (abs > peak) peak = abs;
          }
          const rms = Math.sqrt(sum / dataArray.length);
          recordLocalSpeechWindow(this._localSpeechGateState, rms, peak);
        }, 100);
      } catch (e) {
        logger.warn("Audio level gate setup failed, skipping", { error: e.message }, "audio");
        this._localSpeechGateState = null;
      }

      this.audioChunks = [];
      this._batchSegments = [];
      this._closeBatchPcmTap();
      this._stopRequestedDuringMicRecovery = false;
      this._cancelRequestedDuringMicRecovery = false;
      this._receivedAudioData = false;
      const preRollUsable =
        prepared?.recorder?.state === "recording" &&
        Date.now() - prepared.startedAt <= PRE_ROLL_MAX_AGE_MS;
      if (!preRollUsable) discardPreRoll(prepared);
      const preRoll = preRollUsable
        ? { recorder: prepared.recorder, chunks: prepared.chunks }
        : null;
      // Pre-roll audio is part of the recording, so the reported duration
      // starts when the prepared stream started — but only when its recorder
      // was adopted; a prepared stream without pre-roll contributes no audio
      // before this point, and back-dating would inflate durationSeconds.
      this.recordingStartTime = preRoll ? prepared.startedAt : Date.now();
      // The tap shadows the recorder from its first frame: the pre-roll's own,
      // or the one built before the mic opened. A tap started now would miss
      // the opening, so an unusable pre-roll leaves the WebM path in charge.
      this._batchPcmTap = preRoll ? prepared.pcmTap : freshTap;
      this.createBatchRecorder(micStream, preRoll);
      freshTap?.attach(micStream);
      preparedAdopted = true;
      this.isRecording = true;
      this.onStateChange?.({
        isRecording: true,
        isProcessing: false,
        micCaptureStatus: "active",
      });
      logger.info(
        "Recording start timing",
        {
          micReadyMs: Math.round(micReadyAt - startRequestedAt),
          totalMs: Math.round(performance.now() - startRequestedAt),
          usedPreparedCapture: !!prepared,
          preparedAgeMs: prepared?.startedAt ? Date.now() - prepared.startedAt : 0,
        },
        "audio"
      );

      this._streamingCommitActive = false;
      if (
        getSettings().showTranscriptionPreview &&
        this._batchPcmTap &&
        !this.voiceAgentRequested
      ) {
        const language = getBaseLanguageCode(this.getEffectiveSttLanguage(getSettings())) || "";
        this._nimiPreview = new NimiPreview({
          transcribe: (audio, signal) =>
            runNimiRequest(
              "openwhispr.ai.transcribe",
              {
                audio,
                mimeType: "audio/wav",
                language,
                timestamps: false,
              },
              signal
            ),
          onText: (text) => this.onPartialTranscript?.(text),
          onError: (error) => {
            logger.warn("Nimi preview unavailable", { error: error.message }, "audio");
            window.electronAPI?.hideDictationPreview?.();
            this.onPreviewUnavailable?.();
          },
        });
        const preview = this._nimiPreview;
        this._batchPcmTap.onPcm = (samples) => preview.push(samples);
        for (const part of this._batchPcmTap.capturedPcm()) preview.push(part);
      }
      await this.beginMicRecovery(micStream);

      return true;
    } catch (error) {
      // A prepared value the recording never adopted still owns a live stream
      // (and possibly a pre-roll recorder); release it before any retry.
      freshTap?.close();
      if (prepared && !preparedAdopted) this._disposePrepared(prepared);
      if (isStaleDeviceError(error) && !forceDefaultMic) {
        // Pinned mic is gone (Chromium rotates IDs / device unplugged). Retry once on the default mic. See #900.
        logger.warn("Pinned microphone unavailable, retrying on default mic", {}, "audio");
        this.cachedMicDeviceId = null;
        return this.startRecording(true);
      }

      let errorTitle = "Recording Error";
      let errorDescription = `Failed to access microphone: ${error.message}`;

      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorTitle = "Microphone Access Denied";
        errorDescription =
          "Please grant microphone permission in your system settings and try again.";
      } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        errorTitle = "No Microphone Found";
        errorDescription = "No microphone was detected. Please connect a microphone and try again.";
      } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
        errorTitle = "Microphone In Use";
        errorDescription =
          "The microphone is being used by another application. Please close other apps and try again.";
      } else if (error.name === "MicUnusableError") {
        errorTitle = "Microphone Muted";
        errorDescription =
          "Your microphones stayed muted and produced no audio. Please check your sound input settings and try again.";
      }

      this.onError?.({
        title: errorTitle,
        description: errorDescription,
      });
      return false;
    } finally {
      this._startInProgress = false;
    }
  }

  createBatchRecorder(micStream, adoption = null) {
    // Adopting the pre-roll recorder keeps every chunk captured since key-down:
    // rebinding the handlers below transfers ownership with no gap and no
    // re-encode, and the seeded chunks become the recording's opening.
    const recorder = adoption?.recorder ?? new MediaRecorder(micStream);
    const segmentChunks = adoption ? [...adoption.chunks] : [];
    if (segmentChunks.length > 0) {
      this._receivedAudioData = true;
      // The speech-gate analyser only attaches at recording start, so it never
      // measured these frames. Fail the gate open rather than let it discard a
      // short utterance spoken entirely in pre-roll (#845).
      this._localSpeechGateState = null;
    }
    this.mediaRecorder = recorder;
    this.audioChunks = segmentChunks;
    this.recordingMimeType = recorder.mimeType || "audio/webm";

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this._receivedAudioData = true;
        segmentChunks.push(event.data);
      }
    };

    recorder.onstop = async () => {
      const segment = new Blob(segmentChunks, { type: recorder.mimeType || "audio/webm" });
      segmentChunks.length = 0;
      const rotating = this._rotatingBatchRecorder === recorder;
      // The recorder also stops on its own when its mic track dies (the stream
      // goes inactive). While recovery is armed, treat that like a rotation:
      // bank the segment and keep the recording alive for the replacement mic.
      if (rotating || this.micRecovery.started) {
        if (segment.size > 0) this._batchSegments.push(segment);
        micStream.getTracks().forEach((track) => track.stop());
        this._markCaptureStreamReleased();
        if (rotating) {
          this._rotatingBatchRecorder = null;
          this._rotationResolve?.();
          this._rotationResolve = null;
        } else {
          void this.micRecovery.recover("recorder-stopped");
        }
        return;
      }

      micStream.getTracks().forEach((track) => track.stop());
      this._markCaptureStreamReleased();
      await this.finalizeBatchRecording(segment);
    };

    if (!adoption) recorder.start(RECORDING_TIMESLICE_MS);
    return recorder;
  }

  async finalizeBatchRecording(finalSegment) {
    const processingPipeline = this._startProcessingPipeline();
    const wasCancelled = () => this._shouldAbandonProcessingPipeline(processingPipeline);
    this.micRecovery.stop();
    this.teardownSpeechGate();
    const previewStopPromise = this.cleanupPreview({
      showCleanup: this.shouldShowPreviewCleanupState(),
    });
    const rawWavPromise = this._batchPcmTap?.stop();
    this._batchPcmTap = null;
    this.isRecording = false;
    this.isProcessing = true;
    this.onStateChange?.({
      isRecording: false,
      isProcessing: true,
      micCaptureStatus: "inactive",
    });

    const segments = finalSegment ? [...this._batchSegments, finalSegment] : this._batchSegments;
    this._batchSegments = [];
    const segmentsCount = segments.filter((segment) => segment?.size > 0).length;
    let audioBlob = null;
    let salvagedRecording = false;
    try {
      audioBlob = await this.mergeRecordedSegments(segments);
    } catch (error) {
      if (wasCancelled()) {
        this._settleProcessingPipeline(processingPipeline);
        return;
      }
      logger.error("Failed to assemble recovered recording", { error: error.message }, "audio");
      // Salvage the largest segment rather than dropping the whole recording.
      audioBlob = this.getLargestRecordedSegment(segments);
      salvagedRecording = !!audioBlob;
    }
    if (wasCancelled()) {
      this._settleProcessingPipeline(processingPipeline);
      return;
    }
    audioBlob = audioBlob || new Blob([], { type: this.recordingMimeType || "audio/webm" });
    this.lastAudioBlob = audioBlob;

    logger.info(
      "Recording stopped",
      {
        blobSize: audioBlob.size,
        blobType: audioBlob.type,
        segmentsCount,
      },
      "audio"
    );

    const durationSeconds = this.recordingStartTime
      ? (Date.now() - this.recordingStartTime) / 1000
      : null;
    const analyticsOccurredAt = new Date(this.recordingStartTime || Date.now()).toISOString();
    this.recordingStartTime = null;
    const recordingCheck = evaluateFinishedRecording({
      blobSize: audioBlob.size,
      receivedAudioData: this._receivedAudioData,
    });
    if (!recordingCheck.usable) {
      logger.info(
        "Dropping degenerate recording before transcription",
        {
          blobSize: audioBlob.size,
          reason: recordingCheck.reason,
          receivedAudioData: this._receivedAudioData,
        },
        "audio"
      );
      if (!this._settleProcessingPipeline(processingPipeline)) return;
      this._localSpeechGateState = null;
      this.onTranscriptionComplete?.({ success: true, text: "" });
      return;
    }
    // Non-commit sessions stop concurrently with the decode below.
    const previewStop = this._streamingCommitActive ? await previewStopPromise : null;
    if (wasCancelled()) {
      this._settleProcessingPipeline(processingPipeline);
      return;
    }
    this._streamingCommitActive = false;
    const rawWav = await rawWavPromise;

    await this.processAudio(
      audioBlob,
      {
        durationSeconds,
        analyticsOccurredAt,
        ...(salvagedRecording ? { salvagedRecording: true } : {}),
        ...(previewStop?.streamed ? { streamedText: previewStop.text } : {}),
        ...(rawWav ? { rawWav } : {}),
      },
      processingPipeline
    );
  }

  async replaceBatchMic(replacement) {
    try {
      const recorder = this.mediaRecorder;
      if (!recorder) throw new Error("Batch recorder is no longer active");
      // An auto-stopped recorder (mic track died) already banked its segment in
      // onstop; only a live recorder needs the explicit rotation handshake.
      if (recorder.state === "recording") {
        await new Promise((resolve) => {
          this._rotatingBatchRecorder = recorder;
          this._rotationResolve = resolve;
          recorder.stop();
        });
      }
      if (!this.isRecording) throw new Error("Recording stopped during microphone recovery");

      this._silenceSource?.disconnect();
      if (this._silenceCtx && this._silenceAnalyser) {
        this._silenceSource = this._silenceCtx.createMediaStreamSource(replacement);
        this._silenceSource.connect(this._silenceAnalyser);
      }
      this._previewSource?.disconnect();
      if (this._previewAudioContext && this._previewProcessor) {
        this._previewSource = this._previewAudioContext.createMediaStreamSource(replacement);
        this._previewSource.connect(this._previewProcessor);
      }
      this._batchPcmTap?.attach(replacement);
      this.createBatchRecorder(replacement);
    } finally {
      // Honor a stop/cancel that arrived mid-rotation even when the swap failed —
      // dropping it would leave an unstoppable recording (isRecording stuck true).
      const cancelRequested = this._cancelRequestedDuringMicRecovery;
      const stopRequested = this._stopRequestedDuringMicRecovery;
      this._cancelRequestedDuringMicRecovery = false;
      this._stopRequestedDuringMicRecovery = false;
      if (cancelRequested) this.cancelRecording();
      else if (stopRequested) this.stopRecording();
    }
  }

  stopRecording() {
    this.micRecovery.stop();
    if (this._rotatingBatchRecorder) {
      this._stopRequestedDuringMicRecovery = true;
      return true;
    }
    if (this.mediaRecorder?.state === "recording") {
      this.mediaRecorder.stop();
      return true;
    }
    if (this.isRecording && !this.isStreaming) {
      // The mic died mid-recovery, so no live recorder exists; finalize what
      // was captured instead of leaving the recording unstoppable.
      void this.finalizeBatchRecording(null);
      return true;
    }
    return false;
  }

  teardownSpeechGate() {
    if (this._silenceInterval) {
      clearInterval(this._silenceInterval);
      this._silenceInterval = null;
    }
    this._silenceCtx?.close().catch(() => {});
    this._silenceCtx = null;
    this._silenceAnalyser = null;
    this._silenceSource = null;
    this._levelData = null;
  }

  // Live input level (RMS 0..~1) for the waveform, read from whichever
  // pipeline is recording: the batch speech-gate analyser or the streaming
  // path's analyser. Null (waveform rests) when neither is live.
  getRecordingAudioLevel() {
    const pair = this._silenceAnalyser
      ? { ctx: this._silenceCtx, analyser: this._silenceAnalyser }
      : this.streamingAnalyser
        ? { ctx: this.streamingAudioContext, analyser: this.streamingAnalyser }
        : null;
    if (!pair?.ctx) return null;
    if (pair.ctx.state === "suspended") {
      // A suspended context reads flat silence — nudge it awake (not awaited;
      // resume() can hang when the output device is wedged).
      pair.ctx.resume().catch(() => {});
      return null;
    }
    if (pair.ctx.state !== "running") return null;
    const analyser = pair.analyser;
    if (!this._levelData || this._levelData.length !== analyser.fftSize) {
      this._levelData = new Uint8Array(analyser.fftSize);
    }
    analyser.getByteTimeDomainData(this._levelData);
    let sum = 0;
    for (let i = 0; i < this._levelData.length; i++) {
      const v = (this._levelData[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this._levelData.length);
  }

  cancelRecording() {
    this.micRecovery.stop();
    if (this._rotatingBatchRecorder) {
      this._cancelRequestedDuringMicRecovery = true;
      return true;
    }
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      const recorder = this.mediaRecorder;
      const discarded = this.takeDiscardedBatchSnapshot();
      this.mediaRecorder.onstop = () => {
        recorder.stream?.getTracks().forEach((track) => track.stop());
        this.persistDiscardedBatchRecording(discarded);
      };

      // Detach from manager state before recorder.stop(): its final
      // dataavailable/onstop land async and must not block or observe the
      // next recording.
      this.resetDiscardedBatchRecordingState();

      recorder.stop();

      if (recorder.stream) {
        recorder.stream.getTracks().forEach((track) => track.stop());
        this._markCaptureStreamReleased();
      }

      return true;
    }
    if (this.isRecording && !this.isStreaming) {
      // The mic died mid-recovery, so no live recorder exists; discard what was
      // captured instead of leaving the recording uncancelable.
      this.discardBatchRecording();
      return true;
    }
    return false;
  }

  discardBatchRecording() {
    const discarded = this.takeDiscardedBatchSnapshot();
    this.resetDiscardedBatchRecordingState();
    this.persistDiscardedBatchRecording(discarded);
  }

  takeDiscardedBatchSnapshot() {
    return {
      durationSeconds: this.recordingStartTime
        ? (Date.now() - this.recordingStartTime) / 1000
        : null,
      analyticsOccurredAt: new Date(this.recordingStartTime || Date.now()).toISOString(),
      chunks: this.audioChunks,
      segments: this._batchSegments,
      mimeType: this.recordingMimeType,
    };
  }

  resetDiscardedBatchRecordingState() {
    this.teardownSpeechGate();
    this._localSpeechGateState = null;

    this.cleanupPreview({ dismiss: true });
    this._closeBatchPcmTap();
    this.isRecording = false;
    this.isProcessing = false;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this._batchSegments = [];
    this.recordingStartTime = null;
    this.onStateChange?.({ isRecording: false, isProcessing: false });
  }

  persistDiscardedBatchRecording({
    durationSeconds,
    analyticsOccurredAt,
    chunks,
    segments,
    mimeType,
  }) {
    // This must run after MediaRecorder's final dataavailable event, so decide
    // whether to retain the discarded audio from the snapshot rather than live
    // manager state (which may already belong to a new recording).
    const shouldSave =
      shouldSaveDiscardedRecording(getSettings(), durationSeconds, usePolicyStore.getState()) &&
      (chunks.length > 0 || segments.length > 0);
    if (shouldSave) {
      // Assemble and save in the background — the merge crosses IPC into FFmpeg
      // and must not delay the recorder becoming available again.
      void (async () => {
        try {
          const current = new Blob(chunks, { type: mimeType });
          const blob = await this.mergeRecordedSegments([...segments, current]);
          if (blob)
            await this.saveDiscardedTranscription(blob, durationSeconds, analyticsOccurredAt);
        } catch (error) {
          const fallback = this.getLargestRecordedSegment([
            ...segments,
            new Blob(chunks, { type: mimeType }),
          ]);
          if (fallback) {
            try {
              await this.saveDiscardedTranscription(fallback, durationSeconds, analyticsOccurredAt);
            } catch (fallbackError) {
              logger.warn(
                "Failed to save discarded recording fallback",
                { error: fallbackError.message },
                "audio"
              );
            }
            return;
          }
          logger.warn("Failed to save discarded recording", { error: error.message }, "audio");
        }
      })();
    }
  }

  _startProcessingPipeline() {
    const pipeline = {
      cancellationGeneration: this._processingCancellationGeneration ?? 0,
      controller: new AbortController(),
    };
    this._activeProcessingPipeline = pipeline;
    return pipeline;
  }

  _shouldAbandonProcessingPipeline(pipeline) {
    return (
      pipeline.controller?.signal.aborted ||
      pipeline.cancellationGeneration !== (this._processingCancellationGeneration ?? 0) ||
      this._activeProcessingPipeline !== pipeline
    );
  }

  _settleProcessingPipeline(pipeline) {
    if (this._activeProcessingPipeline !== pipeline) return false;
    this._activeProcessingPipeline = null;
    if (this.isProcessing) {
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
    }
    return true;
  }

  cancelProcessing() {
    if (this.isProcessing) {
      this._activeProcessingPipeline?.controller.abort(NIMI_USER_CANCEL);
      this._processingCancellationGeneration = (this._processingCancellationGeneration ?? 0) + 1;
      // Release this foreground interaction. The request runner separately
      // awaits the explicit Cancel and reports rejection or unconfirmed stop;
      // this local UI transition makes no claim about remote execution.
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      // finalizeBatchRecording's earlier cleanupPreview() call (without
      // dismiss:true) already put the live-transcript panel in a "hold"
      // state — meant to keep showing the final/cleanup text, not close it.
      // onError used to be what actually closed the panel on a failure; the
      // processAudio cancel guard means onError never fires for a cancel, so
      // the close has to happen here instead, independent of onError. Only
      // reached for this foreground processing interaction.
      window.electronAPI?.dismissDictationPreview?.();
      return true;
    }
    return false;
  }

  async processAudio(audioBlob, metadata = {}, processingPipeline = null) {
    const pipeline = processingPipeline ?? this._startProcessingPipeline();
    if (processingPipeline && this._activeProcessingPipeline !== processingPipeline) return;
    const wasCancelled = () => this._shouldAbandonProcessingPipeline(pipeline);
    const pipelineStart = performance.now();
    const settings = getSettings();
    let noAudioDetected = false;
    const speechGateDecision = getLocalSpeechGateDecision(this._localSpeechGateState);
    this._localSpeechGateState = null;

    if (speechGateDecision.skip && speechGateDecision.reason === "silence") {
      logger.info(
        "Speech gate skipped transcription",
        {
          reason: speechGateDecision.reason,
          useLocalWhisper: settings.useLocalWhisper,
          localProvider: settings.localTranscriptionProvider,
          peakRms: speechGateDecision.peakRms?.toFixed(4),
          peakAmplitude: speechGateDecision.peakAmplitude?.toFixed(4),
          speechWindowCount: speechGateDecision.speechWindowCount,
          maxConsecutiveSpeechWindows: speechGateDecision.maxConsecutiveSpeechWindows,
        },
        "audio"
      );
      if (!this._settleProcessingPipeline(pipeline)) return;
      this.onTranscriptionComplete?.({ success: true, text: "" });
      return;
    }

    try {
      const sourceAudio = metadata.rawWav ?? audioBlob;
      if (wasCancelled()) return;
      const response = await transcribeNimiRecording(
        sourceAudio,
        getBaseLanguageCode(this.getEffectiveSttLanguage(settings)) || "",
        pipeline.controller.signal,
        this.getCustomDictionaryPrompt() || ""
      );
      if (wasCancelled()) return;
      const rawText = response.transcript.text;
      let result = {
        success: true,
        text: rawText
          ? await this.processTranscriptionWithNimi(
              rawText,
              wasCancelled,
              pipeline.controller.signal
            )
          : "",
        rawText,
        source: "nimi",
        transcription: response.transcript,
        chunks: response.chunks,
        decodedRawWav: Boolean(metadata.rawWav),
        timings: {},
      };

      if (wasCancelled() || !this.isProcessing) {
        return;
      }

      this.lastAudioMetadata = {
        durationMs: metadata?.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : Math.round(performance.now() - pipelineStart),
        provider: "nimi",
        model: null,
      };

      // A salvaged WebM only matters to whoever decoded it; the tap's WAV spans
      // the whole recording.
      result = withSalvageWarning(result, metadata.salvagedRecording && !result?.decodedRawWav);

      result = {
        ...result,
        ...(metadata.analyticsOccurredAt
          ? { analyticsOccurredAt: metadata.analyticsOccurredAt }
          : {}),
        ...this._takePendingResultExtras(),
      };
      // Delivery is App work after successful inference. Keep its lifetime
      // supervised and report callback failures without relabeling saved ASR.
      logger.info(
        "Dictation delivery started",
        { source: result.source, textLength: result.text.length },
        "clipboard"
      );
      try {
        await this.onTranscriptionComplete?.(result);
      } catch (deliveryError) {
        logger.error(
          "Dictation delivery callback failed",
          { error: deliveryError?.message },
          "clipboard"
        );
        this.onError?.({ title: "Paste Error", code: "PASTE_FAILED", transcript: result.text });
      }
      logger.info("Dictation delivery settled", { source: result.source }, "clipboard");

      if (result?.source === "openwhispr") {
        window.dispatchEvent(new Event("usage-changed"));
      }

      const roundTripDurationMs = Math.round(performance.now() - pipelineStart);

      const timingData = {
        mode: "nimi",
        model: null,
        audioDurationMs: metadata.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : null,
        reasoningProcessingDurationMs: result?.timings?.reasoningProcessingDurationMs ?? null,
        roundTripDurationMs,
        audioSizeBytes: audioBlob.size,
        audioFormat: audioBlob.type,
        outputTextLength: result?.text?.length,
      };

      timingData.transcriptionProcessingDurationMs =
        result?.timings?.transcriptionProcessingDurationMs ?? null;

      logger.info("Pipeline timing", timingData, "performance");
    } catch (error) {
      const errorAtMs = Math.round(performance.now() - pipelineStart);

      if (wasCancelled()) {
        if (error?.audioCancellationFailed)
          this.onError?.({
            title: "Transcription cancellation",
            description: error.message,
            code: error.code,
            reasonCode: error.reasonCode,
            audioCancellationFailed: true,
            details: error.details,
            jobId: error.jobId ?? error.details?.jobId,
            clientSubmissionId: error.clientSubmissionId ?? error.details?.clientSubmissionId,
          });
        // The user cancelled mid-pipeline; the aborted request's rejection is
        // the expected outcome, not a failure to report or persist.
        logger.info("Transcription cancelled by user", { errorAtMs }, "performance");
        return;
      }

      logger.error(
        "Pipeline failed",
        {
          errorAtMs,
          error: error.message,
        },
        "performance"
      );

      const outcome = transcriptionFailureOutcome(error);
      noAudioDetected = outcome.noAudio;
      if (outcome.report) this.onError?.(outcome.report);
      if (outcome.keepAudio && this.lastAudioBlob) {
        this.saveFailedTranscription(error.message, error.code || null, metadata);
      }
    } finally {
      const shouldNotifyNoAudio =
        !wasCancelled() && noAudioDetected && this._activeProcessingPipeline === pipeline;
      this._settleProcessingPipeline(pipeline);
      // Every provider reports genuine silence through this one post-processing
      // outcome. The pill can now leave thinking before the error surface takes
      // ownership, instead of receiving an IPC event mid-pipeline.
      if (shouldNotifyNoAudio) this.onNoAudio?.();
    }
  }

  async processWithReasoningModel(text, model, agentName, config, wasCancelled = neverCancelled) {
    const assertActive = () => {
      config?.signal?.throwIfAborted();
      if (wasCancelled()) throw new DOMException("Selection edit was canceled", "AbortError");
    };
    assertActive();
    if (config?.requiresAgent) this.assertAgentAllowedByPolicy();
    logger.logReasoning("CALLING_REASONING_SERVICE", {
      model,
      agentName,
      textLength: text.length,
      hasOverrides: !!config,
    });

    const startTime = Date.now();

    try {
      const result = await ReasoningService.processText(text, model, agentName, config);
      assertActive();

      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_COMPLETE", {
        model,
        processingTimeMs: processingTime,
        resultLength: result.length,
        success: true,
      });

      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_ERROR", {
        model,
        processingTimeMs: processingTime,
        error: error.message,
        stack: error.stack,
      });

      // The selected image is part of this edit. An error must not silently
      // become a different text-only task or recover/replay a retired request.
      assertActive();
      throw error;
    }
  }

  // Panel-first banking: the command streams into the assistant panel with
  // the chat's tools and memory once transcription completes; nothing types
  // at the cursor. The transcript flows back as the result text so history
  // and previews stay truthful.
  _bankAssistantDirective(transcript, config, options = {}) {
    if (!this.isProcessing) return;
    const { selectedContext, deliverySessionId, deliveryAcceptsMarkdown } = options || {};
    this.pendingAssistantConversation = {
      transcript,
      // Keep the original capture for the panel's own public image request,
      // separate from the in-place editor's reasoning options.
      screenContext: config?.rawScreenContext ?? null,
      ...(selectedContext ? { selectedContext } : {}),
      ...(deliverySessionId ? { deliverySessionId, deliveryAcceptsMarkdown } : {}),
    };
  }

  // Consume the directives banked during reasoning so that exactly one
  // transcription result — batch or streaming — carries them.
  _takePendingResultExtras() {
    const extras = {
      ...(this.pendingAssistantConversation
        ? { assistantConversation: this.pendingAssistantConversation }
        : {}),
      ...(this.pendingSelectionEdit ? { selectionEdit: this.pendingSelectionEdit } : {}),
      ...(this.pendingCleanupFailure ? { cleanupFailure: this.pendingCleanupFailure } : {}),
    };
    this.pendingAssistantConversation = null;
    this.pendingSelectionEdit = null;
    this.pendingCleanupFailure = null;
    return extras;
  }

  // Panel-first commands make no LLM call here — the panel resolves the Voice
  // Assistant scope itself — so the org policy guard must run at bank time.
  _bankPanelAgentCommand(
    text,
    agentName,
    config,
    { selectedContext, selectedText, deliverySessionId, deliveryAcceptsMarkdown } = {}
  ) {
    this.assertAgentAllowedByPolicy();
    const settings = getSettings();
    const command = this.voiceAgentRequested
      ? text
      : stripAgentAddress(
          text,
          agentName,
          config?.wakeWordLanguage ?? resolveWakeWordLanguage(settings),
          config?.snippets ?? settings.snippets
        );
    const transcript = selectedText === undefined ? command : `${command}\n\n"${selectedText}"`;
    this._bankAssistantDirective(transcript, config, {
      selectedContext,
      deliverySessionId,
      deliveryAcceptsMarkdown,
    });
    return text;
  }

  async processAgentCommand(text, model, agentName, config, wasCancelled = neverCancelled) {
    if (wasCancelled()) return text;
    const assistantSelectionContext = this.consumeAssistantSelectionContext();
    if (assistantSelectionContext) {
      // An in-panel selection is conversational context, not an editable OS
      // target. Keep it on the existing panel-first route and leave the
      // external selection replacement path completely untouched.
      this.selectionCapturePromise = null;
      return this._bankPanelAgentCommand(text, agentName, config, {
        selectedContext: assistantSelectionContext,
      });
    }

    let capture;
    try {
      capture = await this.consumeSelectionCapture();
    } catch (cause) {
      const error = new Error(
        `Selection edit could not safely read the selection: ${cause.message}`
      );
      error.code = "SELECTION_EDIT_CAPTURE_FAILED";
      error.messageKey = "hooks.audioRecording.selectionEditing.unavailable";
      error.selectionEditFatal = true;
      error.cause = cause;
      throw error;
    }
    if (wasCancelled()) return text;

    const captureDisposition = getSelectionCaptureDisposition(capture);
    const deliverySessionId =
      captureDisposition === "caret" && getSettings().autoPasteEnabled
        ? capture.sessionId
        : undefined;
    const deliveryAcceptsMarkdown = capture?.acceptsMarkdown === true;

    if (!config?.selectionEditReachable) {
      // No in-place editor: the panel never types, so only a readable
      // selection is quoted; every other capture sends the plain command.
      return this._bankPanelAgentCommand(text, agentName, config, {
        selectedText:
          captureDisposition === "selection" && typeof capture?.text === "string"
            ? capture.text
            : undefined,
        deliverySessionId,
        deliveryAcceptsMarkdown,
      });
    }

    if (capture?.status === "too_large") {
      // A large selection definitely exists, so running the command as plain
      // agent dictation would paste over it — the one capture failure that
      // must not fall through.
      const error = new Error(
        `Selected text exceeds the ${capture.maxCharacters || 6000} character limit`
      );
      error.code = "SELECTION_EDIT_TOO_LARGE";
      error.messageKey = "hooks.audioRecording.selectionEditing.tooLarge";
      error.selectionEditFatal = true;
      throw error;
    }

    if (captureDisposition === "standalone" || captureDisposition === "caret") {
      return this._bankPanelAgentCommand(text, agentName, config, {
        deliverySessionId,
        deliveryAcceptsMarkdown,
      });
    }

    if (capture?.status !== "selected") {
      // A captured target changing, a synthetic-copy failure, or an unexpected
      // accessibility result is ambiguous: a normal agent paste could overwrite
      // unrelated selected text. Abort instead of falling through.
      const error = new Error("Selection edit could not safely verify the selected text");
      error.code = "SELECTION_EDIT_CAPTURE_FAILED";
      error.messageKey =
        captureDisposition === "changed"
          ? "hooks.audioRecording.selectionEditing.changed"
          : "hooks.audioRecording.selectionEditing.unavailable";
      error.selectionEditFatal = true;
      throw error;
    }

    // These are routing directives for this method, not reasoning options —
    // strip them before the config reaches ReasoningService.
    const { selectionEditReachable, rawScreenContext, wakeWordLanguage, ...reasoningOptions } =
      config ?? {};
    const selectionConfig = {
      ...reasoningOptions,
      maxTokens: Math.max(config?.maxTokens || 0, 8192),
      contextSize: Math.max(config?.contextSize || 0, 16384),
      temperature: config?.temperature ?? 0.2,
      requireCompleteOutput: true,
    };
    const completionMarker = `__OPENWHISPR_SELECTION_COMPLETE_${crypto.randomUUID()}__`;
    selectionConfig.systemPrompt = buildSelectionEditSystemPrompt(
      config?.systemPrompt,
      completionMarker
    );
    const userPrompt = buildSelectionEditUserPrompt(text, capture.text);

    try {
      const result = await this.processWithReasoningModel(
        userPrompt,
        model,
        agentName,
        selectionConfig,
        wasCancelled
      );
      if (wasCancelled()) return text;
      const replacement = extractSelectionEditReplacement(result, completionMarker);
      this.pendingSelectionEdit = { sessionId: capture.sessionId };
      return replacement;
    } catch (cause) {
      const error = new Error(`Selection edit failed: ${cause.message}`);
      error.code = "SELECTION_EDIT_REASONING_FAILED";
      error.messageKey = "hooks.audioRecording.selectionEditing.reasoningFailed";
      error.selectionEditFatal = true;
      error.cause = cause;
      throw error;
    }
  }

  // Cleanup-then-translate chain shared by batch, cloud, and streaming paths: Step 1
  // (optional cleanup) soft-fails to input; Step 2 translates unless source === target.

  async processTranscriptionWithNimi(text, wasCancelled, signal) {
    const settings = getSettings();
    const agentName = getAgentName();
    const promptOptions = {
      agentName,
      language: settings.preferredLanguage,
      customDictionary: getDictionaryHintWords(settings),
      uiLanguage: settings.uiLanguage,
    };
    if (
      this.voiceAgentRequested ||
      (settings.useDictationAgent && detectAgentName(text, agentName))
    ) {
      signal?.throwIfAborted();
      if (wasCancelled()) return text;
      const screenContext = this.voiceAgentRequested ? await this.consumeScreenContext() : null;
      signal?.throwIfAborted();
      if (wasCancelled()) return text;
      const systemPrompt = dictationAgentPrompt(settings, agentName);
      return this.processAgentCommand(
        text,
        "",
        agentName,
        {
          requiresAgent: true,
          signal,
          systemPrompt: screenContext
            ? appendScreenContextSuffix(systemPrompt, settings.uiLanguage)
            : systemPrompt,
          ...(screenContext ? { screenContext, rawScreenContext: screenContext } : {}),
          selectionEditReachable: isAgentAllowed(usePolicyStore.getState()),
        },
        wasCancelled
      );
    }
    let output = text;
    if (settings.useCleanupModel) {
      output = await ReasoningService.processText(text, "", agentName, {
        signal,
        systemPrompt: resolvePrompt("cleanup", promptOptions),
      });
      if (wasCancelled()) return text;
    }
    if (
      this.translationRequested &&
      shouldRunTranslateStep(settings.translationSourceLanguage, settings.translationTargetLanguage)
    ) {
      output = await ReasoningService.processText(output, "", agentName, {
        signal,
        systemPrompt: resolvePrompt("translate", {
          ...promptOptions,
          targetLanguageLabel: getLanguageLabel(settings.translationTargetLanguage),
        }),
      });
      signal?.throwIfAborted();
      if (wasCancelled()) return text;
      this.translationApplied = true;
    }
    return this.finalizeChineseScript(output);
  }

  // Local-vs-cloud is decided upstream, so useLocalWhisper is forced off here:
  // the local→cloud fallback resolves its cloud endpoint through this too.

  async safePaste(text, options = {}) {
    try {
      const result = await window.electronAPI.pasteText(text, options);
      if (
        result?.success === false &&
        result.code === "ACCESSIBILITY_PERMISSION_REQUIRED" &&
        result.clipboardCopied === true
      ) {
        this.onError?.({
          title: "Paste Error",
          code: result.code,
          clipboardCopied: true,
          transcript: text,
        });
        return { pasted: false };
      }
      return {
        pasted: result?.pasted === true,
        ...(result?.reason ? { reason: result.reason } : {}),
        ...(result?.code ? { code: result.code } : {}),
      };
    } catch (error) {
      const message =
        error?.message ??
        (typeof error?.toString === "function" ? error.toString() : String(error));
      this.onError?.({
        title: "Paste Error",
        code: "PASTE_FAILED",
        // Keep the platform's guidance, without Electron's IPC wrapper around it.
        description: message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ""),
        transcript: text,
      });
      return { pasted: false };
    }
  }

  async saveTranscription(
    text,
    rawText = null,
    { clientTranscriptionId, analyticsOccurredAt, recognition } = {}
  ) {
    const { dataRetentionEnabled, audioRetentionDays } = getEffectiveRetentionPreferences();
    if (!dataRetentionEnabled) {
      logger.debug("Skipping transcription save — data retention disabled", {}, "audio");
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      return true;
    }

    const eventId = clientTranscriptionId || crypto.randomUUID();
    const occurredAt = analyticsOccurredAt ? new Date(analyticsOccurredAt) : new Date();
    const metadata = this.lastAudioMetadata || {};
    try {
      await window.electronAPI.recordAnalyticsEvent({
        eventId,
        wordCount: countSpokenWords(rawText || text),
        occurredAt: occurredAt.toISOString(),
        localDate: localDateKey(occurredAt),
        spokenDurationMs: metadata.durationMs || null,
        mode: resolveAnalyticsMode(getSettings(), metadata.provider),
        provider: metadata.provider || null,
        model: metadata.model || null,
      });
    } catch (analyticsError) {
      logger.warn(
        "Failed to record local analytics event",
        { error: analyticsError.message },
        "analytics"
      );
    }

    try {
      const result = await window.electronAPI.saveTranscription(text, rawText, {
        clientTranscriptionId: eventId,
        routeKind: this.translationRequested ? "translation" : null,
        analyticsOccurredAt: occurredAt.toISOString(),
        ...(recognition ? { recognition } : {}),
      });
      if (result?.id) syncService.debouncedPush("transcription", result.id);

      // Save audio if we have a captured blob and the transcription was saved successfully
      if (result?.id && this.lastAudioBlob) {
        if (audioRetentionDays > 0) {
          try {
            const arrayBuffer = await this.lastAudioBlob.arrayBuffer();
            await window.electronAPI.saveTranscriptionAudio(
              result.id,
              arrayBuffer,
              this.lastAudioMetadata
            );
          } catch (audioErr) {
            // Non-blocking: transcription is saved even if audio save fails
            logger.warn("Failed to save transcription audio", { error: audioErr.message }, "audio");
          }
        }
        this.lastAudioBlob = null;
        this.lastAudioMetadata = null;
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  async saveFailedTranscription(errorMessage, errorCode = null, metadata = {}) {
    const { dataRetentionEnabled, audioRetentionDays } = getEffectiveRetentionPreferences();
    if (!dataRetentionEnabled) {
      logger.debug("Skipping failed transcription save — data retention disabled", {}, "audio");
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      return;
    }

    try {
      const result = await window.electronAPI.saveTranscription("", null, {
        status: "failed",
        errorMessage,
        errorCode,
        routeKind: this.translationRequested ? "translation" : null,
        ...(metadata?.analyticsOccurredAt
          ? { analyticsOccurredAt: metadata.analyticsOccurredAt }
          : {}),
      });
      if (result?.id) syncService.debouncedPush("transcription", result.id);

      if (result?.id && this.lastAudioBlob) {
        if (audioRetentionDays > 0) {
          try {
            const durationMs = metadata?.durationSeconds
              ? Math.round(metadata.durationSeconds * 1000)
              : null;
            const arrayBuffer = await this.lastAudioBlob.arrayBuffer();
            await window.electronAPI.saveTranscriptionAudio(result.id, arrayBuffer, {
              durationMs,
              provider: null,
              model: null,
            });
          } catch (audioErr) {
            logger.warn(
              "Failed to save audio for failed transcription",
              {
                error: audioErr.message,
              },
              "audio"
            );
          }
        }
        this.lastAudioBlob = null;
        this.lastAudioMetadata = null;
      }
    } catch (error) {
      logger.error(
        "Failed to save failed transcription record",
        {
          error: error.message,
        },
        "audio"
      );
    }
  }

  async saveDiscardedTranscription(blob, durationSeconds, analyticsOccurredAt = null) {
    let savedId = null;
    try {
      const result = await window.electronAPI.saveTranscription("", null, {
        status: "discarded",
        routeKind: this.translationRequested ? "translation" : null,
        ...(analyticsOccurredAt ? { analyticsOccurredAt } : {}),
      });
      if (!result?.id) return;
      savedId = result.id;

      if (blob) {
        const durationMs = durationSeconds ? Math.round(durationSeconds * 1000) : null;
        const arrayBuffer = await blob.arrayBuffer();
        await window.electronAPI.saveTranscriptionAudio(savedId, arrayBuffer, {
          durationMs,
          provider: null,
          model: null,
        });
      }

      syncService.debouncedPush("transcription", savedId);
    } catch (error) {
      logger.error(
        "Failed to save discarded transcription record",
        { error: error.message },
        "audio"
      );
      // A discarded row is only recoverable through its audio; if the audio save
      // failed, drop the dead row instead of leaving an empty unrecoverable entry. See #907.
      if (savedId != null) {
        try {
          await window.electronAPI.deleteTranscription(savedId);
        } catch (cleanupError) {
          logger.warn(
            "Failed to clean up discarded row after audio save failure",
            { error: cleanupError.message },
            "audio"
          );
        }
      }
    }
  }

  getState() {
    return {
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      isStreaming: this.isStreaming,
      isStreamingStartInProgress: this.streamingStartInProgress,
      isFinalizingStreaming: Boolean(this._streamingStopPromise),
      micCaptureStatus: this.micCaptureStatus,
    };
  }

  // Warmup exercises the same connect that recording start will make, so a
  // failing warmup predicts a guaranteed user-facing failure at the next
  // keypress — #1624 logged exactly this on every idle cycle for days at warn
  // level and nobody saw it. Error level, provider named, streak counted.

  // Turns a failed dictation-realtime-start result into a batch fallback or
  // the error the user must see.

  // Why this cloud upload is batch instead of the managed Orukeet stream, for
  // the rollout's fallback-rate metric. Cleared on read: it describes one recording.

  // Resolves once the transcript stops moving. An outstanding partial proves its
  // final is still in flight, so only the ceiling ends the wait until it lands —
  // a plain debounce would expire on the very tail this exists to catch.

  cleanup() {
    this._nimiPreview?.close();
    this._nimiPreview = null;
    this._processingCancellationGeneration += 1;
    this._activeProcessingPipeline?.controller.abort();
    this.micRecovery.stop();
    this._unsubscribeSettings?.();
    this.preparedMicCapture.cancel();
    this._closeBatchPcmTap();
    this.micStreamHold.drop();
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    if (this.mediaRecorder?.state === "recording") {
      this.cancelRecording();
    }
    if (this.persistentAudioContext && this.persistentAudioContext.state !== "closed") {
      this.persistentAudioContext.close().catch(() => {});
      this.persistentAudioContext = null;
      this.workletModuleLoaded = false;
    }
    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl);
      this.workletBlobUrl = null;
    }
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.onPartialTranscript = null;
    this.onStreamingCommit = null;
    if (this._onApiKeyChanged) {
      window.removeEventListener("api-key-changed", this._onApiKeyChanged);
    }
    if (this._onDeviceChange) {
      navigator.mediaDevices?.removeEventListener?.("devicechange", this._onDeviceChange);
    }
  }

  shouldShowPreviewCleanupState() {
    const settings = getSettings();
    return settings.useCleanupModel || this.translationRequested || this.voiceAgentRequested;
  }

  async cleanupPreview({ dismiss = false, showCleanup = false } = {}) {
    this._nimiPreview?.close();
    this._nimiPreview = null;
    if (dismiss) return window.electronAPI?.dismissDictationPreview?.();
    return window.electronAPI?.stopDictationPreview?.({ showCleanup });
  }
}

export default AudioManager;
