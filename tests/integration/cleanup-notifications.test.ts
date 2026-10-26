import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type Component } from "@earendil-works/pi-tui";
import { initTheme, InteractiveMode, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import transcriptUi from "../../src/index.js";
import { restorationFault } from "../fixtures/native-children.js";

async function harness(options: { unsupported?: boolean; rootFailure?: Error; renderFailure?: Error } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "transcript-cleanup-"));
  const settingsPath = join(directory, "settings.json");
  vi.stubEnv("PI_TRANSCRIPT_UI_SETTINGS", settingsPath);
  initTheme();
  const root = new Container(), chat = new Container(); root.addChild(chat);
  const ui = {
    theme: { bold: (text: string) => text, fg: (_style: string, text: string) => text },
    notify: vi.fn((_message: string, _level: string) => {}),
    select: vi.fn(), input: vi.fn(), editor: vi.fn(), custom: vi.fn(),
    setWidget: vi.fn((_key: string, factory: ((tui: unknown) => Component) | undefined) => {
      if (!factory) return;
      const host = { requestRender() { if (options.renderFailure) throw options.renderFailure; } };
      if (options.rootFailure) Object.defineProperty(host, "children", { get() {
        if (options.rootFailure) throw options.rootFailure;
        return root.children;
      } });
      else if (!options.unsupported) Object.assign(host, { children: root.children });
      return factory(host);
    }),
  };
  const ctx = { mode: "tui", hasUI: true, ui, sessionManager: { getBranch: () => [], getEntries: () => [] } };
  type Handler = (event: unknown, context: typeof ctx) => unknown;
  const events = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, context: typeof ctx) => Promise<void> }>();
  const api = {
    on: (name: string, handler: unknown) => events.set(name, handler as Handler),
    registerCommand: (name: string, command: unknown) => commands.set(name, command as { handler: (args: string, context: typeof ctx) => Promise<void> }),
    registerShortcut: vi.fn(), getAllTools: () => [{ name: "read", parameters: {
      type: "object", properties: { path: { type: "string" } }, required: ["path"],
    } }], getActiveTools: () => ["read"], appendEntry: vi.fn(),
  };
  transcriptUi(api as never);
  const emit = (name: string, event: unknown = {}) => events.get(name)!(event, ctx);
  await emit("session_start");
  const makeTool = (id: string) => new ToolExecutionComponent("fixture", id, {}, {}, undefined, { requestRender() {} } as never, directory);
  return { chat, ui, ctx, emit, commands, settingsPath, makeTool, api,
    async dispose() {
      try { emit("session_shutdown"); }
      finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
    } };
}

it("keeps unsupported hosts native and inactive without disabling later non-interactive intent recording", async () => {
  const lookup = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "getRegisteredToolDefinition");
  const h = await harness({ unsupported: true });
  try {
    const native = h.makeTool("unchanged");
    native.updateResult({ content: [{ type: "text", text: "original result" }], isError: false });
    h.chat.addChild(native);
    const before = native.render(80);
    expect(h.ui.notify.mock.calls).toHaveLength(1);
    expect(h.ui.notify.mock.calls[0]?.[1]).toBe("info");
    expect(Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "getRegisteredToolDefinition")).toEqual(lookup);

    const factory = h.ui.setWidget.mock.calls[0]?.[1];
    factory?.({ requestRender() {} });
    factory?.({ requestRender() {} });
    expect(h.ui.notify.mock.calls).toHaveLength(1);
    expect(native.render(80)).toEqual(before);
    expect(Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "getRegisteredToolDefinition")).toEqual(lookup);
    const retiredEvent = { get parentToolCallId() { throw new Error("Retired collector read an event"); } };
    expect(() => h.emit("tool_execution_start", retiredEvent)).not.toThrow();
    expect(() => h.emit("tool_execution_end", retiredEvent)).not.toThrow();

    await h.commands.get("transcript-ui")!.handler("tools", h.ctx);
    expect(h.ui.custom).not.toHaveBeenCalled();
    expect(h.ui.notify.mock.calls).toHaveLength(2);
    expect(h.ui.notify.mock.calls[1]).toEqual(h.ui.notify.mock.calls[0]);
    const prompt = { systemPrompt: "original", systemPromptOptions: {
      sections: { pi_transcript_ui_intent: "previous guidance", unrelated: "keep" },
    } };
    h.emit("before_agent_start", prompt);
    expect(prompt.systemPromptOptions.sections).toEqual({ unrelated: "keep" });
    expect(h.emit("before_agent_start", { systemPrompt: "original" })).toBeUndefined();
    const payload = { tools: [{ type: "function", function: { name: "read", parameters: h.api.getAllTools()[0]!.parameters } }] };
    expect(h.emit("before_provider_request", { payload })).toEqual(payload);

    h.emit("session_shutdown");
    h.ctx.mode = "json";
    await h.emit("session_start");
    const prepared = h.emit("before_provider_request", { payload }) as typeof payload;
    expect(prepared.tools[0]!.function.parameters.properties).toHaveProperty("displaySummary");
    const message = { role: "assistant", content: [{ type: "toolCall", id: "saved", name: "read",
      arguments: { path: "file.ts", displaySummary: "Inspect file" } }] };
    expect(h.emit("message_end", { message })).toEqual({ message: { role: "assistant", content: [
      { type: "toolCall", id: "saved", name: "read", arguments: { path: "file.ts" } },
    ] } });
    expect(h.api.appendEntry).toHaveBeenCalledWith("pi-transcript-ui.intent.v1", [
      { toolCallId: "saved", text: "Inspect file", source: "model" },
    ]);

    h.emit("session_shutdown");
    h.ctx.mode = "tui";
    h.ui.setWidget.mockImplementation((_key, factory) => factory?.({ children: [h.chat], requestRender() {} }));
    await h.emit("session_start");
    expect(native.render(80)).not.toEqual(before);
    native.setExpanded(true);
    expect(native.render(80).join("\n")).toContain("original result");
    await h.commands.get("transcript-ui")!.handler("tools", h.ctx);
    expect(h.ui.custom).toHaveBeenCalledOnce();
    const resumed = h.emit("before_provider_request", { payload }) as typeof payload;
    expect(resumed.tools[0]!.function.parameters.properties).toHaveProperty("displaySummary");
  } finally { await h.dispose(); }
});

