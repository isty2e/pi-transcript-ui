import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode, AssistantMessageComponent, ToolExecutionComponent, SessionManager, createReadTool, createWriteTool, createBashTool, createCodemodeExtension, initTheme,
  type ExtensionAPI, type ExtensionContext, type ToolDefinition, type ToolRenderers, type ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Text, stripTerminalSequences, visibleWidth, getCapabilities, setCapabilities, type Component } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { attachTranscriptPresentation, type NativeToolComponent } from "../../src/wiring.js";
import { CodemodeRuntime } from "../../src/codemode/pi.js";
import { CodemodePresentation } from "../../src/codemode/view.js";
import { defaultSettings } from "../../src/settings.js";
import type { DisplayLimits } from "../../src/display.js";
import { ToolNavigation } from "../../src/navigation.js";
import { theme } from "../fixtures/pi-theme.js";
initTheme("dark", false);
const cleanups: (() => void)[] = [];
const isImageLine = (line: string) => line.includes("\x1b_G");
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const header = { type: "text" as const, text: "Script completed\nWall time 0.1 seconds\nOutput:\n" };
const call = (id: string, name = "read", status = "ok") => ({ id, name, status, args: '{"path":"preview' });
const result = (calls: unknown[], text?: string) => ({ content: [header, ...(text === undefined ? [] : [{ type: "text" as const, text }])], details: { calls }, isError: false });

function fixture(options: { expanded?: boolean; containerExpanded?: boolean; colored?: boolean; oldId?: string; child?: ToolRenderers; accessorChildren?: boolean; codemodeRegistered?: boolean;
  layout?: DisplayLimits["codemode"]; groupCodemode?: boolean; nativeCode?: boolean; output?: ToolRenderers; noOutputResolver?: boolean;
  renderer?: ToolRendererResolver; history?: SessionManager; resolveIntent?: (id: string, args: unknown) => string | undefined;
  install?: (api: ExtensionAPI) => void; installFirst?: boolean; cwd?: string } = {}) {
  const handlers = new Map<string, ((event: Record<string, unknown>) => void)[]>();
  const root = new Container(), chat = new Container(); root.addChild(chat);
  const accessorChildren = (container: Container) => {
    if (!options.accessorChildren) return;
    let children = container.children;
    Object.defineProperty(container, "children", { configurable: true, enumerable: true,
      get: () => children, set: (value: typeof children) => { children = value; } });
  };
  accessorChildren(chat);
  const requests = vi.fn();
  const sourceRender: ToolRenderers = {
    renderShell: "self",
    renderCall(args, _theme, ctx) {
      ctx.state.show ??= false;
      const content = new Container();
      content.addChild(new MouseRegion(new Text("SOURCE CONTROL", 0, 0), event => {
        if (event.type !== "click") return undefined;
        ctx.state.show = !ctx.state.show; ctx.invalidate(); return { handled: true };
      }));
      if (ctx.state.show && typeof args === "object" && args !== null && "code" in args && typeof args.code === "string")
        content.addChild(new Text(args.code, 0, 0));
      return content;
    },
    renderResult(value) { return new Text(`ORIGINAL-AGGREGATE\n${value.content.filter(block => block.type === "text").map(block => block.text).join("\n")}`, 0, 0); },
  };
  const codeParameters = { type: "object", properties: { code: { type: "string" } }, required: ["code"] };
  let builtin: ToolDefinition | undefined;
  if (options.nativeCode) createCodemodeExtension({models: false, mode: "on"})({
    registerTool: (value: ToolDefinition) => { if (value.name === "codemode") builtin = value; },
    getAllTools: () => [], getSettings: () => ({}), appendEntry: () => { throw new Error("Unexpected storage mutation"); },
  } as unknown as ExtensionAPI);
  const codeDefinition = {name: "codemode", parameters: codeParameters, ...sourceRender, execute: builtin?.execute};
  const definitions = new Map<string, ToolRenderers & {name: string; parameters: unknown}>([
    ["codemode", codeDefinition],
    ["read", { name: "read", parameters: createReadTool("/tmp").parameters, ...(options.child ?? {}) }],
    ["bash", { name: "bash", parameters: createBashTool("/tmp").parameters }],
  ]);
  if (options.codemodeRegistered === false) definitions.delete("codemode");
  let layout: DisplayLimits["codemode"] = options.layout ?? "items", pad = 0, showImages = true;
  const sessionManager = options.history ?? { getEntries: () => options.oldId ? [{ type: "message", message: { role: "toolResult", toolCallId: options.oldId } }] : [] };
  const context = {mode: "tui", hasUI: false, ui: {}, cwd: options.cwd ?? "/tmp", sessionManager} as unknown as ExtensionContext;
  let installedRenderer: ToolRendererResolver | undefined;
  const api = {
    on(type: string, handler: (event: Record<string, unknown>, context: ExtensionContext) => void) {
      const list = handlers.get(type) ?? [], receive = (event: Record<string, unknown>) => handler(event, context);
      list.push(receive); handlers.set(type, list);
      return () => { const index = list.indexOf(receive); if (index >= 0) list.splice(index, 1); };
    },
    getAllTools: () => [...definitions.values()],
    registerToolRenderer(renderer: ToolRendererResolver) { installedRenderer = renderer; }, registerCommand() {},
  } as unknown as ExtensionAPI;
  if (options.installFirst) options.install?.(api);
  const runtime = new CodemodeRuntime(api, () => layout);
  if (!options.installFirst) options.install?.(api);
  runtime.start(context); runtime.setRoot(root);
  const emit = (type: string, event: Record<string, unknown>) => { for (const handler of [...handlers.get(type) ?? []]) handler(event); };
  if (options.install) emit("session_start", {});
  const genericResult = vi.fn((value: { content: { type: string; text?: string }[] }) => new Text(value.content.map(block => block.text ?? "").join("\n"), 0, 0));
  const resolveOutput = vi.fn((name: string, base: () => ToolRenderers | undefined) => {
    if (options.renderer) return options.renderer(name, base);
    if (installedRenderer) return installedRenderer(name, base);
    const native = base();
    return name === "pi-transcript-ui:codemode-output" && !native ? options.output ?? { renderResult: genericResult } : native;
  });
  const mode = {
    ui: root, sessionManager, toolOutputExpanded: options.expanded ?? false,
    get outputPad() { return pad; },
    settingsManager: { getShowImages: () => showImages, getImageWidthCells: () => 60 },
    session: { getToolDefinition: (name: string) => definitions.get(name), extensionRunner: { resolveToolRenderers: resolveOutput } },
    getRegisteredToolDefinition(name: string): ToolRenderers | undefined {
      const lookup = Reflect.get(InteractiveMode.prototype, "getRegisteredToolDefinition") as (this: unknown, name: string) => ToolRenderers | undefined;
      return lookup.call(this, name);
    },
  };
  const definition = mode.getRegisteredToolDefinition("codemode");
  if (options.noOutputResolver) {
    Reflect.deleteProperty(mode.session.extensionRunner, "resolveToolRenderers");
    mode.getRegisteredToolDefinition = name => definitions.get(name);
  }
  const presentation = new CodemodePresentation(runtime);
  const attach = () => attachTranscriptPresentation(root, {
    getTheme: () => options.colored ? theme : ({ bold: (s: string) => s, fg: (_kind, s: string) => s }), requestRender: requests,
    displayLimits: { ...defaultSettings().display, codemode: layout }, codemode: presentation,
    ...(options.groupCodemode ? { rules: { codemode: "read" as const } } : {}),
    ...(options.resolveIntent ? {resolveIntent: options.resolveIntent} : {}),
    resolveParameters: name => definitions.get(name)?.parameters,
  });
  let detach = attach();
  const parent = new ToolExecutionComponent("codemode", "p", { code: "USER-CODE" }, { outputPad: pad }, definition, { requestRender: requests } as never, "/tmp");
  accessorChildren(parent);
  // Most cases inspect children of an already opened container; item defaults remain native.
  parent.setExpanded(options.containerExpanded ?? true); chat.addChild(parent);
  const start = () => emit("tool_execution_start", { toolCallId: "p", toolName: "codemode", args: { code: "USER-CODE" } });
  const nestedStart = (id: string, name = "read", args: unknown = { path: "/tmp/file.ts" }) =>
    emit("tool_execution_start", { toolCallId: id, parentToolCallId: "p", toolName: name, args });
  const nestedEnd = (id: string, name = "read", text = "CHILD-RESULT") => emit("tool_execution_end", {
    toolCallId: id, parentToolCallId: "p", toolName: name, result: { content: [{ type: "text", text }] }, isError: false, durationMs: 3,
  });
  const render = () => chat.render(100).map(stripTerminalSequences).join("\n");
  cleanups.push(() => { emit("session_shutdown", {}); detach(); presentation.dispose(); runtime.shutdown(); });
  return { root, chat, parent, runtime, presentation, requests, emit, start, nestedStart, nestedEnd, render, mode, genericResult, resolveOutput, definitions,
    async run(code: string, beforeEnd?: () => void, beforeDisplay?: () => void) {
      if (!codeDefinition.execute) throw new Error("Native executor unavailable");
      parent.updateArgs({code}); start();
      const context = {tools: [], sessionManager: {getBranch: () => []},
        executeTool: () => { throw new Error("Unexpected nested tool"); }} as unknown as Parameters<ToolDefinition["execute"]>[4];
      const native = await codeDefinition.execute("p", {code}, undefined,
        update => parent.updateResult({...update, isError: update.isError === true}, true), context);
      beforeEnd?.();
      emit("tool_execution_end", {toolCallId: "p", toolName: "codemode", result: native, isError: native.isError === true});
      beforeDisplay?.();
      parent.updateResult({...native, isError: native.isError === true}, false);
      return native;
    },
    tool(name: string, id: string, args: unknown) {
      return new ToolExecutionComponent(name, id, args, { outputPad: pad }, mode.getRegisteredToolDefinition(name),
        { requestRender: requests } as never, "/tmp");
    },
    targets: () => detach.targets(),
    layout(value: DisplayLimits["codemode"], reattach = true) { layout = value; if (reattach) { detach(); detach = attach(); } },
    showImages(value: boolean) { showImages = value; },
    padding(value: number) { pad = value; for (const child of chat.children) if ("setOutputPad" in child) (child as { setOutputPad(value: number): void }).setOutputPad(value); },
  };
}

type StoredCalls = NonNullable<Extract<Parameters<SessionManager["appendMessage"]>[0], {role: "toolResult"}>["nestedCalls"]>;
const savedParent = (records: ReturnType<typeof call>[], nestedCalls: StoredCalls, id = "p") => ({
  ...result(records), details: {calls: records}, role: "toolResult" as const, toolCallId: id, toolName: "codemode", timestamp: 0, nestedCalls,
});
const assistantCall = (id: string): Extract<Parameters<SessionManager["appendMessage"]>[0], {role: "assistant"}> => ({
  role: "assistant", content: [{type: "toolCall", id, name: "codemode", arguments: {code: "return 1"}}],
  api: "openai-responses", provider: "openai", model: "fixture", stopReason: "toolUse", timestamp: 0,
  usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
});

