import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import transcriptUi from "../../src/index.js";

it("live settings, reload and session navigation retain native body/expansion and restore intent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "transcript-presentation-"));
  vi.stubEnv("PI_TRANSCRIPT_UI_SETTINGS", join(dir, "settings.json"));
  initTheme();
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, { handler: (...args: any[]) => any }>();
  let branch: unknown[] = [];
  const parameters = { type: "object", properties: {} };
  const api = {
    on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
    registerCommand: (name: string, command: { handler: (...args: any[]) => any }) => commands.set(name, command),
    registerShortcut: vi.fn(), getAllTools: () => [{ name: "custom", parameters }], getActiveTools: () => ["custom"],
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
  };
  const root = new Container(), chat = new Container(); root.addChild(chat);
  const args = {}, tool = new ToolExecutionComponent("custom", "c1", args, {}, undefined, { requestRender: vi.fn() } as never, dir);
  chat.addChild(tool);
  tool.updateResult({ content: [{ type: "text", text: "NATIVE BODY" }], isError: false });
  tool.setExpanded(true);
  const native = tool.render(80);
  const bashArgs = { command: 'cd /Users/example/' + 'long-directory/'.repeat(12) + 'project && git status' };
  const bash = new ToolExecutionComponent('bash', 'b1', bashArgs, {}, undefined, { requestRender: vi.fn() } as never, dir);
  bash.updateResult({ content: [{ type: 'text', text: 'BASH BODY' }], isError: false });
  bash.setExpanded(true);
  const nativeBash = bash.render(80);
  const bashBodies = new Map([1, 12, 48, 80, 180].map(width => [width, bash.render(width)]));
  chat.addChild(bash);
  const ui = {
    theme: { bold: (s: string) => s, fg: (_key: string, s: string) => s }, notify: vi.fn(),
    select: vi.fn(), input: vi.fn(), editor: vi.fn(),
    setWidget: (_key: string, factory: ((root: unknown) => Component) | undefined) => factory?.({ children: root.children, requestRender: vi.fn() }),
  };
  const ctx = { mode: "tui", hasUI: true, ui, sessionManager: { getBranch: () => branch } };
  try {
    transcriptUi(api as never);
    await handlers.get("session_start")!({}, ctx);
    handlers.get("before_provider_request")!({ payload: { tools: [{ name: "custom", parameters }] } }, ctx);
    const cleaned = handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "custom", arguments: { displaySummary: "Check original rendering" } }] } });
    tool.updateArgs(cleaned.message.content[0].arguments);
    expect(tool.render(80)[1]).toContain("Check original rendering");
    expect(tool.render(80).slice(2)).toEqual(native);
    ui.select.mockResolvedValueOnce("Intent").mockResolvedValueOnce("Intent: on").mockResolvedValueOnce("Back").mockResolvedValueOnce("Save");
    await commands.get("transcript-ui")!.handler("settings", ctx);
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).intent.enabled).toBe(false);
    expect(tool.render(80)[1]).not.toContain("Check original rendering");
    expect(tool.render(80)[1]).toMatch(/^▾/);
    expect(tool.render(80).slice(2)).toEqual(native);
    ui.select.mockResolvedValueOnce("Intent").mockResolvedValueOnce("Intent: off").mockResolvedValueOnce("Back").mockResolvedValueOnce("Save");
    await commands.get("transcript-ui")!.handler("settings", ctx);
    expect(tool.render(80)[1]).toContain("Check original rendering");
    handlers.get("session_shutdown")!({}, ctx);
    expect(tool.render(80)).toEqual(native);
    transcriptUi(api as never);
    await handlers.get("session_start")!({}, ctx);
    expect(tool.render(80)[1]).toContain("Check original rendering");
    const savedBranch = branch; branch = [];
    await handlers.get("session_start")!({ reason: "new" }, ctx);
    expect(tool.render(80)[1]).not.toContain("Check original rendering");
    branch = savedBranch; handlers.get("session_tree")!({}, ctx);
    expect(tool.render(80)[1]).toContain("Check original rendering");
    ui.select.mockResolvedValueOnce("Display").mockResolvedValueOnce("Intent display width: 48").mockResolvedValueOnce("Back").mockResolvedValueOnce("Save");
    ui.input.mockResolvedValueOnce("8");
    await commands.get("transcript-ui")!.handler("settings", ctx);
    expect(stripTerminalSequences(tool.render(80)[1]!)).toContain("Check o…");
    expect(tool.render(80).slice(2)).toEqual(native);
    const beforeCancel = tool.render(80);
    ui.select.mockResolvedValueOnce("Display").mockResolvedValueOnce("Intent display width: 8").mockResolvedValueOnce("Back").mockResolvedValueOnce("Cancel");
    ui.input.mockResolvedValueOnce("20");
    await commands.get("transcript-ui")!.handler("settings", ctx);
    expect(tool.render(80)).toEqual(beforeCancel);
    expect(bash.render(80)[1]).toContain('git status');
    ui.select.mockResolvedValueOnce('Display').mockResolvedValueOnce('Command preview: Compact').mockResolvedValueOnce('Raw').mockResolvedValueOnce('Back').mockResolvedValueOnce('Save');
    await commands.get('transcript-ui')!.handler('settings', ctx);
    const rawDisk = await readFile(join(dir, 'settings.json'), 'utf8');
    expect(JSON.parse(rawDisk).display.commandPreview).toBe('raw');
    expect(bash.render(80)[1]).not.toContain('git status');
    expect(bash.render(80).slice(2)).toEqual(nativeBash);
    expect(Reflect.get(bash, 'args')).toBe(bashArgs);
    for (const [width, body] of bashBodies) {
      expect(bash.render(width).slice(2)).toEqual(body);
      expect(bash.render(width).slice(0, 2).every(line => visibleWidth(line) <= Math.min(width, 120))).toBe(true);
    }
    ui.select.mockResolvedValueOnce('Display').mockResolvedValueOnce('Command preview: Raw').mockResolvedValueOnce('Compact').mockResolvedValueOnce('Back').mockResolvedValueOnce('Cancel');
    await commands.get('transcript-ui')!.handler('settings', ctx);
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(rawDisk);
    expect(bash.render(80)[1]).not.toContain('git status');
    ui.select.mockResolvedValueOnce('Display').mockResolvedValueOnce('Command preview: Raw').mockResolvedValueOnce(undefined).mockResolvedValueOnce('Back').mockResolvedValueOnce('Cancel');
    await commands.get('transcript-ui')!.handler('settings', ctx);
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(rawDisk);
    await handlers.get('session_start')!({ reason: 'reload' }, ctx);
    expect(bash.render(80)[1]).not.toContain('git status');
    expect(bash.render(80).slice(2)).toEqual(nativeBash);
    ui.select.mockResolvedValueOnce('Display').mockResolvedValueOnce('Command preview: Raw').mockResolvedValueOnce('Compact').mockResolvedValueOnce('Back').mockResolvedValueOnce('Save');
    await commands.get('transcript-ui')!.handler('settings', ctx);
    expect(bash.render(80)[1]).toContain('git status');
    expect(bash.render(80).slice(2)).toEqual(nativeBash);
    ui.select.mockResolvedValueOnce("Display").mockResolvedValueOnce("Total row width: 120").mockResolvedValueOnce("Back").mockResolvedValueOnce("Save");
    ui.input.mockResolvedValueOnce("24");
    await commands.get("transcript-ui")!.handler("settings", ctx);
    expect(visibleWidth(tool.render(80)[1]!)).toBeLessThanOrEqual(24);
    expect(tool.render(80).slice(2)).toEqual(native);
    expect(ui.notify.mock.calls.filter((call) => call[1] === "error")).toEqual([]);
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
    vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true });
  }
});
