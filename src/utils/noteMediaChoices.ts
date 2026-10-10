import type { NoteSourceMedia, NoteRecordingMedia } from "../types/electron";

export type NoteMediaSelection =
  { sessionId: string; source: "mic" | "system" } | Record<string, never>;
export interface NoteMediaChoice {
  key: string;
  selection: NoteMediaSelection;
  recordingNumber?: number;
  status?: NoteRecordingMedia["status"];
  source?: "mic" | "system";
  durationSeconds?: number;
}

export function getNoteMediaChoices(media: NoteSourceMedia): NoteMediaChoice[] {
  if (media.recordings === undefined)
    return media.originalPath ? [{ key: "original", selection: {} }] : [];
  if (!Array.isArray(media.recordings)) return [];
  if (media.recordings.length === 0)
    return media.originalPath ? [{ key: "original", selection: {} }] : [];
  const originalIsTrack = media.recordings.some(
    (record) =>
      Array.isArray(record?.tracks) &&
      record.tracks.some((track) => track?.path === media.originalPath)
  );
  const original: NoteMediaChoice[] =
    media.originalPath && !originalIsTrack ? [{ key: "original", selection: {} }] : [];
  return [
    ...original,
    ...media.recordings.flatMap((record, index) => {
      if (!record?.sessionId || !Array.isArray(record.tracks)) return [];
      return record.tracks.flatMap((track, trackIndex) => {
        if (!track || !["mic", "system"].includes(track.source) || !track.path) return [];
        const measured =
          Number.isSafeInteger(track.frameCount) &&
          track.frameCount >= 0 &&
          Number.isSafeInteger(track.sampleRate) &&
          track.sampleRate > 0;
        return [
          {
            key: `${index}:${trackIndex}`,
            selection: { sessionId: record.sessionId, source: track.source },
            recordingNumber: index + 1,
            status: record.status,
            source: track.source,
            durationSeconds: measured ? track.frameCount / track.sampleRate : undefined,
          },
        ];
      });
    }),
  ];
}
