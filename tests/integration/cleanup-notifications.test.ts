import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type Component } from "@earendil-works/pi-tui";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import transcriptUi from "../../src/index.js";
import { restorationFault } from "../fixtures/native-children.js";

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "transcript-cleanup-"));
  const settingsPath = join(directory, "settings.json");
  vi.stubEnv("PI_TRANSCRIPT_UI_SETTINGS", settingsPath);
  initTheme();
  const root = new Container(), chat = new Container(); root.addChild(chat);
  const ui = {
    theme: { bold: (text: string) => text, fg: (_style: string, text: string) => text },
    notify: vi.fn((_message: string, _level: string) => {}),
    select: vi.fn(), input: vi.fn(), editor: vi.fn(),
    setWidget: vi.fn((_key: string, factory: ((tui: unknown) => Component) | undefined) =>
      factory?.({ children: root.children, requestRender() {} })),
  };
  const ctx = { mode: "tui", hasUI: true, ui, sessionManager: { getBranch: () => [] } };
  type Handler = (event: unknown, context: typeof ctx) => unknown;
  const events = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, context: typeof ctx) => Promise<void> }>();
  const api = {
    on: (name: string, handler: unknown) => events.set(name, handler as Handler),
    registerCommand: (name: string, command: unknown) => commands.set(name, command as { handler: (args: string, context: typeof ctx) => Promise<void> }),
    registerShortcut: vi.fn(), getAllTools: () => [], getActiveTools: () => [], appendEntry: vi.fn(),
  };
  transcriptUi(api as never);
  const emit = (name: string) => events.get(name)!({}, ctx);
  await emit("session_start");
  const makeTool = (id: string) => new ToolExecutionComponent("fixture", id, {}, {}, undefined, { requestRender() {} } as never, directory);
  return { chat, ui, ctx, emit, commands, settingsPath, makeTool,
    async dispose() {
      try { emit("session_shutdown"); }
      finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
    } };
}

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
