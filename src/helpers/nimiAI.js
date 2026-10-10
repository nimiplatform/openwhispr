const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { getAppDataDirectory } = require("./appData");
const { transcribeNimiFile, cleanupNimiFile } = require("./nimiFileTranscription");
const tokenStore = require("./tokenStore");
const nimiEmbeddings = require("./nimiEmbeddings");
const speakerEmbeddings = require("./speakerEmbeddings");
const businessAI = require("./nimiBusinessAI");
const { describeTranscriptionOptionError } = require("./transcriptionOptionError");
const { MAX_ENCODED_BYTES } = require("./screenContextCapture");
const { runNimiAudioJob } = require("./nimiAsyncAudioJob");
let services;
let generation = 0;
let uploadOwner;
let prepareSession;
const requests = new Map();
tokenStore.subscribe(({ generation: currentGeneration }) => {
  for (const [key, request] of requests) {
    if (request.authGeneration === currentGeneration) continue;
    request.controller.abort();
    if (request.recording) retireRecording(request);
    if (request.fileReady && !request.committing) {
      requests.delete(key);
      cleanupFileWork(request);
    }
  }
});

function invalidate() {
  generation += 1;
  const pending = [...requests.values()];
  requests.clear();
  services = undefined;
  nimiEmbeddings.invalidate();
  speakerEmbeddings.invalidate();
  for (const request of pending) request.controller.abort();
  for (const request of pending) {
    if (request.recording) retireRecording(request);
    if (request.fileReady && !request.committing) cleanupFileWork(request);
  }
}

function cleanupFileWork(scope) {
  try {
    cleanupNimiFile(scope);
  } catch (error) {
    try {
      require("./debugLogger").warn("Nimi upload temporary cleanup failed", {
        error: error.message,
      });
    } catch {}
  }
}

function retireRecording(scope) {
  if (!scope.recording || scope.appending || scope.processing) return;
  requests.delete(scope.key);
  cleanupFileWork(scope);
}

function bindServices(next) {
  services = next;
  nimiEmbeddings.bind(next);
  speakerEmbeddings.bind(next);
}

async function prepareNodeWork(signal) {
  signal?.throwIfAborted();
  const initialGeneration = generation;
  const authGeneration = tokenStore.getGeneration();
  const account = uploadOwner?.database.activeAccountId;
  const check = () => {
    signal?.throwIfAborted();
    if (
      generation !== initialGeneration ||
      tokenStore.getGeneration() !== authGeneration ||
      uploadOwner?.database.activeAccountId !== account
    )
      throw Object.assign(
        new Error("The session or account changed while preparing this task. Send a new request."),
        {
          code: "NIMI_SESSION_CHANGED",
        }
      );
  };
  await businessAI.assertAllowed();
  check();
  if (typeof prepareSession !== "function")
    throw Object.assign(
      new Error("Nimi Host session preparation is unavailable. Reopen this App from Nimi."),
      {
        code: "NIMI_SESSION_UNAVAILABLE",
      }
    );
  await prepareSession(signal);
  check();
  await businessAI.assertAllowed();
  check();
  return check;
}

function requestScope(input, requireAI = true) {
  const requestId = input.payload.requestId;
  if (typeof requestId !== "string" || !/^[\w-]{1,128}$/.test(requestId))
    throw new Error("Invalid AI request identity");
  const key = `${input.event.sender.id}:${requestId}`;
  return workScope(key, requireAI);
}

function workScope(key, requireAI = true) {
  if (requests.has(key)) throw new Error("AI request is already in progress");
  if (requireAI && !services)
    throw Object.assign(
      new Error(
        "Nimi App connection is unavailable. Check the connection in AI settings, then retry the retained recording from history."
      ),
      {
        code: "NIMI_SESSION_UNAVAILABLE",
        messageKey: "nimi.sessionConnectionUnavailable",
        messageParams: { reason: "app-business-services-unbound" },
        settingsTarget: "speechToText",
        technicalDetails: { underlyingError: "app-business-services-unbound" },
      }
    );
  const scope = {
    key,
    services,
    generation,
    account: uploadOwner?.database.activeAccountId,
    authGeneration: tokenStore.getGeneration(),
    controller: new AbortController(),
    cancelController: new AbortController(),
    audioTasks: new Set(),
    cancellationFacts: [],
  };
  requests.set(key, scope);
  return scope;
}