describe("current Codemode parent revisions", () => {
  it("withdraws removed bodies, capabilities and stale controls before another paint", () => {
    let invalidate: (() => void) | undefined;
    const h = fixture({expanded: true, child: {renderResult(_value, _options, _theme, ctx) {
      invalidate = ctx.invalidate; return new Text("RETIRED-BODY", 0, 0);
    }}});
    h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    h.parent.updateResult(result([call("p/1")], "OLD-OUTPUT"), false); expect(h.render()).toContain("RETIRED-BODY");
    const binding = h.runtime.bind(h.parent as unknown as NativeToolComponent)!, facts = binding.facts;
    const proof = facts.matched(facts.records![0]!)!, target = h.targets().find(target => target.label.includes("Read /tmp/file.ts"))!;
    h.parent.updateResult(result([], "CURRENT-OUTPUT"), false);
    const requests = h.requests.mock.calls.length;
    invalidate!(); target.setExpanded(false);
    expect(h.requests).toHaveBeenCalledTimes(requests); expect(h.runtime.input(proof)).toBeUndefined();
    const visible = h.render();
    expect(visible).toContain("CURRENT-OUTPUT"); expect(visible).not.toContain("RETIRED-BODY"); expect(visible).not.toContain("OLD-OUTPUT");
    expect(h.targets().some(target => target.label.includes("Read /tmp/file.ts"))).toBe(false);
    h.nestedStart("p/1"); h.nestedEnd("p/1", "read", "LATE-BODY");
    h.parent.updateResult(result([call("p/1")]), false);
    expect(h.render()).toContain("Detailed result unavailable"); expect(h.render()).not.toContain("LATE-BODY");
  });

  it("creates a lazy child body only from the surviving current receipt", () => {
    const h = fixture(); h.start();
    for (const [id, path] of [["p/1", "/first"], ["p/2", "/second"]]) {
      h.nestedStart(id!, "read", {path}); h.nestedEnd(id!, "read", `BODY-${path}`);
    }
    h.parent.updateResult(result([call("p/1"), call("p/2")]), false); h.render();
    h.parent.updateResult(result([call("p/2")]), false); h.render();
    h.targets().find(target => target.label.includes("Read /second"))!.setExpanded(true);
    const visible = h.render();
    expect(visible).toContain("BODY-/second"); expect(visible).not.toContain("BODY-/first");
    expect(h.targets().some(target => target.label.includes("/first"))).toBe(false);
  });

  it("preserves actual native callback pairs and row state when final activities reorder", () => {
    const callRenderer = vi.fn((args: unknown, _theme: unknown, ctx: {state: Record<string, unknown>; toolCallId: string}) => {
      ctx.state.marker ??= `STATE-${ctx.toolCallId}`;
      return new Text(`${ctx.state.marker} ${JSON.stringify(args)}`, 0, 0);
    });
    const resultRenderer = vi.fn((_value: unknown, _options: unknown, _theme: unknown, ctx: {state: Record<string, unknown>}) =>
      new Text(`RESULT-${ctx.state.marker}`, 0, 0));
    const h = fixture({expanded: true, child: {renderCall: callRenderer, renderResult: resultRenderer}});
    h.start();
    for (const id of ["p/1", "p/2"]) { h.nestedStart(id); h.nestedEnd(id); }
    h.parent.updateResult(result([call("p/1"), call("p/2")]), false); h.render();
    const targets = h.targets().filter(target => target.label.includes("Read /tmp/file.ts"));
    const counts = [callRenderer.mock.calls.length, resultRenderer.mock.calls.length];
    const states = new Map(callRenderer.mock.calls.map(([, , ctx]) => [ctx.toolCallId, ctx.state]));
    h.parent.updateResult(result([call("p/2"), call("p/1")]), false);
    const visible = h.render();
    expect(visible.indexOf("STATE-p/2")).toBeLessThan(visible.indexOf("STATE-p/1"));
    expect(callRenderer.mock.calls.length).toBeGreaterThan(counts[0]!);
    expect(resultRenderer.mock.calls.length).toBeGreaterThan(counts[1]!);
    for (const [, , ctx] of callRenderer.mock.calls) expect(ctx.state).toBe(states.get(ctx.toolCallId));
    expect(h.targets().filter(target => target.label.includes("Read /tmp/file.ts"))).toEqual([...targets].reverse());
  });

  it("releases old output rows across multi, single, absent and shorter multi output", () => {
    const h = fixture({expanded: true});
    const multi = (values: string[]) => values.map((value, index) => `==> text ${index + 1}/${values.length} <==\n${value}`).join("\n");
    for (const [text, expected, absent] of [
      [multi(["OLD-A", "OLD-B", "OLD-C"]), ["OLD-A", "OLD-B", "OLD-C"], []],
      ["SINGLE", ["SINGLE"], ["OLD-A", "OLD-B", "OLD-C"]],
      [undefined, [], ["SINGLE", "Script output"]],
      [multi(["NEXT-A", "NEXT-B", "NEXT-C"]), ["NEXT-A", "NEXT-B", "NEXT-C"], ["SINGLE"]],
      [multi(["FINAL-A", "FINAL-B"]), ["FINAL-A", "FINAL-B"], ["NEXT-A", "NEXT-B", "NEXT-C", "Output 3/3"]],
    ] as const) {
      h.parent.updateResult(result([], text), false);
      const visible = h.render();
      for (const value of expected) expect(visible).toContain(value);
      for (const value of absent) expect(visible).not.toContain(value);
    }
  });

  it("reconciles settled raw messages after append, including a same-leaf in-place replacement", () => {
    const history = SessionManager.inMemory("/tmp"), renderer = vi.fn(() => new Text("CHILD-RESULT", 0, 0));
    const h = fixture({expanded: true, history, child: {renderResult: renderer}});
    history.appendMessage(assistantCall("p")); h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    h.parent.updateResult(result([call("p/1")], "PROVISIONAL"), false); expect(h.render()).toContain("CHILD-RESULT");
    h.emit("tool_execution_end", {toolCallId: "p", toolName: "codemode", result: result([call("p/1")]), isError: false});
    const canonical = {...savedParent([call("p/1")], {complete: true, calls: []}), content: [header, {type: "text" as const, text: "SETTLED"}]};
    h.emit("message_end", {message: canonical});
    expect(h.render()).toContain("PROVISIONAL");
    const entryId = history.appendMessage(canonical);
    h.emit("turn_end", {});
    expect(h.render()).toContain("SETTLED"); expect(h.render()).not.toContain("PROVISIONAL");
    expect(h.render()).toContain("CHILD-RESULT");
    const callbacks = renderer.mock.calls.length;
    h.emit("agent_end", {}); h.render(); expect(renderer).toHaveBeenCalledTimes(callbacks);

    const leaf = history.getLeafId();
    canonical.details.calls = []; canonical.content = [header, {type: "text", text: "REDACTED"}];
    h.emit("message_end", {message: canonical});
    h.emit("agent_end", {});
    expect(history.getLeafId()).toBe(leaf); expect(history.getEntry(entryId)?.type).toBe("message");
    const visible = h.render();
    expect(visible).toContain("REDACTED"); expect(visible).not.toContain("CHILD-RESULT"); expect(visible).not.toContain("SETTLED");
  });

  it.each(["session_tree", "session_compact"])("withdraws an associated owner when its raw parent becomes ambiguous at %s", event => {
    const history = SessionManager.inMemory("/tmp"), h = fixture({expanded: true, history});
    history.appendMessage(assistantCall("p")); h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    h.parent.updateResult(result([call("p/1")]), false); h.render();
    history.appendMessage(savedParent([call("p/1")], {complete: true, calls: []})); h.emit("turn_end", {}); h.render();
    const facts = h.runtime.bind(h.parent as unknown as NativeToolComponent)!.facts, proof = facts.matched(facts.records![0]!)!;
    history.appendMessage(assistantCall("p")); h.emit(event, {});
    expect(h.runtime.input(proof)).toBeUndefined(); expect(h.render()).not.toContain("CHILD-RESULT");
    h.parent.updateResult(result([call("p/1")]), false);
    expect(h.render()).not.toContain("CHILD-RESULT");
  });

  it("does not associate an unrelated restored card by a matching bare parent ID", () => {
    const history = SessionManager.inMemory("/tmp"); history.appendMessage(assistantCall("p"));
    history.appendMessage({...savedParent([], {complete: true, calls: []}), content: [{type: "text", text: "OTHER-SOURCE"}]});
    const h = fixture({expanded: true, history});
    h.parent.updateResult(result([], "SUPPLIED-CARD"), false); h.render(); h.emit("turn_end", {});
    expect(h.render()).toContain("SUPPLIED-CARD"); expect(h.render()).not.toContain("OTHER-SOURCE");
  });

  it("refreshes retained request summaries after an observed same-object final replacement", () => {
    const history = SessionManager.inMemory("/tmp"), read = createReadTool("/tmp");
    history.appendMessage({role: "system", content: "", timestamp: 0,
      toolsAdded: [{name: "read", description: read.description, parameters: read.parameters}]});
    history.appendMessage(assistantCall("p"));
    const message = savedParent([call("p/1")], {complete: true,
      calls: [{id: "p/1", name: "read", arguments: {path: "/before.ts"}, status: "ok"}]});
    const entryId = history.appendMessage(message);
    const h = fixture({expanded: true, history}); h.parent.updateResult(message, false); h.render();
    h.emit("turn_end", {}); expect(h.render()).toContain("Read /before.ts");
    message.nestedCalls.calls[0]!.arguments = {path: "/after.ts"};
    h.emit("message_end", {message}); h.emit("agent_end", {});
    expect(h.render()).toContain("Read /after.ts"); expect(h.render()).not.toContain("Read /before.ts");
    expect(h.render()).toContain("Detailed result unavailable");
    const entry = history.getEntry(entryId);
    if (entry?.type !== "message") throw new Error("Missing saved parent");
    entry.message = {...message, nestedCalls: {complete: true,
      calls: [{id: "p/1", name: "read", arguments: {path: "/new-source.ts"}, status: "ok"}]}};
    h.emit("message_end", {message: entry.message}); h.emit("agent_end", {});
    expect(h.render()).toContain("Read /new-source.ts"); expect(h.render()).not.toContain("Read /after.ts");
  });

  it("preserves validated observed output labels when the final message only wraps the same content", async () => {
    const history = SessionManager.inMemory("/tmp"), h = fixture({expanded: true, nativeCode: true, history});
    history.appendMessage(assistantCall("p"));
    const native = await h.run('text({value: 1}); return 2;');
    expect(h.render()).toContain("Return value");
    history.appendMessage({...savedParent([], {complete: true, calls: []}), content: native.content});
    h.emit("turn_end", {});
    expect(h.render()).toContain("Return value"); expect(h.render()).toContain("Text 1");
    h.parent.updateResult(result([], "REPLACED"), false);
    expect(h.render()).not.toContain("Return value"); expect(h.render()).toContain("REPLACED");
  });
});

