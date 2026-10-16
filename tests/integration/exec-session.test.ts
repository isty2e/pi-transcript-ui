import { expect, it, vi } from "vitest";
import { Container, Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { theme } from "../fixtures/pi-theme.js";
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
    expect(text).toContain(name === "exec_command" ? "Ran npm test (exit 7)" : "Checked output (exit 7)");
    expect(text).not.toContain("3 lines");
    expect(text).not.toContain("73");
    expect(tool.args).toBe(args);
    expect(tool.result).toBe(result);
    expect(tool.toolDefinition).toBe(def);
    expect(def.execute).not.toHaveBeenCalled();
  } finally { dispose(); }
});

it.each(["exec_command", "write_stdin"] as const)("keeps a spaced purpose summary before the original %s body", name => {
  initTheme("dark", false);
  for (const phase of ["pending", "done"]) {
    const { root, chat } = nativeTranscript();
    const def = definition(name);
    const args = name === "exec_command" ? { cmd: "npm test" } : { session_id: 73 };
    const tool = nativeTool({ name, id: phase, args, definition: def });
    if (phase === "done") tool.updateResult({ content: [{ type: "text", text: "receipt" }], isError: false });
    tool.setExpanded(true);
    const native = tool.render(120);
    chat.addChild(new Text("Previous message", 0, 0)); chat.addChild(tool);
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), resolveIntent: () => "Run the test suite" });
    try {
      const lines = chat.render(120);
      expect(stripTerminalSequences(lines[0]!).trimEnd()).toBe("Previous message");
      expect(lines[1]).toBe("");
      expect(stripTerminalSequences(lines[2]!)).toContain(name === "exec_command"
        ? `▾ ${phase === "done" ? "Ran" : "Run"} npm test` : `▾ ${phase === "done" ? "Checked output" : "Check output"}`);
      expect(stripTerminalSequences(lines[2]!)).toContain("Run the test suite");
      expect(lines[3]).toBe("");
      expect(lines.slice(3)).toEqual(native);
      expect(def.execute).not.toHaveBeenCalled();
    } finally { dispose(); }
  }
});

