import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import { resolveSegmentSpeakerName } from "./transcriptSpeakerState";
import type { NoteSourceMedia } from "../types/electron";
import {
  compareTranscriptSegments,
  hasCaptureSource,
  resolveTranscriptSource,
} from "./transcriptMedia.mjs";

export type ImportedTranscriptGroup = {
  units: TranscriptSegment[];
  text: string;
  media?: ReturnType<typeof resolveTranscriptSource>;
};

// A display projection only: the raw alignment units remain the persistence,
// naming and selection owners. A paragraph never creates a new clock or voice.
export function groupImportedTranscript(
  segments: TranscriptSegment[],
  originalText: string,
  mappings?: Record<string, string>,
  media?: NoteSourceMedia
): ImportedTranscriptGroup[] {
  const ordered = [...segments].sort(compareTranscriptSegments);
  // Only the uploaded words may use the uploaded full-text recovery. Capture
  // words remain visible even when they have no model speaker attribution.
  const imported = ordered.filter((s) => !hasCaptureSource(s));
  const recorded = ordered.filter(hasCaptureSource);
  return [
    ...groupAlignedTranscript(imported, originalText, mappings, media),
    ...groupAlignedTranscript(recorded, "", mappings, media),
  ].map((group) => ({ ...group, media: resolveTranscriptSource(group.units[0], media) }));
}

function groupAlignedTranscript(
  segments: TranscriptSegment[],
  originalText: string,
  mappings?: Record<string, string>,
  media?: NoteSourceMedia
): ImportedTranscriptGroup[] {
  if (!segments.length) return [];
  const groups: ImportedTranscriptGroup[] = [];
  const attribution = (s: TranscriptSegment) =>
    JSON.stringify([
      s.source ?? null,
      s.speaker ?? null,
      resolveSegmentSpeakerName(s, mappings) ?? null,
      s.speakerStatus ?? null,
      s.speakerLocked ?? null,
      s.suggestedName ?? null,
      resolveTranscriptSource(s, media).key,
    ]);
  let cursor = 0;
  let exactText = Boolean(originalText);
  for (const segment of segments) {
    const last = groups.at(-1);
    const previous = last?.units.at(-1);
    const gap =
      previous?.endTimestamp !== undefined && segment.timestamp !== undefined
        ? segment.timestamp - previous.endTimestamp
        : 0;
    const boundary =
      !previous ||
      attribution(previous) !== attribution(segment) ||
      /[.!?。！？]\s*$/.test(previous.text) ||
      gap > 1500;
    const group = boundary ? { units: [], text: "" } : last!;
    if (boundary) groups.push(group);
    group.units.push(segment);
    const position = originalText.indexOf(segment.text, cursor);
    if (exactText && position >= cursor && /^\s*$/.test(originalText.slice(cursor, position))) {
      group.text += originalText.slice(cursor, position + segment.text.length);
      cursor = position + segment.text.length;
    } else exactText = false;
  }
  if (exactText && /^\s*$/.test(originalText.slice(cursor))) {
    if (groups.length) groups[groups.length - 1].text += originalText.slice(cursor);
    return groups;
  }
  if (originalText && segments.every((s) => !s.speaker && !s.speakerName && !s.suggestedName)) {
    return [{ units: [...segments], text: originalText }];
  }
  // Some model word lists omit punctuation. Keep those actual words in their
  // attributed groups; never assign omitted text to a guessed speaker.
  for (const group of groups) {
    group.text = group.units
      .map((s) => s.text)
      .reduce((text, token) => {
        const adjacent =
          /\s$/.test(text) ||
          /^\s/.test(token) ||
          !text ||
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(text) ||
          /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Punctuation}]/u.test(token);
        return text + (adjacent ? "" : " ") + token;
      }, "");
  }
  return groups;
}
