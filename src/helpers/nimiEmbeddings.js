// @ts-check
const { createHash } = require("node:crypto");
const businessAI = require("./nimiBusinessAI");
const { noteTranscriptText } = require("./noteSearch");

function changed(message = "Embedding session or selection changed") {
  return Object.assign(new Error(message), { code: "EMBEDDING_CONTEXT_CHANGED" });
}

class NimiEmbeddings {
  /** @param {{getAccountId?: () => string | null, getAuthGeneration?: () => number}} [options] */
  constructor({ getAccountId = () => null, getAuthGeneration = () => 0 } = {}) {
    this.getAccountId = getAccountId;
    this.getAuthGeneration = getAuthGeneration;
    /** @type {import('@nimiplatform/kit/shell/electron/main').NimiElectronAppBusinessServices | null} */
    this.services = null;
    this.generation = 0;
    this.pending = new Set();
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
    // Idle release retires App calls; model/loadout ownership remains with Nimi.
    this.generation += 1;
    for (const controller of this.pending) controller.abort();
  }

  isAvailable() {
    return Boolean(this.services);
  }

  static noteEmbedText(title, content, enhancedContent, transcript) {
    const body = enhancedContent || content || "";
    const speech = noteTranscriptText(transcript);
    return `${title || ""}\n${body}${speech && speech !== body ? "\n" + speech : ""}`;
  }

  /** @param {string[]} inputs @param {{signal?: AbortSignal, purpose?: "retrieval-document" | "retrieval-query"}} [options] */
  async embedTexts(inputs, { signal, purpose } = {}) {
    signal?.throwIfAborted();
    if (
      !Array.isArray(inputs) ||
      !inputs.length ||
      inputs.some(
        (text) =>
          typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > 32768
      )
    )
      throw new Error("Embedding inputs must be nonempty text of at most 32 KiB each");
    const services = this.services;
    if (!services) throw new Error("Nimi App session is unavailable. Open Nimi and sign in.");
    const controller = new AbortController();
    const generation = this.generation;
    const account = this.getAccountId();
    const authGeneration = this.getAuthGeneration();
    this.pending.add(controller);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (
        generation !== this.generation ||
        services !== this.services ||
        account !== this.getAccountId() ||
        authGeneration !== this.getAuthGeneration()
      )
        throw changed();
    };
    const selectionIdentity = async () => {
      assertCurrent();
      const snapshot = await services.aiConfig.get();
      assertCurrent();
      const selection = snapshot.effectiveSelections.find(
        (item) => item.capabilityContract === "text.embed"
      );
      if (selection?.state !== "ready" || !selection.resource)
        throw changed("Configure an available text embedding model in Nimi AI settings");
      const intent = snapshot.config?.capabilities.find(
        (item) => item.capabilityContract === "text.embed"
      );
      const resource = selection.resource;
      const execution =
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
            ];
      // Global CAS revisions and display labels do not change this capability's execution.
      return JSON.stringify([intent, execution]);
    };
    try {
      const selection = await selectionIdentity();
      const assertValid = async () => {
        if ((await selectionIdentity()) !== selection) throw changed();
      };
      let spaceId;
      let dimensions;
      const vectors = [];
      for (let offset = 0; offset < inputs.length; offset += 16) {
        await assertValid();
        await businessAI.assertAllowed();
        assertCurrent();
        const batch = inputs.slice(offset, offset + 16);
        const { output } = await services.ai.scenario.execute(
          { type: "text-embed", inputs: batch, ...(purpose === undefined ? {} : { purpose }) },
          { signal: controller.signal, timeoutMs: 120000 }
        );
        await businessAI.assertAllowed();
        await assertValid();
        if (
          output?.type !== "text-embed" ||
          typeof output.spaceId !== "string" ||
          !output.spaceId.trim() ||
          !Array.isArray(output.vectors) ||
          output.vectors.length !== batch.length
        )
          throw new Error("Invalid Nimi embedding result");
        dimensions ??= output.vectors[0]?.length;
        if (
          !Number.isInteger(dimensions) ||
          dimensions < 1 ||
          output.vectors.some(
            (vector) =>
              !Array.isArray(vector) ||
              vector.length !== dimensions ||
              Array.from(vector).some((value) => !Number.isFinite(value))
          )
        )
          throw new Error("Invalid Nimi embedding vectors");
        spaceId ??= output.spaceId;
        if (spaceId !== output.spaceId)
          throw changed("Nimi embedding space changed within the batch");
        vectors.push(...output.vectors);
      }
      return {
        vectors,
        spaceId,
        dimensions,
        scopeKey: createHash("sha256").update(JSON.stringify(account)).digest("hex"),
        assertCurrent,
        assertValid,
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      this.pending.delete(controller);
    }
  }

  embedText(text, options = {}) {
    return this.embedTexts([text], options);
  }
}

const tokenStore = require("./tokenStore");
const instance = new NimiEmbeddings({
  getAuthGeneration: () => tokenStore.getGeneration(),
});
tokenStore.subscribe(() => {
  // Keep the protected service binding while retiring work from the previous business login.
  const services = instance.services;
  instance.bind(services);
});
module.exports = instance;
module.exports.NimiEmbeddings = NimiEmbeddings;
module.exports.changed = changed;