function assertObservationCurrent(scope) {
  scope.controller.signal.throwIfAborted();
  if (
    scope.generation !== generation ||
    scope.services !== services ||
    scope.account !== uploadOwner?.database.activeAccountId ||
    scope.authGeneration !== tokenStore.getGeneration()
  )
    throw new Error("Nimi App session changed");
}

function assertCurrent(scope) {
  assertObservationCurrent(scope);
  scope.cancelController.signal.throwIfAborted();
}

async function trackAudioTask(scope, task) {
  scope.audioTasks.add(task);
  try {
    return await task;
  } finally {
    scope.audioTasks.delete(task);
  }
}

function extractSpeaker(scope, bytes, options) {
  return trackAudioTask(
    scope,
    speakerEmbeddings._extractAudio(bytes, {
      ...options,
      cancelSignal: scope.cancelController.signal,
      onCancel: (fact) => scope.cancellationFacts.push(fact),
    })
  );
}

function requestAudioCancel(scope) {
  if (scope.cancelPromise) return scope.cancelPromise;
  const pending = [...scope.audioTasks];
  scope.cancelController.abort();
  if (!pending.length) scope.controller.abort();
  scope.cancelPromise = Promise.allSettled(pending).then((settled) => {
    const failure = scope.cancellationFacts.find((fact) => fact.error)?.error;
    if (failure) throw failure;
    const jobs = scope.cancellationFacts
      .filter((fact) => fact.response)
      .map((fact) => fact.response.job);
    if (
      pending.length &&
      !jobs.length &&
      !scope.cancellationFacts.some((fact) => fact.notDispatched)
    ) {
      const original = settled.find((entry) => entry.status === "rejected")?.reason;
      if (original) throw original;
      throw Object.assign(new Error("Audio cancellation could not be confirmed"), {
        code: "NIMI_AUDIO_CANCEL_UNCONFIRMED",
      });
    }
    return { requested: true, jobs };
  });
  return scope.cancelPromise;
}

async function transcribe(scope, payload) {
  const {
    audio,
    mimeType,
    language = "",
    prompt = "",
    timestamps = false,
    diarization = false,
  } = payload;
  const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
  if (!bytes.byteLength || bytes.byteLength > 32 * 1024 * 1024)
    throw new Error("Audio must contain at most 32 MiB");
  assertCurrent(scope);
  await businessAI.assertAllowed();
  assertCurrent(scope);
  try {
    const final = (
      await trackAudioTask(
        scope,
        runNimiAudioJob({
          ai: scope.services.ai,
          spec: {
            type: "speech-transcribe",
            mimeType,
            language,
            prompt,
            responseFormat: "",
            timestamps,
            diarization,
            audioSource: { type: "bytes", bytes },
          },
          signal: scope.controller.signal,
          cancelSignal: scope.cancelController.signal,
          assertCurrent: () => assertObservationCurrent(scope),
          onObservation: (response) => {
            scope.audioObservation = response;
          },
          onCancel: (fact) => scope.cancellationFacts.push(fact),
        })
      )
    ).job;
    await businessAI.assertAllowed();
    assertCurrent(scope);
    if (!final.transcription) throw new Error("Nimi transcription result is missing");
    const result = { transcript: final.transcription, jobId: final.jobId };
    if (diarization && scope.speakerTracking)
      return scope.speakerTracking.apply(result, Buffer.from(bytes));
    return result;
  } catch (error) {
    throw describeTranscriptionOptionError(error, { timestamps, diarization });
  }
}

