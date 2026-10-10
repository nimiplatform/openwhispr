// Explain the requested task without inferring support from a provider or model name.
function describeTranscriptionOptionError(error, { timestamps = false, diarization = false }) {
  const reason = String(error?.reasonCode || error?.code || "")
    .toLowerCase()
    .replaceAll("_", "-");
  if (reason !== "ai-media-option-unsupported" || (!timestamps && !diarization)) return error;
  return Object.assign(error, {
    messageKey: diarization
      ? "nimi.transcriptionSpeakerOptionsUnsupported"
      : "nimi.transcriptionTimingUnsupported",
    messageParams: { reason },
    settingsTarget: "speechToText",
    technicalDetails: { underlyingError: error.message },
  });
}
module.exports = { describeTranscriptionOptionError };
