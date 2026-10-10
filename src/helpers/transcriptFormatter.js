const { i18nMain } = require("./i18nMain");
const {
  compareTranscriptSegments,
  resolveTranscriptSource,
  listTranscriptSources,
  selectTranscriptSource,
} = require("../utils/transcriptMedia.mjs");

function sourceLabel(source) {
  if (source.kind === "original") return i18nMain.t("nimi.originalSource");
  return [
    source.recordingNumber == null
      ? null
      : i18nMain.t("nimi.recordingMedia.recording", { number: source.recordingNumber }),
    i18nMain.t(source.source === "mic" ? "nimi.recordingMedia.mic" : "nimi.recordingMedia.system"),
    source.status ? i18nMain.t("nimi.recordingMedia.status." + source.status) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function resolveSpeaker(seg, speakerMappings) {
  if (seg.speakerName && !seg.speakerIsPlaceholder) return seg.speakerName;
  if (seg.speaker && speakerMappings[seg.speaker]) return speakerMappings[seg.speaker];
  if (seg.speaker === "you") return i18nMain.t("transcript.speaker.you");
  if (seg.speaker) {
    const num = parseInt(seg.speaker.replace("speaker_", ""), 10);
    if (!isNaN(num)) return i18nMain.t("notes.speaker.label", { n: num + 1 });
  }
  if (seg.source === "mic") return i18nMain.t("transcript.speaker.you");
  if (seg.source === "system") return i18nMain.t("transcript.speaker.others");
  return i18nMain.t("notes.speaker.unknown");
}

// Segments merge only when they resolve to the same display name, so the key has
// to cover every field resolveSpeaker reads — a manually named segment would
// otherwise absorb the un-named one beside it.
function speakerKey(seg) {
  const named = seg.speakerName && !seg.speakerIsPlaceholder ? seg.speakerName : "";
  return [seg.speaker || "", named, seg.speaker ? "" : seg.source || ""].join("\u0000");
}

function parseNoteDate(createdAt) {
  if (createdAt == null || createdAt === "") {
    return new Date(NaN);
  }
  if (typeof createdAt === "number") {
    return new Date(createdAt);
  }

  const value = String(createdAt).trim();
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) {
    return new Date(value);
  }

  // SQLite CURRENT_TIMESTAMP is UTC without a timezone suffix.
  return new Date(value.includes("T") ? `${value}Z` : `${value.replace(" ", "T")}Z`);
}

function resolveRecordingStartMs(segments, note) {
  const importOrigin = note?.source_media?.transcriptOriginMs;
  if (typeof importOrigin === "number" && Number.isFinite(importOrigin)) return importOrigin;
  const segmentTimestamps = segments
    .map((seg) => seg.timestamp)
    .filter((ts) => typeof ts === "number" && Number.isFinite(ts));

  if (segmentTimestamps.length > 0) {
    return Math.min(...segmentTimestamps);
  }

  const noteDate = parseNoteDate(note?.created_at);
  return Number.isNaN(noteDate.getTime()) ? null : noteDate.getTime();
}

function normalizeSegmentTimestamps(segments, note) {
  const media = note?.source_media;
  if (media?.recordings?.length) {
    const multi = listTranscriptSources(segments, media).length > 1;
    return [...segments].sort(compareTranscriptSegments).map((seg) => {
      const source = resolveTranscriptSource(seg, media);
      const normalized = { ...seg };
      normalized.sourceClockKnown = Number.isFinite(source.originMs);
      for (const key of ["timestamp", "endTimestamp"]) {
        if (Number.isFinite(seg[key]) && Number.isFinite(source.originMs))
          normalized[key] = (seg[key] - source.originMs) / 1000;
        else delete normalized[key];
      }
      if (multi) normalized.media = source;
      return normalized;
    });
  }
  const startMs = resolveRecordingStartMs(segments, note);
  if (startMs == null || startMs <= 1e9) {
    return segments;
  }

  return segments.map((seg) => {
    const normalized = { ...seg };
    if (typeof seg.timestamp === "number" && Number.isFinite(seg.timestamp)) {
      normalized.timestamp = (seg.timestamp - startMs) / 1000;
    }
    if (typeof seg.endTimestamp === "number" && Number.isFinite(seg.endTimestamp)) {
      normalized.endTimestamp = (seg.endTimestamp - startMs) / 1000;
    }
    return normalized;
  });
}

function mergeSegments(segments, limits = {}) {
  const merged = [];
  let lastTimestamp = null;
  for (const seg of segments) {
    if (!seg.text?.trim()) continue;
    const ts = seg.sourceClockKnown === false ? undefined : (seg.timestamp ?? 0);
    const last = merged[merged.length - 1];
    const measuredEnd = typeof seg.endTimestamp === "number" && Number.isFinite(seg.endTimestamp);
    const cjkJoin =
      last &&
      /[\p{Unified_Ideograph}，。！？]$/u.test(last.text) &&
      /^[\p{Unified_Ideograph}，。！？]/u.test(seg.text);
    const joined = last ? last.text + (cjkJoin ? "" : " ") + seg.text.trim() : seg.text.trim();
    const bounded =
      !last ||
      (Array.from(joined).length <= (limits.characters ?? Infinity) &&
        (!measuredEnd || seg.endTimestamp - last.timestamp <= (limits.seconds ?? Infinity)));
    if (
      last &&
      bounded &&
      last.media?.key === seg.media?.key &&
      speakerKey(last) === speakerKey(seg) &&
      ts - lastTimestamp < 2
    ) {
      last.text = joined;
      if (measuredEnd && typeof last.endTimestamp === "number")
        last.endTimestamp = Math.max(last.endTimestamp, seg.endTimestamp);
      else delete last.endTimestamp;
    } else {
      const next = { ...seg, timestamp: ts, text: seg.text.trim() };
      if (!measuredEnd) delete next.endTimestamp;
      merged.push(next);
    }
    lastTimestamp = ts;
  }
  return merged;
}

function readableSegments(segments, note) {
  const normalized = normalizeSegmentTimestamps(segments, note);
  const merged = mergeSegments(normalized);
  const original = normalized.filter((segment) => !segment.source);
  const raw = note.source_media?.chunks?.map((chunk) => chunk.transcript.text).join("\n");
  if (
    !raw ||
    !original.length ||
    original.some((s) => s.speaker || s.speakerName || s.suggestedName)
  )
    return merged;
  // Full-text recovery belongs only to the original file. A reading paragraph
  // may span its measured words; subtitle cues still use their raw alignment.
  const starts = original.map((s) => s.timestamp).filter(Number.isFinite);
  const ends = original.map((s) => s.endTimestamp).filter(Number.isFinite);
  return [
    {
      ...original[0],
      text: raw,
      timestamp: starts.length ? Math.min(...starts) : undefined,
      endTimestamp: ends.length ? Math.max(...ends) : undefined,
    },
    ...merged.filter((segment) => segment.source),
  ];
}

function formatTimestamp(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function formatSrtTimestamp(seconds) {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function extractMetadata(note) {
  const title = note.title || "Untitled";
  const noteDate = parseNoteDate(note.created_at);
  const dateStr =
    noteDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) +
    " " +
    noteDate.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  let participants = [];
  try {
    const parsed = JSON.parse(note.participants || "[]");
    participants = parsed.map((p) => p.displayName || p.email).filter(Boolean);
  } catch {}

  return { title, dateStr, participants };
}

function formatTxt(note, segments, speakerMappings) {
  const merged = readableSegments(segments, note);
  const { title, dateStr, participants } = extractMetadata(note);

  const lines = [title, dateStr];
  if (participants.length)
    lines.push(`${i18nMain.t("notes.editor.participants")}: ${participants.join(", ")}`);
  lines.push("", "──────────────────────────────────", "");
  let previousMedia;
  for (const seg of merged) {
    if (seg.media?.key !== previousMedia) {
      if (seg.media) lines.push(sourceLabel(seg.media), "");
      previousMedia = seg.media?.key;
    }
    lines.push(`[${formatTimestamp(seg.timestamp)}] ${resolveSpeaker(seg, speakerMappings)}:`);
    lines.push(seg.text);
    lines.push("");
  }
  return lines.join("\n");
}

function formatSrt(segments, speakerMappings, note = {}, selection) {
  if (selection) segments = selectTranscriptSource(segments, note.source_media, selection).segments;
  if (
    note.source_media?.recordings?.length &&
    listTranscriptSources(segments, note.source_media).length > 1
  )
    throw new Error("Choose one media source for subtitle export");
  const measured = segments.every(
    (seg) => typeof seg.endTimestamp === "number" && Number.isFinite(seg.endTimestamp)
  );
  if (!measured) throw new Error("Subtitle export requires actual alignment end times");
  const normalized = normalizeSegmentTimestamps(segments, note);
  if (
    normalized.some(
      (seg) =>
        !Number.isFinite(seg.timestamp) ||
        seg.timestamp < 0 ||
        !Number.isFinite(seg.endTimestamp) ||
        seg.endTimestamp < seg.timestamp
    )
  )
    throw new Error("Subtitle export requires an actual source-local alignment clock");
  const merged = mergeSegments(normalized, { seconds: 6, characters: 64 });
  // Upload transcripts carry no speaker identity at all; prefixing every cue
  // with "Unknown Speaker:" would defeat the subtitle use case. Meeting
  // segments always serialize a source, so they keep their labels.
  const hasSpeakerIdentity = merged.some((seg) => seg.speaker || seg.speakerName || seg.source);
  const entries = [];
  for (let i = 0; i < merged.length; i++) {
    const seg = merged[i];
    const nextTs = seg.endTimestamp;
    entries.push(`${i + 1}`);
    entries.push(`${formatSrtTimestamp(seg.timestamp)} --> ${formatSrtTimestamp(nextTs)}`);
    const text = hasSpeakerIdentity
      ? `${resolveSpeaker(seg, speakerMappings)}: ${seg.text}`
      : seg.text;
    const points = Array.from(text);
    const lines = [];
    for (let start = 0; start < points.length; start += 64)
      lines.push(points.slice(start, start + 64).join(""));
    entries.push(lines.join("\n"));
    entries.push("");
  }
  return entries.join("\n");
}

function formatJson(note, segments, speakerMappings) {
  const merged = readableSegments(segments, note);
  const { title, dateStr } = extractMetadata(note);

  const speakersSet = new Set();
  for (const seg of merged) {
    if (seg.speaker || (seg.speakerName && !seg.speakerIsPlaceholder))
      speakersSet.add(resolveSpeaker(seg, speakerMappings));
  }
  const lastSeg = merged[merged.length - 1];
  const sources = listTranscriptSources(segments, note.source_media);
  const multi = note.source_media?.recordings?.length && sources.length > 1;

  return JSON.stringify(
    {
      metadata: {
        title,
        date: dateStr,
        ...(multi ? { timestamp_unit: "seconds", timestamp_basis: "media-relative" } : {}),
        duration_seconds: multi
          ? null
          : typeof note.audio_duration_seconds === "number"
            ? note.audio_duration_seconds
            : (lastSeg?.endTimestamp ?? null),
        speaker_count: speakersSet.size || null,
        segment_count: merged.length,
      },
      speakers: [...speakersSet],
      ...(multi
        ? {
            media: sources.map((source) => ({
              id: source.key,
              kind: source.kind,
              label: sourceLabel(source),
              name: source.name,
              origin_ms: source.originMs,
              duration_seconds: source.durationSeconds ?? null,
              status: source.status,
              ...(source.kind === "original"
                ? {
                    original_text: note.source_media.chunks
                      ?.map((chunk) => chunk.transcript.text)
                      .join("\n"),
                  }
                : {}),
            })),
          }
        : {}),
      segments: merged.map((seg) => ({
        speaker: resolveSpeaker(seg, speakerMappings),
        timestamp: seg.timestamp,
        endTimestamp: seg.endTimestamp,
        text: seg.text,
        ...(seg.media ? { media: seg.media.key } : {}),
      })),
    },
    null,
    2
  );
}

function formatMd(note, segments, speakerMappings) {
  const merged = readableSegments(segments, note);
  const { title, dateStr, participants } = extractMetadata(note);

  const lines = [`# ${title}`, "", `**Date:** ${dateStr}`];
  if (participants.length)
    lines.push(`**${i18nMain.t("notes.editor.participants")}:** ${participants.join(", ")}`);
  lines.push("", "---", "");
  let previousMedia;
  for (const seg of merged) {
    if (seg.media?.key !== previousMedia) {
      if (seg.media) lines.push(`## ${sourceLabel(seg.media)}`, "");
      previousMedia = seg.media?.key;
    }
    lines.push(`**${resolveSpeaker(seg, speakerMappings)}** \`${formatTimestamp(seg.timestamp)}\``);
    lines.push(`${seg.text}`, "");
  }
  return lines.join("\n");
}

module.exports = {
  formatTxt,
  formatSrt,
  formatJson,
  formatMd,
  parseNoteDate,
  normalizeSegmentTimestamps,
};