async function editText(scope, text, systemPrompt, options = {}) {
  assertCurrent(scope);
  if (typeof text !== "string" || !text.trim() || typeof systemPrompt !== "string")
    throw new Error("Invalid text editing input");
  if (
    options.maxTokens !== undefined &&
    (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)
  )
    throw new Error("Invalid text output budget");
  if (
    options.temperature !== undefined &&
    (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)
  )
    throw new Error("Invalid text temperature");
  let imageBytes;
  let imageMime;
  if (options.screenContext !== undefined) {
    const image = options.screenContext;
    if (
      !image ||
      typeof image !== "object" ||
      Object.keys(image).some((key) => key !== "data" && key !== "mediaType") ||
      !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(image.mediaType) ||
      typeof image.data !== "string" ||
      !image.data.length ||
      image.data.length > 4 * Math.ceil(MAX_ENCODED_BYTES / 3) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
    )
      throw new Error("Invalid selection screen image");
    imageBytes = Buffer.from(image.data, "base64");
    if (
      !imageBytes.length ||
      imageBytes.length > MAX_ENCODED_BYTES ||
      imageBytes.toString("base64") !== image.data
    )
      throw new Error("Invalid selection screen image");
    imageMime = image.mediaType;
  }
  await businessAI.assertAllowed();
  assertCurrent(scope);
  let userMessage = { role: "user", text };
  if (imageBytes) {
    const uploaded = await scope.services.ai.artifacts.upload({
      bytes: imageBytes,
      mimeType: imageMime,
    });
    assertCurrent(scope);
    await businessAI.assertAllowed();
    assertCurrent(scope);
    userMessage = {
      role: "user",
      text: "",
      parts: [
        { type: "text", text },
        { type: "artifact-ref", artifactId: uploaded.artifactId, mediaType: uploaded.mimeType },
      ],
    };
  }
  const result = await scope.services.ai.scenario.execute(
    {
      type: "text-generate",
      messages: [{ role: "system", text: systemPrompt }, userMessage],
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.disableThinking ? { reasoning: { activation: "disabled" } } : {}),
    },
    {
      signal: scope.controller.signal,
      // Every model step obeys the public synchronous limit. Long materials
      // remain App-owned segmented work; cancellation spans every step/commit.
      timeoutMs: 120000,
    }
  );
  assertCurrent(scope);
  await businessAI.assertAllowed();
  assertCurrent(scope);
  if (result.output.type !== "text-generate") throw new Error("Unexpected Nimi editing result");
  if (options.requireCompleteOutput && result.output.finishReason === "length")
    throw Object.assign(new Error("Nimi text output reached its limit"), {
      code: "AI_TEXT_OUTPUT_INCOMPLETE",
    });
  return result.output.items
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
}

async function commitUploadNote(input) {
  const scope = requests.get(String(input.event.sender.id) + ":" + input.payload.requestId);
  if (!scope?.fileReady || !scope.fileResult?.text || !uploadOwner)
    throw new Error("Upload work is no longer available");
  assertCurrent(scope);
  if (scope.committing) throw new Error("The imported note is already being saved");
  scope.committing = true;
  let directory;
  let committed = false;
  try {
    const { title, sourceName, folderId } = input.payload;
    if (typeof title !== "string" || !title.trim() || title.length > 1000)
      throw new Error("Invalid note title");
    const imports = path.join(getAppDataDirectory(), "imports");
    fs.mkdirSync(imports, { recursive: true });
    const storageId = randomUUID();
    directory = path.join(imports, storageId);
    fs.mkdirSync(directory);
    const originalName = "source" + path.extname(scope.originalPath);
    await fs.promises.copyFile(scope.originalPath, path.join(directory, originalName));
    assertCurrent(scope);
    await fs.promises.copyFile(scope.audioPath, path.join(directory, "audio.wav"));
    assertCurrent(scope);
    const anchorMs = Date.now();
    const result = scope.fileResult;
    const transcript = JSON.stringify(
      result.segments.map((segment) => ({
        text: segment.text,
        timestamp: anchorMs + segment.start * 1000,
        endTimestamp: anchorMs + segment.end * 1000,
        ...(segment.speaker ? { speaker: segment.speaker } : {}),
        speakerMatching: segment.speakerMatching,
        speakerStatus: segment.speakerStatus,
      }))
    );
    const sourceMedia = {
      originalName: scope.originalName,
      originalPath: "imports/" + storageId + "/" + originalName,
      audioPath: "imports/" + storageId + "/audio.wav",
      transcriptOriginMs: anchorMs,
      durationSeconds: result.durationSeconds,
      chunks: result.chunks,
      speakerMatching: result.speakerMatching,
    };
    const saved = uploadOwner.database.saveImportedNote({
      title,
      content: result.text,
      sourceFile: typeof sourceName === "string" ? sourceName : scope.originalName,
      audioDuration: result.durationSeconds,
      folderId: folderId ?? null,
      transcript,
      sourceMedia,
      speakerRepresentations: scope.speakerRepresentations,
    });
    committed = true;
    uploadOwner.onSaved(saved.note);
    return saved;
  } finally {
    requests.delete(scope.key);
    if (!committed && directory) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        require("./debugLogger").warn("Uncommitted import cleanup failed", {
          error: error.message,
        });
      }
    }
    cleanupFileWork(scope);
  }
}

