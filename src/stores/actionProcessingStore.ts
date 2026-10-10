import { create } from "zustand";
import { NOTE_OUTPUT_MAX_TOKENS, NOTHING_TO_SUMMARIZE } from "../helpers/builtinActions";
import { stripThinkingTags } from "../helpers/stripThinking";
import { compileSummaryActionPrompt, compileTemplatePrompt } from "../helpers/templatePrompts";
import reasoningService from "../services/ReasoningService";
import { getSettings } from "./settingsStore";
import { getNimiClient } from "../services/nimiClient";
import { appendDictionarySuffix } from "../config/prompts";
import { generateNoteTitle } from "../utils/generateTitle";
import { tagActionItemOwners, type MentionPerson } from "../utils/mentionMarkdown";
import type { ActionItem, NoteItem } from "../types/electron";
import { estimateNoteTokens, planNoteChunks, splitChunkInHalf } from "../helpers/noteChunking";
import type { TechnicalErrorDetailsData } from "../components/ui/useToast";
import type { ReasoningConfig } from "../services/BaseReasoningService";
import {
  EMPTY_OUTPUT_MESSAGE_KEY,
  TRUNCATED_OUTPUT_MESSAGE_KEY,
} from "../services/ai/chatRequestBody";

// The providers' error keys describe dictation cleanup; a note run shows its own.
const NOTE_ERROR_KEYS: Record<string, string> = {
  [TRUNCATED_OUTPUT_MESSAGE_KEY]: "notes.actions.errors.outputTruncated",
  [EMPTY_OUTPUT_MESSAGE_KEY]: "notes.actions.emptyReply",
};

// Output room reserved in each part's window when the parts are planned. The
// allowance a part actually gets is its share of the room the final pass has
// left, up to NOTE_OUTPUT_MAX_TOKENS: capping it here clipped every part of a
// meeting on the default 9B while the merge still had room to spare.
const PART_NOTES_MAX_TOKENS = 2048;
// Below this a part's notes could not hold the specifics of an hour of speech.
const MIN_PART_NOTES_TOKENS = 512;
// Below this a part would hold a minute or two of speech; refuse instead.
const MIN_CHUNK_BUDGET_TOKENS = 1024;
// A part is never larger than this even when the window allows more. Small
// local models lose specifics as the input grows (measured: Llama 3.2 3B given
// a 20k-token part wrote five generic bullets and dropped every number), and
// only the chunked path pays for the extra calls. Roughly an hour of speech.
const MAX_PART_TOKENS = 12288;
const MAX_REDUCE_ROUNDS = 3;
const MAX_SPLIT_DEPTH = 3;

export type ActionProcessingStatus = "idle" | "processing" | "success";

export interface NoteActionProgress {
  step: number;
  total: number;
}

export interface NoteActionState {
  status: ActionProcessingStatus;
  actionName: string | null;
  /** Set while a long note is summarised in parts: "Part 2 of 5". */
  progress?: NoteActionProgress | null;
}

/** The pieces a note action is built from, so a long one can be split along the transcript. */
export interface NoteMaterial {
  notes: string;
  meetingContext: string;
  transcript: string;
}

/** What a run overwrote, so Undo can put it back. */
export type NoteSummarySnapshot = Pick<
  NoteItem,
  "enhanced_content" | "enhancement_prompt" | "enhancement_template_id" | "enhanced_at_content_hash"
> & { title?: string };

export interface ActionAppliedEvent {
  noteId: number;
  action: ActionItem;
  previous: NoteSummarySnapshot;
}

export interface ActionErrorEvent {
  noteId: number;
  message: string;
  /** Set when the failure has a translatable form; the toast prefers it. */
  messageKey?: string;
  messageParams?: Record<string, string | number>;
  /** Not a failure: the run found nothing to write, so the toast only informs. */
  notice?: boolean;
  settingsTarget?: string;
  technicalDetails?: TechnicalErrorDetailsData;
}

interface ActionProcessingStoreState {
  noteStates: Record<number, NoteActionState>;
  errorEvents: ActionErrorEvent[];
  appliedEvents: ActionAppliedEvent[];
}

