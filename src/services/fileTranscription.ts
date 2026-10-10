import { runNimiRequest } from "./nimiClient";
import type { NoteItem } from "../types/electron";

export interface FileTranscriptionConfig {
  language: string;
}
export interface DiarizationSettings {
  enabled: boolean;
  numSpeakers: number | null;
}
export interface FileTranscriptionResult {
  success: boolean;
  status?: "transcribed" | "no-speech";
  text?: string;
  error?: string;
  code?: string;
  messageKey?: string;
  diarized?: boolean;
  diarizationWarning?: boolean;
  speakerMatchingWarning?: boolean;
  warning?: string;
  failedChunks?: number;
  totalChunks?: number;
  durationSeconds?: number | null;
  segments?: Array<{ text: string; start: number; end: number; speaker?: string }>;
}

export async function transcribeFile(
  filePath: string,
  config: FileTranscriptionConfig,
  diarize: boolean,
  options: {
    requestId?: string;
    timestamps?: boolean;
    signal?: AbortSignal;
    retainForNote?: boolean;
    numSpeakers?: number | null;
  } = {}
): Promise<FileTranscriptionResult> {
  return runNimiRequest<FileTranscriptionResult>(
    "openwhispr.ai.transcribe-file",
    {
      requestId: options.requestId ?? crypto.randomUUID(),
      filePath,
      language: config.language,
      timestamps: diarize || Boolean(options.timestamps),
      diarization: diarize,
      numSpeakers: options.numSpeakers ?? null,
      retainForNote: Boolean(options.retainForNote),
    },
    options.signal
  );
}

export async function transcribeFileWithSpeakers(
  filePath: string,
  config: FileTranscriptionConfig,
  diarization: DiarizationSettings,
  _durationSeconds?: number | null,
  options: { requestId?: string; timestamps?: boolean; signal?: AbortSignal } = {}
): Promise<FileTranscriptionResult> {
  return transcribeFile(filePath, config, diarization.enabled, {
    ...options,
    numSpeakers: diarization.numSpeakers,
    retainForNote: true,
  });
}

export interface TranscriptionApiKeys {
  openaiApiKey: string;
  groqApiKey: string;
  xaiApiKey: string;
  mistralApiKey: string;
  geminiApiKey: string;
  tinfoilApiKey: string;
  deepgramApiKey: string;
  assemblyaiApiKey: string;
  customTranscriptionApiKey?: string;
}

export function getTranscriptionApiKey(provider: string, keys: TranscriptionApiKeys): string {
  switch (provider) {
    case "openai":
      return keys.openaiApiKey;
    case "groq":
      return keys.groqApiKey;
    case "xai":
      return keys.xaiApiKey;
    case "mistral":
      return keys.mistralApiKey;
    case "gemini":
      return keys.geminiApiKey;
    case "tinfoil":
      return keys.tinfoilApiKey;
    case "deepgram":
      return keys.deepgramApiKey;
    case "assemblyai":
      return keys.assemblyaiApiKey;
    case "custom":
      return keys.customTranscriptionApiKey || "";
    default:
      return "";
  }
}
