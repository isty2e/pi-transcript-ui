import { expect, it, vi } from "vitest";
import { initTheme, highlightCode, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { attachTranscriptPresentation } from "../../src/wiring.js";
import * as shellColors from "../../src/shell-colors.js";
import { nativeTool, nativeTranscript } from "./fixtures/native-components.js";

const plainTheme = () => ({ bold: theme.bold.bind(theme), fg: theme.fg.bind(theme) });

it.each([false, true].flatMap(grouped => ["running", "success", "error"].map(state => ({ grouped, state }))))(
  "preserves native text/body through updates and themes ($grouped, $state)", ({ grouped, state }) => {
    initTheme("dark");
    const args = { command: 'echo "$HOME"\npwd' };
    function fixture() {
      const { root, chat } = nativeTranscript();
      const tools = Array.from({ length: grouped ? 2 : 1 }, (_, i) => {
        const tool = nativeTool({ name: "bash", id: String(i), args, definition: createBashToolDefinition("/tmp") });
        if (state !== "running") tool.updateResult({ content: [{ type: "text", text: "native output\nsecond line" }], isError: state === "error" });
        tool.setExpanded(true); chat.addChild(tool); return tool;
      });
      return { root, chat, tools };
    }
    const reference = fixture(), trial = fixture();
    const options = { getTheme: () => theme, requestRender: vi.fn(), resolveIntent: () => "출력 확인",
      ...(grouped ? { rules: { bash: "explore" as const } } : {}) };
    const referenceDetach = attachTranscriptPresentation(reference.root, { ...options, getTheme: plainTheme });
    const detach = attachTranscriptPresentation(trial.root, options);
    try {
      for (const palette of ["dark", "light"]) for (const command of ['echo "$HOME"\npwd', 'echo "$PATH"\npwd', 'echo "👩‍💻 e\\\ń"\npwd', 'echo "$HOME"\ncd /tmp\nnode <<EOF\ncd fake\nEOF', 'echo "$HOME"\nnode <<\'JS\' | grep bar\ncd fake\nJS\ngit status']) {
        initTheme(palette); args.command = command;
        for (const tool of [...reference.tools, ...trial.tools]) tool.updateArgs(args);
        for (const width of [1, 8, 24, 48, 120, 180]) for (const [i, tool] of trial.tools.entries()) {
          const actual = tool.render(width), expected = reference.tools[i]!.render(width);
          const prefix = grouped ? i === 0 ? 3 : 1 : 2;
          expect(actual.map(stripTerminalSequences)).toEqual(expected.map(stripTerminalSequences));
          expect(actual.slice(prefix)).toEqual(expected.slice(prefix));
          expect(actual.slice(0, prefix).every(line => visibleWidth(line) <= Math.min(width, 120))).toBe(true);
          expect(Reflect.get(tool, "args")).toBe(args);
          if (width === 180 && command.includes("| grep bar")) {
            const summary = stripTerminalSequences(actual[prefix - 1]!);
            expect(summary).toContain("node […] | grep bar ↵ git status");
            expect(summary).not.toContain("cd fake");
          }
          if (state === "error") expect(actual).toEqual(expected);
          else if (width >= 120) expect(actual[prefix - 1]).toContain(theme.fg("syntaxType", "echo"));
        }
      }
      trial.chat.removeChild(trial.tools[0]!);
    } finally { detach(); referenceDetach(); }
    for (const [i, tool] of trial.tools.entries()) expect(tool.render(120)).toEqual(reference.tools[i]!.render(120));
  },
);

it.each([
  { name: "bash", mode: "raw" as const },
  { name: "powershell", mode: "raw" as const },
  { name: "powershell", mode: "compact" as const },
])("retains uncolored native summary bytes for $name / $mode", ({ name, mode }) => {
  initTheme("dark");
  function fixture(colored: boolean) {
    const { root, chat } = nativeTranscript();
    const tool = nativeTool({ name, id: "1", args: { command: 'echo "$HOME"\npwd' }, definition: createBashToolDefinition("/tmp") });
    chat.addChild(tool);
    return { tool, detach: attachTranscriptPresentation(root, { getTheme: colored ? () => theme : plainTheme,
      requestRender: vi.fn(), displayLimits: { commandPreview: mode } }) };
  }
  const reference = fixture(false), trial = fixture(true);
  try { for (const width of [1, 12, 48, 120]) expect(trial.tool.render(width)).toEqual(reference.tool.render(width)); }
  finally { trial.detach(); reference.detach(); }
});

it("preserves row whitespace across color boundaries and at the trailing edge", () => {
  initTheme("dark");
  for (const command of ['echo "a\t b"', 'echo x  ', '  echo x\t  ', 'echo "unterminated\t  ']) for (const complete of [false, true]) {
    const make = (colored: boolean) => {
      const { root, chat } = nativeTranscript();
      const tool = nativeTool({ name: "bash", id: "1", args: { command }, definition: createBashToolDefinition("/tmp") });
      if (complete) tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
      chat.addChild(tool);
      return { tool, detach: attachTranscriptPresentation(root, { getTheme: colored ? () => theme : plainTheme, requestRender: vi.fn() }) };
    };
    const reference = make(false), trial = make(true);
    try { for (const width of [20, 80]) expect(trial.tool.render(width).map(stripTerminalSequences)).toEqual(reference.tool.render(width).map(stripTerminalSequences)); }
    finally { trial.detach(); reference.detach(); }
  }
});

it("clears on missing input/removal and cannot recreate caches through inactive labels", () => {
  initTheme("dark");
  const highlight = vi.fn((source: string) => highlightCode(source, "bash").join("\n"));
  const create = shellColors.createCommandColorizer;
  const factory = vi.spyOn(shellColors, "createCommandColorizer").mockImplementation(() => create(highlight));
  const { root, chat } = nativeTranscript();
  const args = { command: 'echo "$HOME"' };
  const tool = nativeTool({ name: "bash", id: "1", args, definition: createBashToolDefinition("/tmp") });
  chat.addChild(tool);
  let detach = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
  try {
    tool.render(120); tool.render(120);
    expect(highlight).toHaveBeenCalledTimes(1);
    tool.updateArgs({}); tool.render(120);
    tool.updateArgs(args); tool.render(120);
    expect(highlight).toHaveBeenCalledTimes(2);
    const removedTarget = detach.targets().find(target => target.kind === "tool")!;
    chat.removeChild(tool);
    expect(removedTarget.label).toContain("echo");
    expect(highlight).toHaveBeenCalledTimes(2);
    chat.addChild(tool); tool.render(120);
    expect(highlight).toHaveBeenCalledTimes(3);
    const target = detach.targets().find(target => target.kind === "tool")!;
    detach();
    expect(target.label).toContain("echo");
    expect(highlight).toHaveBeenCalledTimes(3);
    detach = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
    tool.render(120);
    expect(highlight).toHaveBeenCalledTimes(4);
  } finally { detach(); factory.mockRestore(); }
});
