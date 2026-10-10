export type NimiBusinessInvoker = <T>(
  command: string,
  input: Record<string, unknown>
) => Promise<T>;

export const NIMI_USER_CANCEL = { code: "OPENWHISPR_USER_CANCEL" } as const;
const AUDIO_OBSERVATION_COMMANDS = new Set([
  "openwhispr.ai.transcribe",
  "openwhispr.ai.transcribe-file",
  "openwhispr.history.retry",
  "openwhispr.recording.begin",
  "openwhispr.recording.append",
  "openwhispr.recording.transcribe",
  "openwhispr.upload.commit-note",
]);

export function assertNimiAudioCancellation(result: unknown): void {
  const facts = result as { jobs?: { stopOutcome?: string }[] } | undefined;
  if (facts?.jobs?.some((job) => job.stopOutcome === "unconfirmed"))
    throw Object.assign(
      new Error("Cancellation was requested, but the model has not confirmed it stopped."),
      { code: "NIMI_AUDIO_CANCEL_UNCONFIRMED", audioCancellationFailed: true }
    );
}

export function createNimiRequestRunner(invoke: NimiBusinessInvoker) {
  return async function runNimiRequest<T>(
    command: string,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    signal?.throwIfAborted();
    const requestId = typeof input.requestId === "string" ? input.requestId : crypto.randomUUID();
    const pending = invoke<T>(command, { ...input, requestId });
    let control: Promise<{ error?: unknown; result?: unknown }> | undefined;
    const cancel = () => {
      const explicit = signal?.reason?.code === NIMI_USER_CANCEL.code;
      const action =
        !explicit && AUDIO_OBSERVATION_COMMANDS.has(command)
          ? "openwhispr.ai.detach"
          : "openwhispr.ai.cancel";
      control = invoke(action, { requestId }).then(
        (result) => ({ result }),
        (error) => ({ error })
      );
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = await pending;
      signal?.throwIfAborted();
      return result;
    } finally {
      signal?.removeEventListener("abort", cancel);
      const outcome = await control;
      if (outcome?.error) {
        if (outcome.error instanceof Error)
          Object.assign(outcome.error, { audioCancellationFailed: true });
        throw outcome.error;
      }
      if (outcome) assertNimiAudioCancellation(outcome.result);
    }
  };
}
