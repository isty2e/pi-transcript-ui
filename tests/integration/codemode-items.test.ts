import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode, AssistantMessageComponent, ToolExecutionComponent, createReadTool, createBashTool, createCodemodeExtension, initTheme,
  type ExtensionAPI, type ExtensionContext, type ToolDefinition, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Text, stripTerminalSequences, visibleWidth, getCapabilities, setCapabilities, type Component } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.useRealTimers(); });
const header = { type: "text" as const, text: "Script completed\nWall time 0.1 seconds\nOutput:\n" };
const call = (id: string, name = "read", status = "ok") => ({ id, name, status, args: '{"path":"preview' });
const result = (calls: unknown[], text?: string) => ({ content: [header, ...(text === undefined ? [] : [{ type: "text" as const, text }])], details: { calls }, isError: false });

function fixture(options: { expanded?: boolean; containerExpanded?: boolean; colored?: boolean; oldId?: string; child?: ToolRenderers; accessorChildren?: boolean; codemodeRegistered?: boolean;
  layout?: DisplayLimits["codemode"]; groupCodemode?: boolean; nativeCode?: boolean; output?: ToolRenderers } = {}) {
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
  const sessionManager = { getEntries: () => options.oldId ? [{ type: "message", message: { role: "toolResult", toolCallId: options.oldId } }] : [] };
  const api = {
    on(type: string, handler: (event: Record<string, unknown>) => void) { const list = handlers.get(type) ?? []; list.push(handler); handlers.set(type, list); },
    getAllTools: () => [...definitions.values()],
  } as unknown as ExtensionAPI;
  const runtime = new CodemodeRuntime(api, () => layout);
  const context = { mode: "tui", sessionManager } as unknown as ExtensionContext;
  runtime.start(context); runtime.setRoot(root);
  const genericResult = vi.fn((value: { content: { type: string; text?: string }[] }) => new Text(value.content.map(block => block.text ?? "").join("\n"), 0, 0));
  const mode = {
    ui: root, sessionManager, toolOutputExpanded: options.expanded ?? false,
    get outputPad() { return pad; },
    settingsManager: { getShowImages: () => showImages, getImageWidthCells: () => 60 },
    session: { getToolDefinition: (name: string) => definitions.get(name), extensionRunner: {
      resolveToolRenderers(name: string, base: () => ToolRenderers | undefined) {
        return name === "pi-transcript-ui:codemode-output" ? options.output ?? { renderResult: genericResult } : base();
      },
    } },
    getRegisteredToolDefinition(name: string): ToolRenderers | undefined {
      const lookup = Reflect.get(InteractiveMode.prototype, "getRegisteredToolDefinition") as (this: unknown, name: string) => ToolRenderers | undefined;
      return lookup.call(this, name);
    },
  };
  const definition = mode.getRegisteredToolDefinition("codemode");
  const presentation = new CodemodePresentation(runtime);
  const attach = () => attachTranscriptPresentation(root, {
    getTheme: () => options.colored ? theme : ({ bold: (s: string) => s, fg: (_kind, s: string) => s }), requestRender: requests,
    displayLimits: { ...defaultSettings().display, codemode: layout }, codemode: presentation,
    ...(options.groupCodemode ? { rules: { codemode: "read" as const } } : {}),
    resolveParameters: name => definitions.get(name)?.parameters,
  });
  let detach = attach();
  const parent = new ToolExecutionComponent("codemode", "p", { code: "USER-CODE" }, { outputPad: pad }, definition, { requestRender: requests } as never, "/tmp");
  accessorChildren(parent);
  // Most cases inspect children of an already opened container; item defaults remain native.
  parent.setExpanded(options.containerExpanded ?? true); chat.addChild(parent);
  const emit = (type: string, event: Record<string, unknown>) => { for (const handler of handlers.get(type) ?? []) handler(event); };
  const start = () => emit("tool_execution_start", { toolCallId: "p", toolName: "codemode", args: { code: "USER-CODE" } });
  const nestedStart = (id: string, name = "read", args: unknown = { path: "/tmp/file.ts" }) =>
    emit("tool_execution_start", { toolCallId: id, parentToolCallId: "p", toolName: name, args });
  const nestedEnd = (id: string, name = "read", text = "CHILD-RESULT") => emit("tool_execution_end", {
    toolCallId: id, parentToolCallId: "p", toolName: name, result: { content: [{ type: "text", text }] }, isError: false, durationMs: 3,
  });
  const render = () => chat.render(100).map(stripTerminalSequences).join("\n");
  cleanups.push(() => { detach(); presentation.dispose(); runtime.shutdown(); });
  return { root, chat, parent, runtime, presentation, requests, emit, start, nestedStart, nestedEnd, render, mode, genericResult, definitions,
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
    members[0]!.setExpanded(true); h.render();
    expect(h.genericResult.mock.calls.at(-1)![0].content).toEqual([{type: "text", text: "A"}]);
    expect(h.genericResult.mock.calls.every(([value]) => value.content.every(block => block.text === "A"))).toBe(true);
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
    members[1]!.setExpanded(true); h.render();
    expect(h.genericResult.mock.calls.at(-1)![0].content).toEqual([{type: "text", text: "B"}]);
    expect(Reflect.get(h.parent, "result").content[1].text).toBe("==> text 1/2 <==\nA\n==> text 2/2 <==\nB");

    const malformed = fixture();
    const original = "==> text 1/3 <==\nA\n==> text 3/3 <==\nC";
    malformed.parent.updateResult(result([], original), false); malformed.render();
    expect(malformed.targets().at(-1)!.label).toBe("  ▸ Script output");
    malformed.targets().at(-1)!.setExpanded(true); malformed.render();
    expect(malformed.genericResult.mock.calls.at(-1)![0].content).toEqual([{type: "text", text: original}]);
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
    members[0]!.setExpanded(true); h.render();
    expect(h.genericResult.mock.calls.at(-1)![0].content).toEqual([{type: "text", text: payload}]);
  });

  it("can disclose an empty formatted section without painting its numbered header", () => {
    const h = fixture({layout: "flat"});
    h.parent.updateResult(result([], "==> text 1/2 <==\nA\n==> text 2/2 <=="), false);
    h.render(); h.targets().at(-1)!.setExpanded(true); h.render();
    const empty = h.targets().at(-1)!;
    expect(empty.label.trim()).toBe("▸ Output 2/2");
    empty.setExpanded(true);
    expect(() => h.render()).not.toThrow();
    expect(h.genericResult.mock.calls.at(-1)![0].content).toEqual([]);
  });

  it("applies native bulk defaults and image/padding settings to lazy output members", async () => {
    const h = fixture({nativeCode: true, expanded: true, output: {
      renderResult(_value, _options, _theme, ctx) { return new Text(`CTX:${ctx.outputPad}:${ctx.showImages}`, 0, 0); },
    }});
    h.padding(2); h.showImages(false);
    await h.run("text('A'); text('B');"); h.render();
    expect(h.targets().every(target => target.expanded)).toBe(true);
    const output = h.targets().find(target => target.label.includes("Script output"))!;
    const members = h.targets().filter(target => target.parent === output);
    expect(members).toHaveLength(2);
    expect(h.render().split("\n").filter(line => line.trim() === "CTX:2:false")).toHaveLength(2);
    const scope = h.chat.children[0] as Component & {setExpanded(value: boolean): void};
    scope.setExpanded(false); h.render(); expect(h.targets()).toHaveLength(1);
    scope.setExpanded(true); h.render(); expect(h.targets().every(target => target.expanded)).toBe(true);
    h.padding(0); h.showImages(true); h.render();
    expect(h.render().split("\n").filter(line => line.trim() === "CTX:0:true")).toHaveLength(2);
  });

  it("preserves renderer-local controls per output member and fences callbacks after removal", async () => {
    const invalidations: (() => void)[] = [];
    const h = fixture({nativeCode: true, output: {renderShell: "self",
      renderResult(value, _options, _theme, ctx) {
        invalidations.push(ctx.invalidate);
        const payload = value.content.filter(block => block.type === "text").map(block => block.text).join("");
        return new MouseRegion(new Text(`${payload} CONTROL ${ctx.state.detail ? "ON" : "OFF"}`, 0, 0), event => {
          if (event.type !== "click") return undefined;
          ctx.state.detail = !ctx.state.detail; ctx.invalidate(); return {handled: true};
        });
      },
    }});
    await h.run("text('A'); text('B');"); h.render();
    const parent = h.targets()[0]!, output = h.targets().at(-1)!;
    output.setExpanded(true); h.render();
    const members = h.targets().filter(target => target.parent === output);
    for (const member of members) member.setExpanded(true);
    h.render();
    const component = members[0] as unknown as Component;
    const lines = component.render(100).map(stripTerminalSequences), y = lines.findIndex(line => line.includes("A CONTROL OFF"));
    expect(y).toBeGreaterThan(0);
    component.handleMouse?.({type: "click", button: "left", x: 0, y, width: 100, height: lines.length,
      screenX: 0, screenY: y, shift: false, alt: false, ctrl: false});
    expect(h.render()).toContain("A CONTROL ON"); expect(h.render()).toContain("B CONTROL OFF");
    parent.setExpanded(false); h.render(); parent.setExpanded(true);
    expect(h.render()).toContain("A CONTROL ON"); expect(h.render()).toContain("B CONTROL OFF");
    const stale = invalidations.at(-1)!;
    h.chat.children = []; h.render();
    const before = h.requests.mock.calls.length;
    stale();
    expect(h.requests).toHaveBeenCalledTimes(before);
    expect(h.targets()).toEqual([]);
  });

  it("keeps native-only output intact and can use formatted regions when later switched to items", async () => {
    const h = fixture({nativeCode: true, layout: "native"});
    await h.run("text('A'); text('B');");
    expect(h.render()).toContain("ORIGINAL-AGGREGATE");
    expect(h.genericResult).not.toHaveBeenCalled();
    h.layout("items"); h.render();
    expect(h.targets().at(-1)!.label).toContain("2 sections");
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
    const preferences: {pad: number; images: boolean}[] = [];
    const h = fixture({nativeCode: true, expanded: true, output: {
      renderResult(_value, _options, _theme, ctx) {
        preferences.push({pad: ctx.outputPad, images: ctx.showImages}); return new Text("BODY", 0, 0);
      },
    }});
    await h.run("text('A'); text('B');"); h.render();
    const before = preferences.length;
    h.runtime.setRoot(new Container());
    expect(() => h.padding(3)).not.toThrow();
    expect(preferences).toHaveLength(before);
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
    expect(opened).toContain("▸ Source");
    expect(opened).toContain("▸ Script output");
    expect(h.targets()).toHaveLength(4);
    expect(h.targets().slice(1).every(target => !target.expanded)).toBe(true);
    expect(opened).not.toMatch(/SOURCE CONTROL|CHILD-RESULT|SCRIPT-OUTPUT/);
  });

  it("keeps Source, native code controls and sibling disclosure independent through parent folding", () => {
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

  it("projects separate source/activity/output targets using actual native bodies and generic result dispatch", () => {
    const h = fixture({ expanded: true }); h.start(); h.nestedStart("p/1"); h.nestedEnd("p/1");
    h.parent.updateResult(result([call("p/1")], "SCRIPT-OUTPUT"), false);
    const visible = h.render();
    expect(visible).toContain("Ran code"); expect(visible).toContain("Source");
    expect(visible).toContain("CHILD-RESULT"); expect(visible).toContain("SCRIPT-OUTPUT");
    expect(visible).not.toContain("ORIGINAL-AGGREGATE"); expect(visible).not.toContain("USER-CODE");
    expect(h.targets().map(target => target.label)).toHaveLength(4);
    expect(h.genericResult).toHaveBeenCalled();
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
    expect(visible).toContain("Ran code"); expect(visible).toContain("Source"); expect(visible).toContain("HISTORY-OUTPUT");
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

  it("keeps native image rendering outside a text-only generic result renderer", () => {
    const before = getCapabilities(); setCapabilities({ ...before, images: "kitty" });
    try {
      const h = fixture({ expanded: true }); h.start();
      const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9kAAAAASUVORK5CYII=" };
      h.parent.updateResult({ content: [header, image], details: { calls: [] }, isError: false });
      expect(h.chat.render(100).filter(isImageLine)).toHaveLength(1);
      h.showImages(false);
      expect(h.chat.render(100).filter(isImageLine)).toHaveLength(0);
      h.showImages(true);
      expect(h.chat.render(100).filter(isImageLine)).toHaveLength(1);
    } finally { setCapabilities(before); }
  });
});

const compositorSource = process.env["PI_ALT_COMPOSITOR_SOURCE"];
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
