import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, getPackageDir, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import transcriptUi from "../../src/index.js";
import { INTENT_ENTRY } from "../../src/intent-transport.js";

it("real provider → awaited AgentSession message_end → cached validation → preparation/execution → disk → reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "transcript-session-"));
  vi.stubEnv("PI_TRANSCRIPT_UI_SETTINGS", join(dir, "transcript-settings.json"));
  const requests: Record<string, any>[] = [];
  const executed: unknown[] = [], prepared: unknown[] = [], errors: unknown[] = [];
  const schema = Object.freeze({ type: "object", properties: Object.freeze({ value: { type: "string" } }), required: ["value"], additionalProperties: false });
  const validatorPath = join(getPackageDir(), "node_modules/@earendil-works/pi-ai/dist/utils/validation.js");
  const { validateToolArguments } = await import(validatorPath);
  validateToolArguments({ name: "strict_fixture", parameters: schema }, { name: "strict_fixture", arguments: { value: "prime cache" } });
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const index = requests.length;
    const delta = index % 2 === 1 ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${index}`, type: "function", function: {
      name: "strict_fixture", arguments: JSON.stringify({ value: "native", ...(index === 1 ? { displaySummary: "Verify native execution contracts" } : index === 5 ? { displaySummary: "" } : index === 7 ? { displaySummary: null } : {}) }),
    } }] } : { role: "assistant", content: "Done" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: `response_${index}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: `response_${index}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: index % 2 === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const model = { id: "intent-fixture", name: "Intent Fixture", provider: "intent-fixture", api: "openai-completions" as const,
    baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
  const fixture = (pi: ExtensionAPI) => {
    pi.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, apiKey: "local-fixture-not-a-secret", models: [model] });
    pi.registerTool({ name: "strict_fixture", label: "Strict Fixture", description: "Test original strict preparation", parameters: schema as never,
      prepareArguments(args) { prepared.push(structuredClone(args)); return { ...(args as { value: string }), value: "prepared" } as never; },
      async execute(_id, args) { executed.push(structuredClone(args)); return { content: [{ type: "text", text: "Native success" }], details: {} }; },
    });
  };
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true,
    noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [fixture, transcriptUi] });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models"), refreshOnCreate: false });
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime: runtime, resourceLoader: loader,
      settingsManager, tools: ["strict_fixture"], sessionManager: SessionManager.create(dir, join(dir, "sessions")) }));
    await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
    await session.prompt("Call strict_fixture");
    expect(errors).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.tools[0].function.parameters.properties.displaySummary).toMatchObject({ type: "string", maxLength: 48 });
    expect(requests[0]!.tools[0].function.parameters.required).toEqual(["value"]);
    expect(prepared).toEqual([{ value: "native" }]);
    expect(executed).toEqual([{ value: "prepared" }]);
    const entries = session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === INTENT_ENTRY);
    expect(entries).toHaveLength(1);
    expect((entries[0] as { data: unknown }).data).toEqual([{ toolCallId: "call_1", text: "Verify native execution contracts", source: "model" }]);
    const persisted = await readFile(session.sessionManager.getSessionFile()!, "utf8");
    expect(persisted).toContain(INTENT_ENTRY);
    const assistant = session.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toContainEqual(expect.objectContaining({ type: "toolCall", arguments: { value: "native" } }));
    await session.reload();
    await session.prompt("Call strict_fixture again after reload");
    expect(errors).toEqual([]);
    expect(prepared).toEqual([{ value: "native" }, { value: "native" }]);
    expect(executed).toEqual([{ value: "prepared" }, { value: "prepared" }]);
    expect(session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === INTENT_ENTRY)).toHaveLength(1);
    await session.prompt("Call strict_fixture with empty intent");
    await session.prompt("Call strict_fixture with null intent");
    expect(errors).toEqual([]);
    expect(prepared).toEqual(Array(4).fill({ value: "native" }));
    expect(executed).toEqual(Array(4).fill({ value: "prepared" }));
    expect(session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === INTENT_ENTRY)).toHaveLength(1);
    expect(schema.properties).toEqual({ value: { type: "string" } });
    validateToolArguments({ name: "strict_fixture", parameters: schema }, { name: "strict_fixture", arguments: { value: "still cached" } });
    expect(() => validateToolArguments({ name: "strict_fixture", parameters: schema }, { name: "strict_fixture", arguments: { value: "native", displaySummary: "must not reach native validator" } })).toThrow();
  } finally {
    session?.dispose();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true });
  }
}, 30000);
