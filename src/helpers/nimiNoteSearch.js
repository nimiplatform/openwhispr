const tokenStore = require("./tokenStore");
const debugLogger = require("./debugLogger");

async function searchNimiNotes({
  database,
  semanticSearch,
  query,
  limit = 5,
  spaceId = null,
  folderId = null,
  signal,
  assertCurrent = () => {},
}) {
  signal?.throwIfAborted();
  assertCurrent();
  if (
    typeof query !== "string" ||
    !query.trim() ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new Error("Invalid note search input");
  const account = database.activeAccountId;
  const authGeneration = tokenStore.getGeneration();
  const assertSearchScope = () => {
    signal?.throwIfAborted();
    assertCurrent();
    if (account !== database.activeAccountId || authGeneration !== tokenStore.getGeneration())
      throw new Error("Note search account changed");
  };
  const currentNotes = (ids) => {
    const allowed = new Set(database.getNoteIdsInScope(spaceId, folderId, ids));
    return ids
      .filter((id) => allowed.has(id))
      .map((id) => database.getNote(id))
      .filter((note) => note && !note.deleted_at);
  };
  try {
    // Qdrant payload updates are best-effort. Use its space filter to
    // reduce the candidate set, then validate every scoped vector hit
    // against SQLite before it can enter the fused ranking.
    const overFetch = folderId != null ? limit * 4 : limit * 2;
    const constraints = [];
    if (spaceId != null) constraints.push({ key: "space_id", match: { value: spaceId } });
    if (folderId != null) constraints.push({ key: "folder_id", match: { value: folderId } });
    const vectorFilter = constraints.length ? { must: constraints } : undefined;
    const [ftsResults, vectorResults] = await Promise.all([
      database.searchNotes(query, overFetch, spaceId, folderId),
      semanticSearch?.search(query, overFetch, vectorFilter, { signal }),
    ]);
    assertSearchScope();
    if (vectorResults == null)
      return {
        notes: currentNotes(ftsResults.slice(0, limit).map((note) => note.id)),
        mode: "keyword",
      };
    const scopedIds = new Set(
      database.getNoteIdsInScope(
        spaceId,
        folderId,
        vectorResults.map(({ noteId }) => noteId)
      )
    );

    // Filter low-confidence semantic matches before RRF
    const filteredVectorResults = vectorResults.filter(
      ({ noteId, score }) => score > 0.3 && scopedIds.has(noteId)
    );

    // Reciprocal Rank Fusion (K=60, matching cloud implementation)
    const scores = new Map();
    ftsResults.forEach((note, i) => {
      scores.set(note.id, (scores.get(note.id) || 0) + 1 / (60 + i));
    });
    filteredVectorResults.forEach(({ noteId }, i) => {
      scores.set(noteId, (scores.get(noteId) || 0) + 1 / (60 + i));
    });

    const rankedIds = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);

    return { notes: currentNotes(rankedIds), mode: "hybrid" };
  } catch (error) {
    assertSearchScope();
    debugLogger.error("Semantic search failed, falling back to FTS5", {
      error: error.message,
    });
    return { notes: database.searchNotes(query, limit, spaceId, folderId), mode: "keyword" };
  }
}

async function searchNimiConversations({
  database,
  semanticSearch,
  query,
  limit = 20,
  signal,
  assertCurrent = () => {},
}) {
  if (
    typeof query !== "string" ||
    !query.trim() ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new Error("Invalid conversation search input");
  const account = database.activeAccountId;
  const authGeneration = tokenStore.getGeneration();
  const guard = () => {
    signal?.throwIfAborted();
    assertCurrent();
    if (account !== database.activeAccountId || authGeneration !== tokenStore.getGeneration())
      throw new Error("Conversation search account changed");
  };
  const visible = (conversation) => {
    if (
      !conversation ||
      conversation.deleted_at ||
      conversation.archived_at ||
      conversation.space_id != null ||
      conversation.folder_id != null
    )
      return false;
    if (conversation.note_id == null) return true;
    const note = database.getNoteForVectorIndex(conversation.note_id);
    return note && !note.deleted_at;
  };
  guard();
  try {
    const hits = await semanticSearch?.searchConversations(query, limit, { signal });
    guard();
    if (hits != null) {
      const conversations = hits
        .map((hit) => database.getAgentConversation(hit.conversationId))
        .filter(visible)
        .map((conversation) => ({
          ...conversation,
          message_count: conversation.messages?.length ?? 0,
          last_message: conversation.messages?.at(-1)?.content,
        }));
      if (conversations.length) return { conversations, mode: "semantic" };
    }
  } catch (error) {
    guard();
    debugLogger.debug("Conversation semantic search unavailable", { error: error.message });
  }
  return {
    conversations: database
      .searchAgentConversations(query, limit)
      .map((preview) => {
        const current = database.getAgentConversation(preview.id);
        return current ? { ...preview, ...current } : null;
      })
      .filter(visible),
    mode: "keyword",
  };
}
module.exports = { searchNimiNotes, searchNimiConversations };
