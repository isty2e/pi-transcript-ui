import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type Component } from "@earendil-works/pi-tui";
import type { ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import transcriptUi from "../../src/index.js";

it("gates both navigation entries by current compositor activity, not installation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "transcript-input-policy-"));
  vi.stubEnv("PI_TRANSCRIPT_UI_SETTINGS", join(dir, "settings.json"));
  const active = Symbol.for("pi-fixed-editor-compositor.alternateScreenActive");
  const registry = Symbol.for("pi-fixed-editor-compositor.sidebar.v2");
  const savedActive = Object.getOwnPropertyDescriptor(globalThis, active);
  const savedRegistry = Object.getOwnPropertyDescriptor(globalThis, registry);
  const events = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  const shortcuts = new Map<string, { handler(ctx: ExtensionContext): Promise<void> }>();
  const root = new Container(); root.addChild(new Container());
  const ui = {
    theme: { bold: (s: string) => s, fg: (_k: string, s: string) => s },
    notify: vi.fn(), custom: vi.fn(async () => undefined), setToolsExpanded: vi.fn(),
    setWidget: (_key: string, factory?: (tui: unknown) => Component) => factory?.({ children: root.children, requestRender: vi.fn() }),
  };
  const ctx = { mode: "tui", hasUI: true, ui, sessionManager: { getBranch: () => [] } } as unknown as ExtensionCommandContext;
  try {
    Reflect.set(globalThis, registry, { version: 2 });
    Reflect.deleteProperty(globalThis, active);
    transcriptUi({
      on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => events.set(name, handler),
      registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => commands.set(name, command),
      registerShortcut: (key: string, shortcut: { handler(ctx: ExtensionContext): Promise<void> }) => shortcuts.set(key, shortcut),
    } as never);
    await events.get("session_start")!({} as never, ctx);
    const command = () => commands.get("transcript-ui")!.handler("tools", ctx);
    const shortcut = () => shortcuts.get("ctrl+shift+o")!.handler(ctx);
    await command(); await shortcut();
    expect(ui.custom).toHaveBeenCalledTimes(2);

    Reflect.set(globalThis, active, true);
    await command(); await shortcut();
    expect(ui.custom).toHaveBeenCalledTimes(2);
    expect(ui.notify).toHaveBeenCalledTimes(2);
    expect(ui.notify.mock.calls.every(([message, level]) => message.includes("use the mouse") && level === "info")).toBe(true);
    expect(ui.setToolsExpanded).not.toHaveBeenCalled();

    Reflect.set(globalThis, active, false);
    await command(); await shortcut();
    expect(ui.custom).toHaveBeenCalledTimes(4);
  } finally {
    events.get("session_shutdown")?.({} as never, ctx);
    for (const [key, descriptor] of [[active, savedActive], [registry, savedRegistry]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true });
  }
});