describe("retained Codemode request summaries", () => {
  it.each(["retained", "preview"])("honors the existing intent policy without a live child body: %s", source => {
    const h = fixture({layout: "flat", resolveIntent: () => undefined});
    const args = {path: "/intent.ts", displaySummary: "HIDDEN_REQUEST_PURPOSE"};
    const records = [{...call("p/1"), args: JSON.stringify(args)}];
    const message = source === "retained" ? savedParent(records, {
      complete: true, calls: [{id: "p/1", name: "read", arguments: args, status: "ok"}],
    }) : result(records);
    h.parent.updateResult(message, false); h.render();
    const label = h.targets().find(target => target.label.includes("Read /intent.ts"))!.label;
    expect(label).not.toContain("HIDDEN_REQUEST_PURPOSE");
  });

  it.each(["retained", "preview"])("resolves the individual child intent instead of requiring a body or copying a request field: %s", source => {
    const resolveIntent = vi.fn((id: string) => id === "p/1" ? "RESTORED_CHILD_PURPOSE" : undefined);
    const h = fixture({layout: "flat", resolveIntent});
    const args = {path: "/intent.ts", displaySummary: "REQUEST_FIELD_PURPOSE"};
    const records = [{...call("p/1"), args: JSON.stringify(args)}];
    const message = source === "retained" ? savedParent(records, {
      complete: true, calls: [{id: "p/1", name: "read", arguments: args, status: "ok"}],
    }) : result(records);
    h.parent.updateResult(message, false); h.render();
    const label = h.targets().find(target => target.label.includes("Read /intent.ts"))!.label;
    expect(label).toContain("RESTORED_CHILD_PURPOSE"); expect(label).not.toContain("REQUEST_FIELD_PURPOSE");
  });

  it("uses independently retained requests even for an incomplete inventory, without inventing bodies or measured totals", () => {
    const h = fixture({expanded: true, layout: "flat"});
    const message = savedParent([{...call("p/1"), args: '{"path":"/preview.ts","limit":1}'}], {
      complete: false, calls: [{id: "p/1", name: "read", arguments: {path: "/saved.ts", offset: 4, limit: 2}, status: "ok"}],
    });
    h.parent.updateResult(message, false); h.render();
    const label = h.targets().find(target => target.label.includes("/saved.ts"))!.label;
    expect(label).toContain("Read /saved.ts (requested lines 4–5)");
    expect(label).not.toContain("/preview.ts"); expect(label).not.toContain("(0 lines)");
    expect(h.render()).toContain("Detailed result unavailable"); expect(h.genericResult).not.toHaveBeenCalled();
  });

  it.each(["duplicate", "wrong name", "invalid arguments", "present undefined"])("does not backfill a conflicting retained source from an older preview: %s", variant => {
    const h = fixture({layout: "flat"});
    const entry = {id: "p/1", name: "read", arguments: {path: "/saved.ts"}, status: "ok" as const};
    if (variant === "wrong name") entry.name = "bash";
    if (variant === "invalid arguments") Object.defineProperty(entry, "arguments", {value: null});
    if (variant === "present undefined") Object.defineProperty(entry, "arguments", {value: undefined});
    const message = savedParent([{...call("p/1"), args: '{"path":"/preview.ts","limit":2}'}], {
      complete: true, calls: variant === "duplicate" ? [entry, {...entry}] : [entry],
    });
    h.parent.updateResult(message, false); h.render();
    const label = h.targets().find(target => target.label.includes("/preview.ts"))!.label;
    expect(label).not.toContain("Read /preview.ts"); expect(label).not.toContain("requested");
    expect(h.targets()).toHaveLength(3);
  });

  it("uses a valid partial producer preview only when retained arguments were omitted", () => {
    const h = fixture({layout: "flat"});
    h.parent.updateResult(savedParent([{...call("p/1"), args: '{"path":"/preview.ts","offset":7,"limit":2,...'}], {
      complete: false, calls: [{id: "p/1", name: "read", argumentsBytes: 90_000, status: "ok"}],
    }), false); h.render();
    expect(h.targets().some(target => target.label.includes("Read /preview.ts (requested lines 7–8)"))).toBe(true);
  });

  it("keeps native activity cancellation and final unknown completion independent of retained status vocabulary", () => {
    const h = fixture({expanded: true});
    h.parent.updateResult(savedParent([call("p/1", "read", "running"), call("p/2", "read", "cancelled")], {
      complete: false, calls: [
        {id: "p/1", name: "read", arguments: {path: "/same.ts"}, status: "ok"},
        {id: "p/2", name: "read", arguments: {path: "/same.ts"}, status: "unfinished"},
      ],
    }), false); h.render();
    const labels = h.targets().map(target => target.label);
    expect(labels.some(label => label.includes("read /same.ts — completion unknown"))).toBe(true);
    expect(labels.some(label => label.includes("Read /same.ts — cancelled"))).toBe(true);
    const group = h.targets().find(target => target.kind === "group")!;
    expect(group.label).toContain("1 file"); expect(group.label).toContain("1 completion unknown");
    expect(group.label).toContain("1 cancelled");
    group.setExpanded(false); h.render(); expect(group.expanded).toBe(false);
    expect(labels.some(label => label.includes("1 running"))).toBe(false);
  });

  it.each(["declaration update", "duplicate declaration", "duplicate result"])("does not borrow an ambiguous declaration: %s", variant => {
    const history = SessionManager.inMemory("/tmp");
    history.appendMessage({role: "system", content: "", timestamp: 0,
      toolsAdded: [{name: "operation", description: "", parameters: createReadTool("/tmp").parameters}]});
    const assistant = assistantCall("p");
    if (variant === "duplicate declaration") assistant.content.push(...assistantCall("p").content);
    history.appendMessage(assistant);
    if (variant === "declaration update") history.appendMessage({role: "system", content: "", timestamp: 0,
      toolsAdded: [{name: "operation", description: "", parameters: createWriteTool("/tmp").parameters}]});
    const message = savedParent([call("p/1", "operation")], {
      complete: true, calls: [{id: "p/1", name: "operation", arguments: {path: "/ambiguous.ts", limit: 2}, status: "ok"}],
    });
    history.appendMessage(message);
    if (variant === "duplicate result") history.appendMessage({...message});
    const h = fixture({history, layout: "flat"}); h.parent.updateResult(message, false); h.render();
    expect(h.targets().some(target => /(?:Read|Write) \/ambiguous\.ts/.test(target.label))).toBe(false);
    expect(h.targets().some(target => target.label.includes("operation"))).toBe(true);
  });

  it("does not reinterpret retained parents using a later compaction checkpoint", () => {
    const history = SessionManager.inMemory("/tmp");
    history.appendMessage({role: "system", content: "", timestamp: 0,
      toolsAdded: [{name: "operation", description: "read", parameters: createReadTool("/tmp").parameters}]});
    const kept = history.appendMessage(assistantCall("p"));
    const message = savedParent([call("p/1", "operation")], {
      complete: true, calls: [{id: "p/1", name: "operation", arguments: {path: "/before.ts", limit: 2}, status: "ok"}],
    });
    history.appendMessage(message);
    history.appendMessage({role: "system", content: "", timestamp: 0,
      toolsAdded: [{name: "operation", description: "write", parameters: createWriteTool("/tmp").parameters}]});
    history.appendCompaction("retained calls", kept, 0);
    const h = fixture({history, layout: "flat"});
    h.parent.updateResult(message, false); h.render();
    expect(h.targets().some(target => target.label.includes("Read /before.ts (requested lines 1–2)"))).toBe(true);
    expect(h.targets().some(target => target.label.includes("Write /before.ts"))).toBe(false);
  });

  it("uses declarations at the exact parent occurrence, not a later registry or another parent's schema", () => {
    const history = SessionManager.inMemory("/tmp");
    const schema = createReadTool("/tmp").parameters;
    history.appendMessage({role: "system", content: "", timestamp: 0, toolsAdded: [{name: "operation", description: "", parameters: schema}]});
    history.appendMessage(assistantCall("p"));
    const first = savedParent([call("p/1", "operation")], {
      complete: true, calls: [{id: "p/1", name: "operation", arguments: {path: "/first.ts", limit: 2}, status: "ok"}],
    });
    history.appendMessage(first);
    const h = fixture({history, layout: "flat"});
    h.definitions.set("operation", {name: "operation", parameters: createWriteTool("/tmp").parameters});
    h.parent.updateResult(first, false); h.render();
    expect(h.targets().some(target => target.label.includes("Read /first.ts (requested lines 1–2)"))).toBe(true);

    history.appendMessage({role: "system", content: "", timestamp: 0, toolsAdded: [{name: "operation", description: "", parameters: createWriteTool("/tmp").parameters}]});
    history.appendMessage(assistantCall("q"));
    const second = savedParent([call("q/1", "operation")], {
      complete: true, calls: [{id: "q/1", name: "operation", arguments: {path: "/second.ts", content: "one\n"}, status: "ok"}],
    }, "q");
    history.appendMessage(second);
    const next = h.tool("codemode", "q", {code: "return 1"}); next.setExpanded(true); h.chat.addChild(next); next.updateResult(second, false); h.render();
    expect(h.targets().some(target => target.label.includes("Write /second.ts (requested 1 line)"))).toBe(true);
    expect(h.targets().some(target => target.label.includes("Read /first.ts"))).toBe(true);

    const scans = vi.spyOn(history, "getBranch");
    h.layout("items"); h.render();
    expect(scans).not.toHaveBeenCalled();
    const clone = {...second}; next.updateResult(clone, false); h.render();
    expect(h.targets().some(target => target.label.includes("Write /second.ts"))).toBe(false);
  });
});

