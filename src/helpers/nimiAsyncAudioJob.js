const { randomUUID } = require("node:crypto");

let modules;
const sdk = () =>
  (modules ??= Promise.all([
    import("@nimiplatform/sdk/runtime"),
    import("@nimiplatform/sdk/app"),
    import("@nimiplatform/sdk/runtime/wire-types"),
  ]));
function uncertainSubmission(error) {
  const code = error?.reasonCode ?? error?.code;
  return (
    code == null ||
    [
      2,
      4,
      13,
      14,
      "UNKNOWN",
      "DEADLINE_EXCEEDED",
      "INTERNAL",
      "UNAVAILABLE",
      "RUNTIME_UNAVAILABLE",
      "runtime-unavailable",
      "ECONNRESET",
      "ETIMEDOUT",
    ].includes(code)
  );
}

function rememberIdentity(error, identity) {
  if (error && Object.isExtensible(error))
    Object.assign(error, { ...identity, details: { ...error.details, ...identity } });
  return error;
}

// Only the App's actual transcription and speaker work use this adapter. The
// public SDK owns serialized Get cadence, stream disposal and terminal readers.
async function runNimiAudioJob({
  ai,
  spec,
  signal,
  cancelSignal,
  assertCurrent,
  assertControlCurrent = assertCurrent,
  onObservation = undefined,
  onCancel = undefined,
  getIntervalMs = 1000,
}) {
  assertCurrent();
  signal?.throwIfAborted();
  const requireActiveAction = () => {
    if (cancelSignal?.aborted) {
      onCancel?.({ notDispatched: true });
      cancelSignal.throwIfAborted();
    }
  };
  requireActiveAction();
  const [runtime, app, wire] = await sdk();
  assertCurrent();
  requireActiveAction();
  const scenarioType =
    spec.type === "speech-transcribe"
      ? wire.ScenarioType.SPEECH_TRANSCRIBE
      : spec.type === "audio-speaker-embed"
        ? wire.ScenarioType.AUDIO_SPEAKER_EMBED
        : undefined;
  if (scenarioType === undefined) throw new Error("Unsupported audio action type");
  // Invocation identity only: no database, audio copy or cross-restart recovery
  // promise. Existing history and note owners retain actual business results.
  const clientSubmissionId = randomUUID();
  let receipt;
  try {
    receipt = await ai.scenarioJobs.submit(spec, { clientSubmissionId });
  } catch (error) {
    assertCurrent();
    if (!uncertainSubmission(error)) {
      throw rememberIdentity(error, { clientSubmissionId });
    }
    try {
      receipt = await ai.scenarioJobs.lookupSubmission(clientSubmissionId);
    } catch (lookupError) {
      throw Object.assign(
        new Error("The audio submission could not be confirmed. It has not been submitted again."),
        {
          code: "NIMI_AUDIO_SUBMISSION_UNCONFIRMED",
          cause: error,
          lookupError,
          clientSubmissionId,
          details: {
            clientSubmissionId,
            submissionError: {
              message: error?.message,
              reasonCode: error?.reasonCode ?? error?.code,
            },
            lookupError: {
              message: lookupError?.message,
              reasonCode: lookupError?.reasonCode ?? lookupError?.code,
            },
          },
        }
      );
    }
  }
  const jobId = receipt.job.jobId;
  if (!jobId || receipt.job.scenarioType !== spec.type)
    throw new Error("Audio submission returned a different Job");
  try {
    assertCurrent();
    const api = {
      ...ai.scenarioJobs,
      cancel: async (...args) => {
        let response;
        try {
          response = await ai.scenarioJobs.cancel(...args);
        } catch (error) {
          rememberIdentity(error, { jobId, clientSubmissionId });
          onCancel?.({ error });
          throw error;
        }
        onCancel?.({ response });
        assertControlCurrent();
        return response;
      },
    };
    await runtime.observeNimiRuntimeScenarioJob({
      ai: app.createNimiLocalAppRuntimeScenarioJobClient({ ...ai, scenarioJobs: api }),
      jobId,
      scenarioType,
      signal,
      cancelSignal,
      getIntervalMs,
      onObservation(response) {
        assertCurrent();
        onObservation?.(response);
      },
    });
    assertCurrent();
    // Preserve the complete, typed Local App Get result used by the original
    // product. Never reconstruct transcription or a vector from an artifact ID.
    const result = await ai.scenarioJobs.get(jobId);
    assertCurrent();
    if (
      result.job.jobId !== jobId ||
      result.job.scenarioType !== spec.type ||
      result.job.status !== "completed"
    )
      throw new Error("Original audio action has no completed typed result");
    cancelSignal?.throwIfAborted();
    return result;
  } catch (error) {
    throw rememberIdentity(error, { jobId, clientSubmissionId });
  }
}

module.exports = { runNimiAudioJob };
