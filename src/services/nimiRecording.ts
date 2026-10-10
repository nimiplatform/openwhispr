import { invokeNimiBusiness, runNimiRequest } from "./nimiClient";
import i18n from "../i18n";

export async function transcribeNimiRecording<T>(
  audio: Blob,
  language: string,
  signal: AbortSignal,
  prompt = ""
): Promise<T> {
  signal.throwIfAborted();
  if (new TextEncoder().encode(prompt).byteLength > 4 * 1024)
    throw new Error(i18n.t("hooks.audioRecording.dictionaryPromptTooLong"));
  const requestId = crypto.randomUUID();
  try {
    await runNimiRequest(
      "openwhispr.recording.begin",
      { requestId, mimeType: audio.type.split(";")[0] },
      signal
    );
    for (let offset = 0; offset < audio.size; offset += 2 * 1024 * 1024) {
      signal.throwIfAborted();
      const bytes = new Uint8Array(
        await audio.slice(offset, offset + 2 * 1024 * 1024).arrayBuffer()
      );
      await runNimiRequest(
        "openwhispr.recording.append",
        { requestId, offset, audio: bytes },
        signal
      );
    }
    return await runNimiRequest<T>(
      "openwhispr.recording.transcribe",
      { requestId, language, prompt },
      signal
    );
  } finally {
    await invokeNimiBusiness("openwhispr.ai.detach", { requestId }).catch(() => {});
  }
}
