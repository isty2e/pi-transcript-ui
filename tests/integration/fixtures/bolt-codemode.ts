import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSessionRuntime, InteractiveMode, ModelRuntime, SessionManager, SettingsManager, VERSION,
  createAgentSessionServices, createAgentSessionFromServices, createCodemodeExtension,
  type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Text, stripTerminalSequences, type Component, type Terminal } from "@earendil-works/pi-tui";
import { attachTranscriptPresentation, type NativeToolComponent } from "../../../src/wiring.js";
import { CodemodeRuntime } from "../../../src/codemode/pi.js";
import { CodemodePresentation } from "../../../src/codemode/view.js";
import type { DisplayLimits } from "../../../src/display.js";
import { observeNativeMode, type NativeModeObservation } from "../../../src/native-mode.js";

interface ModeFixtureAccess {
  ui: Container;
  chatContainer: Container;
  documentContainer: Container;
  isInitialized: boolean;
  bindCurrentSessionExtensions(): Promise<void>;
  renderSessionEntries(entries: ReturnType<SessionManager["buildContextEntries"]>): void;
  handleEvent(event: Record<string, unknown>): Promise<void>;
  stop(): void;
}

export default function codemodeFixture(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, context) => {
    const output = process.env.PI_TRANSCRIPT_UI_RUNTIME_REPORT;
    if (!output) throw new Error("Missing runtime fixture output path");
    const cases: string[] = [];
    let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
    let runtime: CodemodeRuntime | undefined, presentation: CodemodePresentation | undefined;
    let observation: NativeModeObservation | undefined;
    let mode: InteractiveMode | undefined, detach: ReturnType<typeof attachTranscriptPresentation> | undefined;
    let layout: DisplayLimits["codemode"] = "items", ownSource = false, executed = 0, requests = 0;
    let terminalStarts = 0, terminalWrites = 0, invalidateChild: (() => void) | undefined;
    let fixtureContext: ExtensionContext | undefined, vmExecutions = 0;

    try {
      const fixture: ExtensionFactory = api => {
        runtime = new CodemodeRuntime(api, () => layout);
        const ownerCommand = async () => {};
        api.registerCommand("transcript-ui", { handler: ownerCommand });
        observation = observeNativeMode(api, ownerCommand, captured => { runtime!.captureMode(captured); return undefined; });
        api.on("session_start", async (_event, ctx) => {
          fixtureContext = ctx;
          runtime!.start(ctx);
          await ctx.ui.custom((tui, _theme, _keys, done) => {
            runtime!.setRoot(tui); done(null); return new Text("", 0, 0);
          });
        });
        api.registerTool({ name: "fixture_child", label: "fixture", description: "Display fixture; never executed",
          parameters: { type: "object", properties: {} },
          execute: async () => { executed++; throw new Error("Fixture must not execute tools"); },
          renderCall: () => new Text("CHILD CALL", 0, 0),
          renderResult: (_result, _options, _theme, ctx) => { invalidateChild = ctx.invalidate; return new Text("CHILD BODY", 0, 0); } });
        api.registerToolRenderer((name, next) => name !== "codemode" || !ownSource ? next() : {
          renderShell: "self",
          renderCall(args, _theme, ctx) {
            ctx.state.showCode ??= false;
            const source = new Container();
            source.addChild(new MouseRegion(new Text("CODE CONTROL", 0, 0), event => {
              if (event.type !== "click") return undefined;
              ctx.state.showCode = !ctx.state.showCode; ctx.invalidate(); return { handled: true };
            }));
            if (ctx.state.showCode && typeof args === "object" && args !== null && "code" in args && typeof args.code === "string")
              source.addChild(new Text(args.code, 0, 0));
            return source;
          },
          renderResult: () => new Text("ORIGINAL BODY", 0, 0),
        });
      };
      const modelRuntime = await ModelRuntime.create({ authPath: join(context.cwd, "auth.json"), modelsPath: null,
        modelsStorePath: join(context.cwd, "models"), refreshOnCreate: false });
      const services = await createAgentSessionServices({ cwd: context.cwd, agentDir: context.cwd, modelRuntime,
        settingsManager: SettingsManager.inMemory({ theme: "dark", outputPad: 0 }),
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
          extensionFactories: [createCodemodeExtension({ models: false }), fixture] } });
      const model = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions" as const,
        baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text" as const], contextWindow: 10000, maxTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(context.cwd),
        model, tools: ["codemode", "fixture_child"] }));
      const codeDefinition = session.getToolDefinition("codemode")!, originalExecute = codeDefinition.execute;
      codeDefinition.execute = async () => { executed++; throw new Error("Display-only cases must not execute codemode"); };
      const owner = new AgentSessionRuntime(session, services, async () => { throw new Error("Fixture must not replace the session"); });
      const terminal: Terminal = { columns: 100, rows: 40, kittyProtocolActive: false,
        start() { terminalStarts++; }, stop() {}, drainInput: async () => {}, write() { terminalWrites++; }, moveBy() {},
        hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} };
      mode = new InteractiveMode(owner, { terminal });
      const access = mode as unknown as ModeFixtureAccess;

      // Keep native construction/binding/dispatch, but bypass startup's managed tools and terminal negotiation.
      access.ui.addChild(access.documentContainer); access.isInitialized = true;
      await access.bindCurrentSessionExtensions();
      access.renderSessionEntries(session.sessionManager.buildContextEntries());
      presentation = new CodemodePresentation(runtime!);
      const attach = () => attachTranscriptPresentation(access.ui, {
        getTheme: () => ({ bold: text => text, fg: (_style, text) => text }), requestRender() { requests++; },
        codemode: presentation!, displayLimits: { codemode: layout }, resolveParameters: name => runtime!.parameters(name),
      });
      detach = attach();
      const render = () => access.chatContainer.render(100).map(stripTerminalSequences).join("\n");
      const emit = async (event: Record<string, unknown>) => {
        await session!.extensionRunner!.emit(event as never);
        await access.handleEvent(event);
      };
      const finishParent = async (id: string) => emit({ type: "tool_execution_end", toolName: "codemode", toolCallId: id,
        isError: false, durationMs: 2, result: {
          content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }, { type: "text", text: "SCRIPT OUTPUT" }],
          details: { calls: [{ id: `${id}/1`, name: "fixture_child", args: "{}", status: "ok" }] },
        } });

      for (const selected of [false, true]) {
        ownSource = selected;
        if (selected) { detach(); layout = "flat"; detach = attach(); }
        const id = selected ? "selected" : "native";
        await emit({ type: "tool_execution_start", toolName: "codemode", toolCallId: id, args: { code: "return 'SOURCE-CODE'" } });
        const parent = access.chatContainer.children[0] as unknown as NativeToolComponent;
        await emit({ type: "tool_execution_start", parentToolCallId: id, toolName: "fixture_child", toolCallId: `${id}/1`, args: {} });
        await emit({ type: "tool_execution_end", parentToolCallId: id, toolName: "fixture_child", toolCallId: `${id}/1`,
          result: { content: [{ type: "text", text: "CHILD BODY" }] }, isError: false, durationMs: 1 });
        await finishParent(id);
        const folded = render();
        assert.equal(runtime!.mode(), mode, "The real mode must be discovered, not a fixture mode record");
        assert.equal(detach.targets().length, 1, "The folded execution parent must hide every section");
        assert.ok(!folded.includes(" (original)"));
        assert.ok(!folded.includes("CHILD BODY") && !folded.includes("SCRIPT OUTPUT"));
        const execution = detach.targets()[0]!;
        execution.setExpanded(true); render();
        assert.equal(detach.targets().length, 4, "Original fallback must not count as item coverage");
        const [, source, child, script] = detach.targets();
        assert.ok(source!.label.includes("Call"));
        child!.setExpanded(true); script!.setExpanded(true);
        assert.ok(render().includes("CHILD BODY") && render().includes("SCRIPT OUTPUT"));
        source!.setExpanded(true);
        assert.ok(render().includes("CHILD CALL"));

        const currentSource = () => Reflect.get(parent, "callRendererComponent") as Component;
        if (selected) {
          assert.ok(!render().includes("SOURCE-CODE"));
          currentSource().handleMouse?.({ type: "click", button: "left", x: 0, y: 0, width: 100, height: 1,
            screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false });
          assert.ok(render().includes("SOURCE-CODE"), "Renderer-owned code control must invalidate the current source");
        } else {
          assert.ok(render().includes(currentSource().render(100).map(stripTerminalSequences).join("\n")));
        }
        source!.setExpanded(false);
        assert.ok(render().includes("CHILD BODY") && render().includes("SCRIPT OUTPUT"));
        source!.setExpanded(true);
        execution.setExpanded(false);
        assert.ok(!render().includes("CHILD BODY") && !render().includes("SCRIPT OUTPUT"));
        assert.equal(detach.targets().length, 1);
        execution.setExpanded(true);
        assert.ok(render().includes("CHILD BODY") && render().includes("SCRIPT OUTPUT"));
        detach(); layout = "native"; detach = attach();
        const original = render();
        assert.equal(detach.targets().length, 1);
        assert.ok(original.includes("SCRIPT OUTPUT") || (selected && original.includes("ORIGINAL BODY")));
        assert.ok(original.includes("SOURCE-CODE"));
        detach(); layout = "items"; detach = attach();
        const restored = render();
        assert.equal(detach.targets().length, 4);
        assert.ok(restored.includes("SOURCE-CODE") && restored.includes("CHILD BODY") && restored.includes("SCRIPT OUTPUT"));
        assert.ok(!restored.includes("ORIGINAL BODY"));
        const bodies = () => detach!.targets().slice(1).map(target =>
          (target as unknown as { children: Component[] }).children[1]!.render(100));
        const indentedBodies = bodies(), sourceLines = currentSource().render(100);
        assert.equal(detach.targets()[1]!.label.match(/^ */)![0].length, 2);
        detach(); layout = "flat"; detach = attach(); render();
        assert.equal(detach.targets()[1]!.label.match(/^ */)![0].length, 0);
        assert.deepEqual(bodies(), indentedBodies); assert.deepEqual(currentSource().render(100), sourceLines);
        detach(); layout = "items"; detach = attach(); render();
        assert.deepEqual(bodies(), indentedBodies);

        const late = invalidateChild;
        assert.ok(late, "A native completed child body must have been constructed");
        access.chatContainer.clear(); render();
        const before = requests;
        late();
        await session.extensionRunner!.emit({ type: "tool_execution_end", parentToolCallId: id,
          toolCallId: `${id}/1`, toolName: "fixture_child", result: { content: [{ type: "text", text: "LATE" }] }, isError: false } as never);
        assert.equal(requests, before);
        assert.equal(detach.targets().length, 0);
        assert.equal(render(), "");
        cases.push(`${id}: independent items, native dispatch, source state, layout round-trip and removal fencing`);
      }

      // Exercise the real registered executor separately from the display-only event fixtures.
      codeDefinition.execute = originalExecute;
      assert.ok(fixtureContext);
      runtime!.start(fixtureContext); runtime!.setRoot(access.ui);
      const code = "text({first:1}); console.log('NOTE'); return 'RETURN';";
      await emit({type: "tool_execution_start", toolName: "codemode", toolCallId: "vm-output", args: {code}});
      const tool = session.agent.state.tools.find(tool => tool.name === "codemode");
      assert.ok(tool);
      const updates: Promise<void>[] = [];
      vmExecutions++;
      const final = await tool.execute("vm-output", {code}, undefined, partial => {
        updates.push(emit({type: "tool_execution_update", toolName: "codemode", toolCallId: "vm-output", partialResult: partial}));
      });
      await Promise.all(updates);
      const originalContent = structuredClone(final.content);
      await emit({type: "tool_execution_end", toolName: "codemode", toolCallId: "vm-output", isError: final.isError === true, result: final});
      render();
      detach.targets()[0]!.setExpanded(true); render();
      const outputSection = detach.targets().at(-1)!;
      assert.ok(outputSection.label.includes("3 items"), "The real registry path must retain witnessed return and console roles");
      outputSection.setExpanded(true); render();
      const outputs = detach.targets().filter(target => target.parent === outputSection);
      assert.equal(outputs.length, 3);
      assert.ok(outputs[0]!.label.includes("Text 1"));
      assert.ok(outputs[1]!.label.includes("Return value"));
      assert.ok(outputs[2]!.label.includes("Console output"));
      outputs[0]!.setExpanded(true);
      const formatted = render().split("\n").map(line => line.trimEnd()).join("\n");
      assert.ok(formatted.includes('{\n  "first": 1\n}'));
      assert.ok(!formatted.includes("pi-transcript-ui:codemode-output"));
      assert.deepEqual(final.content, originalContent);
      access.chatContainer.clear(); render();
      cases.push("actual registered native executor: witnessed text/return/console and independent output disclosure");

      await emit({ type: "tool_execution_start", toolName: "codemode", toolCallId: "unsupported", args: { code: "return 'SOURCE-CODE'" } });
      await finishParent("unsupported");
      runtime!.setRoot(new Container());
      assert.ok(render().includes(" (original)"));
      assert.equal(detach.targets().length, 1);
      const late = invalidateChild;
      detach(); presentation.dispose(); runtime!.shutdown();
      const before = requests;
      late?.();
      await session.extensionRunner!.emit({ type: "tool_execution_start", toolCallId: "late", parentToolCallId: "unsupported",
        toolName: "fixture_child", args: {} } as never);
      assert.equal(requests, before);
      assert.equal(executed, 0);
      assert.equal(session.messages.length, 0);
      assert.equal(terminalStarts, 0); assert.equal(terminalWrites, 0);
      cases.push("unavailable host uses Original; shutdown rejects late callbacks/events");
      writeFileSync(output, JSON.stringify({ ok: true, version: VERSION, cases, executed, vmExecutions, terminalStarts, terminalWrites }));
    } catch (error) {
      writeFileSync(output, JSON.stringify({ ok: false, version: VERSION, cases, error: String(error), stack: error instanceof Error ? error.stack : undefined }));
    } finally {
      detach?.(); presentation?.dispose(); runtime?.shutdown();
      observation?.dispose();
      (mode as unknown as ModeFixtureAccess | undefined)?.stop(); session?.dispose(); context.shutdown();
    }
  });
}
