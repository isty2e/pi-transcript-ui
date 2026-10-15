import { expect, it, vi } from "vitest";
import { Container, Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { attachTranscriptPresentation, type NativeToolComponent } from "../../src/wiring.js";
import { nativeTool, nativeTranscript } from "./fixtures/native-components.js";
import { ToolNavigation } from "../../src/navigation.js";

function definition(name: "exec_command" | "write_stdin"): ToolDefinition {
  const key = name === "exec_command" ? "cmd" : "session_id";
  return {
    name, label: name, description: "Shell contract fixture",
    parameters: { type: "object", properties: { [key]: { type: key === "cmd" ? "string" : "number" },
      chars: { type: "string" } }, required: [key] } as ToolDefinition["parameters"],
    execute: vi.fn(async () => ({ content: [], details: {} })),
    renderCall: () => new Text("Native heading", 0, 0),
    renderResult: () => new Text("Original output", 0, 0),
  };
}

it.each(["exec_command", "write_stdin"] as const)("summarizes %s without receipt line totals or session IDs", name => {
  initTheme("dark", false);
  const { root, chat } = nativeTranscript();
  const args = name === "exec_command" ? { cmd: "npm test", shell: "/bin/fish" } : { session_id: 73 };
  const def = definition(name);
  const tool = nativeTool({ name, id: "a", args, definition: def }) as unknown as NativeToolComponent;
  const result = { content: [{ type: "text" as const, text: "metadata\nOutput:\nhello" }],
    details: { output: "hello", wall_time_seconds: 0.1, exit_code: 7 }, isError: false };
  tool.updateResult(result);
  chat.addChild(tool);
  const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
  try {
    const text = stripTerminalSequences(chat.render(120).join("\n"));
    expect(text).toContain(name === "exec_command" ? "Run npm test (exit 7)" : "Check output (exit 7)");
    expect(text).not.toContain("3 lines");
    expect(text).not.toContain("73");
    expect(tool.args).toBe(args);
    expect(tool.result).toBe(result);
    expect(tool.toolDefinition).toBe(def);
    expect(def.execute).not.toHaveBeenCalled();
  } finally { dispose(); }
});

it.each(["dark", "light"])("flattens only the outer title while preserving Native body and folding in %s", themeName => {
  initTheme(themeName, false);
  for (const name of ["exec_command", "write_stdin"] as const) {
    for (const phase of ["pending", "partial", "done", "error", "hidden", "throws", "unknown-slot", "default", "self", "intent"] as const) {
      const def = definition(name);
      const invalidate: Array<() => void> = [];
      def.renderCall = (_args, _theme, ctx) => {
        invalidate.push(ctx.invalidate);
        if (phase === "throws") throw new Error("fixture renderer failure");
        if (phase === "hidden") return new Text("", 0, 0);
        if (phase === "unknown-slot") { const c = new Container(); c.addChild(new Text("Opaque native heading", 0, 0)); return c; }
        return new Text("Native heading\ncomplete requested source", 0, 0);
      };
      def.renderResult = () => phase === "hidden" ? new Container() : new Text("Original output", 0, 0);
      if (phase === "default") { delete def.renderCall; delete def.renderResult; }
      if (phase === "self") def.renderShell = "self";

      const args = name === "exec_command" ? { cmd: "npm test" } : { session_id: 73, chars: "\n" };
      const tool = nativeTool({ name, id: phase, args, definition: def }) as unknown as NativeToolComponent;
      const result = { content: [{ type: "text" as const, text: "receipt" }], isError: phase === "error" };
      if (phase !== "pending") tool.updateResult(result, phase === "partial");
      tool.setExpanded(true);
      const widths = [1, 5, 24, 80, 120];
      const baseline = new Map(widths.map(w => [w, tool.render(w)]));
      const render = tool.render;
      const { root, chat } = nativeTranscript(); chat.addChild(tool);
      const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(),
        ...(phase === "intent" ? { resolveIntent: () => "Checking tests" } : {}) });
      try {
        for (const width of widths) {
          const rows = tool.render(width);
          const native = baseline.get(width)!;
          const fallback = ["hidden", "throws", "unknown-slot", "default"].includes(phase);
          if (fallback || phase === "pending" || phase === "intent") {
            expect(rows.slice(-native.length)).toEqual(native);
            expect(visibleWidth(rows[phase === "pending" || phase === "intent" ? 0 : 1]!)).toBeLessThanOrEqual(width);
          } else expect(rows).toEqual(native);
        }
        const lines = tool.render(120);
        const y = lines.findIndex(line => stripTerminalSequences(line).trim());
        const event = { type: "click" as const, button: "left" as const, x: 4, y, screenX: 4, screenY: y, width: 120, height: lines.length,
          shift: false, alt: false, ctrl: false };
        expect(tool.handleMouse?.(event)?.handled).toBe(true);
        expect(tool.expanded).toBe(false);
        const nav = new ToolNavigation(() => dispose.targets());
        nav.act("right"); expect(tool.expanded).toBe(true);
        nav.act("left"); expect(tool.expanded).toBe(false);
        expect(stripTerminalSequences(tool.render(120).join("\n"))).toContain(name === "exec_command" ? "Run npm test" : "Send input");
        expect(tool.args).toBe(args); expect(tool.toolDefinition).toBe(def);
        if (phase !== "pending") expect(tool.result).toBe(result);
      } finally { dispose(); }
      expect(tool.render).toBe(render);
      tool.setExpanded(true);
      expect(tool.render(80)).toEqual(baseline.get(80));
      invalidate.at(-1)?.();
      expect(tool.render(80)).toEqual(baseline.get(80));
      expect(def.execute).not.toHaveBeenCalled();
    }
  }
});

