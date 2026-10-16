import { expect, it, vi } from "vitest";
import { defineTool, initTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { attachTranscriptPresentation } from "../../src/wiring.js";
import { theme } from "../fixtures/pi-theme.js";
import { nativeTool, nativeTranscript } from "./fixtures/native-components.js";

const cases = [
  { name: "read", args: { path: "f.txt" }, properties: { path: { type: "string" } }, required: ["path"] },
  { name: "write", args: { path: "f.txt", content: "written" },
    properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  { name: "edit", args: { path: "f.txt", oldText: "old", newText: "new" },
    properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] },
  { name: "bash", args: { command: "npm test" }, properties: { command: { type: "string" } }, required: ["command"] },
  { name: "powershell", args: { command: "Get-ChildItem" }, properties: { command: { type: "string" } }, required: ["command"] },
  { name: "exec_command", args: { cmd: "npm test" }, properties: { cmd: { type: "string" } }, required: ["cmd"] },
  { name: "write_stdin", args: { session_id: 73 },
    properties: { session_id: { type: "number" }, chars: { type: "string" } }, required: ["session_id"] },
  { name: "codemode", args: { code: "return 1" }, properties: { code: { type: "string" } }, required: ["code"] },
  { name: "custom", args: {}, properties: {}, required: [] },
  { name: "exec_command", args: { script: "other provider" }, properties: { script: { type: "string" } }, required: ["script"] },
  { name: "apply_patch", args: { input: "*** Begin Patch\n*** Add File: f.txt\n+new\n*** End Patch" },
    properties: { input: { type: "string" } }, required: ["input"] },
];

function definition(entry: typeof cases[number]) {
  return defineTool({ name: entry.name, label: entry.name, description: "Native duration fixture",
    parameters: { type: "object", properties: entry.properties, required: entry.required } as ToolDefinition["parameters"],
    execute: vi.fn(async () => ({ content: [], details: {} })),
    renderCall: () => new Text("Native title", 0, 0),
    renderResult: () => new Text("Native output\nTook 9.9s", 0, 0) });
}

it.each(cases)("uses the same timing option for native $name without changing its body", entry => {
  initTheme("dark", false);
  const { root, chat } = nativeTranscript();
  const def = definition(entry);
  const tool = nativeTool({ name: entry.name, id: "duration", args: entry.args, definition: def });
  const result = { content: [{ type: "text" as const, text: "returned output" }], durationMs: 125300, isError: false,
    details: { calls: [{ name: "read", status: "ok" }], output: "returned output", wall_time_seconds: 9.9, exit_code: 0 } };
  tool.updateResult(result);
  tool.setExpanded(true);
  chat.addChild(tool);
  const widths = [1, 10, 24, 80, 120];
  const native = new Map(widths.map(width => [width, tool.render(width)]));

  for (const toolDuration of [true, false]) {
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(),
      displayLimits: { toolDuration }, resolveIntent: () => "Inspect output" });
    try {
      const row = stripTerminalSequences(tool.render(120)[1]!);
      expect(row.includes("(2m 5s)")).toBe(toolDuration);
      expect(row.split("2m 5s")).toHaveLength(toolDuration ? 2 : 1);
      if (entry.name === "codemode") expect(row).toContain("(1 nested call)");
      if (entry.name === "apply_patch") expect(row).toContain("requested");
      for (const width of widths) {
        const rendered = tool.render(width);
        expect(rendered.slice(2)).toEqual(native.get(width));
        expect(rendered.slice(0, 2).every(line => visibleWidth(line) <= Math.min(width, 120))).toBe(true);
      }
      expect(Reflect.get(tool, "args")).toBe(entry.args);
      expect(Reflect.get(tool, "result")).toBe(result);
      expect(Reflect.get(tool, "toolDefinition")).toBe(def);
      expect(def.execute).not.toHaveBeenCalled();
    } finally { dispose(); }
    expect(tool.render(80)).toEqual(native.get(80));
  }
});

it("rereads current final duration after progress, errors, replacement and reattachment", () => {
  initTheme("dark", false);
  const { root, chat } = nativeTranscript();
  const entry = cases.find(entry => entry.name === "custom")!;
  const tool = nativeTool({ name: entry.name, id: "progress", args: entry.args, definition: definition(entry) });
  chat.addChild(tool);
  let dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
  const row = () => stripTerminalSequences(tool.render(120).join("\n"));
  try {
    expect(row()).not.toContain("(1.2s)");
    tool.updateResult({ content: [], durationMs: 1234, isError: false }, true);
    expect(row()).not.toContain("(1.2s)");
    tool.updateResult({ content: [], durationMs: 1234, isError: true });
    expect(row()).toContain("— error");
    expect(row()).toContain("(1.2s)");

    const saved = { content: [], durationMs: 60000, isError: false };
    const replay: typeof saved = JSON.parse(JSON.stringify(saved));
    tool.updateResult(replay);
    expect(row()).toContain("(1m 0s)");
    expect(row()).not.toContain("— error");
    dispose();
    dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
    expect(row()).toContain("(1m 0s)");

    for (const durationMs of [undefined, -1, Infinity, NaN, "1234"]) {
      const result = { content: [{ type: "text" as const, text: "Wall time 9.9 seconds" }],
        details: { durationMs: 9900, wall_time_seconds: 9.9 }, isError: false };
      Reflect.set(result, "durationMs", durationMs);
      tool.updateResult(result);
      expect(row()).not.toMatch(/\(\d+(?:\.\d+)?s\)/);
    }
    tool.updateResult({ content: [], durationMs: 0, isError: false });
    expect(row()).toContain("(0.0s)");
  } finally { dispose(); }
});

it("keeps group time absent while applying the option to individual members", () => {
  initTheme("dark", false);
  const { root, chat } = nativeTranscript();
  const entry = cases[0]!;
  for (const [index, durationMs] of [1234, 2500].entries()) {
    const tool = nativeTool({ name: "read", id: String(index), args: { path: `${index}.txt` }, definition: definition(entry) });
    tool.updateResult({ content: [], durationMs, isError: false });
    chat.addChild(tool);
  }
  for (const toolDuration of [true, false]) {
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), displayLimits: { toolDuration } });
    try {
      const group = dispose.targets().find(target => target.kind === "group")!;
      expect(group.label).not.toMatch(/\(\d+(?:\.\d+)?s\)/);
      group.setExpanded(true);
      const members = dispose.targets().filter(target => target.kind === "tool");
      expect(members).toHaveLength(2);
      expect(members[0]!.label.includes("(1.2s)")).toBe(toolDuration);
      expect(members[1]!.label.includes("(2.5s)")).toBe(toolDuration);
      expect(group.label).not.toContain("3.7s");
    } finally { dispose(); }
  }
});
