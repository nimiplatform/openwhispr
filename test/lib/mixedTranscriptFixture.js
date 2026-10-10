// Explicit model/media fixtures for clock-domain and reading tests, not AI acceptance.
module.exports = function mixedTranscriptFixture() {
  const origin = 1791400000000;
  const imported = [
    { text: "Hello", timestamp: origin + 2300, endTimestamp: origin + 2710 },
    { text: "world", timestamp: origin + 304000, endTimestamp: origin + 304400 },
  ];
  const recorded = [
    {
      id: "live-session:mic:0:0",
      text: "新发言。",
      source: "mic",
      timestamp: origin + 20000,
      endTimestamp: origin + 20800,
      clockBasis: "arrival",
    },
    {
      id: "live-session:system:0:0",
      text: "New reply.",
      source: "system",
      timestamp: origin + 22000,
      endTimestamp: origin + 22400,
      clockBasis: "arrival",
    },
  ];
  const media = {
    originalName: "long.wav",
    originalPath: "imports/original/source.wav",
    audioPath: "imports/original/audio.wav",
    transcriptOriginMs: origin,
    durationSeconds: 305,
    chunks: [
      {
        offsetSeconds: 0,
        durationSeconds: 305,
        transcript: { status: "transcribed", text: "Hello, world!", words: [] },
        jobId: "fixture-import",
      },
    ],
    recordings: [
      {
        sessionId: "live-session",
        status: "canceled",
        originalPath: "imports/live/mic.wav",
        audioPath: "imports/live/mic.wav",
        tracks: [
          {
            source: "mic",
            path: "imports/live/mic.wav",
            anchorMs: origin + 19000,
            clockBasis: "arrival",
            sampleRate: 24000,
            frameCount: 48000,
          },
          {
            source: "system",
            path: "imports/live/system.wav",
            anchorMs: origin + 19500,
            clockBasis: "arrival",
            sampleRate: 24000,
            frameCount: 72000,
          },
        ],
      },
    ],
  };
  return {
    origin,
    imported,
    recorded,
    media,
    note: {
      title: "Mixed media",
      created_at: "2026-10-10T00:00:00Z",
      note_type: "upload",
      source_media: media,
      audio_duration_seconds: 305,
    },
  };
};
