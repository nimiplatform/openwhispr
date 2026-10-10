import { useMemo, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import type { TranscriptSegment } from "../../stores/meetingRecordingStore";
import { groupImportedTranscript } from "../../utils/importedTranscript";
import { resolveSegmentSpeakerName } from "../../utils/transcriptSpeakerState";
import { SpeakerLabel } from "./MeetingTranscriptChat";
import type { NoteSourceMedia } from "../../types/electron";

type LabelProps = ComponentProps<typeof SpeakerLabel>;
type Props = {
  segments: TranscriptSegment[];
  originalText: string;
  originMs?: number;
  media?: NoteSourceMedia;
  className?: string;
  speakerMappings?: Record<string, string>;
  speakerProfiles?: LabelProps["speakerProfiles"];
  participants?: LabelProps["participants"];
  onMapSpeaker?: LabelProps["onMap"];
  onConfirmSuggestion?: LabelProps["onConfirm"];
  onDismissSuggestion?: LabelProps["onDismiss"];
  selectedIds: Set<string>;
  readOnly?: boolean;
  onToggleGroup: (ids: string[]) => void;
};

export function ImportedTranscript(props: Props) {
  const { t } = useTranslation();
  const groups = useMemo(
    () =>
      groupImportedTranscript(
        props.segments,
        props.originalText,
        props.speakerMappings,
        props.media
      ),
    [props.segments, props.originalText, props.speakerMappings, props.media]
  );
  const time = (ms: number, origin: number) => {
    const seconds = Math.max(0, Math.floor((ms - origin) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  return (
    <div className={props.className} data-testid="imported-transcript">
      <div className="divide-y divide-border/60 px-5 py-3">
        {groups.map((group, index) => {
          const first = group.units[0];
          const starts = group.units.flatMap((s) =>
            s.timestamp === undefined ? [] : [s.timestamp]
          );
          const ends = group.units.flatMap((s) =>
            s.endTimestamp === undefined ? [] : [s.endTimestamp]
          );
          const selected = group.units.every((s) => props.selectedIds.has(s.id));
          const partlySelected = !selected && group.units.some((s) => props.selectedIds.has(s.id));
          const origin =
            group.media?.originMs ??
            (group.media?.kind === "original" ? props.originMs : undefined);
          return (
            <section
              key={first.id}
              className="group py-4"
              data-testid="imported-transcript-paragraph"
            >
              <div className="mb-2 flex min-h-6 flex-wrap items-center gap-3 text-xs text-muted-foreground">
                {!props.readOnly && (
                  <input
                    type="checkbox"
                    checked={selected}
                    aria-checked={partlySelected ? "mixed" : selected}
                    aria-label={`${t("notes.editor.transcript")} ${index + 1}`}
                    onChange={() => props.onToggleGroup(group.units.map((s) => s.id))}
                  />
                )}
                {group.media?.kind === "recording" && (
                  <span>
                    {group.media.recordingNumber !== undefined && (
                      <>
                        {t("nimi.recordingMedia.recording", {
                          number: group.media.recordingNumber,
                        })}{" "}
                        ·{" "}
                      </>
                    )}
                    {t(
                      group.media.source === "mic"
                        ? "nimi.recordingMedia.mic"
                        : "nimi.recordingMedia.system"
                    )}
                    {group.media.status && (
                      <> · {t("nimi.recordingMedia.status." + group.media.status)}</>
                    )}
                  </span>
                )}
                {origin !== undefined &&
                  Number.isFinite(origin) &&
                  starts.length > 0 &&
                  ends.length > 0 && (
                    <span className="tabular-nums">
                      {time(Math.min(...starts), origin)}–{time(Math.max(...ends), origin)}
                    </span>
                  )}
                {first.speaker && (
                  <SpeakerLabel
                    speakerId={first.speaker}
                    segment={first}
                    resolvedName={resolveSegmentSpeakerName(first, props.speakerMappings)}
                    speakerProfiles={props.speakerProfiles}
                    participants={props.participants}
                    colorIdx={index % 8}
                    isOriginallyYou={first.speaker === "you"}
                    onMap={props.onMapSpeaker}
                    onConfirm={props.onConfirmSuggestion}
                    onDismiss={props.onDismissSuggestion}
                    t={t}
                  />
                )}
              </div>
              <p dir="auto" className="whitespace-pre-wrap text-sm leading-7 text-foreground">
                {group.text}
              </p>
            </section>
          );
        })}
      </div>
    </div>
  );
}
