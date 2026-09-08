import { expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createLsToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { attachTranscriptPresentation } from "../../src/wiring.js";
import { nativeTool, nativeTranscript } from "./fixtures/native-components.js";

const theme = { bold: (text: string) => text, fg: (_kind: string, text: string) => text };
const sourcePath = `packages/${"distant-directory-".repeat(12)}/src/near/index.ts`;
const definitions = [
  createReadToolDefinition("/tmp"), createWriteToolDefinition("/tmp"),
  createEditToolDefinition("/tmp"), createLsToolDefinition("/tmp"),
  { ...createReadToolDefinition("/tmp"), name: "remote_reader" },
  { ...createWriteToolDefinition("/tmp"), name: "remote_writer" },
  { ...createEditToolDefinition("/tmp"), name: "remote_editor" },
];

it.each(definitions.flatMap(definition => [false, true].map(grouped => ({ definition, grouped }))))(
  "preserves native data and expanded bodies for $definition.name (grouped=$grouped)", ({ definition, grouped }) => {
    initTheme();
    const { root, chat } = nativeTranscript();
    const args = Object.freeze(definition.name === "write" || definition.name === "remote_writer"
      ? { path: sourcePath, content: "first\nsecond\n" }
      : definition.name === "edit" || definition.name === "remote_editor"
        ? { path: sourcePath, edits: [{ oldText: "first", newText: "second" }] }
        : { path: sourcePath });
    const tools = Array.from({ length: grouped ? 2 : 1 }, (_, index) => {
      const tool = nativeTool({ name: definition.name, id: String(index), args, definition });
      tool.updateResult({ content: [{ type: "text", text: "first\nsecond" }], isError: false });
      tool.setExpanded(true); chat.addChild(tool); return tool;
    });
    const widths = Array.from({ length: 180 }, (_, index) => index + 1);
    const bodies = tools.map(tool => new Map(widths.map(width => [width, tool.render(width)])));
    const results = tools.map(tool => Reflect.get(tool, "result"));
    const attach = () => attachTranscriptPresentation(root, {
      getTheme: () => theme, requestRender: vi.fn(), resolveIntent: () => "Inspect file",
      ...(grouped && definition.name === "remote_reader" ? { rules: { remote_reader: "explore" as const } } : {}),
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      const detach = attach();
      try {
        for (const [index, tool] of tools.entries()) for (const width of widths) {
          const native = bodies[index]!.get(width)!;
          const rows = tool.render(width), prefixCount = rows.length - native.length;
          expect(rows.slice(prefixCount)).toEqual(native);
          const summaries = rows.slice(0, prefixCount);
          expect(summaries.every(row => visibleWidth(row) <= Math.min(width, 120))).toBe(true);
          if (width >= 80) {
            const summary = summaries.map(stripTerminalSequences).find(row => row.includes("index.ts"));
            expect(summary).toContain("packages/…/");
            expect(summary).toContain(" — Inspect file");
            expect(summary!.indexOf("index.ts")).toBeLessThan(summary!.indexOf(" — Inspect file"));
          }
          expect(Reflect.get(tool, "args")).toBe(args);
          expect(Reflect.get(tool, "result")).toBe(results[index]);
        }
        for (const target of detach.targets().filter(target => target.kind === "tool")) {
          expect(target.label).toContain("index.ts");
        }
      } finally { detach(); }
      for (const [index, tool] of tools.entries()) expect(tool.render(120)).toEqual(bodies[index]!.get(120));
    }
  },
);

it("keeps original Read path identity when distinct paths have identical abbreviated labels", () => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const definition = createReadToolDefinition("/tmp");
  const paths = [sourcePath, sourcePath.replace("distant", "different"), sourcePath];
  for (const [index, path] of paths.entries()) {
    const tool = nativeTool({ name: "read", id: String(index), args: { path }, definition });
    tool.updateResult({ content: [{ type: "text", text: "one\ntwo" }], isError: false });
    chat.addChild(tool);
  }
  const detach = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
  try {
    const group = detach.targets().find(target => target.kind === "group")!;
    expect(group.label).toContain("Read 2 files (3 reads, 6 lines)");
    group.setExpanded(true);
    const labels = detach.targets().filter(target => target.kind === "tool").map(target => target.label);
    expect(labels).toHaveLength(3);
    expect(new Set(labels).size).toBe(1);
    expect(labels[0]).toContain("packages/…/src/near/index.ts");
  } finally { detach(); }
});
