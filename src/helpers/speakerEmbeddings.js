// @ts-check
const fs = require("node:fs");
const { readPcmWavInfo, readPcmWavWindow } = require("./nimiPcmWav");
const vectors = require("./speakerRepresentation");
const tokenStore = require("./tokenStore");
const businessAI = require("./nimiBusinessAI");
const debugLogger = require("./debugLogger");
const SAMPLE_RATE = 16000;
const MIN_SEGMENT_SECONDS = 1.5;
const MAX_EMBEDDING_SECONDS = 8;
function contextChanged() {
  return Object.assign(new Error("Nimi speaker session or selection changed"), {
    code: "SPEAKER_CONTEXT_CHANGED",
  });
}
function sampleWav(samples) {
  if (!(samples instanceof Float32Array) || samples.some((value) => !Number.isFinite(value)))
    throw new Error("Speaker audio must contain finite original samples");
  const wav = Buffer.alloc(44 + samples.length * 4);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(32, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples.length * 4, 40);
  samples.forEach((value, i) => wav.writeFloatLE(value, 44 + i * 4));
  return wav;
}
class SpeakerEmbeddings {
  constructor() {
    /** @type {import('@nimiplatform/kit/shell/electron/main').NimiElectronAppBusinessServices | null} */
    this.services = null;
    this.generation = 0;
    /** @type {Set<AbortController>} */
    this.pending = new Set();
    /** @type {() => string | null} */
    this.getAccountId = () => null;
    this.getAuthGeneration = () => tokenStore.getGeneration();
  }
  /** @param {import('@nimiplatform/kit/shell/electron/main').NimiElectronAppBusinessServices | null} services */
  bind(services) {
    this.invalidate();
    this.services = services;
  }
  invalidate() {
    this.generation += 1;
    this.services = null;
    for (const controller of this.pending) controller.abort();
  }
  async unload() {
    this.generation += 1;
    for (const controller of this.pending) controller.abort();
  }
  isAvailable() {
    return Boolean(this.services);
  }
  /** @param {Uint8Array} bytes @param {{signal?: AbortSignal, cancelSignal?: AbortSignal, onCancel?: (fact: unknown) => void}} [options] */
  async _extractAudio(bytes, { signal, cancelSignal, onCancel } = {}) {
    signal?.throwIfAborted();
    const services = this.services;
    if (!services) throw new Error("Nimi App session is unavailable. Open Nimi and sign in.");
    const generation = this.generation,
      account = this.getAccountId(),
      authGeneration = this.getAuthGeneration();
    const controller = new AbortController();
    this.pending.add(controller);
    const abortSource = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abortSource, { once: true });
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (
        services !== this.services ||
        generation !== this.generation ||
        account !== this.getAccountId() ||
        authGeneration !== this.getAuthGeneration()
      )
        throw contextChanged();
    };
    const selectionIdentity = async () => {
      assertCurrent();
      const config = await services.aiConfig.get();
      assertCurrent();
      const selection = config.effectiveSelections.find(
        (item) => item.capabilityContract === "audio.speaker.embed"
      );
      if (selection?.state !== "ready" || !selection.resource)
        throw Object.assign(
          new Error("Configure an available speaker representation model in Nimi AI settings"),
          { code: "SPEAKER_SELECTION_UNAVAILABLE" }
        );
      const intent = config.config?.capabilities.find(
        (item) => item.capabilityContract === "audio.speaker.embed"
      );
      const resource = selection.resource;
      return JSON.stringify([
        intent,
        resource.oneofKind === "local"
          ? [
              "local",
              resource.local.loadoutRef,
              resource.local.implementation,
              resource.local.configuredFeatures,
            ]
          : [
              "cloud",
              resource.cloud.connector.connectorRef,
              resource.cloud.target.implementation,
              resource.cloud.target.providerModelTarget,
            ],
      ]);
    };
    try {
      const selection = await selectionIdentity();
      await businessAI.assertAllowed();
      assertCurrent();
      const { runNimiAudioJob } = require("./nimiAsyncAudioJob");
      const { job } = await runNimiAudioJob({
        ai: services.ai,
        spec: {
          type: "audio-speaker-embed",
          mimeType: "audio/wav",
          audioSource: { type: "bytes", bytes },
        },
        signal: controller.signal,
        cancelSignal,
        assertCurrent,
        onCancel,
      });
      await businessAI.assertAllowed();
      assertCurrent();
      if ((await selectionIdentity()) !== selection) throw contextChanged();
      return vectors.representation(job.speakerEmbedding);
    } finally {
      signal?.removeEventListener("abort", abortSource);
      this.pending.delete(controller);
    }
  }
  /** @param {Float32Array} samples @param {{signal?: AbortSignal}} [options] */
  extractEmbeddingFromSamples(samples, options = {}) {
    options.signal?.throwIfAborted();
    if (samples.length < SAMPLE_RATE * MIN_SEGMENT_SECONDS) return Promise.resolve(null);
    const capped = samples.subarray(
      Math.max(0, samples.length - SAMPLE_RATE * MAX_EMBEDDING_SECONDS)
    );
    return this._extractAudio(sampleWav(capped), options);
  }
  _window(fd, info, startSec, endSec) {
    if (
      !Number.isFinite(startSec) ||
      !Number.isFinite(endSec) ||
      startSec < 0 ||
      endSec <= startSec
    )
      throw new Error("Invalid speaker audio interval");
    const start = Math.floor(Math.max(startSec, endSec - MAX_EMBEDDING_SECONDS) * info.sampleRate);
    const end = Math.floor(endSec * info.sampleRate);
    return readPcmWavWindow(fd, info, start, end - start);
  }
  /** @param {string} wavPath @param {number} startSec @param {number} endSec @param {{signal?: AbortSignal}} [options] */
  async extractEmbedding(wavPath, startSec, endSec, options = {}) {
    options.signal?.throwIfAborted();
    if (endSec - startSec < MIN_SEGMENT_SECONDS) return null;
    const fd = fs.openSync(wavPath, "r");
    try {
      return await this._extractAudio(
        this._window(fd, readPcmWavInfo(fd), startSec, endSec),
        options
      );
    } finally {
      fs.closeSync(fd);
    }
  }
  /** @param {string} wavPath @param {{speaker: string, start: number, end: number}[]} segments @param {{signal?: AbortSignal}} [options] */
  async extractClusterCentroids(wavPath, segments, { signal } = {}) {
    signal?.throwIfAborted();
    const generation = this.generation,
      account = this.getAccountId(),
      authGeneration = this.getAuthGeneration();
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (
        generation !== this.generation ||
        account !== this.getAccountId() ||
        authGeneration !== this.getAuthGeneration()
      )
        throw contextChanged();
    };
    const bySpeaker = new Map();
    for (const segment of segments) {
      if (segment.end - segment.start < MIN_SEGMENT_SECONDS) continue;
      if (!bySpeaker.has(segment.speaker)) bySpeaker.set(segment.speaker, []);
      bySpeaker.get(segment.speaker).push(segment);
    }
    const centroids = new Map(),
      fd = fs.openSync(wavPath, "r");
    try {
      const info = readPcmWavInfo(fd);
      for (const [speaker, entries] of bySpeaker) {
        assertCurrent();
        const values = [];
        try {
          for (const segment of entries
            .sort((a, b) => b.end - b.start - (a.end - a.start))
            .slice(0, 3)) {
            assertCurrent();
            values.push(
              await this._extractAudio(this._window(fd, info, segment.start, segment.end), {
                signal,
              })
            );
            assertCurrent();
          }
          if (values.length) centroids.set(speaker, vectors.computeCentroid(values));
        } catch (error) {
          if (signal?.aborted || error.code === "SPEAKER_CONTEXT_CHANGED") throw error;
          debugLogger.warn("Speaker representation unavailable", { speaker, error: error.message });
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    assertCurrent();
    return centroids;
  }
  computeCentroid(values) {
    return vectors.computeCentroid(values);
  }
  cosineSimilarity(a, b) {
    return vectors.cosineSimilarity(a, b);
  }
}
const instance = new SpeakerEmbeddings();
tokenStore.subscribe(() => {
  const services = instance.services;
  instance.bind(services);
});
module.exports = instance;
module.exports.SpeakerEmbeddings = SpeakerEmbeddings;
module.exports.MAX_EMBEDDING_SECONDS = MAX_EMBEDDING_SECONDS;
