import { expect, it, vi } from "vitest";
import { initTheme, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { attachTranscriptPresentation } from "../../src/wiring.js";
import { nativeTool, nativeTranscript } from "./fixtures/native-components.js";

it.each([false, true].flatMap(grouped => ["running", "success", "error"].map(state => ({ grouped, state }))))(
  "styles intent with the live theme while preserving native bodies ($grouped, $state)", ({ grouped, state }) => {
    initTheme();
    const { root, chat } = nativeTranscript();
    const args = Object.freeze({ command: "printf 'hello'" });
    const widths = [1, 12, 48, 120];
    const tools = Array.from({ length: grouped ? 2 : 1 }, (_, i) => {
      const tool = nativeTool({ name: "bash", id: String(i), args, definition: createBashToolDefinition("/tmp") });
      if (state !== "running") tool.updateResult({ content: [{ type: "text", text: "original output\nsecond line" }], isError: state === "error" });
      tool.setExpanded(true);
      chat.addChild(tool);
      return tool;
    });
    const bodies = tools.map(tool => new Map(widths.map(width => [width, tool.render(width)])));
    let intentColor = "90";
    const theme = { bold: (text: string) => text,
      fg: (kind: string, text: string) => `\x1b[${kind === "thinkingText" ? intentColor : "31"}m${text}\x1b[39m` };
    const detach = attachTranscriptPresentation(root, {
      getTheme: () => theme, requestRender: vi.fn(), resolveIntent: () => "출력 확인",
      ...(grouped ? { rules: { bash: "explore" as const } } : {}),
    });
    try {
      for (const color of ["90", "94"]) {
        intentColor = color;
        for (const [index, tool] of tools.entries()) for (const width of widths) {
          const rows = tool.render(width);
          const prefix = grouped ? index === 0 ? 3 : 1 : 2;
          expect(rows.slice(prefix)).toEqual(bodies[index]!.get(width));
          expect(rows.slice(0, prefix).every(row => visibleWidth(row) <= width)).toBe(true);
          if (width === 120) {
            expect(rows[prefix - 1]).toContain(theme.fg("thinkingText", " — 출력 확인"));
            if (grouped && index === 0) expect(rows[1]).not.toContain(theme.fg("thinkingText", " — 출력 확인"));
          }
          expect(Reflect.get(tool, "args")).toBe(args);
        }
      }
    } finally { detach(); }
    for (const [index, tool] of tools.entries()) expect(tool.render(120)).toEqual(bodies[index]!.get(120));
  },
);