describe("independent native codemode items", () => {
  it("reuses the captured native host without leaving another lookup hook installed", () => {
    const h = fixture();
    const lookup = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "getRegisteredToolDefinition");
    h.runtime.start({ mode: "tui", sessionManager: h.mode.sessionManager } as unknown as ExtensionContext);
    h.runtime.setRoot(h.root);
    expect(h.runtime.mode()).toBe(h.mode);
    expect(Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "getRegisteredToolDefinition")).toEqual(lookup);
  });

  it("rediscovers the native host after retiring and restarting observation", () => {
    const h = fixture();
    h.runtime.shutdown();
    h.runtime.start({ mode: "tui", sessionManager: h.mode.sessionManager } as unknown as ExtensionContext);
    h.runtime.setRoot(h.root);
    h.mode.getRegisteredToolDefinition("codemode");
    expect(h.runtime.mode()).toBe(h.mode);
    const parent = h.tool("codemode", "restarted", { code: "return 1;" });
    expect(h.runtime.bind(parent as unknown as NativeToolComponent)?.supported()).toBe(true);
  });

  it("observes the actual registered executor before the first frame and discloses only selected output bodies", async () => {
    const h = fixture({nativeCode: true, containerExpanded: false});
    await h.run("text('A'); text('B'); console.log('C'); return {value:2};");
    h.render(); expect(h.targets()).toHaveLength(1);
    h.targets()[0]!.setExpanded(true); h.render();
    const [parent, source, output] = h.targets();
    expect(output!.label).toContain("4 items");
    expect(h.genericResult).not.toHaveBeenCalled();
    output!.setExpanded(true); h.render();
    const members = h.targets().filter(target => target.parent === output);
    expect(members.map(target => target.label)).toEqual([
      "    ▸ Text 1 — A", "    ▸ Text 2 — B", "    ▸ Return value — {\"value\":2}", "    ▸ Console output — C",
    ]);
    expect(members.every(target => !target.expanded)).toBe(true);
    expect(h.genericResult).not.toHaveBeenCalled();
    members[0]!.setExpanded(true);
    const opened = h.render().split("\n").map(line => line.trim());
    expect(opened).toContain("A");
    expect(opened).not.toContain("B"); expect(opened).not.toContain("C");
    expect(h.genericResult).not.toHaveBeenCalled();
    expect(h.resolveOutput.mock.calls.map(([name]) => name)).not.toContain("pi-transcript-ui:codemode-output");
    output!.setExpanded(false); h.render(); expect(h.targets()).toEqual([parent, source, output]);
    output!.setExpanded(true); h.render(); expect(members[0]!.expanded).toBe(true);
    parent!.setExpanded(false); h.render(); expect(h.targets()).toEqual([parent]);
    parent!.setExpanded(true); h.render(); expect(h.targets().filter(target => target.parent === output)).toEqual(members);
    for (const width of [1, 2, 3, 12, 40]) expect(h.chat.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
  });

  it("uses complete printed numbering without runtime tracing and leaves malformed numbering combined", () => {
    const h = fixture({layout: "flat"});
    h.parent.updateResult(result([], "==> text 1/2 <==\nA\n==> text 2/2 <==\nB"), false); h.render();
    const section = h.targets().at(-1)!;
    expect(section.label).toBe("▸ Script output (2 sections)");
    section.setExpanded(true); h.render();
    const members = h.targets().filter(target => target.parent === section);
    expect(members.map(target => target.label)).toEqual(["  ▸ Output 1/2 — A", "  ▸ Output 2/2 — B"]);
    members[1]!.setExpanded(true);
    expect(h.render().split("\n").map(line => line.trim())).toContain("B");
    expect(h.render().split("\n").map(line => line.trim())).not.toContain("A");
    expect(Reflect.get(h.parent, "result").content[1].text).toBe("==> text 1/2 <==\nA\n==> text 2/2 <==\nB");

    const malformed = fixture();
    const original = "==> text 1/3 <==\nA\n==> text 3/3 <==\nC";
    malformed.parent.updateResult(result([], original), false); malformed.render();
    expect(malformed.targets().at(-1)!.label).toBe("  ▸ Script output");
    malformed.targets().at(-1)!.setExpanded(true);
    expect(malformed.render().split("\n").map(line => line.trimEnd()).join("\n")).toContain(original);
  });

  it("keeps terminal controls and empty decorative separators out of collapsed output headings", async () => {
    const h = fixture({nativeCode: true});
    const payload = "\x1b]52;c;U0VDUkVU\x07\x1b[2JVISIBLE";
    await h.run(`text(${JSON.stringify(payload)}); text('\\r\\t');`); h.render();
    const output = h.targets().at(-1)!;
    output.setExpanded(true); h.render();
    const rendered = h.chat.render(100).join("\n");
    expect(rendered).not.toContain("\x1b]52;");
    expect(rendered).not.toContain("\x1b[2J");
    const members = h.targets().filter(target => target.parent === output);
    expect(members[0]!.label).toContain("VISIBLE");
    expect(members[1]!.label.trim()).toBe("▸ Text 2");
    expect(h.genericResult).not.toHaveBeenCalled();
    members[0]!.setExpanded(true);
    expect(h.render().split("\n").map(line => line.trim())).toContain("VISIBLE");
    expect(h.chat.render(100).join("\n")).not.toContain("\x1b]52;");
    expect(h.genericResult).not.toHaveBeenCalled();
  });

  it("can disclose an empty formatted section without painting its numbered header", () => {
    const h = fixture({layout: "flat"});
    h.parent.updateResult(result([], "==> text 1/2 <==\nA\n==> text 2/2 <=="), false);
    h.render(); h.targets().at(-1)!.setExpanded(true); h.render();
    const empty = h.targets().at(-1)!;
    expect(empty.label.trim()).toBe("▸ Output 2/2");
    empty.setExpanded(true);
    expect(() => h.render()).not.toThrow();
    expect(h.render()).not.toContain("==> text");
    expect(h.genericResult).not.toHaveBeenCalled();
  });

  it("applies native bulk defaults and image/padding settings to lazy output members", async () => {
    const h = fixture({nativeCode: true, expanded: true});
    h.padding(2); h.showImages(false);
    await h.run("text('A'); text('B');"); h.render();
    expect(h.targets().every(target => target.expanded)).toBe(true);
    const output = h.targets().find(target => target.label.includes("Script output"))!;
    const members = h.targets().filter(target => target.parent === output);
    expect(members).toHaveLength(2);
    const bodies = () => members.map(member => (member as unknown as {children: Component[]}).children[1]!.render(100));
    const native = (value: string, pad: number) => {
      const host = new ToolExecutionComponent("unused", "unused", {}, {outputPad: pad, showImages: false},
        {renderCall: () => new Text("", 0, 0)}, {requestRender: h.requests} as never, "/tmp");
      host.updateResult({content: [{type: "text", text: value}], isError: false}); host.setExpanded(true);
      return host.render(100);
    };
    expect(bodies()).toEqual([native("A", 2), native("B", 2)]);
    const scope = h.chat.children[0] as Component & {setExpanded(value: boolean): void};
    scope.setExpanded(false); h.render(); expect(h.targets()).toHaveLength(1);
    scope.setExpanded(true); h.render(); expect(h.targets().every(target => target.expanded)).toBe(true);
    h.padding(0); h.showImages(true); h.render();
    expect(bodies()).toEqual([native("A", 0), native("B", 0)]);
  });

  it("uses native text disclosure per output member and fences native callbacks after removal", async () => {
    const foreignCall = vi.fn(() => new Text("FOREIGN CALL", 0, 0));
    const foreignResult = vi.fn(() => new Text("FOREIGN RESULT", 0, 0));
    const updates = vi.spyOn(ToolExecutionComponent.prototype, "updateResult");
    const h = fixture({nativeCode: true, output: {renderCall: foreignCall, renderResult: foreignResult}});
    await h.run("text('A'); text('B');"); h.render();
    const parent = h.targets()[0]!, output = h.targets().at(-1)!;
    output.setExpanded(true); h.render();
    const members = h.targets().filter(target => target.parent === output);
    for (const member of members) member.setExpanded(true);
    h.render();
    const component = members[0] as unknown as Component;
    const lines = component.render(100).map(stripTerminalSequences), y = lines.findIndex(line => line.trim() === "A");
    expect(y).toBeGreaterThan(0);
    component.handleMouse?.({type: "click", button: "left", x: 0, y, width: 100, height: lines.length,
      screenX: 0, screenY: y, shift: false, alt: false, ctrl: false});
    h.render();
    expect(members.map(member => member.expanded)).toEqual([false, true]);
    expect(h.render().split("\n").map(line => line.trim())).not.toContain("A");
    expect(h.render().split("\n").map(line => line.trim())).toContain("B");
    parent.setExpanded(false); h.render(); parent.setExpanded(true);
    h.render(); expect(members.map(member => member.expanded)).toEqual([false, true]);
    const hosts = updates.mock.contexts.filter((host): host is ToolExecutionComponent => host instanceof ToolExecutionComponent && host !== h.parent);
    expect(hosts).toHaveLength(2);
    h.chat.children = []; h.render();
    const before = h.requests.mock.calls.length;
    for (const host of hosts) {
      host.invalidate();
      (Reflect.get(host, "ui") as {requestRender(): void}).requestRender();
    }
    expect(h.requests).toHaveBeenCalledTimes(before);
    expect(h.targets()).toEqual([]);
    expect(foreignCall).not.toHaveBeenCalled(); expect(foreignResult).not.toHaveBeenCalled();
    expect(h.resolveOutput.mock.calls.map(([name]) => name)).not.toContain("pi-transcript-ui:codemode-output");
  });

  it("keeps native-only output intact and can use formatted regions when later switched to items", async () => {
    const h = fixture({nativeCode: true, layout: "native"});
    await h.run("text('A'); text('B');");
    expect(h.render()).toContain("ORIGINAL-AGGREGATE");
    expect(h.genericResult).not.toHaveBeenCalled();
    h.layout("items"); h.render();
    expect(h.targets().at(-1)!.label).toContain("2 sections");
  });

  it("observes and displays formatted output without a generic-renderer resolver on the host", async () => {
    const h = fixture({nativeCode: true, expanded: true, noOutputResolver: true});
    const original = await h.run('text({a:1}); return [2,3];');
    const before = structuredClone(original);
    const visible = h.render().split("\n").map(line => line.trimEnd()).join("\n");
    expect(visible).toContain('{\n  "a": 1\n}');
    expect(visible).toContain('[2, 3]');
    const section = h.targets().find(target => target.label.includes("Script output"))!;
    expect(section.label).toContain("2 items");
    expect(h.targets().filter(target => target.parent === section).map(target => target.label.trim()))
      .toEqual(['▾ Text 1 — {"a":1}', '▾ Return value — [2,3]']);
    expect(original).toEqual(before);
    expect(Reflect.get(h.parent, "result").content).toEqual(original.content);
  });

  it("does not resolve or display an invocation for output even when its private name is a real tool", () => {
    const h = fixture({expanded: true});
    const renderCall = vi.fn(() => new Text("REAL TOOL CALL", 0, 0));
    const renderResult = vi.fn(() => new Text("REAL TOOL RESULT", 0, 0));
    h.definitions.set("pi-transcript-ui:codemode-output", {name: "pi-transcript-ui:codemode-output", parameters: {}, renderCall, renderResult});
    const raw = Array.from({length: 18}, (_, i) => `supplied-${i}`).join("\n");
    h.parent.updateResult(result([], raw), false);
    const visible = h.render();
    expect(visible).toContain("supplied-0"); expect(visible).toContain("supplied-17");
    expect(visible).not.toContain("pi-transcript-ui:codemode-output");
    expect(visible).not.toContain("REAL TOOL");
    expect(renderCall).not.toHaveBeenCalled(); expect(renderResult).not.toHaveBeenCalled();

    const real = h.tool("pi-transcript-ui:codemode-output", "real", {});
    real.updateResult({content: [{type: "text", text: "original"}], isError: false}); real.setExpanded(true);
    const rendered = real.render(100).map(stripTerminalSequences).join("\n");
    expect(rendered).toContain("REAL TOOL CALL"); expect(rendered).toContain("REAL TOOL RESULT");
    expect(renderCall).toHaveBeenCalled(); expect(renderResult).toHaveBeenCalled();
  });

  it("lets the native component wrap long scalar arrays while retaining every value", () => {
    const h = fixture({expanded: true});
    const values = Array.from({length: 1500}, (_, index) => index);
    const native = result([], JSON.stringify(values)), before = structuredClone(native.content);
    h.parent.updateResult(native, false);
    const lines = h.chat.render(80).map(stripTerminalSequences);
    expect(lines.length).toBeLessThan(values.length);
    expect(lines.every(line => visibleWidth(line) <= 80)).toBe(true);
    const selected = h.targets().at(-1)!;
    const body = (selected as unknown as {children: Component[]}).children[1]!.render(80).map(stripTerminalSequences);
    const displayed = body.map(line => line.trim()).join(" ");
    const tokens = displayed.match(/\d+/g)?.map(Number);
    expect(tokens).toEqual(values);
    expect(native.content).toEqual(before);
  });

  it("reuses one final-output projection across sibling opens and preserves Original mode", async () => {
    const h = fixture({nativeCode: true});
    const raw = '{"n":9007199254740993,"n":1e400}';
    await h.run(`text(${JSON.stringify(raw)}); text('[1,2]');`);
    const parse = vi.spyOn(JSON, "parse");
    h.render(); const section = h.targets().at(-1)!;
    section.setExpanded(true); h.render();
    const members = h.targets().filter(target => target.parent === section);
    members[1]!.setExpanded(true); h.render();
    members[0]!.setExpanded(true);
    expect(h.render().split("\n").map(line => line.trimEnd()).join("\n")).toContain('{\n  "n": 9007199254740993,\n  "n": 1e400\n}');
    for (const member of members) { member.setExpanded(false); h.render(); member.setExpanded(true); h.render(); }
    expect(parse.mock.calls.filter(([value]) => value === raw)).toHaveLength(1);
    expect(parse.mock.calls.filter(([value]) => value === "[1,2]")).toHaveLength(1);
    const content = structuredClone(Reflect.get(h.parent, "result").content);
    h.layout("native"); const original = h.render();
    expect(original).toContain("ORIGINAL-AGGREGATE"); expect(original).toContain(raw);
    expect(Reflect.get(h.parent, "result").content).toEqual(content);
    h.layout("items"); h.render();
    const restored = h.targets().find(target => target.label.includes("Script output"))!;
    restored.setExpanded(true); h.render();
    for (const target of h.targets().filter(target => target.parent === restored)) target.setExpanded(true);
    h.render();
    expect(parse.mock.calls.filter(([value]) => value.trimEnd() === raw)).toHaveLength(1);
  });

  it("memoizes raw fallback and replaces it when the parent receives new sealed facts", () => {
    const h = fixture({expanded: true});
    const raw = "[".repeat(250) + "0" + "]".repeat(250);
    h.parent.updateResult(result([], raw), false);
    const parse = vi.spyOn(JSON, "parse");
    h.render(); const output = h.targets().at(-1)!;
    output.setExpanded(false); h.render(); output.setExpanded(true); h.render();
    expect(parse.mock.calls.filter(([value]) => value === raw)).toHaveLength(1);
    h.parent.updateResult(result([], '{"new":2}'), true); h.start();
    h.parent.updateResult(result([], '{"new":2}'), false);
    const visible = h.render().split("\n").map(line => line.trimEnd()).join("\n");
    expect(visible).toContain('{\n  "new": 2\n}');
    expect(visible).not.toContain(raw);
    expect(parse.mock.calls.filter(([value]) => value === '{"new":2}')).toHaveLength(1);
  });

  it.each(["before-end", "before-display"])("rejects staged observation when the parent becomes ambiguous %s", async when => {
    const h = fixture({nativeCode: true});
    const duplicateParent = () => {
      const duplicate = new ToolExecutionComponent("codemode", "p", {code: "OTHER"}, {showImages: true, imageWidthCells: 60},
        h.mode.getRegisteredToolDefinition("codemode"), {requestRender: h.requests} as never, "/tmp");
      duplicate.updateResult(result([]), true); h.chat.addChild(duplicate); h.runtime.bind(duplicate as unknown as NativeToolComponent);
    };
    await h.run("text('A'); console.log('C'); return 'B';", when === "before-end" ? duplicateParent : undefined,
      when === "before-display" ? duplicateParent : undefined);
    h.render();
    const output = h.targets().find(target => target.label.includes("Script output"))!;
    expect(output.label).toContain("2 sections");
    expect(output.label).not.toContain("3 items");
  });

  it("does not pass incomplete appearance settings into cached bodies when the host is unavailable", async () => {
    const updates = vi.spyOn(ToolExecutionComponent.prototype, "updateResult");
    const h = fixture({nativeCode: true, expanded: true});
    await h.run("text('A'); text('B');"); h.render();
    const hosts = updates.mock.contexts.filter((host): host is ToolExecutionComponent => host instanceof ToolExecutionComponent && host !== h.parent);
    expect(hosts).toHaveLength(2);
    const preferences = hosts.map(host => vi.spyOn(host, "setOutputPad"));
    h.runtime.setRoot(new Container());
    expect(() => h.padding(3)).not.toThrow();
    for (const preference of preferences) expect(preference).not.toHaveBeenCalled();
    expect(h.render()).toContain(" (original)");
  });

  it("folds the whole container and opens only independent section headings", () => {
    const h = fixture({ containerExpanded: false }); h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    h.parent.updateResult(result([call("p/1")], "SCRIPT-OUTPUT"), false);
    expect(h.render()).toContain("▸ Ran code");
    expect(h.targets()).toHaveLength(1);
    expect(h.render()).not.toMatch(/SOURCE CONTROL|CHILD-RESULT|SCRIPT-OUTPUT|Script output/);

    h.targets()[0]!.setExpanded(true);
    const opened = h.render();
    expect(opened).toContain("▾ Ran code");
    expect(opened).toContain("▸ Call");
    expect(opened).toContain("▸ Script output");
    expect(h.targets()).toHaveLength(4);
    expect(h.targets().slice(1).every(target => !target.expanded)).toBe(true);
    expect(opened).not.toMatch(/SOURCE CONTROL|CHILD-RESULT|SCRIPT-OUTPUT/);
  });

  it("keeps Call, native code controls and sibling disclosure independent through parent folding", () => {
    const h = fixture(); h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    h.parent.updateResult(result([call("p/1")], "SCRIPT-OUTPUT"), false); h.render();
    const [parent, source, child, output] = h.targets();
    source!.setExpanded(true);
    expect(h.render()).toContain("SOURCE CONTROL");
    expect(h.render()).not.toContain("USER-CODE");
    expect(parent!.expanded).toBe(true);
    expect([child!.expanded, output!.expanded]).toEqual([false, false]);
    const sourceComponent = source as typeof source & Component;
    sourceComponent.handleMouse?.({ type: "click", button: "left", x: 0, y: 1, width: 100, height: 2,
      screenX: 0, screenY: 1, shift: false, alt: false, ctrl: false });
    expect(h.render()).toContain("USER-CODE");
    child!.setExpanded(true); output!.setExpanded(true); h.render();
    parent!.setExpanded(false);
    expect(h.render()).not.toMatch(/SOURCE CONTROL|USER-CODE|CHILD-RESULT|SCRIPT-OUTPUT/);
    expect(h.targets()).toEqual([parent]);
    sourceComponent.handleMouse?.({ type: "click", button: "left", x: 0, y: 0, width: 100, height: 1,
      screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false });
    expect(source!.expanded).toBe(true);
    parent!.setExpanded(true);
    const reopened = h.render();
    expect(reopened).toContain("USER-CODE"); expect(reopened).toContain("CHILD-RESULT"); expect(reopened).toContain("SCRIPT-OUTPUT");
    expect(h.targets()).toEqual([parent, source, child, output]);
  });

  it("uses native bulk defaults at lazy section creation and forwards later bulk actions", () => {
    const h = fixture({ containerExpanded: false }); h.render();
    h.mode.toolOutputExpanded = true; h.parent.setExpanded(true);
    h.parent.updateResult(result([call("p/1")], "SCRIPT-OUTPUT"), false); h.render();
    expect(h.targets().every(target => target.expanded)).toBe(true);
    const scope = h.chat.children[0] as Component & {setExpanded(value: boolean): void};
    scope.setExpanded(false); h.render(); expect(h.targets()).toHaveLength(1);
    scope.setExpanded(true); h.render(); expect(h.targets().every(target => target.expanded)).toBe(true);
  });

  it("keeps the settled execution caption after a late partial replacement", () => {
    const h = fixture(); h.start();
    h.parent.updateResult(result([call("p/1")]), false); h.render();
    const label = h.targets()[0]!.label;
    expect(label).toMatch(/^▾ Ran code/);
    h.parent.updateResult(result([call("p/1", "read", "running"), call("p/2")]), true); h.render();
    expect(h.targets()[0]!.label).toBe(label);
  });

  it("styles matched nested shell summaries like ordinary shell summaries", () => {
    const h = fixture({ colored: true }); const args = {command: "printf 'PARITY'"};
    const direct = h.tool("bash", "direct", args);
    direct.updateResult({content:[{type:"text",text:"CHILD-RESULT"}],isError:false,durationMs:3}, false);
    h.chat.addChild(direct); h.start(); h.nestedStart("p/1", "bash", args); h.nestedEnd("p/1", "bash");
    h.parent.updateResult(result([call("p/1", "bash")]), false);
    const lines = h.chat.render(100).filter(line => stripTerminalSequences(line).includes("PARITY"));
    expect(lines).toHaveLength(2);
    expect(lines[0]!.replace(/^  /, "")).toBe(lines[1]);
  });

  it.each(["items", "flat"] as const)("lays out %s headings while preserving the existing local group level", layout => {
    const h = fixture({ layout });
    h.parent.updateResult(result([{ ...call("p/1"), args: '{"path":"한글/👩‍💻.ts"}' }, call("p/2")], "SCRIPT RESULT"));
    h.render();
    const group = h.targets().find(target => target.kind === "group")!;
    const depth = layout === "items" ? 2 : 0;
    expect(group.label.match(/^ */)![0]).toHaveLength(depth);
    group.setExpanded(true); h.render();
    const members = h.targets().filter(target => target.parent === group);
    expect(members).toHaveLength(2);
    for (const member of members) expect(member.label.match(/^ */)![0]).toHaveLength(depth + 2);
    expect(h.targets().at(-1)!.label.match(/^ */)![0]).toHaveLength(depth);
    expect(h.targets()[0]!.label).toMatch(/^▾ Ran code/);

    h.layout(layout === "items" ? "flat" : "items", false); h.render();
    expect(group.label.match(/^ */)![0]).toHaveLength(depth === 2 ? 0 : 2);
    expect(members[0]!.label.match(/^ */)![0]).toHaveLength(depth === 2 ? 2 : 4);
    expect(group.expanded).toBe(true);
    for (const width of [1, 2, 3, 12, 40]) expect(h.chat.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
  });

  it("keeps codemode heading depth relative to its ordinary parent group", () => {
    const h = fixture({ groupCodemode: true });
    h.parent.updateResult(result([call("p/1", "bash")]));
    const sibling = h.tool("codemode", "q", { code: "OTHER-CODE" });
    sibling.updateResult(result([call("q/1", "bash")])); h.chat.addChild(sibling);
    h.render(); const outer = h.targets()[0]!; outer.setExpanded(true); h.render();
    const source = h.targets().find(target => target.kind === "tool" && target.parent === outer)!;
    const member = h.targets().find(target => target.parent === source)!;
    expect(source.label.match(/^ */)![0]).toHaveLength(2);
    expect(member.label.match(/^ */)![0]).toHaveLength(4);
    h.layout("flat", false); h.render();
    expect(member.label.match(/^ */)![0]).toHaveLength(2);
  });

  it("keeps completed bodies, source code and horizontal mouse coordinates identical in both item layouts", () => {
    const clicked = vi.fn((_event: Parameters<NonNullable<Component["handleMouse"]>>[0]) => ({ handled: true }));
    const widths: number[] = [];
    const h = fixture({ layout: "flat", child: { renderShell: "self", renderCall: () => new Text("CALL", 0, 0),
      renderResult: () => ({ render(width) { widths.push(width); return ["  BODY CONTENT"]; }, invalidate() {}, handleMouse: clicked }) } });
    h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    h.parent.updateResult(result([call("p/1")], "  SCRIPT CONTENT")); h.render();
    for (const target of h.targets()) target.setExpanded(true);
    h.render();
    const currentSource = () => Reflect.get(h.parent, "callRendererComponent") as Component;
    currentSource().handleMouse?.({ type: "click", button: "left", x: 0, y: 0, width: 100, height: 1,
      screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false });
    const snapshot = () => {
      const text = h.render(), scope = h.chat.children[0]!;
      const bodies = h.targets().slice(1)
        .map(target => (target as unknown as { children: Component[] }).children[1]!.render(100));
      scope.handleMouse?.({ type: "click", button: "left", x: 7, y: text.split("\n").findIndex(line => line.includes("BODY CONTENT")),
        width: 100, height: text.split("\n").length, screenX: 7, screenY: 0, shift: false, alt: false, ctrl: false });
      return { bodies, source: currentSource().render(100), pointer: clicked.mock.calls.at(-1)?.[0] };
    };
    const flat = snapshot();
    expect(h.render()).toContain("USER-CODE");
    h.layout("items");
    const indented = snapshot();
    expect(indented.bodies).toEqual(flat.bodies);
    expect(indented.source).toEqual(flat.source);
    expect(indented.pointer).toEqual(flat.pointer);
    expect(clicked.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(widths.length).toBeGreaterThan(0);
    expect(new Set(widths)).toEqual(new Set([100]));
    h.layout("native"); h.render(); h.layout("flat");
    expect(snapshot().bodies).toEqual(flat.bodies);
  });

  it("skips repeated global pruning on stable ordinary frames without caching their displayed result", () => {
    const h = fixture(); h.chat.clear();
    const tool = h.tool("bash", "ordinary", { command: "printf ordinary" });
    tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false }); h.chat.addChild(tool);
    h.render(); const prune = vi.spyOn(h.presentation, "prune");
    for (let frame = 0; frame < 5; frame++) h.render();
    expect(prune.mock.calls.length).toBe(0);

    tool.updateResult({ content: [{ type: "text", text: "failure" }], isError: true });
    expect(h.render()).toContain("— error"); expect(prune.mock.calls.length).toBe(0);
  });

  it("admits new item data without a structural sweep and acknowledges its own physical slot change", () => {
    const h = fixture({ expanded: true }); h.start(); h.render();
    const prune = vi.spyOn(h.presentation, "prune");
    expect(h.chat.children[0]).toBe(h.parent);
    h.parent.updateResult(result([call("p/1")], "NEW-OUTPUT"), false);
    expect(h.render()).toContain("NEW-OUTPUT"); expect(h.chat.children[0]).not.toBe(h.parent);
    h.parent.setExpanded(false);
    for (let frame = 0; frame < 3; frame++) expect(h.render()).not.toContain("NEW-OUTPUT");
    h.parent.setExpanded(true); expect(h.render()).toContain("NEW-OUTPUT");
    expect(prune.mock.calls.length).toBe(0);
  });

  it("detects same-length replacement/reordering and preserves a replacement array with identical members", () => {
    const h = fixture(); h.chat.clear();
    const reads = ["a", "b", "c"].map(id => {
      const tool = h.tool("read", id, { path: `/tmp/${id}` });
      tool.updateResult({ content: [{ type: "text", text: id }], isError: false }); return tool;
    });
    h.chat.addChild(reads[0]!); h.chat.addChild(reads[1]!); h.render();
    h.targets()[0]!.setExpanded(true); h.render();
    h.chat.children.splice(1, 1, new Text("BOUNDARY", 0, 0));
    expect(h.render()).toContain("BOUNDARY"); expect(h.targets().some(target => target.kind === "group")).toBe(false);
    h.chat.children[1] = reads[2]!; h.render();
    expect(h.targets()[0]!.kind).toBe("group");
    h.chat.children.reverse(); h.render();
    const members = h.targets().filter(target => target.kind === "tool");
    expect(members[0]!.label).toContain("/tmp/c"); expect(members[1]!.label).toContain("/tmp/a");
    const group = h.targets()[0], replacement = [...h.chat.children]; h.chat.children = replacement;
    h.render(); expect(h.chat.children).toBe(replacement); expect(h.targets()[0]).toBe(group);
  });

  it("regroups unchanged slots after native assistant transparency and argument classification change", () => {
    const h = fixture(); h.chat.clear();
    const a = h.tool("read", "a", { path: "/tmp/a" }), b = h.tool("read", "b", { path: "/tmp/b" });
    for (const tool of [a, b]) tool.updateResult({ content: [{ type: "text", text: "read" }], isError: false });
    const bridge = new AssistantMessageComponent();
    const declaration = { type: "toolCall", id: "b", name: "read", arguments: { path: "/tmp/b" } };
    bridge.updateContent({ role: "assistant", content: [declaration], stopReason: "toolUse" } as never, true);
    h.chat.addChild(a); h.chat.addChild(bridge); h.chat.addChild(b); h.render();
    expect(h.targets().some(target => target.kind === "group")).toBe(false);
    bridge.updateContent({ role: "assistant", content: [declaration], stopReason: "toolUse" } as never, false);
    h.render(); expect(h.targets()[0]!.kind).toBe("group");
    bridge.updateContent({ role: "assistant", content: [{ type: "text", text: "EXPLANATION" }, declaration], stopReason: "toolUse" } as never, false);
    expect(h.render()).toContain("EXPLANATION"); expect(h.targets().some(target => target.kind === "group")).toBe(false);

    h.chat.clear();
    const parameters = { type: "object", properties: { input: { type: "string" } }, required: ["input"] };
    const patch = (id: string) => new ToolExecutionComponent("apply_patch", id, { input: "partial" }, {},
      { name: "apply_patch", label: "Patch", description: "fixture", parameters, execute: async () => ({ content: [], details: {} }) },
      { requestRender: h.requests } as never, "/tmp");
    const first = patch("first"), second = patch("second");
    h.chat.addChild(first); h.chat.addChild(second); h.render();
    expect(h.targets().some(target => target.kind === "group")).toBe(false);
    first.updateArgs({ input: "*** Begin Patch\n*** Add File: first.txt\n+one\n*** End Patch" });
    second.updateArgs({ input: "*** Begin Patch\n*** Add File: second.txt\n+two\n*** End Patch" });
    h.render(); expect(h.targets()[0]!.kind).toBe("group");
  });

  it("projects separate call/activity/output targets using actual renderers and native output display", () => {
    const h = fixture({ expanded: true }); h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    h.parent.updateResult(result([call("p/1")], "SCRIPT-OUTPUT"), false);
    const visible = h.render();
    expect(visible).toContain("Ran code"); expect(visible).toContain("Call");
    expect(visible).toContain("CHILD-RESULT"); expect(visible).toContain("SCRIPT-OUTPUT");
    expect(visible).not.toContain("ORIGINAL-AGGREGATE"); expect(visible).not.toContain("USER-CODE");
    expect(h.targets().map(target => target.label)).toHaveLength(4);
    expect(h.genericResult).not.toHaveBeenCalled();
    expect(h.resolveOutput.mock.calls.map(([name]) => name)).not.toContain("pi-transcript-ui:codemode-output");
    h.parent.setExpanded(false);
    expect(h.render()).not.toContain("CHILD-RESULT"); expect(h.render()).not.toContain("SCRIPT-OUTPUT");
    h.parent.setExpanded(true);
    expect(h.render()).toContain("CHILD-RESULT"); expect(h.render()).toContain("SCRIPT-OUTPUT");
  });

  it("keeps source state and current source component when switching layout", () => {
    const h = fixture({ expanded: true }); h.start();
    h.parent.updateResult(result([], "SCRIPT-OUTPUT"), false); h.render();
    const originalSlot = Reflect.get(h.parent, "callRendererComponent") as Container;
    originalSlot.handleMouse({ type: "click", button: "left", x: 0, y: 0, width: 100, height: 1,
      screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false });
    expect(Reflect.get(h.parent, "callRendererComponent")).not.toBe(originalSlot);
    expect(h.render()).toContain("USER-CODE");
    h.layout("native"); expect(h.render()).toContain("ORIGINAL-AGGREGATE");
    h.layout("items"); const items = h.render();
    expect(items).toContain("USER-CODE"); expect(items).toContain("SCRIPT-OUTPUT"); expect(items).not.toContain("ORIGINAL-AGGREGATE");
  });

  it("folds settled metadata-only groups and never counts unavailable output as zero", () => {
    const h = fixture(); h.start();
    h.parent.updateResult(result([call("p/1"), call("p/2")]), false);
    h.render(); const targets = h.targets();
    const group = targets.find(target => target.kind === "group")!;
    expect(group.label).toContain("2 calls"); expect(group.expanded).toBe(false);
    expect(group.label).not.toContain("0 lines");
    group.setExpanded(true); h.render(); expect(h.targets()).toHaveLength(5);
    group.setExpanded(false); h.render(); expect(h.targets()).toHaveLength(3);
  });

  it("uses canonical actions for recorded native tools and declared read/patch aliases without manufacturing live bodies", () => {
    const h = fixture({layout: "flat", expanded: true});
    h.definitions.set("view_file", {...h.definitions.get("read")!, name: "view_file"});
    h.definitions.set("change_file", {...h.definitions.get("read")!, name: "change_file", parameters: {
      type: "object", properties: {input: {type: "string"}}, required: ["input"],
    }});
    const names = ["exec_command", "apply_patch", "codemode", "write_stdin", "view_file", "change_file"];
    h.parent.updateResult(result(names.map((name, index) => ({...call(`saved/${index}`, name), args: "OPAQUE PREVIEW"}))), false);
    h.render();
    const labels = h.targets().filter(target => target.label.includes("OPAQUE PREVIEW")).map(target => target.label);
    for (const action of ["Ran", "Patched", "Ran code", "Used shell session", "Read"]) {
      expect(labels.some(label => label.trimStart().startsWith(`▾ ${action} `))).toBe(true);
    }
    expect(labels.filter(label => label.includes("Patched"))).toHaveLength(2);
    expect(h.render()).toContain("Detailed result unavailable");
    expect(h.genericResult).not.toHaveBeenCalled();
  });

  it.each([false, true])("initializes local groups from native bulk expansion without reopening a user fold: %s", expanded => {
    const h = fixture({ expanded }); h.start();
    h.parent.updateResult(result([call("p/1"), call("p/2")]), false); h.render();
    const group = h.targets().find(target => target.kind === "group")!;
    expect(group.expanded).toBe(expanded);
    group.setExpanded(false); h.render();
    h.layout("native"); h.render(); h.layout("items"); h.render();
    expect(h.targets().find(target => target.kind === "group")!.expanded).toBe(false);
  });

  it("does not create live hosts for placeholders, early IDs or missing end evidence", () => {
    vi.useFakeTimers();
    const h = fixture({ expanded: true }); h.start(); h.nestedStart("p/1", "bash", { command: "printf one" });
    h.parent.updateResult(result([call("p/1", "bash", "running")]), true);
    expect(h.render()).toContain("Detailed result unavailable");
    expect(vi.getTimerCount()).toBe(0);
    h.nestedEnd("p/1", "bash", "FINISHED-SHELL");
    expect(h.render()).toContain("FINISHED-SHELL");
    expect(vi.getTimerCount()).toBe(0);
    h.chat.clear(); const before = h.requests.mock.calls.length;
    vi.advanceTimersByTime(5000); expect(h.requests).toHaveBeenCalledTimes(before);
  });

  it("detects a native running-shell timer but never starts one for an unawaited child", () => {
    vi.useFakeTimers();
    const h = fixture({ expanded: true });
    const native = new ToolExecutionComponent("bash", "control", { command: "printf control" }, {},
      h.mode.getRegisteredToolDefinition("bash"), { requestRender: h.requests } as never, "/tmp");
    native.markExecutionStarted(); native.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
    expect(vi.getTimerCount()).toBe(1);
    native.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
    expect(vi.getTimerCount()).toBe(0);

    h.start(); h.nestedStart("p/1", "bash", { command: "printf detached" });
    h.parent.updateResult(result([call("p/?", "bash", "cancelled")]), false);
    h.nestedEnd("p/1", "bash", "LATE-RESULT");
    expect(h.render()).toContain("Detailed result unavailable");
    expect(h.render()).not.toContain("LATE-RESULT");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses body association for a completed parent ID from native history", () => {
    const h = fixture({ expanded: true, oldId: "p" }); h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    h.parent.updateResult(result([call("p/1")]), false);
    const visible = h.render();
    expect(visible).not.toContain("CHILD-RESULT"); expect(visible).toContain("Detailed result unavailable");
  });

  it.each(["before start", "after start", "after a child result"])("keeps duplicate partial parents metadata-only when the second arrives %s", timing => {
    let invalidate: (() => void) | undefined;
    const childResult = vi.fn<NonNullable<ToolRenderers["renderResult"]>>((_value, _options, _theme, ctx) => {
      invalidate = ctx.invalidate; return new Text("AMBIGUOUS-BODY", 0, 0);
    });
    const h = fixture({ expanded: true, child: { renderResult: childResult } });
    const other = new ToolExecutionComponent("codemode", "p", { code: "OTHER-CODE" }, {},
      h.mode.getRegisteredToolDefinition("codemode"), { requestRender: h.requests } as never, "/tmp");
    other.setExpanded(true);
    if (timing === "before start") h.chat.addChild(other);
    h.start();
    if (timing === "after a child result") {
      h.nestedStart("p/1"); h.nestedEnd("p/1");
      h.parent.updateResult(result([call("p/1")]), true);
      expect(h.render()).toContain("AMBIGUOUS-BODY");
    }
    const bodiesBefore = childResult.mock.calls.length;
    if (timing !== "before start") h.chat.addChild(other);
    if (timing !== "after a child result") { h.nestedStart("p/1"); h.nestedEnd("p/1"); }
    h.parent.updateResult(result([call("p/1")]), false);
    other.updateResult(result([call("p/1")]), false);

    const visible = h.render();
    expect(h.targets()).toHaveLength(6);
    expect(visible).toContain("Detailed result unavailable");
    expect(visible).not.toContain("AMBIGUOUS-BODY");
    expect(childResult).toHaveBeenCalledTimes(bodiesBefore);
    const requestsBefore = h.requests.mock.calls.length;
    invalidate?.(); expect(h.requests).toHaveBeenCalledTimes(requestsBefore);
  });

  it("drops unknown-parent late events in a fresh runtime without retaining them for a later parent", () => {
    const h = fixture({ expanded: true });
    h.nestedStart("p/1"); h.nestedEnd("p/1", "read", "STALE-PAYLOAD");
    h.start();
    h.nestedEnd("p/1", "read", "LATE-END-WITHOUT-START");
    h.nestedStart("p/2"); h.nestedEnd("p/2", "read", "CURRENT-PAYLOAD");
    h.parent.updateResult(result([call("p/1"), call("p/2")]), false);

    const visible = h.render();
    expect(visible).toContain("Detailed result unavailable"); expect(visible).toContain("CURRENT-PAYLOAD");
    expect(visible).not.toContain("STALE-PAYLOAD"); expect(visible).not.toContain("LATE-END-WITHOUT-START");
  });

  it.each(["items", "flat"] as const)("marks unavailable %s presentation as original, without treating it as an execution failure", layout => {
    const h = fixture({ expanded: true, codemodeRegistered: false, layout });
    h.parent.updateResult(result([call("p/1")], "HISTORY-OUTPUT"), false);
    expect(h.render()).toContain(" (original)"); expect(h.render()).toContain("HISTORY-OUTPUT");
    expect(h.render()).not.toContain("— error"); expect(h.targets()).toHaveLength(1);
    expect(h.chat.children).toContain(h.parent);

    h.layout("native");
    expect(h.render()).not.toContain(" (original)"); expect(h.render()).toContain("HISTORY-OUTPUT");
  });

  it("shows completed history as items without adopting another live execution's evidence", () => {
    const h = fixture({ expanded: true }); h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1", "read", "LIVE-PAYLOAD");
    const restored = new ToolExecutionComponent("codemode", "p", { code: "HISTORY-CODE" }, {},
      h.mode.getRegisteredToolDefinition("codemode"), { requestRender: h.requests } as never, "/tmp");
    restored.updateResult(result([call("p/1")], "HISTORY-OUTPUT"), false); restored.setExpanded(true);
    h.chat.addChild(restored);
    const visible = h.render();
    expect(visible).toContain("Ran code"); expect(visible).toContain("Call"); expect(visible).toContain("HISTORY-OUTPUT");
    expect(visible).toContain("Detailed result unavailable"); expect(visible).not.toContain("LIVE-PAYLOAD");

    h.parent.updateResult(result([call("p/1")]), false);
    expect(h.render()).toContain("LIVE-PAYLOAD");
  });

  it("keeps source counts, outcome and time aligned with the sealed item snapshot", () => {
    const h = fixture({ expanded: true }); h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    const activity = call("p/1"), final = { ...result([activity], "FINAL-OUTPUT"), durationMs: 1200 };
    h.parent.updateResult(final, false);
    h.render();
    const before = h.targets()[0]!.label;
    activity.name = "write";
    h.parent.invalidate(); h.render(); expect(h.targets()[0]!.label).toBe(before);
    h.parent.updateResult({ ...result([call("p/2", "write", "running")], "LATE-PARTIAL"), isError: true }, true);
    const after = h.render();
    expect(h.targets()[0]!.label).toBe(before);
    expect(after).toContain("CHILD-RESULT"); expect(after).toContain("FINAL-OUTPUT"); expect(after).not.toContain("LATE-PARTIAL");
  });

  it("retires a rich body omitted from the final snapshot, but preserves it during a temporary partial shrink", () => {
    let invalidate: (() => void) | undefined;
    const h = fixture({ expanded: true, child: { renderResult(_value, _options, _theme, ctx) {
      invalidate = ctx.invalidate; return new Text("RICH", 0, 0);
    } } });
    h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    h.parent.updateResult(result([call("p/1")]), true); expect(h.render()).toContain("RICH");
    const target = h.targets()[2]!;
    h.parent.updateResult(result([]), true); h.render();
    h.parent.updateResult(result([call("p/1")]), true); h.render(); expect(h.targets()[2]).toBe(target);
    h.parent.updateResult(result([]), false); h.render();
    const before = h.requests.mock.calls.length;
    invalidate!(); expect(h.requests).toHaveBeenCalledTimes(before);
    expect(h.targets()).toHaveLength(2);
  });

  it("uses the original parent rather than stale items after malformed replacement metadata", () => {
    const h = fixture({ expanded: true }); h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    h.parent.updateResult(result([call("p/1")]), true); h.render(); expect(h.targets()).toHaveLength(3);
    const facts = h.runtime.bind(h.parent as unknown as NativeToolComponent)!.facts, matched = facts.matched(facts.records![0]!)!;
    expect(h.runtime.input(matched)?.result.content).toBeDefined();
    h.parent.updateResult({ content: [{ type: "text", text: "CURRENT-ORIGINAL" }], details: {}, isError: false }, true);
    expect(h.render()).toContain("CURRENT-ORIGINAL"); expect(h.targets()).toHaveLength(1);
    expect(h.chat.children).toContain(h.parent);
    expect(h.runtime.input(matched)).toBeUndefined();
  });

  it("restores the actual parent slot when a dynamic decoration failure releases its source wrapper", () => {
    const h = fixture({ expanded: true }); h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    h.parent.updateResult(result([call("p/1")]), true); h.render();
    const facts = h.runtime.bind(h.parent as unknown as NativeToolComponent)!.facts, proof = facts.matched(facts.records![0]!)!;
    expect(h.runtime.input(proof)).toBeDefined();
    h.requests.mockImplementation(() => { throw new Error("redraw unavailable"); });
    expect(() => h.parent.updateResult(result([call("p/1")], "LATEST-NATIVE"), false)).not.toThrow();
    h.requests.mockImplementation(() => {});
    expect(h.render()).toContain("LATEST-NATIVE");
    expect(h.chat.children).toContain(h.parent);
    expect(h.targets()).toHaveLength(0);
    expect(h.runtime.input(proof)).toBeUndefined();
  });

  it("retains both child return and equal script print, without duplicate painting of the original parent", () => {
    const h = fixture({ expanded: true }); h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1", "read", "SHARED-VALUE");
    h.parent.updateResult(result([call("p/1")], "SHARED-VALUE"), false);
    expect(h.render().split("SHARED-VALUE")).toHaveLength(3);
    expect(h.render()).not.toContain("ORIGINAL-AGGREGATE");
  });

  it("falls back atomically to the actual original parent on a late body render failure", () => {
    const h = fixture({ expanded: true, child: { renderShell: "self", renderCall: () => ({ render() { throw new Error("late render"); }, invalidate() {} }) } });
    h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    h.parent.updateResult(result([call("p/1")], "SCRIPT-OUTPUT"), false);
    const visible = h.render();
    expect(visible).toContain("ORIGINAL-AGGREGATE"); expect(visible.split("SCRIPT-OUTPUT")).toHaveLength(2);
    expect(h.chat.children).toContain(h.parent); expect(h.targets()).toHaveLength(1);
    expect(Reflect.get(h.parent, "rendererState").show).toBe(false);
  });

  it("does not retry a faulty body every frame and permits explicit original/items retry", () => {
    let fail = true;
    const render = vi.fn(() => { if (fail) throw new Error("controlled view failure"); return ["RECOVERED-BODY"]; });
    const h = fixture({ expanded: true, child: { renderCall: () => ({ render, invalidate() {} }) } });
    h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    h.parent.updateResult(result([call("p/1")]), false);
    expect(h.render()).toContain("ORIGINAL-AGGREGATE");
    const attempts = render.mock.calls.length;
    fail = false;
    expect(h.render()).toContain("ORIGINAL-AGGREGATE"); expect(render).toHaveBeenCalledTimes(attempts);
    h.layout("native"); h.render(); h.layout("items");
    expect(h.render()).toContain("RECOVERED-BODY");
  });

  it("preserves direct native array insertions and current padding on original restoration", () => {
    const h = fixture({ expanded: true }); h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    h.parent.updateResult(result([call("p/1")], "SCRIPT-OUTPUT"), false); h.render();
    const list = h.chat.children, later = new Text("LATER-NATIVE", 0, 0);
    h.chat.children.splice(0, 0, later);
    h.padding(3); expect(h.render()).toContain("LATER-NATIVE"); expect(h.chat.children).toBe(list);
    h.layout("native"); h.render(); expect(h.chat.children).toContain(h.parent);
    expect(Reflect.get(h.parent, "outputPad")).toBe(3);
    expect(h.chat.children[0]).toBe(later);
  });

  it.each([false, true])("preserves latest native collections and removal by actual parent (accessors: %s)", accessorChildren => {
    const h = fixture({ expanded: true, accessorChildren }); h.start();
    h.parent.updateResult(result([], "SCRIPT-OUTPUT"), false); h.render();
    const later = new Text("LATER-NATIVE", 0, 0), projected = h.chat.children[0]!;
    const latest = [later, projected]; h.chat.children = latest;
    expect(h.render()).toContain("SCRIPT-OUTPUT"); expect(h.chat.children).toBe(latest);
    h.chat.removeChild(h.parent);
    expect(h.render()).toContain("LATER-NATIVE"); expect(h.render()).not.toContain("SCRIPT-OUTPUT");
    expect(h.chat.children).toEqual([later]); expect(h.targets()).toHaveLength(0);
    h.layout("native"); expect(h.chat.children).toEqual([later]);
  });

  it("falls back to the surviving source target from a selected local group member", () => {
    const h = fixture({ expanded: true }); h.start();
    h.parent.updateResult(result([call("p/1"), call("p/2")]), false);
    h.render(); h.targets().find(target => target.kind === "group")!.setExpanded(true); h.render();
    const navigation = new ToolNavigation(h.targets), member = navigation.view().selected!;
    expect(member.parent?.kind).toBe("group");
    h.runtime.shutdown(); h.render();
    expect(navigation.view().selected).toBe(h.targets()[0]);
  });

  it("retains the native call slot of a rich nested renderer, not just renderResult", () => {
    const h = fixture({ expanded: true, child: { renderShell: "self", renderCall: () => new Text("REQUEST-DIFF", 0, 0),
      renderResult: () => new Text("APPLIED-RECEIPT", 0, 0) } });
    h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1"); h.parent.updateResult(result([call("p/1")]), false);
    const rendered = h.render();
    expect(rendered).toContain("REQUEST-DIFF"); expect(rendered).toContain("APPLIED-RECEIPT");
  });

  it("keeps actual-call shared state and separate previous components through output formatting and reflow", () => {
    const callStates: object[] = [], resultStates: object[] = [], callSlots: Component[] = [], resultSlots: Component[] = [];
    let invalidate: (() => void) | undefined;
    const h = fixture({expanded: true, child: {
      renderCall(_args, _theme, ctx) {
        callStates.push(ctx.state);
        const component = ctx.lastComponent instanceof Text ? ctx.lastComponent : new Text("", 0, 0);
        component.setText(ctx.state.applied ? "APPLIED CALL DIFF" : "PENDING CALL"); callSlots.push(component);
        return component;
      },
      renderResult(_value, _options, _theme, ctx) {
        resultStates.push(ctx.state); invalidate = ctx.invalidate;
        ctx.state.applied = true;
        const component = ctx.lastComponent instanceof Text ? ctx.lastComponent : new Text("APPLIED RECEIPT", 0, 0);
        resultSlots.push(component); return component;
      },
    }});
    h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    h.parent.updateResult(result([call("p/1")], '{"value":1}'), false);
    h.render(); h.render();
    expect(h.render()).toContain("APPLIED CALL DIFF"); expect(h.render()).toContain("APPLIED RECEIPT");
    expect(h.render().split("\n").map(line => line.trimEnd()).join("\n")).toContain('{\n  "value": 1\n}');
    const before = h.requests.mock.calls.length;
    invalidate!(); expect(h.requests.mock.calls.length).toBeGreaterThan(before);
    h.chat.render(40); h.padding(2); h.render();
    expect(new Set([...callStates, ...resultStates]).size).toBe(1);
    expect(new Set(callSlots).size).toBe(1); expect(new Set(resultSlots).size).toBe(1);
    expect(callSlots[0]).not.toBe(resultSlots[0]);
  });

  it("fences late renderer invalidation and public events after removal and session shutdown", () => {
    let invalidate: (() => void) | undefined;
    const h = fixture({ expanded: true, child: { renderResult(_value, _options, _theme, ctx) { invalidate = ctx.invalidate; return new Text("RICH", 0, 0); } } });
    h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1"); h.parent.updateResult(result([call("p/1")]), false); h.render();
    expect(invalidate).toBeDefined();
    h.chat.children.splice(0, 1); h.render();
    const before = h.requests.mock.calls.length;
    invalidate!(); expect(h.requests).toHaveBeenCalledTimes(before);
    h.runtime.shutdown(); h.nestedStart("p/9"); h.nestedEnd("p/9");
    expect(h.requests).toHaveBeenCalledTimes(before);
  });

  it("refreshes a body invalidated during rendering without replacing that frame's hit geometry", () => {
    let first = true;
    const clicked = vi.fn();
    const h = fixture({ expanded: true, child: { renderResult(_value, _options, _theme, ctx) {
      return { render() {
        if (first) { first = false; ctx.invalidate(); return ["OLD-FRAME"]; }
        return ["NEW-FRAME", "NEW-SECOND-LINE"];
      }, invalidate() {}, handleMouse: clicked };
    } } });
    h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1"); h.parent.updateResult(result([call("p/1")]), false);
    const firstFrame = h.render();
    expect(firstFrame).toContain("OLD-FRAME"); expect(firstFrame).not.toContain("NEW-SECOND-LINE");
    const scope = h.chat.children[0]!, target = h.targets()[2]!;
    const y = firstFrame.split("\n").findIndex(line => line.includes("OLD-FRAME"));
    expect(scope.handleMouse?.({ type: "click", button: "left", x: 0, y, width: 100, height: firstFrame.split("\n").length,
      screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false })).toEqual({ handled: true });
    expect(clicked).not.toHaveBeenCalled(); expect(target.expanded).toBe(true);
    const refreshed = h.render();
    expect(refreshed).toContain("NEW-FRAME"); expect(refreshed).toContain("NEW-SECOND-LINE");
    expect(refreshed).not.toContain("OLD-FRAME");
  });

  it("keeps native images and preferences beside formatted text without changing original blocks", () => {
    const before = getCapabilities(); setCapabilities({ ...before, images: "kitty" });
    try {
      const h = fixture({ expanded: true }); h.start();
      const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9kAAAAASUVORK5CYII=" };
      const native = { content: [header, {type: "text", text: '{"image":true}'}, image], details: { calls: [] }, isError: false };
      const beforeContent = structuredClone(native.content);
      h.parent.updateResult(native);
      expect(h.chat.render(100).filter(isImageLine)).toHaveLength(1);
      expect(h.render().split("\n").map(line => line.trimEnd()).join("\n")).toContain('{\n  "image": true\n}');
      h.showImages(false);
      expect(h.chat.render(100).filter(isImageLine)).toHaveLength(0);
      h.showImages(true);
      expect(h.chat.render(100).filter(isImageLine)).toHaveLength(1);
      expect(native.content).toEqual(beforeContent);
    } finally { setCapabilities(before); }
  });
});