it.each(["container", "initial render"])("retires a genuine %s failure and recovers on settings retry without disguising the error", async (stage) => {
  const lookup = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "getRegisteredToolDefinition");
  const options: { rootFailure?: Error; renderFailure?: Error } = stage === "container"
    ? { rootFailure: new Error("Controlled attachment failure") }
    : { renderFailure: new Error("Controlled initial redraw failure") };
  const h = await harness(options);
  try {
    expect(h.ui.notify.mock.calls).toHaveLength(1);
    expect(h.ui.notify.mock.calls[0]?.[1]).toBe("error");
    expect(Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "getRegisteredToolDefinition")).toEqual(lookup);
    const retiredEvent = { get parentToolCallId() { throw new Error("Retired collector read an event"); } };
    expect(() => h.emit("tool_execution_start", retiredEvent)).not.toThrow();
    expect(() => h.emit("tool_execution_end", retiredEvent)).not.toThrow();
    const native = h.makeTool("after-failure");
    native.updateResult({ content: [{ type: "text", text: "original result" }], isError: false });
    const before = native.render(80);
    h.chat.addChild(native);
    expect(native.render(80)).toEqual(before);
    const payload = { tools: [{ type: "function", function: { name: "read", parameters: h.api.getAllTools()[0]!.parameters } }] };
    expect(h.emit("before_provider_request", { payload })).toEqual(payload);
    await h.commands.get("transcript-ui")!.handler("tools", h.ctx);
    expect(h.ui.notify.mock.calls.at(-1)?.[1]).toBe("warning");
    expect(h.ui.custom).not.toHaveBeenCalled();

    delete options.rootFailure;
    delete options.renderFailure;
    h.ui.select.mockResolvedValueOnce("Save");
    await h.commands.get("transcript-ui")!.handler("settings", h.ctx);
    expect(native.render(80)).not.toEqual(before);
    native.setExpanded(true);
    expect(native.render(80).join("\n")).toContain("original result");
    await h.commands.get("transcript-ui")!.handler("tools", h.ctx);
    expect(h.ui.custom).toHaveBeenCalledOnce();
    const resumed = h.emit("before_provider_request", { payload }) as typeof payload;
    expect(resumed.tools[0]!.function.parameters.properties).toHaveProperty("displaySummary");
  } finally { await h.dispose(); }
});

it("routes dynamic rollback/removal and inactive shutdown cleanup to the same UI diagnostic", async () => {
  const h = await harness();
  try {
    const failed = restorationFault(h.makeTool("failed"), true);
    expect(() => h.chat.addChild(failed.proxy)).not.toThrow();
    const removed = restorationFault(h.makeTool("removed"));
    h.chat.addChild(removed.proxy); removed.arm();
    expect(() => h.chat.removeChild(removed.proxy)).not.toThrow();
    const remaining = restorationFault(h.makeTool("shutdown"));
    h.chat.addChild(remaining.proxy); remaining.arm();
    const alsoRemaining = restorationFault(h.makeTool("shutdown-second"));
    h.chat.addChild(alsoRemaining.proxy); alsoRemaining.arm();
    expect(() => h.emit("session_shutdown")).not.toThrow();

    const diagnostics = h.ui.notify.mock.calls.filter(([message]) => message.startsWith("transcript-ui cleanup incomplete"));
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.every(([, level]) => level === "error")).toBe(true);
    expect(diagnostics[0]![0]).toMatch(/\b1 issue\b/);
    expect(diagnostics[1]![0]).toMatch(/\b1 issue\b/);
    expect(diagnostics[2]![0]).toMatch(/\b2 issues\b/);
    expect(h.ui.notify.mock.calls.filter(([, level]) => level === "warning")).toEqual([]);
    expect(h.ui.setWidget.mock.calls.at(-1)?.[1]).toBeUndefined();
  } finally { await h.dispose(); }
});

it("continues settings application and shutdown bookkeeping when cleanup notification throws", async () => {
  const h = await harness();
  try {
    const native = restorationFault(h.makeTool("settings"));
    h.chat.addChild(native.proxy); native.arm();
    h.ui.notify.mockImplementation((_message, level) => { if (level === "error") throw new Error("notification failed"); });
    h.ui.select.mockResolvedValueOnce("Display").mockResolvedValueOnce("Tool duration: on").mockResolvedValueOnce("Back").mockResolvedValueOnce("Save");
    await expect(h.commands.get("transcript-ui")!.handler("settings", h.ctx)).resolves.toBeUndefined();
    const saved = JSON.parse(await readFile(h.settingsPath, "utf8")) as { display: { toolDuration: boolean } };
    expect(saved.display.toolDuration).toBe(false);
    expect(h.ui.notify.mock.calls.some(([, level]) => level === "info")).toBe(true);
    expect(() => h.emit("session_shutdown")).not.toThrow();
    expect(h.ui.setWidget.mock.calls.at(-1)?.[1]).toBeUndefined();
  } finally { await h.dispose(); }
});