const commandHandlers = {
  "openwhispr.business.ai-access": async (input) => {
    if (Object.keys(input.payload || {}).length)
      throw new Error("Business AI access takes no selectors");
    await businessAI.assertAllowed();
    return { allowed: true };
  },
  "openwhispr.history.retry": async (input) => {
    const scope = requestScope(input);
    const destroyed = () => scope.controller.abort();
    input.event.sender.once("destroyed", destroyed);
    try {
      if (
        [...requests.values()].some(
          (other) => other !== scope && other.historyId === input.payload.id
        )
      )
        throw new Error("This history retry is already in progress");
      const { retryNimiHistory } = require("./nimiHistoryRetry");
      return await retryNimiHistory(scope, input.payload, uploadOwner, {
        transcribe,
        assertCurrent,
        editText,
      });
    } finally {
      input.event.sender.removeListener("destroyed", destroyed);
      requests.delete(scope.key);
      cleanupFileWork(scope);
    }
  },
  "openwhispr.storage.info": () => {
    if (!uploadOwner?.database?.db) throw new Error("The business database is unavailable");
    const { app } = require("electron");
    const directory = getAppDataDirectory();
    const databasePath = uploadOwner.database.db.name;
    return {
      directory,
      realDirectory: fs.realpathSync.native(directory),
      databasePath,
      realDatabasePath: fs.realpathSync.native(databasePath),
      mode: process.env.NODE_ENV === "development" ? "development" : "production",
      home: app.getPath("home"),
      appData: app.getPath("appData"),
    };
  },
  "openwhispr.note.reveal-source": (input) => {
    if (!uploadOwner) throw new Error("The note owner is unavailable");
    const target = require("./noteMediaAccess").resolveNoteMediaPath(
      uploadOwner.database,
      getAppDataDirectory(),
      input.payload
    );
    require("electron").shell.showItemInFolder(target);
    return { revealed: true };
  },
  "openwhispr.ai.transcribe": async (input) => {
    const scope = requestScope(input);
    try {
      return await transcribe(scope, input.payload);
    } finally {
      requests.delete(scope.key);
    }
  },
  "openwhispr.recording.begin": (input) => {
    const scope = requestScope(input);
    try {
      const extension = {
        "audio/wav": ".wav",
        "audio/webm": ".webm",
        "audio/ogg": ".ogg",
        "audio/mp4": ".m4a",
      }[input.payload.mimeType];
      if (!extension) throw new Error("Unsupported captured recording format");
      scope.directory = fs.mkdtempSync(
        path.join(require("./safeTempDir").getSafeTempDir(), "ow-nimi-upload-")
      );
      scope.originalName = "recording" + extension;
      scope.originalPath = path.join(scope.directory, scope.originalName);
      fs.writeFileSync(scope.originalPath, Buffer.alloc(0));
      scope.recording = true;
      scope.bytes = 0;
      return { started: true };
    } catch (error) {
      requests.delete(scope.key);
      cleanupFileWork(scope);
      throw error;
    }
  },
  "openwhispr.recording.append": async (input) => {
    const scope = requests.get(`${input.event.sender.id}:${input.payload.requestId}`);
    if (!scope?.recording || scope.processing || scope.appending)
      throw new Error("Recording upload is unavailable");
    assertCurrent(scope);
    const bytes = Buffer.from(input.payload.audio);
    if (!bytes.length || bytes.length > 2 * 1024 * 1024 || input.payload.offset !== scope.bytes)
      throw new Error("Invalid recording upload chunk");
    scope.appending = true;
    try {
      await fs.promises.appendFile(scope.originalPath, bytes);
      assertCurrent(scope);
      scope.bytes += bytes.length;
      return { bytes: scope.bytes };
    } finally {
      scope.appending = false;
      if (scope.controller.signal.aborted) retireRecording(scope);
    }
  },
  "openwhispr.recording.transcribe": async (input) => {
    const scope = requests.get(`${input.event.sender.id}:${input.payload.requestId}`);
    if (!scope?.recording || scope.processing || scope.appending || !scope.bytes)
      throw new Error("Recording upload is unavailable");
    assertCurrent(scope);
    scope.processing = true;
    try {
      const result = await transcribeNimiFile(
        scope,
        {
          language: input.payload.language || "",
          prompt: input.payload.prompt || "",
          timestamps: false,
        },
        { transcribe, assertCurrent },
        true
      );
      assertCurrent(scope);
      const reported = result.chunks
        .filter((chunk) => chunk.transcript.status === "transcribed")
        .map((chunk) => chunk.transcript.language);
      const language =
        reported.length && reported.every((value) => value && value === reported[0])
          ? reported[0]
          : "";
      return {
        transcript: {
          status: result.text ? "transcribed" : "no-speech",
          text: result.text,
          language,
          words: result.segments.map((segment) => ({
            text: segment.text,
            startSeconds: segment.start,
            endSeconds: segment.end,
          })),
        },
        chunks: result.chunks,
        durationSeconds: result.durationSeconds,
        diarized: result.diarized,
        speakerMatching: result.speakerMatching,
      };
    } finally {
      requests.delete(scope.key);
      cleanupFileWork(scope);
    }
  },
  "openwhispr.ai.transcribe-file": async (input) => {
    const scope = requestScope(input);
    if (input.payload.diarization === true) {
      const { NimiSpeakerTracking } = require("./nimiSpeakerTracking");
      scope.speakerTracking = new NimiSpeakerTracking({
        namespace: input.payload.requestId,
        extract: (bytes, options) => extractSpeaker(scope, bytes, options),
        signal: scope.controller.signal,
        assertCurrent: () => assertCurrent(scope),
        getMaxSpeakers: () => input.payload.numSpeakers ?? null,
      });
    }
    try {
      const result = await transcribeNimiFile(scope, input.payload, {
        transcribe,
        assertCurrent,
        onProgress: (progress) => {
          if (!input.event.sender.isDestroyed())
            input.event.sender.send("upload-transcription-progress", {
              ...progress,
              requestId: input.payload.requestId,
            });
        },
      });
      assertCurrent(scope);
      if (!result.text || !input.payload.retainForNote) {
        requests.delete(scope.key);
        cleanupFileWork(scope);
      } else scope.fileReady = true;
      return {
        success: true,
        status: result.status,
        text: result.text,
        segments: result.segments,
        durationSeconds: result.durationSeconds,
        diarized: result.diarized,
        speakerMatching: result.speakerMatching,
        speakerMatchingWarning:
          result.segments.some(
            (segment) => segment.speakerMatching && segment.speakerMatching !== "matched-space"
          ) ||
          Object.values(result.speakerMatching || {}).some((state) => state !== "matched-space"),
      };
    } catch (error) {
      requests.delete(scope.key);
      cleanupFileWork(scope);
      throw error;
    }
  },
  "openwhispr.upload.commit-note": commitUploadNote,
  "openwhispr.notes.search": async (input) => {
    const scope = requestScope(input, false);
    try {
      assertCurrent(scope);
      const { searchNimiNotes } = require("./nimiNoteSearch");
      const { query, limit, spaceId, folderId } = input.payload;
      return await searchNimiNotes({
        database: uploadOwner.database,
        semanticSearch: scope.services ? uploadOwner.getSemanticSearch() : undefined,
        query,
        limit,
        spaceId,
        folderId,
        signal: scope.controller.signal,
        assertCurrent: () => assertCurrent(scope),
      });
    } finally {
      requests.delete(scope.key);
    }
  },
  "openwhispr.conversations.search": async (input) => {
    const scope = requestScope(input, false);
    try {
      assertCurrent(scope);
      const { searchNimiConversations } = require("./nimiNoteSearch");
      const { query, limit } = input.payload;
      return await searchNimiConversations({
        database: uploadOwner.database,
        semanticSearch: scope.services ? uploadOwner.getSemanticSearch() : undefined,
        query,
        limit,
        signal: scope.controller.signal,
        assertCurrent: () => assertCurrent(scope),
      });
    } finally {
      requests.delete(scope.key);
    }
  },
  "openwhispr.ai.edit-text": async (input) => {
    const scope = requestScope(input);
    try {
      const { text, systemPrompt } = input.payload;
      if (typeof text !== "string" || !text.trim() || typeof systemPrompt !== "string")
        throw new Error("Invalid text editing input");
      const result = await editText(scope, text, systemPrompt, input.payload);
      assertCurrent(scope);
      if (!result.trim()) throw new Error("Nimi returned an empty text editing result");
      return { text: result };
    } finally {
      requests.delete(scope.key);
    }
  },
  "openwhispr.ai.cancel": async (input) => {
    const scope = requests.get(input.event.sender.id + ":" + input.payload.requestId);
    if (!scope) return { requested: false, jobs: [] };
    const result = await requestAudioCancel(scope);
    if (scope.recording) retireRecording(scope);
    if (scope.fileReady && !scope.committing) {
      requests.delete(scope.key);
      cleanupFileWork(scope);
    }
    return result;
  },
  "openwhispr.ai.detach": (input) => {
    const scope = requests.get(input.event.sender.id + ":" + input.payload.requestId);
    if (!scope) return { detached: false };
    scope.controller.abort();
    if (scope.recording) retireRecording(scope);
    if (scope.fileReady && !scope.committing) {
      requests.delete(scope.key);
      cleanupFileWork(scope);
    }
    return { detached: true };
  },
};

