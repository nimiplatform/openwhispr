import type { NoteItem, ConversationPreview } from "../types/electron";
import { runNimiRequest } from "./nimiClient";

export function searchNimiNotes(
  query: string,
  limit = 5,
  spaceId: number | null = null,
  folderId: number | null = null,
  signal?: AbortSignal
): Promise<{ notes: NoteItem[]; mode: "keyword" | "hybrid" }> {
  return runNimiRequest("openwhispr.notes.search", { query, limit, spaceId, folderId }, signal);
}

export function searchNimiConversations(
  query: string,
  limit = 20,
  signal?: AbortSignal
): Promise<{ conversations: ConversationPreview[]; mode: "keyword" | "semantic" }> {
  return runNimiRequest("openwhispr.conversations.search", { query, limit }, signal);
}