it.each(["dark", "light"])("keeps the summary, complete Native body and folding in %s", themeName => {
  initTheme(themeName, false);
  for (const name of ["exec_command", "write_stdin"] as const) {
    for (const phase of ["pending", "partial", "done", "error", "hidden", "throws", "container", "default", "self", "intent"] as const) {
      const def = definition(name);
      const invalidate: Array<() => void> = [];
      def.renderCall = (_args, _theme, ctx) => {
        invalidate.push(ctx.invalidate);
        if (phase === "throws") throw new Error("fixture renderer failure");
        if (phase === "hidden") return new Text("", 0, 0);
        if (phase === "container") { const c = new Container(); c.addChild(new Text("Opaque native heading", 0, 0)); return c; }
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
      const label = name === "exec_command" ? `${phase === "pending" ? "Run" : phase === "partial" ? "Running" : "Ran"} npm test`
        : phase === "pending" ? "Send input" : phase === "partial" ? "Sending input" : "Sent input";
      try {
        for (const width of widths) {
          const rows = tool.render(width);
          const native = baseline.get(width)!;
          expect(rows[0]).toBe("");
          expect(visibleWidth(rows[1]!)).toBeLessThanOrEqual(width);
          expect(rows.slice(2)).toEqual(native);
        }
        const lines = tool.render(120);
        expect(stripTerminalSequences(lines[1]!)).toContain(`▾ ${label}`);
        const y = lines.findIndex(line => stripTerminalSequences(line).trim());
        const event = { type: "click" as const, button: "left" as const, x: 4, y, screenX: 4, screenY: y, width: 120, height: lines.length,
          shift: false, alt: false, ctrl: false };
        expect(tool.handleMouse?.(event)?.handled).toBe(true);
        expect(tool.expanded).toBe(false);
        const nav = new ToolNavigation(() => dispose.targets());
        nav.act("right"); expect(tool.expanded).toBe(true);
        nav.act("left"); expect(tool.expanded).toBe(false);
        expect(stripTerminalSequences(tool.render(120).join("\n"))).toContain(label);
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
    expect(text).toContain("Wrote result.txt");
    expect(text).toContain("2 lines");
    expect(text).not.toContain("Ran npm test");
    expect(def.execute).not.toHaveBeenCalled();
  } finally { dispose(); }
});

it.each(["bash", "zsh"])("rechecks explicit %s preview evidence and Raw selection without changing Native state", shell => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const command = "cd /workspace/a/long/project/directory && npm run build --configuration lengthy-development-profile || printf '%s' fallback | head -n 20";
  const args: { cmd: string; shell?: string } = { cmd: command, shell: `/usr/local/bin/${shell}` };
  const fields = { cmd: { type: "string" }, shell: { type: "string" } };
  const def = definition("exec_command");
  def.parameters = { type: "object", properties: fields, required: ["cmd"] } as ToolDefinition["parameters"];
  def.renderCall = () => new Text(`Native requested command\n${command}`, 0, 0);
  const tool = nativeTool({ name: def.name, id: `${shell}-preview`, args, definition: def }) as unknown as NativeToolComponent;
  const result = { content: [{ type: "text" as const, text: "Original complete output" }], isError: false,
    details: { output: "Original complete output", wall_time_seconds: 1, exit_code: 0 }, durationMs: 125300 };
  tool.updateResult(result);
  tool.setExpanded(true);
  const widths = [1, 5, 24, 72, 120];
  const native = new Map(widths.map(width => [width, tool.render(width)]));
  tool.setExpanded(false); chat.addChild(tool);
  const limits = { commandPreview: "compact" as "compact" | "raw" };
  let purpose: string | undefined;
  const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), displayLimits: limits,
    resolveIntent: () => purpose });
  try {
    const header = () => stripTerminalSequences(tool.render(72).join("\n"));
    expect(header()).toMatch(/&&.*\|\|.*\|/);
    expect(header()).toContain("(exit 0) (2m 5s)");
    tool.setExpanded(true);
    for (const width of widths) {
      const rows = tool.render(width);
      expect(rows.slice(2)).toEqual(native.get(width));
      expect(visibleWidth(rows[1]!)).toBeLessThanOrEqual(width);
    }
    tool.setExpanded(false);
    purpose = "Check build"; tool.updateDisplay();
    expect(header()).toMatch(/&&.*\|\|.*\|/);
    expect(header()).toContain("— Check build");
    purpose = undefined; tool.updateDisplay();

    args.shell = "/bin/zsh";
    args.cmd = "npm test\nrepeat 2 do\nprintf HIDDEN\ndone\nprintf AFTER";
    tool.updateArgs(args);
    expect(header()).toContain("Ran npm test ↵ repeat […]");
    expect(header()).not.toMatch(/HIDDEN|AFTER/);
    args.shell = `/bin/${shell}`;
    args.cmd = "npm test\nprintf x >>| REDIRECTION_TARGET\nprintf AFTER";
    tool.updateArgs(args);
    expect(header()).toContain("Ran npm test ↵ printf […]");
    expect(header()).not.toMatch(/REDIRECTION_TARGET|AFTER/);
    args.cmd = command;

    args.shell = "/bin/fish"; tool.updateArgs(args);
    const raw = header();
    expect(raw).not.toContain("||");
    args.shell = `/opt/homebrew/bin/${shell}`; tool.updateArgs(args);
    expect(header()).toMatch(/&&.*\|\|.*\|/);
    limits.commandPreview = "raw"; tool.updateDisplay();
    expect(header()).toBe(raw);
    limits.commandPreview = "compact"; tool.updateDisplay();
    expect(header()).toMatch(/&&.*\|\|.*\|/);

    fields.shell.type = "number"; tool.updateDisplay();
    expect(header()).toBe(raw);
    fields.shell.type = "string"; tool.updateDisplay();
    expect(header()).toMatch(/&&.*\|\|.*\|/);
    delete args.shell; tool.updateArgs(args);
    expect(header()).toBe(raw);
    expect(tool.args).toBe(args); expect(tool.result).toBe(result); expect(tool.toolDefinition).toBe(def);
    args.shell = shell;
    const failed = { ...result, isError: true, details: { ...result.details, exit_code: 7 } };
    tool.updateArgs(args); tool.updateResult(failed);
    expect(header()).toMatch(/&&.*\|\|.*\|/);
    expect(header()).toContain("— error (exit 7)");
    expect(tool.result).toBe(failed);
    expect(def.execute).not.toHaveBeenCalled();
  } finally { dispose(); }
});

