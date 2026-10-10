import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { noteTranscriptText } from "../../utils/noteTranscriptText.mjs";

export const getNoteTool: ToolDefinition = {
  name: "get_note",
  description:
    "Get the original note content, any summary, and the saved speech transcript separately. Use search_notes first to find the note ID.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "The note ID to retrieve",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  readOnly: true,

  async execute(args: Record<string, unknown>, context): Promise<ToolResult> {
    context?.signal.throwIfAborted();
    const id = args.id as number;

    try {
      const note = await window.electronAPI.getNote(id);
      context?.signal.throwIfAborted();

      if (!note) {
        return {
          success: false,
          data: null,
          displayText: `Note with ID ${id} not found`,
        };
      }

      return {
        success: true,
        data: {
          id: note.id,
          title: note.title,
          content: note.content,
          summary: note.enhanced_content || undefined,
          transcript: noteTranscriptText(note.transcript) || undefined,
          type: note.note_type,
          folder_id: note.folder_id,
          created_at: note.created_at,
          updated_at: note.updated_at,
        },
        displayText: `Retrieved note: "${note.title}"`,
      };
    } catch (error) {
      context?.signal.throwIfAborted();
      return {
        success: false,
        data: null,
        displayText: `Failed to get note: ${(error as Error).message}`,
      };
    }
  },
};