// The run a note's in-flight action belongs to. A per-note flag would be reset
// by a new run on the same note and revive the run the user just cancelled.
// The id also tags the run's local requests so a cancel can abort them.
const activeRuns = new Map<number, string>();
const actionControllers = new Map<number, AbortController>();
const processingFlags = new Map<number, boolean>();
const successTimers = new Map<number, NodeJS.Timeout>();

const IDLE_STATE: NoteActionState = { status: "idle", actionName: null };

function setNoteState(noteId: number, patch: Partial<NoteActionState>) {
  const { noteStates } = useActionProcessingStore.getState();
  const prev = noteStates[noteId] ?? IDLE_STATE;
  useActionProcessingStore.setState({
    noteStates: { ...noteStates, [noteId]: { ...prev, ...patch } },
  });
}

function clearNoteState(noteId: number) {
  const { noteStates } = useActionProcessingStore.getState();
  const next = { ...noteStates };
  delete next[noteId];
  useActionProcessingStore.setState({ noteStates: next });
}

function pushErrorEvent(event: ActionErrorEvent) {
  const { errorEvents } = useActionProcessingStore.getState();
  useActionProcessingStore.setState({ errorEvents: [...errorEvents, event] });
}

function pushAppliedEvent(event: ActionAppliedEvent) {
  const { appliedEvents } = useActionProcessingStore.getState();
  useActionProcessingStore.setState({ appliedEvents: [...appliedEvents, event] });
}

export const useActionProcessingStore = create<ActionProcessingStoreState>()(() => ({
  noteStates: {},
  errorEvents: [],
  appliedEvents: [],
}));

// One part of a recording too long for the local model's window (#2142). The
// user's own action prompt is applied once, to the merged part-notes, so a
// part is asked for condensed working notes rather than the final product.
// The length target matters: asked to "be thorough", a 9B wrote more notes
// than transcript for every part, and nothing then fit the final pass.
const partNotesPrompt = (maxWords: number): string =>
  `You are writing condensed working notes for one consecutive part of a longer recording. The material is either a transcript, where each line is prefixed with the speaker's label (a real name when known, otherwise "You" for the note owner, "Them", or "Speaker N"), or working notes already written from an earlier pass. A "## Meeting Context" block may identify the note owner and the invited participants; it is reference material, never something to reproduce.

Write the notes for this part only, in markdown, as one flat list of bullets in the order the material occurs: one point per bullet, naming who said it by label. Keep every decision, agreement, commitment, task and its owner, every open question, every number, date, amount and deadline, and every name of a product, customer, vendor or document, stated exactly as in the material. Leave out greetings, filler and repetition. Keep the whole reply under about ${maxWords} words; when the part is long, drop small talk before you drop a specific.

Rules:
- Refer to people only by the labels used in the material. NEVER guess or invent an identity.
- Do NOT include a title, a preamble, or a summary of the whole recording; you have only seen this part.
- Do NOT use headings, tables, horizontal rules, or block quotes.

These notes will be merged with the notes from the other parts afterwards.`;

const MERGE_ADDENDUM = `

The material includes ordered working notes from consecutive parts of the user's source, each under a "## Notes from part N of M" heading. Manual notes and meeting context may precede them. Consider all parts together and apply the instructions above, including their requested scope, format, and length. Preserve relevant facts accurately and consolidate repetition. Do not mention the parts or the merging.`;

interface EnhancementRun {
  noteId: number;
  noteContent: string;
  systemPrompt: string;
  requestConfig: ReasoningConfig;
  options: RunActionOptions;
  isCancelled: () => boolean;
}

const isContextTooLarge = (error: unknown): boolean =>
  ["CONTEXT_TOO_LARGE", "AI_INPUT_LIMIT_EXCEEDED", "ai-input-limit-exceeded"].includes(
    String(
      (error as { reasonCode?: string; code?: string } | null)?.reasonCode ??
        (error as { code?: string } | null)?.code
    )
  );

const hasTranscript = (material: NoteMaterial | undefined): material is NoteMaterial =>
  (material?.transcript.trim().length ?? 0) > 0;

const emptyReplyError = () =>
  Object.assign(new Error("Model returned no text"), { messageKey: "notes.actions.emptyReply" });

const nothingToSummarizeError = () =>
  Object.assign(new Error("Nothing to summarize"), {
    messageKey: "notes.actions.errors.nothingToSummarize",
    notice: true,
  });