const compositorSource = process.env["PI_ALT_COMPOSITOR_SOURCE"];
const toolViewsSource = process.env["PI_TOOL_VIEWS_SOURCE"];
it.skipIf(!toolViewsSource).each([true, false])("reconciles actual Tool Views child callbacks at final-source replacement (Tool Views first: %s)", async installFirst => {
  const {default: install} = await import(pathToFileURL(join(toolViewsSource!, "src/index.ts")).href) as {default(pi: ExtensionAPI): void};
  const root = await mkdtemp(join(tmpdir(), "transcript-tool-views-")), previous = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
  const history = SessionManager.inMemory(root), read = createReadTool(root);
  history.appendMessage({role: "system", content: "", timestamp: 0,
    toolsAdded: [{name: "read", description: read.description, parameters: read.parameters}]});
  const h = fixture({expanded: true, history, install, installFirst, cwd: root});
  try {
    const assistant = assistantCall("p");
    h.emit("message_start", {message: assistant}); history.appendMessage(assistant); h.emit("message_end", {message: assistant});
    h.start(); h.nestedStart("p/1", "read", {path: "src/pair.ts"}); h.nestedEnd("p/1", "read", "const pair = 1;");
    h.parent.updateResult(result([call("p/1")], '{"pair":true}'), false);
    expect(h.render()).toContain("Read src/pair.ts"); expect(h.render()).toContain("1 const pair = 1;");
    h.emit("tool_execution_end", {toolCallId: "p", toolName: "codemode", isError: false, result: result([call("p/1")])});
    const message = {...savedParent([call("p/1")], {complete: true,
      calls: [{id: "p/1", name: "read", arguments: {path: "src/pair.ts"}, status: "ok"}]}),
      content: [header, {type: "text" as const, text: '{"pair":true}'}]};
    history.appendMessage(message); h.emit("message_end", {message}); h.emit("turn_end", {});
    expect(h.render()).toContain("Read src/pair.ts"); expect(h.render()).toContain("1 const pair = 1;");
    const leaf = history.getLeafId();

    message.content = [header, {type: "text", text: "CURRENT-PARENT"}];
    h.emit("message_end", {message}); h.emit("turn_end", {});
    const refreshed = h.render();
    expect(history.getLeafId()).toBe(leaf); expect(refreshed).toContain("CURRENT-PARENT");
    expect(refreshed).toContain("1 const pair = 1;");
    expect(refreshed).not.toContain('"pair": true');

    message.details.calls = []; message.nestedCalls.calls = []; message.content = [header, {type: "text", text: "WITHDRAWN"}];
    h.emit("message_end", {message}); h.emit("turn_end", {});
    expect(h.render()).toContain("WITHDRAWN"); expect(h.render()).not.toContain("const pair = 1;");
    expect(h.targets().some(target => target.label.includes("src/pair.ts"))).toBe(false);
    h.emit("agent_end", {});
    expect(h.render()).not.toContain("const pair = 1;");
  } finally {
    h.emit("session_shutdown", {});
    if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = previous;
    await rm(root, {recursive: true, force: true});
  }
});

