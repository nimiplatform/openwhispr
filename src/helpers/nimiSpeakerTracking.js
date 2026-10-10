const vectors = require("./speakerRepresentation");

function speakerForWord(transcript, start, end, mapping = {}) {
  const intervals = transcript.diarization?.intervals || [];
  const overlaps = new Map();
  for (const interval of intervals) {
    const overlap = Math.max(
      0,
      Math.min(end, interval.endSeconds) - Math.max(start, interval.startSeconds)
    );
    if (overlap > 0)
      overlaps.set(interval.speakerId, (overlaps.get(interval.speakerId) || 0) + overlap);
  }
  const ranked = [...overlaps].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || (ranked[1] && ranked[0][1] === ranked[1][1])) return null;
  return mapping[ranked[0][0]] || null;
}

function projectWordSpeaker(transcript, start, end, mapping, states) {
  const speaker = speakerForWord(transcript, start, end, mapping);
  if (speaker) return { speaker, speakerMatching: states?.[speaker] };
  if (!transcript.diarization) return {};
  const intersecting = new Set(
    transcript.diarization.intervals
      .filter((interval) => interval.startSeconds < end && interval.endSeconds > start)
      .map((interval) => interval.speakerId)
  );
  return {
    speakerMatching: intersecting.size > 1 ? "ambiguous-overlap" : "unassigned-interval",
    speakerStatus: "provisional",
  };
}

function cropVoice(wav, intervals, speakerId) {
  // Producer is the App's own canonical PCM writer; no path or renderer handles.
  if (
    !Buffer.isBuffer(wav) ||
    wav.length < 44 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.readUInt16LE(20) !== 1 ||
    wav.readUInt16LE(22) !== 1 ||
    wav.readUInt16LE(34) !== 16 ||
    wav.toString("ascii", 36, 40) !== "data"
  )
    throw new Error("Speaker capture must be canonical mono PCM16");
  const rate = wav.readUInt32LE(24),
    frames = (wav.length - 44) / 2;
  if (!rate || !Number.isInteger(frames) || wav.readUInt32LE(40) !== frames * 2)
    throw new Error("Invalid speaker capture clock");
  const parts = [];
  let collected = 0;
  for (const interval of [...intervals]
    .filter((value) => value.speakerId === speakerId)
    .reverse()) {
    // Mixed overlapping speech cannot become a clean voice representation.
    if (
      intervals.some(
        (other) =>
          other.speakerId !== speakerId &&
          other.startSeconds < interval.endSeconds &&
          other.endSeconds > interval.startSeconds
      )
    )
      continue;
    const end = Math.min(frames, Math.floor(interval.endSeconds * rate));
    const start = Math.max(
      0,
      Math.floor(interval.startSeconds * rate),
      end - (8 * rate - collected)
    );
    if (end <= start) continue;
    parts.unshift(wav.subarray(44 + start * 2, 44 + end * 2));
    collected += end - start;
    if (collected >= rate * 8) break;
  }
  if (collected < rate * 1.5) return null;
  const pcm = Buffer.concat(parts),
    output = Buffer.from(wav.subarray(0, 44));
  output.writeUInt32LE(36 + pcm.length, 4);
  output.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([output, pcm]);
}

class NimiSpeakerTracking {
  constructor({ namespace, extract, signal, assertCurrent, getMaxSpeakers = () => null }) {
    this.namespace = namespace;
    this.extract = extract;
    this.signal = signal;
    this.assertCurrent = assertCurrent;
    this.getMaxSpeakers = getMaxSpeakers;
    this.voices = new Map();
    this.next = 0;
    this.queue = Promise.resolve();
  }
  apply(result, wav) {
    const next = this.queue.then(() => this._apply(result, wav));
    this.queue = next.catch(() => {});
    return next;
  }
  async _apply(result, wav) {
    this.assertCurrent();
    this.signal.throwIfAborted();
    const diarization = result.transcript.diarization;
    if (!diarization) return result;
    const mapping = {},
      representations = {},
      states = {};
    for (const speaker of new Set(diarization.intervals.map((interval) => interval.speakerId))) {
      this.assertCurrent();
      this.signal.throwIfAborted();
      const jobLocal = `${this.namespace}:${result.jobId}:${speaker}`;
      const voice = cropVoice(wav, diarization.intervals, speaker);
      if (!voice) {
        mapping[speaker] = jobLocal;
        states[jobLocal] = "insufficient-unmixed-audio";
        continue;
      }
      let representation;
      try {
        representation = await this.extract(voice, { signal: this.signal });
      } catch (error) {
        this.assertCurrent();
        this.signal.throwIfAborted();
        const terminal = error?.details?.scenarioJobStatus;
        if (
          !["FAILED", "CANCELED", "TIMEOUT"].includes(terminal) &&
          error?.code !== "SPEAKER_SELECTION_UNAVAILABLE"
        )
          throw error;
        mapping[speaker] = jobLocal;
        states[jobLocal] = "unavailable";
        continue;
      }
      this.assertCurrent();
      this.signal.throwIfAborted();
      const ranked = [...this.voices]
        .map(([id, entry]) => ({
          id,
          entry,
          similarity: vectors.cosineSimilarity(representation, entry.representation),
        }))
        .filter((entry) => entry.similarity !== null)
        .sort((a, b) => b.similarity - a.similarity);
      const maximum = this.getMaxSpeakers();
      const constrained = Number.isInteger(maximum) && maximum > 0 && this.voices.size >= maximum;
      const matched =
        ranked[0] &&
        ranked[0].similarity >= 0.65 &&
        (!ranked[1] || ranked[0].similarity - ranked[1].similarity >= 0.03);
      const forced = !matched && constrained && ranked.length > 0;
      let id;
      if (matched) {
        const best = ranked[0];
        id = best.id;
        best.entry.representation = vectors.weightedCentroid(
          best.entry.representation,
          representation,
          best.entry.count,
          1
        );
        best.entry.count++;
      } else if (forced) {
        // A requested cap limits confirmed clusters. An overflow voice without
        // a confident match remains Job-local, never borrows a person's name
        // or their centroid for later manual profile training.
        id = jobLocal;
      } else {
        id = `${this.namespace}:speaker_${this.next++}`;
        this.voices.set(id, { representation: vectors.representation(representation), count: 1 });
      }
      mapping[speaker] = id;
      states[id] = forced ? "count-constrained" : "matched-space";
      if (!forced) representations[id] = this.voices.get(id).representation;
    }
    return {
      ...result,
      speakerMap: mapping,
      speakerRepresentations: representations,
      speakerMatching: states,
    };
  }
}

module.exports = { NimiSpeakerTracking, speakerForWord, projectWordSpeaker, cropVoice };
