// @ts-check
// Project actual word alignment into the App's capture clock. Capture channels
// are source labels; they do not identify people or invent speech boundaries.
/** @param {{ transcript: import("@nimiplatform/sdk/app").NimiLocalAppSpeechTranscript, speakerMap?: Record<string,string>, speakerMatching?: Record<string,string>, source: "mic" | "system", startFrame: number, endFrame: number, sampleRate: number, anchorMs: number, clockBasis: "capture" | "arrival" }} chunk
 * @param {string} sessionId */
function projectMeetingTranscript(chunk, sessionId) {
  const transcript = chunk.transcript;
  if (transcript?.status === "no-speech") return [];
  if (transcript?.status !== "transcribed" || !transcript.text || !transcript.words?.length)
    throw new Error("Meeting recognition requires actual word alignment");
  const duration = (chunk.endFrame - chunk.startFrame) / chunk.sampleRate;
  const origin = chunk.anchorMs + (chunk.startFrame / chunk.sampleRate) * 1000;
  if (!Number.isFinite(origin) || !Number.isFinite(duration) || duration <= 0)
    throw new Error("Invalid meeting source clock");
  return transcript.words.map((word, index) => {
    const { startSeconds: start, endSeconds: end } = word;
    if (
      typeof word.text !== "string" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start ||
      end > duration + 1 / chunk.sampleRate
    )
      throw new Error("Invalid meeting word alignment");
    const speakerFields = require("./nimiSpeakerTracking").projectWordSpeaker(
      transcript,
      start,
      end,
      chunk.speakerMap,
      chunk.speakerMatching
    );
    return {
      id: `${sessionId}:${chunk.source}:${chunk.startFrame}:${index}`,
      text: word.text,
      source: chunk.source,
      timestamp: origin + start * 1000,
      endTimestamp: origin + end * 1000,
      clockBasis: chunk.clockBasis,
      ...speakerFields,
      ...(speakerFields.speakerMatching && speakerFields.speakerMatching !== "matched-space"
        ? { speakerStatus: "provisional" }
        : {}),
      ...(index === 0
        ? {
            recognition: {
              transcript,
              source: chunk.source,
              startFrame: chunk.startFrame,
              endFrame: chunk.endFrame,
              sampleRate: chunk.sampleRate,
              anchorMs: chunk.anchorMs,
              clockBasis: chunk.clockBasis,
              speakerMatching: chunk.speakerMatching,
              speakerMap: chunk.speakerMap,
            },
          }
        : {}),
    };
  });
}
module.exports = { projectMeetingTranscript };
