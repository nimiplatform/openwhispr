import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import { resolveSegmentSpeakerName } from "./transcriptSpeakerState";

export interface MeetingTranscriptGroup {
  units: TranscriptSegment[];
  text: string;
  attribution: string;
}

// This is the App-owned word id emitted by projectMeetingTranscript. Whole
// transcript segments remain whole rows; only identified alignment units join.
function recordingOfWord(segment: TranscriptSegment): string | undefined {
  const match = /^(.*):(mic|system):\d+:\d+$/.exec(segment.id);
  return match?.[1] && match[2] === segment.source ? match[1] : undefined;
}

function appendWord(text: string, word: string): string {
  const adjacent =
    !text ||
    /\s$/.test(text) ||
    /^\s/.test(word) ||
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(text) ||
    /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Punctuation}]/u.test(word);
  return text + (adjacent ? "" : " ") + word;
}

// Read-only UI projection. The members, rather than a synthetic sentence id or
// clock, remain the selection, naming, persistence and voice-sample owners.
export function groupMeetingTranscript(
  segments: TranscriptSegment[],
  mappings?: Record<string, string>
): MeetingTranscriptGroup[] {
  const groups: MeetingTranscriptGroup[] = [];
  const activeBySource = new Map<string, MeetingTranscriptGroup>();
  let activeRecording: string | undefined;
  for (const segment of segments) {
    const recording = recordingOfWord(segment);
    if (!recording || recording !== activeRecording) activeBySource.clear();
    activeRecording = recording;
    const attribution = JSON.stringify([
      recording ?? null,
      segment.source,
      segment.speaker ?? null,
      resolveSegmentSpeakerName(segment, mappings) ?? null,
      segment.speakerIsPlaceholder ?? null,
      segment.speakerStatus ?? null,
      segment.speakerLocked ?? null,
      segment.speakerLockSource ?? null,
      segment.suggestedName ?? null,
      segment.suggestedProfileId ?? null,
      segment.speakerMatching ?? null,
      segment.clockBasis ?? null,
    ]);
    // Simultaneous mic/system words may interleave in the raw timeline. Each
    // track keeps its own turn; no row ever combines the two sources.
    const last = recording ? activeBySource.get(segment.source) : undefined;
    const previous = last?.units.at(-1);
    const continuous =
      previous &&
      last?.attribution === attribution &&
      Number.isFinite(previous.timestamp) &&
      Number.isFinite(previous.endTimestamp) &&
      Number.isFinite(segment.timestamp) &&
      Number.isFinite(segment.endTimestamp) &&
      previous.endTimestamp! >= previous.timestamp! &&
      segment.endTimestamp! >= segment.timestamp! &&
      segment.timestamp! >= previous.timestamp! &&
      segment.timestamp! - previous.endTimestamp! <= 1500 &&
      !/[.!?。！？]\s*$/.test(previous.text);
    if (continuous && last) {
      last.units.push(segment);
      last.text = appendWord(last.text, segment.text);
    } else {
      const group = { units: [segment], text: segment.text, attribution };
      groups.push(group);
      if (recording) activeBySource.set(segment.source, group);
    }
  }
  return groups;
}

export function meetingGroupSelectionToggles(
  group: MeetingTranscriptGroup,
  selected: Set<string>
): string[] {
  const allSelected = group.units.every((unit) => selected.has(unit.id));
  return group.units.filter((unit) => allSelected || !selected.has(unit.id)).map((unit) => unit.id);
}