it("reevaluates blank and multiline exec requests while retaining the full native source", () => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const args = { cmd: "\nnpm test" };
  const def = definition("exec_command");
  def.renderCall = () => new Text(args.cmd, 0, 0);
  const tool = nativeTool({ name: def.name, id: "stream", args, definition: def });
  tool.updateResult({ content: [{ type: "text", text: "receipt" }], isError: false,
    details: { output: "", wall_time_seconds: 1, exit_code: 0 } });
  chat.addChild(tool);
  const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
  try {
    const text = () => stripTerminalSequences(tool.render(120).join("\n"));
    expect(text()).not.toMatch(/\b(?:Run|Running|Ran)\b/);
    args.cmd = "cd repo\nrm -rf build\nnpm test"; tool.updateArgs(args);
    expect(text()).toContain("Ran cd repo […] (exit 0)");
    expect(text()).not.toContain("rm -rf build");
    dispose.targets()[0]!.setExpanded(true);
    expect(text()).toContain("rm -rf build");
    expect(text()).toContain("npm test");
    dispose.targets()[0]!.setExpanded(false);
    args.cmd = "\r\nnpm test"; tool.updateArgs(args);
    expect(text()).not.toMatch(/\b(?:Run|Running|Ran)\b/);
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

it.each(["exec_command", "write_stdin"] as const)("keeps incomplete required %s inputs on the generic row and group path", name => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const key = name === "exec_command" ? "workdir" : "chars";
  const def = definition(name);
  def.parameters = { type: "object", properties: name === "exec_command"
    ? { cmd: { type: "string" }, workdir: { type: "string" } }
    : { session_id: { type: "number" }, chars: { type: "string" } },
    required: [name === "exec_command" ? "cmd" : "session_id", key] } as ToolDefinition["parameters"];
  const args: Record<string, unknown> = name === "exec_command" ? { cmd: "npm test" } : { session_id: 73 };
  const tool = nativeTool({ name, id: "incomplete", args, definition: def }) as unknown as NativeToolComponent;
  const result = { content: [{ type: "text" as const, text: "Validation failed\nMissing required input" }], isError: true };
  tool.updateResult(result); tool.setExpanded(true);
  const native = tool.render(120); tool.setExpanded(false);
  const otherDef = { ...definition("exec_command"), name: "diagnostic" };
  const other = nativeTool({ name: otherDef.name, id: "other", args: { cmd: "inspect" }, definition: otherDef });
  other.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
  chat.addChild(tool); chat.addChild(other);
  const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(),
    rules: { [name]: "explore", diagnostic: "explore" } });
  try {
    dispose.targets()[0]!.setExpanded(true);
    const text = () => stripTerminalSequences(chat.render(120).join("\n"));
    const label = name === "exec_command" ? "Ran npm test" : "Checked output";
    expect(text()).toContain("(3 lines)");
    expect(text()).not.toContain(label);

    args[key] = name === "exec_command" ? "/tmp" : ""; tool.updateArgs(args);
    expect(text()).toContain(label);
    expect(text()).not.toContain("(3 lines)");
    expect(text()).toContain("1 failed");
    args[key] = undefined; tool.updateArgs(args);
    expect(text()).not.toContain(label);
    expect(text()).toContain("(3 lines)");
    args[key] = name === "exec_command" ? "/tmp" : ""; tool.updateArgs(args);
    expect(text()).toContain(label);
    delete args[key]; tool.updateArgs(args);
    expect(text()).not.toContain(label);
    expect(text()).toContain("(3 lines)");

    dispose.targets()[1]!.setExpanded(true);
    expect(tool.render(120).slice(-native.length)).toEqual(native);
    expect(tool.args).toBe(args); expect(tool.result).toBe(result); expect(tool.toolDefinition).toBe(def);
    expect(def.execute).not.toHaveBeenCalled();
    expect(otherDef.execute).not.toHaveBeenCalled();
  } finally { dispose(); }
});