/**
 * Whether the reply is the marker itself, as models wrap it: in a fence or
 * emphasis, or after a short sentence. A summary that only contains it, such as
 * a section a small model answered with the marker, is still a summary.
 */
function isNothingToSummarizeReply(reply: string): boolean {
  const lines = stripThinkingTags(reply)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("```"));
  const last = lines.pop()?.replace(/^[*_`]+|[*_`.!]+$/g, "");
  if (last !== NOTHING_TO_SUMMARIZE) return false;
  const lead = lines.join("\n");
  return lead.length <= 200 && !/^(?:#|[-*+]\s|\d+[.)]\s)/m.test(lead);
}

/**
 * One request on every route; parts-then-merge only when a local model refuses
 * a recording as too large for its window (#2142).
 */
async function runEnhancement(run: EnhancementRun): Promise<string> {
  try {
    return await reasoningService.processText(run.noteContent, "", null, run.requestConfig);
  } catch (error) {
    if (!isContextTooLarge(error) || !hasTranscript(run.options.material)) throw error;
    if (run.isCancelled()) throw new Error("cancelled");
    return runInParts(run, run.options.material);
  }
}

async function runInParts(run: EnhancementRun, material: NoteMaterial): Promise<string> {
  const { transcript, meetingContext: context, notes: manualNotes } = material;
  const preserveSpeakerLabels = run.options.isMeetingNote === true;
  const chunks = planNoteChunks(transcript, MAX_PART_TOKENS, { preserveSpeakerLabels });
  if (!chunks.length) throw emptyReplyError();
  const summarisePart = async (
    text: string,
    heading: string,
    outputTokens = PART_NOTES_MAX_TOKENS,
    depth = 0
  ): Promise<string> => {
    if (run.isCancelled()) throw new Error("cancelled");
    try {
      const notes = await reasoningService.processText(
        [context, `## ${heading}\n${text}`].filter(Boolean).join("\n\n"),
        "",
        null,
        {
          ...run.requestConfig,
          systemPrompt: partNotesPrompt(Math.floor(outputTokens / 2)),
          maxTokens: outputTokens,
          disableThinking: true,
          refuseClippedByWindow: false,
          requireCompleteOutput: true,
        }
      );
      if (run.isCancelled()) throw new Error("cancelled");
      if (!notes.trim()) throw emptyReplyError();
      return notes;
    } catch (error) {
      if (!isContextTooLarge(error) || depth >= MAX_SPLIT_DEPTH) throw error;
      const halves = splitChunkInHalf(text, { preserveSpeakerLabels });
      if (halves && estimateNoteTokens(text) > MIN_CHUNK_BUDGET_TOKENS) {
        const first = await summarisePart(halves[0], heading, outputTokens, depth + 1);
        const second = await summarisePart(halves[1], heading, outputTokens, depth + 1);
        return first + "\n\n" + second;
      }
      if (outputTokens > MIN_PART_NOTES_TOKENS) {
        return summarisePart(
          text,
          heading,
          Math.max(MIN_PART_NOTES_TOKENS, Math.floor(outputTokens / 2)),
          depth + 1
        );
      }
      throw error;
    }
  };
  let sections: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    setNoteState(run.noteId, { progress: { step: i + 1, total: chunks.length } });
    sections.push(await summarisePart(chunks[i], `Part ${i + 1} of ${chunks.length}`));
  }
  let refusal: unknown;
  for (let round = 0; round <= MAX_REDUCE_ROUNDS; round++) {
    if (run.isCancelled()) throw new Error("cancelled");
    const content = [
      manualNotes,
      context,
      ...sections.map((notes, index) => `## Notes from part ${index + 1}\n${notes}`),
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      return await reasoningService.processText(content, "", null, {
        ...run.requestConfig,
        systemPrompt: run.systemPrompt + MERGE_ADDENDUM,
        refuseClippedByWindow: false,
        requireCompleteOutput: true,
      });
    } catch (error) {
      if (!isContextTooLarge(error)) throw error;
      refusal = error;
    }
    if (round === MAX_REDUCE_ROUNDS || sections.length < 2) break;
    const consolidated: string[] = [];
    for (let index = 0; index < sections.length; index += 2) {
      consolidated.push(
        await summarisePart(
          sections.slice(index, index + 2).join("\n\n"),
          "Consolidated working notes"
        )
      );
    }
    sections = consolidated;
  }
  throw refusal;
}