it.skipIf(!toolViewsSource)("keeps actual Tool Views call renderers while output uses the native display path", async () => {
  const {default: install} = await import(pathToFileURL(join(toolViewsSource!, "src/index.ts")).href) as {default(pi: ExtensionAPI): void};
  let renderer: ToolRendererResolver | undefined;
  const shutdown: (() => void)[] = [];
  install({
    registerToolRenderer(value: ToolRendererResolver) { renderer = value; },
    registerCommand() {},
    on(event: string, callback: () => void) { if (event === "session_shutdown") shutdown.push(callback); return () => {}; },
  } as unknown as ExtensionAPI);
  cleanups.push(() => { for (const stop of shutdown) stop(); });
  expect(renderer).toBeDefined();
  const names: string[] = [];
  const h = fixture({expanded: true, renderer: (name, next) => { names.push(name); return renderer!(name, next); }});
  h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
  const native = result([call("p/1")], '{"value":1}'), before = structuredClone(native);
  h.parent.updateResult(native, false);
  const rendered = h.render().split("\n").map(line => line.trimEnd()).join("\n");
  expect(rendered).toContain("Call"); expect(rendered).toContain("Script output");
  expect(rendered).toContain('{\n  "value": 1\n}');
  expect(names).toContain("codemode"); expect(names).toContain("read");
  expect(names).not.toContain("pi-transcript-ui:codemode-output");
  expect(rendered).not.toContain("pi-transcript-ui:codemode-output");
  expect(native).toEqual(before);
});