it("keeps established file capabilities ahead of a same-named shell request", () => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const def = definition("exec_command");
  def.parameters = { type: "object", properties: { cmd: { type: "string" }, path: { type: "string" }, content: { type: "string" } },
    required: ["cmd", "path", "content"] } as ToolDefinition["parameters"];
  const args = { cmd: "npm test", path: "result.txt", content: "one\ntwo\n" };
  const tool = nativeTool({ name: def.name, id: "writer", args, definition: def });
  tool.updateResult({ content: [{ type: "text", text: "receipt" }], isError: false });
  chat.addChild(tool);
  const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
  try {
    const text = stripTerminalSequences(tool.render(120).join("\n"));
    expect(text).toContain("Write result.txt");
    expect(text).toContain("2 lines");
    expect(text).not.toContain("Run npm test");
    expect(def.execute).not.toHaveBeenCalled();
  } finally { dispose(); }
});

it("reevaluates streaming/mutable arguments and refuses unsupported binary input", () => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const def = definition("write_stdin");
  def.parameters = { type: "object", properties: { session_id: { type: "number" }, chars: { type: "string" },
    chars_b64: { type: "string" } }, required: ["session_id"] } as ToolDefinition["parameters"];
  const args = { session_id: 73, chars: "", chars_b64: "bHMK" };
  const tool = nativeTool({ name: def.name, id: "stream", args, definition: def }) as unknown as NativeToolComponent;
  chat.addChild(tool);
  const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
  try {
    const text = () => stripTerminalSequences(chat.render(120).join("\n"));
    expect(text()).not.toContain("Check output");
    args.chars_b64 = ""; tool.updateArgs(args);
    expect(text()).toContain("Check output");
    args.chars = "\u0003"; tool.updateArgs(args);
    expect(text()).toContain("Send input");
    args.chars_b64 = "bHMK"; tool.updateArgs(args);
    expect(text()).not.toContain("Send input");
    expect(args.chars).toBe("\u0003");
  } finally { dispose(); }
});

it("counts native calls, not protocol lines, under explicit shell grouping", () => {
  initTheme();
  const { root, chat } = nativeTranscript();
  for (const name of ["exec_command", "write_stdin"] as const) {
    const tool = nativeTool({ name, id: name, args: name === "exec_command" ? { cmd: "x && y" } : { session_id: 73 }, definition: definition(name) });
    tool.updateResult({ content: [{ type: "text", text: "header\nOutput:\nline" }], isError: false }, false);
    chat.addChild(tool);
  }
  const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(),
    rules: { exec_command: "explore", write_stdin: "explore" } });
  try {
    expect(stripTerminalSequences(chat.render(120).join("\n"))).toContain("2 calls");
    expect(stripTerminalSequences(chat.render(120).join("\n"))).not.toContain("lines");
    expect(dispose.targets()).toHaveLength(1);
    dispose.targets()[0]!.setExpanded(true);
    expect(dispose.targets()).toHaveLength(3);
    dispose.targets()[1]!.setExpanded(true);
    dispose.targets()[0]!.setExpanded(false);
    expect(dispose.targets()).toHaveLength(1);
    dispose.targets()[0]!.setExpanded(true);
    expect(dispose.targets()[1]!.expanded).toBe(true);
  } finally { dispose(); }
});
