import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode, ToolExecutionComponent, createBashTool, createReadTool, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { attachTranscriptPresentation } from "../src/wiring.js";
import { DEFAULT_DISPLAY_LIMITS, type DisplayLimits } from "../src/display.js";
import * as display from "../src/display.js";
import * as metrics from "../src/tool-metrics.js";
import * as phase from "../src/tool-phase.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });

function fixture(name: "bash" | "read", count: number, limits: Partial<DisplayLimits> = {}) {
  initTheme("dark", false);
  const root = new Container(), chat = new Container(); root.addChild(chat);
  const definitions = new Map<string, ReturnType<typeof createBashTool> | ReturnType<typeof createReadTool>>([
    ["bash", createBashTool("/tmp")], ["read", createReadTool("/tmp")],
  ]);
  const lookup = Reflect.get(InteractiveMode.prototype, "getRegisteredToolDefinition");
  const mode = { session: { getToolDefinition: (name: string) => definitions.get(name),
    extensionRunner: { resolveToolRenderers: (_name: string, base: () => unknown) => base() } } };
  const args = Array.from({ length: count }, (_, i) => name === "bash" ? { command: `printf row-${i}` } : { path: `/tmp/file-${i}` });
  const results = args.map(() => ({ content: [{ type: "text" as const, text: "done" }], isError: false, durationMs: 1000 }));
  const tools = args.map((args, i) => {
    const tool = new ToolExecutionComponent(name, `${name}-${i}`, args, {}, lookup.call(mode, name), { requestRender() {} } as never, "/tmp");
    tool.updateResult(results[i]!); chat.addChild(tool); return tool;
  });
  let color = 31, purpose: string | undefined;
  const theme = { bold: (text: string) => text, fg: (_key: string, text: string) => `\x1b[${color}m${text}\x1b[0m` };
  const settings = { ...DEFAULT_DISPLAY_LIMITS, ...limits };
  const detach = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender() {}, displayLimits: settings,
    resolveParameters: name => definitions.get(name)?.parameters, resolveIntent: () => purpose });
  cleanups.push(detach);
  return { chat, args, results, tools, settings, render: (width = 80) => chat.render(width),
    setColor: (next: number) => { color = next; }, setPurpose: (next: string | undefined) => { purpose = next; } };
}

describe("revision-driven summary work", () => {
  it("reuses settled summaries across unchanged frames and the compositor's independent label width", () => {
    const h = fixture("bash", 40), summarize = vi.spyOn(display, "settledLine");
    const first = h.render();
    const label = () => Reflect.get(h.tools[0]!.children[0]!, "text") as string;
    const fullLabel = label();
    summarize.mockClear();
    for (let i = 0; i < 4; i++) { expect(h.render()).toEqual(first); expect(label()).toBe(fullLabel); }
    expect(summarize.mock.calls.length).toBe(0);

    h.args[3]!.command = "printf changed";
    h.tools[3]!.updateArgs(h.args[3]!);
    expect(h.render().map(stripTerminalSequences).join("\n")).toContain("printf changed");
    expect(summarize.mock.calls.length).toBe(1);
  });

  it("refreshes reused results, independent purpose, mutable theme, widths and settings", () => {
    const h = fixture("bash", 1);
    const initial = h.render();
    h.results[0]!.content[0]!.text = "failed output"; h.results[0]!.isError = true;
    h.tools[0]!.updateResult(h.results[0]!);
    const failed = h.render();
    expect(failed.map(stripTerminalSequences).join("\n")).toContain("— error");
    expect(failed).not.toEqual(initial);

    h.setPurpose("Check current output");
    expect(h.render().map(stripTerminalSequences).join("\n")).toContain("Check current output");
    h.setColor(32);
    const recolored = h.render();
    expect(recolored.join("\n")).toContain("\x1b[32m");
    expect(recolored.join("\n")).not.toContain("\x1b[31m");
    expect(h.render(25).every(line => visibleWidth(line) <= 25)).toBe(true);
    expect(h.render()).toEqual(recolored);

    h.setPurpose(undefined);
    h.args[0]!.command = "printf lengthy-argument && printf another-argument";
    h.tools[0]!.updateArgs(h.args[0]!);
    const wide = h.render();
    h.settings.commandMaxWidth = 12;
    expect(h.render()).not.toEqual(wide);
    h.settings.commandMaxWidth = DEFAULT_DISPLAY_LIMITS.commandMaxWidth;
    expect(h.render()).toEqual(wide);
  });

  it("checks every Bash summary fact even when its shared payload changes without an update notification", () => {
    const h = fixture("bash", 1);
    h.render();
    h.args[0]!.command = "printf unannounced";
    h.results[0]!.isError = true; h.results[0]!.durationMs = 2500;
    const next = h.render().map(stripTerminalSequences).join("\n");
    expect(next).toContain("printf unannounced");
    expect(next).toContain("— error");
    expect(next).toContain("(2.5s)");
  });

  it("does not rescan a settled group for each hidden member, but refreshes changed membership and phase", () => {
    const h = fixture("read", 200), summarize = vi.spyOn(metrics, "summaryMetrics"), phases = vi.spyOn(phase, "toolPhase");
    const initial = h.render();
    summarize.mockClear(); phases.mockClear();
    for (let i = 0; i < 3; i++) expect(h.render()).toEqual(initial);
    expect(summarize.mock.calls.length).toBeLessThanOrEqual(600);
    expect(phases.mock.calls.length).toBeLessThanOrEqual(600);

    h.tools[30]!.updateResult(h.results[30]!, true);
    expect(h.render().map(stripTerminalSequences).join("\n")).toContain("Reading");
    h.tools[30]!.updateResult(h.results[30]!);
    expect(h.render()).toEqual(initial);
    h.chat.removeChild(h.tools[0]!);
    expect(h.render().map(stripTerminalSequences).join("\n")).toContain("199 files");
  });

  it("does not publish a re-entrant invalidation as an unchanged semantic snapshot", () => {
    const h = fixture("bash", 1), summarize = vi.spyOn(display, "settledLine");
    h.render(); summarize.mockClear();
    h.tools[0]!.invalidate();
    const original = display.displayFor;
    let change = true;
    vi.spyOn(display, "displayFor").mockImplementation((...args) => {
      const value = original(...args);
      if (change) { change = false; h.tools[0]!.updateArgs({ command: "printf fresh" }); }
      return value;
    });
    h.render();
    expect(h.render().map(stripTerminalSequences).join("\n")).toContain("printf fresh");
    expect(summarize.mock.calls.length).toBe(2);
  });
});