it.skipIf(!compositorSource)("preserves independent codemode controls and appearance changes through the reference compositor cache", async () => {
  const load = (path: string) => import(pathToFileURL(join(compositorSource!, "src", path)).href);
  const [{ ChildRenderCache }, { ComponentRangeMapper }, { CollapseController }] = await Promise.all([
    load("terminal/render-cache.ts"), load("terminal/range-mapper.ts"), load("collapse/collapse-controller.ts"),
  ]);
  const h = fixture({ expanded: true }); h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
  h.parent.updateResult(result([call("p/1")], "SCRIPT-OUTPUT"), false);
  const cache = new ChildRenderCache(), mapper = new ComponentRangeMapper(), collapse = new CollapseController();
  const render = () => cache.render(h.root.children, 100, collapse, mapper);
  expect(render().lines.join("\n")).toContain("CHILD-RESULT");
  const ranges = mapper.buildRanges(h.root.children, 100, 0, 500, 0) as {component: object; startLine: number; lineCount: number}[];
  const toolRows = ranges.filter(range => Reflect.get(range.component, "toolName") === "__codemode_activity__");
  expect(toolRows).toHaveLength(1);
  expect(collapse.toggleTool(toolRows[0]!.component, toolRows[0]!.startLine)).toBe(true);
  expect(render().lines.join("\n")).not.toContain("CHILD-RESULT");
  expect(render().lines.join("\n")).toContain("SCRIPT-OUTPUT");
  const sourceRange = ranges.find(range => Reflect.get(range.component, "toolName") === "__codemode_source__")!;
  expect(collapse.toggleTool(sourceRange.component, sourceRange.startLine)).toBe(true);
  expect(render().lines.join("\n")).not.toContain("SOURCE CONTROL");
  expect(h.targets()[0]!.expanded).toBe(true);
  h.parent.setExpanded(false);
  expect(render().lines.join("\n")).not.toContain("SCRIPT-OUTPUT");
  h.parent.setExpanded(true);
  const reopened = render().lines.join("\n");
  expect(reopened).toContain("SCRIPT-OUTPUT");
  expect(reopened).not.toContain("CHILD-RESULT"); expect(reopened).not.toContain("SOURCE CONTROL");
  h.padding(3);
  expect(render().changed).toBe(true);
});

