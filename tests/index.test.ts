import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "transcript-index-")); vi.stubEnv("PI_TRANSCRIPT_UI_SETTINGS", join(dir, "settings.json")); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
import { Container, type Component } from "@earendil-works/pi-tui";
import { initTheme, ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import transcriptUi from "../src/index.js";
import packageMetadata from "../package.json" with { type: "json" };

it("reports the package version in command help", async () => {
  const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
  transcriptUi({ on: vi.fn(), registerCommand, registerShortcut: vi.fn() } as never);
  const command = registerCommand.mock.calls.find(([name]) => name === "transcript-ui")?.[1];
  if (!command) throw new Error("Transcript UI command was not registered");
  const notify = vi.fn();
  await command.handler("help", { hasUI: true, ui: { notify } } as never);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining(`pi-transcript-ui ${packageMetadata.version}\n`), "info");
});

it("attaches through the widget without registering/replacing tools, schemas, editor or footer", async () => {
  initTheme();
  const handlers = new Map<string, (...args: any[]) => any>();
  const parameters = Object.freeze({ type: "object", properties: Object.freeze({}) });
  const pi = {
    on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
    registerTool: vi.fn(), registerCommand: vi.fn(), registerShortcut: vi.fn(), getAllTools: () => [{ name: "custom", parameters }],
  };
  transcriptUi(pi as never);
  const chat = new Container();
  const document = new Container();
  document.addChild(new Container()); // header
  document.addChild(new Container()); // loaded resources
  document.addChild(chat);
  const root = new Container();
  root.addChild(document);
  const tool = new ToolExecutionComponent("custom", "id", {}, {}, undefined, { requestRender: vi.fn() } as never, "/tmp");
  chat.addChild(tool);
  tool.updateResult({ content: [{ type: "text", text: "native result" }], isError: false });
  const before = tool.render(80);
  const widgets = new Map<string, unknown>();
  const ui = {
    theme: { bold: (s: string) => s, fg: (_key: string, s: string) => s },
    notify: vi.fn(), setEditorComponent: vi.fn(), setFooter: vi.fn(),
    setWidget: (key: string, factory: ((root: unknown) => Component) | undefined) => {
      widgets.set(key, factory?.({ children: root.children, requestRender: vi.fn() }));
    },
  };
  const ctx = { mode: "tui", hasUI: true, ui, sessionManager: { getBranch: () => [] } };
  await handlers.get("session_start")!({}, ctx);
  expect(tool.render(80)).toHaveLength(2);
  expect(widgets.size).toBe(1);
  expect(pi.registerTool).not.toHaveBeenCalled();
  expect(parameters).toEqual({ type: "object", properties: {} });
  expect(ui.setEditorComponent).not.toHaveBeenCalled(); expect(ui.setFooter).not.toHaveBeenCalled();
  expect(handlers.get("before_agent_start")!({ systemPrompt: "original" }).systemPrompt).toContain("displaySummary");
  handlers.get("session_shutdown")!({}, ctx);
  expect(tool.render(80)).toEqual(before);
  expect(widgets.get("pi-transcript-ui-attachment")).toBeUndefined();
  await handlers.get("session_start")!({}, ctx);
  expect(tool.render(80)).toHaveLength(2);
  handlers.get("session_shutdown")!({}, ctx);
});

it("keeps original schema ownership while adding purpose instructions", () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const parameters = Object.freeze({ properties: Object.freeze({ displaySummary: Object.freeze({ type: "string" }) }) });
  transcriptUi({
    on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
    registerCommand: vi.fn(), registerShortcut: vi.fn(), getAllTools: () => [{ name: "custom", parameters }],
  } as never);
  const result = handlers.get("before_agent_start")!({ systemPrompt: "original" });
  expect(result.systemPrompt).toContain("original");
  expect(result.systemPrompt).toContain("displaySummary");
  expect(parameters.properties.displaySummary).toEqual({ type: "string" });
  expect(handlers.has("tool_call")).toBe(false);
});

it("filters historical fallback in actual rows and restores genuine branch intent without new records", async () => {
  initTheme();
  const handlers = new Map<string, (...args: any[]) => any>();
  const appendEntry = vi.fn();
  transcriptUi({ on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn), registerCommand: vi.fn(), registerShortcut: vi.fn(), appendEntry } as never);
  const chat = new Container(), root = new Container(); root.addChild(chat);
  const tool = new ToolExecutionComponent("bash", "id", { command: "printf 'original command'" }, {}, undefined, { requestRender: vi.fn() } as never, "/tmp");
  tool.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }); chat.addChild(tool);
  let source = "fallback";
  const entry = () => ({ type: "custom", customType: "pi-transcript-ui.intent.v1", data: [{ toolCallId: "id", text: "Run command", source }] });
  const ctx = { mode: "tui", hasUI: true, sessionManager: { getBranch: () => [entry()] }, ui: {
    theme: { bold: (s: string) => s, fg: (_key: string, s: string) => s }, notify: vi.fn(),
    setWidget: (_key: string, factory: ((root: unknown) => Component) | undefined) => { factory?.({ children: root.children, requestRender: vi.fn() }); },
  } };
  await handlers.get("session_start")!({}, ctx);
  expect(tool.render(120).join("\n")).not.toContain("— Run command");
  source = "model"; handlers.get("session_tree")!({}, ctx);
  expect(tool.render(120).join("\n")).toContain("— Run command");
  source = "fallback"; handlers.get("session_tree")!({}, ctx);
  expect(tool.render(120).join("\n")).not.toContain("— Run command");
  tool.updateArgs({ command: "printf 'original command'", displaySummary: "Genuine new legacy purpose" });
  expect(tool.render(120).join("\n")).toContain("— Genuine new legacy purpose");
  expect(appendEntry).not.toHaveBeenCalled();
  expect(handlers.get("before_agent_start")!({ systemPrompt: "original" }).systemPrompt).toContain("Omit intent when redundant");
  expect(handlers.get("before_agent_start")!({ systemPrompt: "original" }).systemPrompt).not.toContain("every call");
  handlers.get("session_shutdown")!({}, ctx);
});
