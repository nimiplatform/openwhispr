import { getNimiClient } from "./nimiClient";
import ReasoningService from "./ReasoningService";
import { resolvePrompt, wrapCleanupTranscript, type PromptKind } from "../config/prompts";
import { getLanguageLabel } from "../utils/languageSupport";
import { getDictionaryHintWords } from "../utils/snippets";
import type { SettingsState } from "../stores/settingsStore";

export async function testNimiPrompt(input: {
  kind: PromptKind;
  text: string;
  draft: string;
  agentName: string;
  settings: SettingsState;
  signal: AbortSignal;
  noModelMessage: string;
}) {
  input.signal.throwIfAborted();
  const selection = (await getNimiClient().aiConfig.get()).effectiveSelections.find(
    (value) => value.capabilityContract === "text.generate"
  );
  input.signal.throwIfAborted();
  if (selection?.state !== "ready") throw new Error(input.noModelMessage);
  const translate = input.kind === "translate";
  const systemPrompt = resolvePrompt(input.kind, {
    template: input.draft,
    agentName: input.agentName,
    uiLanguage: input.settings.uiLanguage,
    language: translate ? undefined : input.settings.preferredLanguage,
    customDictionary: getDictionaryHintWords(input.settings),
    targetLanguageLabel: translate
      ? getLanguageLabel(input.settings.translationTargetLanguage)
      : undefined,
  });
  const text = await ReasoningService.processText(
    input.kind === "cleanup" ? wrapCleanupTranscript(input.text) : input.text,
    "",
    input.agentName,
    {
      systemPrompt,
      signal: input.signal,
      inferenceScope: translate
        ? "dictationTranslation"
        : input.kind === "dictationAgent"
          ? "dictationAgent"
          : "dictationCleanup",
      requiresAgent: input.kind === "dictationAgent",
      disableThinking: translate
        ? input.settings.translationDisableThinking
        : input.kind === "dictationAgent"
          ? input.settings.dictationAgentDisableThinking
          : input.settings.cleanupDisableThinking,
    }
  );
  input.signal.throwIfAborted();
  return { text, selection };
}
