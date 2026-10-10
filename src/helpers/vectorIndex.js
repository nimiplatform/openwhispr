// @ts-check
const { QdrantClient } = require("@qdrant/js-client-rest");
const { createHash } = require("node:crypto");
const nimiEmbeddings = require("./nimiEmbeddings");
const debugLogger = require("./debugLogger");
const { chunkConversation } = require("./conversationChunker");
const { chunkEmbeddingText } = require("./embeddingChunks");

function pointId(kind, id, chunkIndex) {
  const hash = createHash("sha256")
    .update(JSON.stringify([kind, id, chunkIndex]))
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function incompatible() {
  return Object.assign(new Error("Nimi embedding context changed; rebuild the semantic index"), {
    code: "EMBEDDING_CONTEXT_CHANGED",
  });
}
function fatal(error) {
  return error.code === "EMBEDDING_CONTEXT_CHANGED" || error.name === "AbortError";
}
class VectorIndex {
  constructor({
    embeddings = nimiEmbeddings,
    clientFactory = (port) => new QdrantClient({ host: "127.0.0.1", port }),
  } = {}) {
    this.embeddings = embeddings;
    this.clientFactory = clientFactory;
    this.reset();
  }
  init(port) {
    this.reset();
    this.client = this.clientFactory(port);
  }
  reset() {
    this.generation = (this.generation || 0) + 1;
    /** @type {import('@qdrant/js-client-rest').QdrantClient | null} */
    this.client = null;
    this.identity = null;
    this.validity = null;
    this.collectionName = null;
    this.conversationChunksCollection = null;
  }
  isReady() {
    try {
      this.validity?.assertCurrent();
    } catch {
      return false;
    }
    return Boolean(this.client && this.identity);
  }
  assertCurrent() {
    if (!this.isReady()) throw incompatible();
    this.validity.assertCurrent();
  }
  _context(result) {
    const identity = JSON.stringify([result.scopeKey, result.spaceId, result.dimensions]);
    if (!this.client || (this.identity && this.identity !== identity)) throw incompatible();
    const generation = this.generation;
    const client = this.client;
    return {
      identity,
      client,
      assert: async () => {
        result.assertCurrent();
        if (generation !== this.generation || client !== this.client) throw incompatible();
        await result.assertValid();
        if (generation !== this.generation || client !== this.client) throw incompatible();
      },
    };
  }
  async _ensure(name, dimensions, context) {
    await context.assert();
    let created = false;
    try {
      const collection = await context.client.getCollection(name);
      const shape = collection.config?.params?.vectors;
      if (shape?.size !== dimensions || shape?.distance !== "Cosine")
        throw new Error("The App semantic index has incompatible vector dimensions or distance");
    } catch (error) {
      if (error.status !== 404) throw error;
      await context.client.createCollection(name, {
        vectors: { size: dimensions, distance: "Cosine" },
      });
      created = true;
    }
    await context.assert();
    return { created };
  }
  async ensureCollection(query, seed) {
    const result = seed || (await this.embeddings.embedText(query, { purpose: "retrieval-query" }));
    const context = this._context(result);
    // Keep Windows segment paths below the native helper's path budget.
    const suffix = createHash("sha256").update(context.identity).digest("hex").slice(0, 32);
    const name = "nimi_note_chunks_" + suffix;
    const collection = await this._ensure(name, result.dimensions, context);
    this.identity = context.identity;
    this.collectionName = name;
    this.conversationChunksCollection = "nimi_conversations_" + suffix;
    this.dimensions = result.dimensions;
    this.validity = result;
    return collection;
  }
  async pruneNotes(getNote) {
    if (!this.isReady()) throw incompatible();
    const client = this.client;
    const name = this.collectionName;
    const generation = this.generation;
    let offset;
    do {
      const page = await client.scroll(name, {
        limit: 256,
        with_payload: true,
        with_vector: false,
        ...(offset != null ? { offset } : {}),
      });
      if (generation !== this.generation) throw incompatible();
      const removed = page.points
        .filter((point) => {
          const noteId = point.payload?.note_id;
          if (!Number.isSafeInteger(noteId)) return true;
          const note = getNote(noteId);
          return !note || note.deleted_at;
        })
        .map((point) => point.id);
      if (removed.length) await client.delete(name, { wait: true, points: removed });
      if (generation !== this.generation) throw incompatible();
      offset = page.next_page_offset;
    } while (offset != null);
  }
  async upsertNote(noteId, text, payload = {}, options = {}) {
    if (!this.isReady()) return false;
    try {
      const chunks = chunkEmbeddingText(text).filter((chunk) => chunk.trim());
      if (!chunks.length) return this.deleteNote(noteId);
      const result = await this.embeddings.embedTexts(chunks, {
        ...options,
        purpose: "retrieval-document",
      });
      const context = this._context(result);
      await context.assert();
      if (!(await this.deleteNote(noteId)))
        throw new Error("Failed to retire previous note chunks");
      for (let offset = 0; offset < chunks.length; offset += 16) {
        await context.assert();
        await context.client.upsert(this.collectionName, {
          wait: true,
          points: result.vectors.slice(offset, offset + 16).map((vector, index) => ({
            id: pointId("note", noteId, offset + index),
            vector,
            payload: { ...payload, note_id: noteId, chunk_index: offset + index },
          })),
        });
      }
      await context.assert();
      return true;
    } catch (error) {
      if (fatal(error)) throw error;
      debugLogger.debug("Vector index upsert failed", { noteId, error: error.message });
      return false;
    }
  }
  async _delete(request) {
    if (!this.isReady()) return false;
    const client = this.client;
    const generation = this.generation;
    try {
      await client.delete(this.collectionName, { wait: true, ...request });
      if (generation !== this.generation) throw incompatible();
      return true;
    } catch (error) {
      if (fatal(error)) throw error;
      debugLogger.debug("Vector index delete failed", { error: error.message });
      return false;
    }
  }
  deleteNote(noteId) {
    return this._delete({ filter: { must: [{ key: "note_id", match: { value: noteId } }] } });
  }
  deleteBySpace(spaceId) {
    return this._delete({ filter: { must: [{ key: "space_id", match: { value: spaceId } }] } });
  }
  async search(query, limit = 5, filter, options = {}) {
    if (!this.isReady()) return null;
    const result = await this.embeddings.embedText(query, {
      ...options,
      purpose: "retrieval-query",
    });
    const context = this._context(result);
    await context.assert();
    const { groups } = await context.client.queryGroups(this.collectionName, {
      query: result.vectors[0],
      limit,
      group_by: "note_id",
      group_size: 1,
      ...(filter ? { filter } : {}),
    });
    await context.assert();
    return groups
      .map((group) => ({ noteId: group.id, score: group.hits[0]?.score }))
      .filter((hit) => Number.isSafeInteger(hit.noteId) && Number.isFinite(hit.score));
  }
  async ensureConversationChunksCollection(result) {
    const context = this._context(result);
    await this._ensure(this.conversationChunksCollection, result.dimensions, context);
  }
  async upsertConversationChunks(conversationId, title, messages, options = {}) {
    if (!this.isReady()) throw incompatible();
    const chunks = chunkConversation(title, messages);
    if (!chunks.length) return;
    const result = await this.embeddings.embedTexts(
      chunks.map((chunk) => chunk.text),
      { ...options, purpose: "retrieval-document" }
    );
    const context = this._context(result);
    await this.ensureConversationChunksCollection(result);
    await context.assert();
    await this.deleteConversationChunks(conversationId);
    await context.assert();
    const points = chunks.map((chunk, index) => {
      return {
        id: pointId("conversation", conversationId, chunk.chunkIndex),
        vector: result.vectors[index],
        payload: { conversation_id: conversationId, chunk_index: chunk.chunkIndex },
      };
    });
    await context.client.upsert(this.conversationChunksCollection, { wait: true, points });
    await context.assert();
  }
  async deleteConversationChunks(conversationId) {
    if (!this.isReady()) throw incompatible();
    const generation = this.generation;
    await this.client.delete(this.conversationChunksCollection, {
      wait: true,
      filter: { must: [{ key: "conversation_id", match: { value: conversationId } }] },
    });
    if (generation !== this.generation) throw incompatible();
  }
  async searchConversations(query, limit = 10, options = {}) {
    if (!this.isReady()) return null;
    const result = await this.embeddings.embedText(query, {
      ...options,
      purpose: "retrieval-query",
    });
    const context = this._context(result);
    await this.ensureConversationChunksCollection(result);
    await context.assert();
    const { points: hits } = await context.client.query(this.conversationChunksCollection, {
      query: result.vectors[0],
      limit: limit * 3,
      with_payload: true,
    });
    await context.assert();
    const scores = new Map();
    for (const hit of hits) {
      const id = hit.payload?.conversation_id;
      if (hit.score > 0.3 && Number.isSafeInteger(id))
        scores.set(id, Math.max(scores.get(id) || 0, hit.score));
    }
    return [...scores]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([conversationId, score]) => ({ conversationId, score }));
  }
  async reindexAllConversations(conversations, options = {}) {
    // Derived chunks are rebuilt from the current database snapshot, including deletions.
    const name = this.conversationChunksCollection;
    const generation = this.generation;
    let collection;
    try {
      collection = await this.client.getCollection(name);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (collection) await this.client.delete(name, { wait: true, filter: {} });
    if (generation !== this.generation) throw incompatible();
    for (const conversation of conversations) {
      await this.upsertConversationChunks(
        conversation.id,
        conversation.title,
        conversation.messages,
        options
      );
    }
  }
}
module.exports = new VectorIndex();
module.exports.VectorIndex = VectorIndex;
