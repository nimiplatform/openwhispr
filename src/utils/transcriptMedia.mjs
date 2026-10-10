/** @typedef {{key: string, kind: "original" | "recording", originMs?: number,
 * durationSeconds?: number, name?: string, recordingNumber?: number, source?: string, status?: string,
 * selection?: import("../types/electron").NoteTranscriptSource}} TranscriptMediaSource */

/** @param {{source?: string}} segment */
export function hasCaptureSource(segment) {
  return segment.source === "mic" || segment.source === "system";
}

// Uploaded alignment has a source-local clock encoded with its import origin.
// Compare capture clocks only with other capture clocks, never that origin.
/** @param {{source?: string, timestamp?: number}} a
 * @param {{source?: string, timestamp?: number}} b */
export function compareTranscriptSegments(a, b) {
  const domain = Number(hasCaptureSource(a)) - Number(hasCaptureSource(b));
  if (!Number.isFinite(a.timestamp) || !Number.isFinite(b.timestamp)) return domain;
  return domain || (a.timestamp ?? Infinity) - (b.timestamp ?? Infinity);
}

/** @param {{id?: string, source?: string}} segment
 * @param {import("../types/electron").NoteSourceMedia | undefined} media
 * @returns {TranscriptMediaSource} */
export function resolveTranscriptSource(segment, media) {
  if (!hasCaptureSource(segment)) {
    return {
      key: "original",
      kind: "original",
      originMs: media?.transcriptOriginMs,
      durationSeconds: media?.durationSeconds,
      name: media?.originalName,
      selection: /** @type {import("../types/electron").NoteTranscriptSource} */ ({
        type: "original",
      }),
    };
  }
  const matches = (media?.recordings ?? []).filter((r) =>
    segment.id?.startsWith(r.sessionId + ":")
  );
  const recording = matches.length === 1 ? matches[0] : undefined;
  const tracks = recording?.tracks.filter((track) => track.source === segment.source) ?? [];
  const track = tracks.length === 1 ? tracks[0] : undefined;
  return {
    key: recording
      ? JSON.stringify([recording.sessionId, segment.source])
      : "unbound:" + segment.source,
    kind: "recording",
    recordingNumber: recording ? (media?.recordings ?? []).indexOf(recording) + 1 : undefined,
    source: segment.source,
    status: recording?.status,
    originMs: track?.anchorMs,
    durationSeconds:
      track && track.sampleRate > 0 && track.frameCount >= 0
        ? track.frameCount / track.sampleRate
        : undefined,
    selection:
      recording && track
        ? /** @type {import("../types/electron").NoteTranscriptSource} */ ({
            type: "recording",
            sessionId: recording.sessionId,
            source: track.source,
          })
        : undefined,
  };
}

/** @param {Array<{id?: string, source?: string}>} segments
 * @param {import("../types/electron").NoteSourceMedia | undefined} media */
export function listTranscriptSources(segments, media) {
  const sources = /** @type {Map<string, TranscriptMediaSource>} */ (new Map());
  for (const segment of segments) {
    const source = resolveTranscriptSource(segment, media);
    if (!sources.has(source.key)) sources.set(source.key, source);
  }
  return [...sources.values()];
}

/** @param {Array<{id?: string, source?: string}>} segments
 * @param {import("../types/electron").NoteSourceMedia | undefined} media
 * @param {import("../types/electron").NoteTranscriptSource} selection */
export function selectTranscriptSource(segments, media, selection) {
  if (Array.isArray(selection)) throw new Error("Invalid transcript source selection");
  const keys =
    selection && typeof selection === "object" ? Object.keys(selection).sort().join(",") : "";
  if (
    !(selection?.type === "original" && keys === "type") &&
    !(
      selection?.type === "recording" &&
      keys === "sessionId,source,type" &&
      typeof selection.sessionId === "string" &&
      ["mic", "system"].includes(selection.source)
    )
  )
    throw new Error("Invalid transcript source selection");
  const source = listTranscriptSources(segments, media).find(
    (s) =>
      s.selection?.type === selection.type &&
      (selection.type === "original" ||
        (s.selection?.type === "recording" &&
          s.selection.sessionId === selection.sessionId &&
          s.selection.source === selection.source))
  );
  if (!source) throw new Error("Selected media has no transcript in this note");
  if (!Number.isFinite(source.originMs))
    throw new Error("Selected media has no actual alignment clock");
  return {
    source,
    segments: segments.filter(
      (segment) => resolveTranscriptSource(segment, media).key === source.key
    ),
  };
}