export interface RunActionOptions {
  isMeetingNote?: boolean;
  /** Opt-in so enhancement never renames a note the user has titled. */
  allowTitleGeneration?: boolean;
  /** People whose names in generated action-item owners become mention tags. */
  knownPeople?: MentionPerson[];
  /** Structured pieces of `noteContent`; only its transcript is ever split into parts. */
  material?: NoteMaterial;
  /** An action's input is the note's AI summary rather than its notes and transcript. */
  fromSummary?: boolean;
}

export interface RunActionLabels {
  noModel: string;
  noEndpoint: string;
  actionFailed: string;
}

/**
 * Start processing an action on a note. Runs in the background — survives
 * component unmounts and navigation so the user can switch notes mid-action.
 */
export function runBackgroundAction(
  noteId: number,
  noteContent: string,
  contentHash: string,
  action: ActionItem,
  options: RunActionOptions,
  labels: RunActionLabels
): void {
  if (processingFlags.get(noteId)) return;

  const settings = getSettings();

  const runId = crypto.randomUUID();
  const controller = new AbortController();
  actionControllers.set(noteId, controller);
  activeRuns.set(noteId, runId);
  const isCancelled = () => activeRuns.get(noteId) !== runId || controller.signal.aborted;
  processingFlags.set(noteId, true);
  setNoteState(noteId, { status: "processing", actionName: action.name, progress: null });

  (async () => {
    try {
      const selection = (await getNimiClient().aiConfig.get()).effectiveSelections.find(
        (value) => value.capabilityContract === "text.generate"
      );
      if (isCancelled()) return;
      if (selection?.state !== "ready")
        throw Object.assign(new Error(labels.noModel), { settingsTarget: "llms" });
      // Only summary actions reach the runner; chat actions run in the note chat.
      const editsSummary = action.kind === "action";
      // A summary action with no summary yet writes a first one, like a template.
      const rewritesSummary = editsSummary && !!options.fromSummary;
      const instructions = editsSummary
        ? compileSummaryActionPrompt(action, {
            fromSummary: !!options.fromSummary,
            isMeetingNote: options.isMeetingNote,
          })
        : compileTemplatePrompt(action, { isMeetingNote: options.isMeetingNote });
      const systemPrompt = appendDictionarySuffix(
        instructions,
        options.isMeetingNote ? settings.customDictionary : undefined,
        settings.uiLanguage
      );
      const requestConfig: ReasoningConfig = {
        systemPrompt,
        // A rewrite repeats a summary written under NOTE_OUTPUT_MAX_TOKENS, plus its edit.
        maxTokens: rewritesSummary ? 2 * NOTE_OUTPUT_MAX_TOKENS : NOTE_OUTPUT_MAX_TOKENS,
        temperature: 0.3,
        disableThinking: settings.noteFormattingDisableThinking,
        // A local model that shrinks the reply to fit the prompt refuses a reply
        // that fills the shrunken allowance, so a recording is summarised in
        // parts rather than saved clipped. A plain note has no parts route, so
        // its clipped reply is saved as before. A rewrite sets it too, so a
        // local model shortens its allowance instead of refusing up front.
        // Other routes ignore the flag.
        refuseClippedByWindow: rewritesSummary || hasTranscript(options.material),
        // Rewriting an existing summary replaces all of it, so a clipped
        // rewrite would lose content: providers refuse it (OpenWhispr Cloud
        // refuses a truncated reply for every request).
        ...(rewritesSummary && { requireCompleteOutput: true }),
        requestId: runId,
        inferenceScope: "noteFormatting",
        signal: controller.signal,
      };
      const enhanced = await runEnhancement({
        noteId,
        noteContent,
        systemPrompt,
        requestConfig,
        options,
        isCancelled,
      });

      // IPC-bridged providers relay whatever the model returned; a blank
      // result must not be saved as the enhanced note.
      if (!enhanced.trim()) {
        throw emptyReplyError();
      }
      // Only greetings or filler: say so rather than save that as the summary.
      if (isNothingToSummarizeReply(enhanced)) {
        throw nothingToSummarizeError();
      }

      if (isCancelled()) return;

      let title: string | undefined;
      if (!editsSummary && options.allowTitleGeneration && getSettings().autoGenerateNoteTitle) {
        const generated = await generateNoteTitle(enhanced, "", { signal: controller.signal });
        if (generated) title = generated;
      }

      const before = await window.electronAPI.getNote(noteId);
      if (isCancelled()) return;

      const enhancedContent = options.knownPeople?.length
        ? tagActionItemOwners(enhanced, options.knownPeople)
        : enhanced;
      // A summary action keeps the template the summary was built from. Editing
      // a summary also keeps its material hash; writing one from the material
      // records that material, so later edits to it mark the summary stale.
      const updates: Record<string, string> = !editsSummary
        ? {
            enhanced_content: enhancedContent,
            enhancement_prompt: instructions,
            enhancement_template_id: action.client_id,
            enhanced_at_content_hash: contentHash,
          }
        : options.fromSummary
          ? { enhanced_content: enhancedContent }
          : { enhanced_content: enhancedContent, enhanced_at_content_hash: contentHash };
      if (title) updates.title = title;
      const result = await window.electronAPI.updateNote(noteId, updates);
      if (!result?.success) throw new Error(labels.actionFailed);
      pushAppliedEvent({
        noteId,
        action,
        previous: {
          // "" as deleting a summary does: sync keeps the cloud copy over a null.
          enhanced_content: before?.enhanced_content ?? "",
          enhancement_prompt: before?.enhancement_prompt ?? null,
          enhancement_template_id: before?.enhancement_template_id ?? null,
          enhanced_at_content_hash: before?.enhanced_at_content_hash ?? null,
          ...(title && before && { title: before.title }),
        },
      });

      setNoteState(noteId, { status: "success", actionName: action.name, progress: null });

      const timer = setTimeout(() => {
        processingFlags.set(noteId, false);
        clearNoteState(noteId);
        successTimers.delete(noteId);
      }, 600);
      successTimers.set(noteId, timer);
    } catch (err) {
      if (isCancelled()) return;
      processingFlags.set(noteId, false);
      clearNoteState(noteId);
      const message = err instanceof Error ? err.message : labels.actionFailed;
      const { messageKey, messageParams, notice, settingsTarget, technicalDetails } = (err ??
        {}) as {
        messageKey?: string;
        messageParams?: Record<string, string | number>;
        notice?: boolean;
        settingsTarget?: string;
        technicalDetails?: TechnicalErrorDetailsData;
      };
      pushErrorEvent({
        noteId,
        message,
        messageKey: (messageKey && NOTE_ERROR_KEYS[messageKey]) || messageKey,
        messageParams,
        notice,
        settingsTarget,
        technicalDetails,
      });
    } finally {
      if (activeRuns.get(noteId) === runId) activeRuns.delete(noteId);
      if (actionControllers.get(noteId) === controller) actionControllers.delete(noteId);
    }
  })();
}

