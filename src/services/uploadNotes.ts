import { runNimiRequest } from "./nimiClient";
import type { DiarizationSettings } from "./fileTranscription";

export interface UploadSegment {
  text: string;
  start: number;
  end?: number;
  speaker?: string;
}

interface SaveUploadNoteParams {
  title: string;
  text: string;
  sourceName: string;
  folderId: number | null;
  diarization: DiarizationSettings;
  durationSeconds?: number | null;
  segments?: UploadSegment[] | null;
  requestId: string;
  signal?: AbortSignal;
}

// The Host commits its captured transcription and timing under this request identity.
export async function saveUploadNote({
  title,
  text,
  sourceName,
  folderId,
  diarization,
  durationSeconds,
  segments,
  requestId,
  signal,
}: SaveUploadNoteParams) {
  signal?.throwIfAborted();
  if (!requestId) throw new Error("Upload work identity is missing");
  const result = await runNimiRequest<{
    success: boolean;
    note?: import("../types/electron").NoteItem;
  }>(
    "openwhispr.upload.commit-note",
    {
      requestId,
      title,
      sourceName,
      folderId,
    },
    signal
  );
  if (!result.success || !result.note) throw new Error("Imported note was not saved");
  return result;
}

// First words of the transcript, else the file name without its extension.
export function uploadTitleFallback(text: string, fileName: string): string {
  const words = text.trim().split(/\s+/);
  const preview = words.slice(0, 6).join(" ") + (words.length > 6 ? "..." : "");
  const title = preview || fileName.replace(/\.[^.]+$/, "");
  const points = Array.from(title);
  return points.length > 120 ? points.slice(0, 120).join("") + "…" : title;
}
