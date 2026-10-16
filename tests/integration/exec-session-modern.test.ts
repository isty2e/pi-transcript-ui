import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ToolExecutionComponent, getPackageDir, initTheme } from "pi-codemode-fixture";
import { attachTranscriptPresentation, type NativeToolComponent, type RowTheme } from "../../src/wiring.js";

const require = createRequire(join(getPackageDir(), "package.json"));
const { Container, Text, stripTerminalSequences } = await import(require.resolve("@earendil-works/pi-tui")) as typeof import("@earendil-works/pi-tui");
const { theme } = await import(join(getPackageDir(), "dist/modes/interactive/theme/theme.js")) as { theme: RowTheme };

it.each(["exec_command", "write_stdin"])("preserves the real Pi 1.2 %s component and its current native title", name => {
  initTheme("dark", false);
  const parameters = name === "exec_command"
    ? { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] }
    : { type: "object", properties: { session_id: { type: "number" }, chars: { type: "string" } }, required: ["session_id"] };
  const definition = { name, label: name, description: "Native renderer fixture", parameters,
    execute: vi.fn(async () => ({ content: [] })),
    renderCall: () => new Text("Native supplied title\nfull input source", 0, 0),
    renderResult: () => new Text("Original modern output", 0, 0) };
  const args = name === "exec_command" ? { cmd: "npm test" } : { session_id: 73 };
  const component = new ToolExecutionComponent(name, "modern", args, {}, definition as never, { requestRender: vi.fn() } as never, "/tmp") as unknown as NativeToolComponent;
  const result = { content: [{ type: "text" as const, text: "receipt" }], details: { chunkId: "abc", wallTimeSeconds: 0.1, exitCode: 7 }, isError: false };
  component.updateResult(result);
  component.setExpanded(true);
  const widths = [24, 80, 120];
  const original = new Map(widths.map(width => [width, component.render(width)]));
  const root = new Container(); const chat = new Container(); root.addChild(chat); chat.addChild(component);
  const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
  try {
    for (const width of widths) {
      const rows = component.render(width);
      expect(rows[0]).toBe("");
      expect(stripTerminalSequences(rows[1]!)).toMatch(/^▾ /);
      expect(rows.slice(2)).toEqual(original.get(width));
    }
    dispose.targets()[0]!.setExpanded(false);
    const compact = stripTerminalSequences(component.render(120).join("\n"));
    expect(compact).toContain(name === "exec_command" ? "Run npm test (exit 7)" : "Check output (exit 7)");
    dispose.targets()[0]!.setExpanded(true);
    expect(component.render(80).slice(2)).toEqual(original.get(80));
    expect(component.args).toBe(args); expect(component.result).toBe(result); expect(component.toolDefinition).toBe(definition);
  } finally { dispose(); }
  expect(component.render(80)).toEqual(original.get(80));
  expect(definition.execute).not.toHaveBeenCalled();
});
