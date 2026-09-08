import { expect, it, vi } from "vitest";
import { Container, Text, visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { initTheme, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { attachTranscriptPresentation } from "../../src/wiring.js";

it.each([false, true])("fits actual tool rows on resize without altering native bodies (grouped=%s)", (grouped) => {
  initTheme();
  const definition: ToolDefinition = { name: "bash", label: "Bash", description: "fixture", parameters: { type: "object" },
    execute: async () => ({ content: [], details: undefined }), renderCall: () => new Text("NATIVE CALL", 0, 0), renderResult: () => new Text("NATIVE RESULT", 0, 0) };
  const chat = new Container(), root = new Container(); root.addChild(chat);
  const tools = [0, 1].slice(0, grouped ? 2 : 1).map((id) => {
    const tool = new ToolExecutionComponent("bash", String(id), { command: "npm test -- " + "한글🧪".repeat(40) }, {}, definition, { requestRender: vi.fn() } as never, "/tmp");
    tool.updateResult({ content: [{ type: "text", text: "a\nb" }], isError: false });
    tool.setExpanded(true); chat.addChild(tool); return tool;
  });
  const widths = [1, 4, 12, 40, 80, 160, 240];
  const originals = tools.map((tool) => new Map(widths.map((width) => [width, tool.render(width)])));
  const dispose = attachTranscriptPresentation(root, { getTheme: () => ({ bold: (s) => `\x1b[1m${s}\x1b[22m`, fg: (_k, s) => s }),
    requestRender: vi.fn(), ...(grouped ? { rules: { bash: "explore" as const } } : {}),
    displayLimits: { commandMaxWidth: 120, intentMaxWidth: 20 }, resolveIntent: () => "테스트 환경과 실행 결과 확인" });
  try {
    for (const width of widths) for (const [index, tool] of tools.entries()) {
      const lines = tool.render(width);
      const prefix = grouped ? index === 0 ? 3 : 1 : 2;
      expect(lines.slice(prefix)).toEqual(originals[index]!.get(width));
      expect(lines.slice(0, prefix).every((line) => visibleWidth(line) <= Math.min(width, 120))).toBe(true);
      if (width >= 40) expect(stripTerminalSequences(lines[prefix - 1]!)).toContain("npm test");
    }
    for (const tool of tools) tool.setExpanded(false);
    expect(chat.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
  } finally { dispose(); }
});
