const test = require("node:test");
const assert = require("node:assert/strict");
const { MockLanguageModelV3, simulateReadableStream } = require("ai/test");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function runToolMetadataScenario(t, cachePrefix, toolExecute, calledTool = "test_tool") {
  installBrowserGlobals(t);
  let steps = 0;
  globalThis.__metadataModel = new MockLanguageModelV3({
    doStream: async () => {
      const first = steps++ === 0;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            ...(first
              ? [{ type: "tool-call", toolCallId: "call-test", toolName: calledTool, input: "{}" }]
              : [
                  { type: "text-start", id: "answer" },
                  { type: "text-delta", id: "answer", delta: "Answer" },
                  { type: "text-end", id: "answer" },
                ]),
            {
              type: "finish",
              finishReason: { unified: first ? "tool-calls" : "stop", raw: "stop" },
              usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
            },
          ],
        }),
      };
    },
  });
  t.after(() => {
    delete globalThis.__metadataModel;
  });
  const vite = await createRendererServer(t, {
    cachePrefix,
    noExternal: ["@nimiplatform/sdk-adapter-vercel-ai"],
    mockModules: {
      "@nimiplatform/sdk-adapter-vercel-ai":
        "export const createNimiLocalAppVercelLanguageModel=()=>globalThis.__metadataModel;",
      "/stores/settingsStore": "export const getSettings=()=>({});",
      "/config/prompts":
        "export const getCleanupSystemPrompt=()=>'';export const wrapCleanupTranscript=x=>x;",
      "/nimiClient": `export const getNimiClient=()=>({ai:{}}); export const prepareNimiAIWork=async()=>{};
        export const assertNimiBusinessAIAllowed=async()=>{}; export const runNimiRequest=async()=>{};`,
    },
  });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { ToolRegistry } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
  t.after(() => service.destroy());
  const registry = new ToolRegistry();
  registry.register({
    name: "test_tool",
    description: "Test tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    execute: toolExecute,
  });
  const chunks = [];
  for await (const chunk of service.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    { systemPrompt: "Answer the user." },
    registry.toAISDKFormat()
  ))
    chunks.push(chunk);
  const result = chunks.find((chunk) => chunk.type === "tool_result");
  assert.ok(result, "expected a tool_result chunk");
  return result;
}

test("a successful object tool output is forwarded as metadata", async (t) => {
  const toolResult = await runToolMetadataScenario(
    t,
    "openwhispr-tool-metadata-object-test-",
    async () => ({
      success: true,
      data: { id: 42, title: "Q3 notes" },
      displayText: "Created note",
    })
  );

  assert.deepEqual(toolResult.metadata, { id: 42, title: "Q3 notes" });
});

test("a successful array tool output (search results) is forwarded as metadata", async (t) => {
  const results = [
    { id: 1, title: "First" },
    { id: 2, title: "Second" },
  ];
  const toolResult = await runToolMetadataScenario(
    t,
    "openwhispr-tool-metadata-array-test-",
    async () => ({
      success: true,
      data: results,
      displayText: "Found 2 notes",
    })
  );

  assert.deepEqual(toolResult.metadata, results);
});

test("a failed tool output yields no metadata and keeps the error as displayText", async (t) => {
  const toolResult = await runToolMetadataScenario(
    t,
    "openwhispr-tool-metadata-error-test-",
    async () => ({
      success: false,
      data: null,
      displayText: "Something failed",
    })
  );

  assert.equal(toolResult.metadata, undefined);
  assert.deepEqual(JSON.parse(toolResult.displayText), { error: "Something failed" });
});

test("a successful string tool output yields no metadata", async (t) => {
  const toolResult = await runToolMetadataScenario(
    t,
    "openwhispr-tool-metadata-string-test-",
    async () => ({
      success: true,
      data: "plain string result",
      displayText: "Done",
    })
  );

  assert.equal(toolResult.metadata, undefined);
  assert.equal(toolResult.displayText, "plain string result");
});

test("a call the SDK rejects still settles, with its error as displayText", async (t) => {
  let executed = false;
  const toolResult = await runToolMetadataScenario(
    t,
    "openwhispr-tool-metadata-rejected-test-",
    async () => {
      executed = true;
      return { success: true, data: "unreachable", displayText: "Done" };
    },
    "ghost_tool"
  );

  assert.equal(executed, false);
  assert.equal(toolResult.callId, "call-test");
  assert.equal(toolResult.toolName, "ghost_tool");
  assert.match(toolResult.displayText, /(?:Error|error): .*ghost_tool/);
  assert.equal(toolResult.metadata, undefined);
});
