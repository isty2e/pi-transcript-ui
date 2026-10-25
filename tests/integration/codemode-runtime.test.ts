import { expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, getPackageDir, initTheme, ModelRuntime, SessionManager, SettingsManager,
  ToolExecutionComponent, InteractiveMode, VERSION, type ExtensionFactory, type CodemodeToolDetails, type ExtensionContext, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import transcriptUi from "../../src/index.js";
import { attachTranscriptPresentation } from "../../src/wiring.js";
import { theme } from "../fixtures/pi-theme.js";
import { piCapabilities } from "../fixtures/pi-capabilities.js";
import { CodemodeRuntime } from "../../src/codemode/pi.js";
import { CodemodePresentation } from "../../src/codemode/view.js";

const { createCodemodeExtension } = await import(join(getPackageDir(), "dist/extensions/codemode/index.js")) as {
  createCodemodeExtension: (options: { models: boolean }) => ExtensionFactory;
};

it("summarizes actual host execution, progress and persisted results without replacing native bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "transcript-codemode-"));
  vi.stubEnv("PI_TRANSCRIPT_UI_SETTINGS", join(directory, "transcript-settings.json"));
  initTheme("dark", false);
  const scenarios = [
    { name: "parallel success", code: 'return await Promise.all([tools.fixture_ok({value:"one"}), tools.fixture_ok({value:"two"})]);',
      statuses: ["ok", "ok"], isError: false },
    { name: "caught child error", code: 'const value = await tools.fixture_ok({value:"before"});\ntry { await tools.fixture_fail({value:"boom"}); } catch (error) { text(error.message); }\nreturn value;',
      statuses: ["ok", "error"], isError: false },
    { name: "uncaught child error", code: 'text(await tools.fixture_ok({value:"kept output"}));\nawait tools.fixture_fail({value:"boom"});',
      statuses: ["ok", "error"], isError: true },
    { name: "rejected options", code: '// @options: {"timeout_ms":-1}\nreturn 1;', statuses: undefined, isError: true },
  ];
  let requests = 0;
  const executed: string[] = [], errors: unknown[] = [];
  let itemsRuntime: CodemodeRuntime | undefined;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the local fixture request. */ }
    const index = requests++;
    const scenario = scenarios[Math.floor(index / 2)]!;
    const delta = index % 2 === 0 ? { role: "assistant", tool_calls: [{ index: 0, id: `code_${index}`, type: "function",
      function: { name: "codemode", arguments: JSON.stringify({ code: scenario.code }) } }] } : { role: "assistant", content: "Done" };
    const chunk = (change: unknown, finish: string | null) => JSON.stringify({ id: `response_${index}`, object: "chat.completion.chunk",
      choices: [{ index: 0, delta: change, finish_reason: finish }] });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${chunk(delta, null)}\n\ndata: ${chunk({}, index % 2 === 0 ? "tool_calls" : "stop")}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local fixture address");
  const model = { id: "codemode-fixture", name: "Codemode Fixture", provider: "codemode-fixture", api: "openai-completions" as const,
    baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
  const fixture: ExtensionFactory = pi => {
    itemsRuntime = new CodemodeRuntime(pi, () => "items");
    pi.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, apiKey: "local-fixture-not-a-secret", models: [model] });
    for (const name of ["fixture_ok", "fixture_fail"]) {
      pi.registerTool({ name, label: name, description: "Pure codemode test tool", exposure: "codemode",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
        async execute(_id, args) {
          executed.push(name);
          if (name === "fixture_fail") throw new Error("Controlled child failure");
          return { content: [{ type: "text", text: `OK ${args.value}` }], details: {} };
        },
      });
    }
  };
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true,
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [fixture, createCodemodeExtension({ models: false }), transcriptUi as unknown as ExtensionFactory] });
  const root = new Container(), chat = new Container();
  root.addChild(chat);
  const attach = () => attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let dispose: ReturnType<typeof attach> | undefined;
  let component: ToolExecutionComponent | undefined;
  const itemsRoot = new Container(), itemsChat = new Container(); itemsRoot.addChild(itemsChat);
  let itemsParent: ToolExecutionComponent | undefined;
  let itemsPresentation: CodemodePresentation | undefined;
  let itemsDetach: ReturnType<typeof attach> | undefined;
  let args: unknown;
  const progress: { calls: CodemodeToolDetails["calls"]; row: string }[] = [];
  const settledRows: string[] = [];
  const row = () => stripTerminalSequences(chat.render(120).join("\n"));

  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null,
      modelsStorePath: join(directory, "models"), refreshOnCreate: false });
    ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, model, modelRuntime: runtime,
      resourceLoader: loader, settingsManager, tools: ["codemode", "fixture_ok", "fixture_fail"],
      sessionManager: SessionManager.create(directory, join(directory, "sessions")) }));
    await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
    itemsRuntime!.start({ mode: "tui", sessionManager: session.sessionManager } as unknown as ExtensionContext);
    itemsRuntime!.setRoot(itemsRoot);
    const mode = {
      ui: itemsRoot, sessionManager: session.sessionManager, session, settingsManager, outputPad: 0, toolOutputExpanded: true,
      getRegisteredToolDefinition(name: string): ToolRenderers | undefined {
        const lookup = Reflect.get(InteractiveMode.prototype, "getRegisteredToolDefinition") as (this: unknown, name: string) => ToolRenderers | undefined;
        return lookup.call(this, name);
      },
    };
    const itemsDefinition = mode.getRegisteredToolDefinition("codemode");
    itemsPresentation = new CodemodePresentation(itemsRuntime!);
    itemsDetach = attachTranscriptPresentation(itemsRoot, { getTheme: () => theme, requestRender: vi.fn(), codemode: itemsPresentation,
      resolveParameters: name => itemsRuntime!.parameters(name) });
    const definition = session.getToolDefinition("codemode")!;
    const execute = definition.execute;
    session.subscribe(event => {
      if (event.type === "tool_execution_start" && event.toolName === "codemode") {
        args = event.args;
        component = new ToolExecutionComponent("codemode", event.toolCallId, args, {}, definition,
          { requestRender() {} } as never, directory);
        component.markExecutionStarted();
        itemsParent = new ToolExecutionComponent("codemode", event.toolCallId, args, { outputPad: 0 }, itemsDefinition,
          { requestRender() {} } as never, directory);
        itemsParent.setExpanded(true); itemsParent.markExecutionStarted(); itemsChat.addChild(itemsParent);
        chat.addChild(component);
        dispose = attach();
      } else if (event.type === "tool_execution_update" && event.toolName === "codemode") {
        const partial = event.partialResult as { content: { type: string; text?: string }[]; details: CodemodeToolDetails };
        component!.updateResult({ ...partial, isError: false }, true);
        itemsParent!.updateResult({ ...partial, isError: false }, true);
        progress.push({ calls: structuredClone(partial.details.calls), row: row() });
      } else if (event.type === "tool_execution_end" && event.toolName === "codemode") {
        component!.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs });
        itemsParent!.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs });
      }
    });

    for (const scenario of scenarios) {
      const progressStart = progress.length;
      await session.prompt(`Run ${scenario.name}`);
      const receipt = session.messages.filter(message => message.role === "toolResult").filter(message => message.toolName === "codemode").at(-1)!;
      expect(receipt.isError).toBe(scenario.isError);
      const details = receipt.details as CodemodeToolDetails | undefined;
      expect(details?.calls?.map(call => call.status)).toEqual(scenario.statuses);
      expect(dispose!.targets()).toHaveLength(1);
      expect(dispose!.targets()[0]!.parent).toBeUndefined();
      const label = row();
      const items = stripTerminalSequences(itemsChat.render(120).join("\n"));
      if (scenario.statuses) {
        expect(items).toContain("Code source");
        expect(itemsDetach!.targets().length).toBeGreaterThanOrEqual(3);
        expect(items).not.toContain("Detailed result unavailable");
        itemsParent!.setExpanded(false);
        expect(stripTerminalSequences(itemsChat.render(120).join("\n"))).toContain("OK");
      } else expect(itemsDetach!.targets()).toHaveLength(1);
      expect(label).not.toContain("lines)");
      expect(label.includes("— error")).toBe(scenario.isError);
      if (scenario.statuses) {
        expect(label).toContain("2 nested calls");
        expect(label.includes("1 error")).toBe(scenario.statuses.includes("error"));
        const updates = progress.slice(progressStart);
        expect(updates.length).toBeGreaterThan(0);
        expect(updates.some(update => update.calls.some(call => call.status === "running"))).toBe(true);
        expect(updates.every(update => update.row.includes("so far") && !/\d(?:ms|s)\)/.test(update.row))).toBe(true);
        if (piCapabilities(VERSION).recordedToolDuration) expect(receipt.durationMs).toBeGreaterThanOrEqual(0);
        else expect(receipt.durationMs).toBeUndefined();
      } else {
        expect(label).not.toContain("nested call");
      }
      if (scenario.name === "uncaught child error") {
        expect(receipt.content.some(block => block.type === "text" && block.text.includes("kept output"))).toBe(true);
      }
      settledRows.push(label);
      dispose!();

      for (const themeName of ["dark", "light"]) {
        initTheme(themeName, false);
        component!.updateResult(receipt);
        component!.setExpanded(true);
        const widths = [1, 24, 80, 120];
        const native = new Map(widths.map(width => [width, component!.render(width)]));
        dispose = attach();
        for (const width of widths) {
          const rows = component!.render(width);
          expect(rows.slice(2)).toEqual(native.get(width));
          expect(rows.slice(0, 2).every(line => visibleWidth(line) <= width)).toBe(true);
        }
        const actual = component as unknown as { args: unknown; result: unknown; toolDefinition: unknown };
        expect(actual.args).toBe(args);
        expect(actual.result).toBe(receipt);
        expect(actual.toolDefinition).toBe(definition);
        expect(definition.execute).toBe(execute);
        dispose();
        component!.setExpanded(false);
      }
      chat.clear();
      itemsChat.clear();
    }

    const reloaded = SessionManager.open(session.sessionManager.getSessionFile()!).buildSessionContext().messages
      .filter(message => message.role === "toolResult").filter(message => message.toolName === "codemode");
    expect(reloaded).toHaveLength(scenarios.length);
    for (const [index, receipt] of reloaded.entries()) {
      const restored = new ToolExecutionComponent("codemode", receipt.toolCallId, { code: scenarios[index]!.code }, {}, definition,
        { requestRender() {} } as never, directory);
      restored.updateResult(receipt);
      chat.addChild(restored);
      dispose = attach();
      expect(row()).toBe(settledRows[index]);
      dispose();
      chat.clear();
    }
    expect(requests).toBe(scenarios.length * 2);
    expect(executed.filter(name => name === "fixture_ok")).toHaveLength(4);
    expect(executed.filter(name => name === "fixture_fail")).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally {
    dispose?.();
    itemsDetach?.(); itemsPresentation?.dispose(); itemsRuntime?.shutdown();
    session?.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