/**
 * Aborts the run's local request in flight, which would otherwise hold the one
 * local model slot for minutes. Other routes finish and are discarded.
 */
export function cancelAction(noteId: number): void {
  actionControllers.get(noteId)?.abort();
  actionControllers.delete(noteId);
  activeRuns.delete(noteId);
  processingFlags.set(noteId, false);
  const timer = successTimers.get(noteId);
  if (timer) {
    clearTimeout(timer);
    successTimers.delete(noteId);
  }
  clearNoteState(noteId);
}

export function consumeErrorEvents(): ActionErrorEvent[] {
  const { errorEvents } = useActionProcessingStore.getState();
  if (errorEvents.length === 0) return [];
  useActionProcessingStore.setState({ errorEvents: [] });
  return errorEvents;
}

export function consumeAppliedEvents(): ActionAppliedEvent[] {
  const { appliedEvents } = useActionProcessingStore.getState();
  if (appliedEvents.length === 0) return [];
  useActionProcessingStore.setState({ appliedEvents: [] });
  return appliedEvents;
}

export function selectNoteActionState(
  state: ActionProcessingStoreState,
  noteId: number | null
): NoteActionState {
  if (noteId == null) return IDLE_STATE;
  return state.noteStates[noteId] ?? IDLE_STATE;
}
