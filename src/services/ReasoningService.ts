import { streamText, stepCountIs, wrapLanguageModel, type ModelMessage, type Tool } from "ai";
import { createNimiLocalAppVercelLanguageModel } from "@nimiplatform/sdk-adapter-vercel-ai";
import { getSettings } from "../stores/settingsStore";
import { getCleanupSystemPrompt, wrapCleanupTranscript } from "../config/prompts";
import {
  assertNimiBusinessAIAllowed,
  getNimiClient,
  prepareNimiAIWork,
  runNimiRequest,
} from "./nimiClient";
import type { ReasoningConfig } from "./BaseReasoningService";

export type ToolMetadata = Record<string, unknown> | Array<Record<string, unknown>>;
export type AgentStreamChunk =
  | { type: "content"; text: string }
  | { type: "tool_calls"; calls: Array<{ id: string; name: string; arguments: string }> }
  | {
      type: "tool_result";
      callId: string;
      toolName: string;
      displayText: string;
      metadata?: ToolMetadata;
    }
  | { type: "transcript"; messages: ModelMessage[] }
  | { type: "done"; finishReason?: string };

class ReasoningService {
  private streamAbortController: AbortController | null = null;
  private activeRequestControllers = new Set<AbortController>();

  async processText(
    text: string,
    _model = "",
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    const controller = new AbortController();
    this.activeRequestControllers.add(controller);
    const abort = () => controller.abort();
    config.signal?.addEventListener("abort", abort, { once: true });
    try {
      config.signal?.throwIfAborted();
      const settings = getSettings();
      const systemPrompt =
        config.systemPrompt ||
        getCleanupSystemPrompt(
          agentName,
          settings.customDictionary,
          settings.preferredLanguage,
          settings.uiLanguage
        );
      const result = await runNimiRequest<{ text: string }>(
        "openwhispr.ai.edit-text",
        {
          text: config.systemPrompt ? text : wrapCleanupTranscript(text),
          systemPrompt,
          ...(config.screenContext ? { screenContext: config.screenContext } : {}),
          ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
          ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
          requireCompleteOutput: Boolean(
            config.requireCompleteOutput || config.refuseClippedByWindow
          ),
          inferenceScope: config.inferenceScope || "dictation",
          disableThinking: Boolean(config.disableThinking),
        },
        controller.signal
      );
      return result.text;
    } finally {
      config.signal?.removeEventListener("abort", abort);
      this.activeRequestControllers.delete(controller);
    }
  }

  async *processTextStreamingAI(
    messages: Array<{ role: string; content: unknown }>,
    config: ReasoningConfig & { systemPrompt: string },
    tools?: Record<string, Tool>
  ): AsyncGenerator<AgentStreamChunk> {
    const controller = new AbortController();
    this.streamAbortController = controller;
    const abort = () => controller.abort();
    config.signal?.addEventListener("abort", abort, { once: true });
    try {
      config.signal?.throwIfAborted();
      await prepareNimiAIWork(controller.signal);
      const binding = createNimiLocalAppVercelLanguageModel({
        ai: getNimiClient().ai,
        executionMode: "sync",
      });
      const model = wrapLanguageModel({
        model: binding,
        middleware: {
          specificationVersion: "v3",
          transformParams: async ({ params }) => {
            await assertNimiBusinessAIAllowed(controller.signal);
            return params;
          },
        },
      });
      const result = streamText({
        model,
        messages: messages as ModelMessage[],
        tools,
        stopWhen: stepCountIs(tools ? 20 : 1),
        abortSignal: controller.signal,
      });
      for await (const chunk of result.fullStream) {
        controller.signal.throwIfAborted();
        if (chunk.type === "text-delta") yield { type: "content", text: chunk.text };
        else if (chunk.type === "tool-call")
          yield {
            type: "tool_calls",
            calls: [
              {
                id: chunk.toolCallId,
                name: chunk.toolName,
                arguments: JSON.stringify(chunk.input),
              },
            ],
          };
        else if (chunk.type === "tool-result") {
          const output = chunk.output;
          const metadata =
            output && typeof output === "object" && !("error" in output)
              ? (output as ToolMetadata)
              : undefined;
          const displayText = typeof output === "string" ? output : JSON.stringify(output);
          yield {
            type: "tool_result",
            callId: chunk.toolCallId,
            toolName: chunk.toolName,
            displayText,
            metadata,
          };
        } else if (chunk.type === "tool-error") {
          yield {
            type: "tool_result",
            callId: chunk.toolCallId,
            toolName: chunk.toolName,
            displayText: chunk.error instanceof Error ? chunk.error.message : String(chunk.error),
          };
        } else if (chunk.type === "error") throw chunk.error;
      }
      controller.signal.throwIfAborted();
      const response = await result.response;
      yield { type: "transcript", messages: response.messages };
      yield { type: "done", finishReason: await result.finishReason };
    } finally {
      controller.abort();
      config.signal?.removeEventListener("abort", abort);
      if (this.streamAbortController === controller) this.streamAbortController = null;
    }
  }

  cancelActiveStream(): void {
    this.streamAbortController?.abort();
  }
  cancelAllRequests(): void {
    for (const controller of this.activeRequestControllers) controller.abort();
    this.cancelActiveStream();
  }
  async isAvailable(): Promise<boolean> {
    try {
      return (await getNimiClient().aiConfig.get()).effectiveSelections.some(
        (selection) =>
          selection.capabilityContract === "text.generate" && selection.state === "ready"
      );
    } catch {
      return false;
    }
  }
  destroy(): void {
    this.cancelAllRequests();
  }
}

export default new ReasoningService();
