import { expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createBashToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { attachTranscriptPresentation } from "../../src/wiring.js";
import { nativeTool, nativeTranscript } from "./fixtures/native-components.js";

it.each([
  { grouped: false, multiline: false }, { grouped: true, multiline: false },
  { grouped: false, multiline: true }, { grouped: true, multiline: true },
])("keeps command arguments and native expanded bodies unchanged ($grouped, $multiline)", ({ grouped, multiline }) => {
  initTheme();
  const command = multiline ? "set -euo pipefail\nnpm test\ngit diff --check"
    : `cd /Users/example/Desktop/git/pi-transcript-ui && git diff --check && test -z "$(git diff --cached --name-only)" && kata --project pi-transcript-ui close example --message '${"보고 기록 ".repeat(60)}'; if tmux has-session -t example 2>/dev/null; then echo yes; else echo no; fi`;
  const args = Object.freeze({ command });
  const { root, chat } = nativeTranscript();
  const widths = [1, 12, 48, 80, 120, 180];
  const tools = Array.from({ length: grouped ? 2 : 1 }, (_, i) => {
    const tool = nativeTool({ name: "bash", id: String(i), args, definition: createBashToolDefinition("/tmp") });
    tool.updateResult({ content: [{ type: "text", text: "fixture output\nsecond line" }], isError: false });
    tool.setExpanded(true); chat.addChild(tool); return tool;
  });
  const bodies = tools.map(tool => new Map(widths.map(width => [width, tool.render(width)])));
  const detach = attachTranscriptPresentation(root, {
    getTheme: () => ({ bold: s => s, fg: (_kind, s) => s }), requestRender: vi.fn(),
    ...(grouped ? { rules: { bash: "explore" as const } } : {}),
    resolveIntent: () => "검증 근거 기록과 작업 마무리",
  });
  try {
    for (const [index, tool] of tools.entries()) for (const width of widths) {
      const rows = tool.render(width), prefix = grouped ? index === 0 ? 3 : 1 : 2;
      expect(rows.slice(prefix)).toEqual(bodies[index]!.get(width));
      expect(rows.slice(0, prefix).every(row => visibleWidth(row) <= Math.min(width, 120))).toBe(true);
      if (width >= 120) {
        const summary = stripTerminalSequences(rows[prefix - 1]!);
        if (multiline) {
          for (const head of ["set", "npm test", "git diff"]) expect(summary).toContain(head);
          expect(summary.match(/↵/g)).toHaveLength(2);
        } else {
          for (const head of ["git diff", "test", "kata", "if […]"]) expect(summary).toContain(head);
          expect(summary).toContain('test -z "$(…)"');
        }
      }
      expect(Reflect.get(tool, "args")).toBe(args);
    }
  } finally { detach(); }
  for (const [index, tool] of tools.entries()) expect(tool.render(120)).toEqual(bodies[index]!.get(120));
});