it.skipIf(!compositorSource)("refreshes formatted output height and independent hit ranges through the compositor cache", async () => {
  const load = (path: string) => import(pathToFileURL(join(compositorSource!, "src", path)).href);
  const [{ChildRenderCache}, {ComponentRangeMapper}, {CollapseController}] = await Promise.all([
    load("terminal/render-cache.ts"), load("terminal/range-mapper.ts"), load("collapse/collapse-controller.ts"),
  ]);
  const h = fixture({expanded: true});
  h.parent.updateResult(result([], '{"files":["a.ts","b.ts"],"count":2}'), false);
  const cache = new ChildRenderCache(), mapper = new ComponentRangeMapper(), collapse = new CollapseController();
  const render = (width = 100) => cache.render(h.root.children, width, collapse, mapper);
  const open = render();
  expect(open.lines.map((line: string) => stripTerminalSequences(line).trimEnd()).join("\n"))
    .toContain('{\n  "files": ["a.ts", "b.ts"],\n  "count": 2\n}');
  const ranges = mapper.buildRanges(h.root.children, 100, 0, 500, 0) as {component: object; startLine: number; lineCount: number}[];
  const output = ranges.find(range => Reflect.get(range.component, "toolName") === "__codemode_output__")!;
  expect(output.lineCount).toBeGreaterThan(4);
  expect(collapse.toggleTool(output.component, output.startLine)).toBe(true);
  const folded = render();
  expect(folded.changed).toBe(true); expect(folded.lines.length).toBeLessThan(open.lines.length);
  expect(folded.lines.join("\n")).not.toContain('"count": 2');
  expect(collapse.toggleTool(output.component, output.startLine)).toBe(true);
  expect(render().lines).toEqual(open.lines);
  expect(render(20).changed).toBe(true);
  expect(render(20).lines.every((line: string) => visibleWidth(line) <= 20)).toBe(true);
});

it.skipIf(!compositorSource)("refreshes compositor image output when native preferences change without a label change", async () => {
  const before = getCapabilities(); setCapabilities({ ...before, images: "kitty" });
  try {
    const load = (path: string) => import(pathToFileURL(join(compositorSource!, "src", path)).href);
    const [{ ChildRenderCache }, { CollapseController }, { ComponentRangeMapper }] = await Promise.all([
      load("terminal/render-cache.ts"), load("collapse/collapse-controller.ts"), load("terminal/range-mapper.ts"),
    ]);
    const h = fixture({ expanded: true }); h.start();
    const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9kAAAAASUVORK5CYII=" };
    h.parent.updateResult({ content: [header, image], details: { calls: [] }, isError: false });
    const cache = new ChildRenderCache(), collapse = new CollapseController(), mapper = new ComponentRangeMapper();
    const render = () => cache.render(h.root.children, 100, collapse, mapper);
    expect(render().lines.filter(isImageLine)).toHaveLength(1);
    const labels = h.targets().map(target => target.label);
    h.showImages(false); const hidden = render();
    expect(hidden.changed).toBe(true); expect(hidden.lines.filter(isImageLine)).toHaveLength(0);
    expect(h.targets().map(target => target.label)).toEqual(labels);
    h.showImages(true);
    expect(render().lines.filter(isImageLine)).toHaveLength(1);
  } finally { setCapabilities(before); }
});