module.exports = {
  async transcribeCliFile(input, signal) {
    if (Object.keys(input).some((key) => !["filePath", "language"].includes(key)))
      throw new Error("Select models in Nimi; CLI transcription accepts file and language only");
    const assertPrepared = await prepareNodeWork(signal);
    assertPrepared();
    const scope = workScope(`cli:${randomUUID()}`);
    const abort = () => scope.controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await businessAI.assertAllowed();
      assertCurrent(scope);
      const result = await transcribeNimiFile(scope, input, { transcribe, assertCurrent });
      return {
        success: Boolean(result.text),
        text: result.text,
        transcription: result.chunks,
        code: result.text ? undefined : "NO_SPEECH_DETECTED",
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      requests.delete(scope.key);
      cleanupFileWork(scope);
    }
  },
  async cliTranscriptionSelection(signal) {
    const assertPrepared = await prepareNodeWork(signal);
    assertPrepared();
    const scope = workScope(`cli-models:${randomUUID()}`);
    const abort = () => scope.controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const snapshot = await scope.services.aiConfig.get();
      assertCurrent(scope);
      return snapshot.effectiveSelections.filter(
        (value) => value.capabilityContract === "audio.transcribe"
      );
    } finally {
      signal?.removeEventListener("abort", abort);
      requests.delete(scope.key);
    }
  },
  configureSessionPreparation(next) {
    prepareSession = next;
  },
  bindServices,
  invalidate,
  openMeetingWork(input, callbacks) {
    const scope = requestScope(input);
    const { NimiSpeakerTracking } = require("./nimiSpeakerTracking");
    scope.speakerTracking = new NimiSpeakerTracking({
      namespace: input.payload.requestId,
      extract: (bytes, options) => extractSpeaker(scope, bytes, options),
      signal: scope.controller.signal,
      assertCurrent: () => assertCurrent(scope),
      getMaxSpeakers: callbacks.getMaxSpeakers,
    });
    const { NimiMeetingAudio } = require("./nimiMeetingAudio");
    let work;
    try {
      work = new NimiMeetingAudio({
        root: path.join(getAppDataDirectory(), "meeting-work"),
        signal: scope.controller.signal,
        assertCurrent: () => assertCurrent(scope),
        transcribe: (audio) =>
          transcribe(scope, {
            audio,
            mimeType: "audio/wav",
            language: input.payload.language || "",
            prompt: input.payload.prompt || "",
            timestamps: true,
            diarization: callbacks.getDiarization?.() ?? input.payload.diarization === true,
          }),
        onResult: callbacks.onResult,
        onError: callbacks.onError,
      });
    } catch (error) {
      requests.delete(scope.key);
      scope.controller.abort();
      throw error;
    }
    let closing;
    const close = () => {
      if (closing) return closing;
      scope.controller.signal.removeEventListener("abort", onAbort);
      scope.controller.abort();
      requests.delete(scope.key);
      closing = work.close();
      return closing;
    };
    const onAbort = () => {
      void close();
      callbacks.onAbort?.();
    };
    scope.controller.signal.addEventListener("abort", onAbort, { once: true });
    return {
      work,
      assertCurrent: () => assertCurrent(scope),
      close,
      cancel: () => requestAudioCancel(scope),
    };
  },
  commandHandlers,
  configureUploadOwner(owner) {
    uploadOwner = owner;
    nimiEmbeddings.getAccountId = () => owner.database.activeAccountId;
    speakerEmbeddings.getAccountId = () => owner.database.activeAccountId;
  },
};
