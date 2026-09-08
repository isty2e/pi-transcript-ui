import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createEditToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { attachTranscriptPresentation } from "../../src/wiring.js";

it.each(["dark", "light"])("uses actual edit results and %s theme without changing the native body", async (themeName) => {
  initTheme(themeName, false);
  const dir = await mkdtemp(join(tmpdir(), "edit-delta-"));
  let dispose: (() => void) | undefined;
  try {
    await writeFile(join(dir, "sample.txt"), "first\r\nunchanged\r\nlast\r\n");
    const args = { path: "sample.txt", edits: [{ oldText: "first", newText: "changed\nextra" }, { oldText: "last", newText: "final" }] };
    const definition = createEditToolDefinition(dir);
    const result = await definition.execute("edit-fixture", args, undefined, undefined, {} as never);
    expect(await readFile(join(dir, "sample.txt"), "utf8")).toBe("changed\r\nextra\r\nunchanged\r\nfinal\r\n");
    const tool = new ToolExecutionComponent("edit", "edit-fixture", args, {}, definition, { requestRender: vi.fn() } as never, dir);
    tool.updateResult({ ...result, isError: false }); tool.setExpanded(true);
    const native = tool.render(100);
    const chat = new Container(), root = new Container(); chat.addChild(tool); root.addChild(chat);
    dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
    const lines = tool.render(100);
    expect(stripTerminalSequences(lines[1]!)).toContain("Edit sample.txt (+3 -2)");
    expect(lines[1]).toContain(theme.fg("toolDiffAdded", "+3"));
    expect(lines[1]).toContain(theme.fg("toolDiffRemoved", "-2"));
    expect(lines.slice(2)).toEqual(native);
    for (const width of [12, 35, 80, 240]) expect(visibleWidth(tool.render(width)[1]!)).toBeLessThanOrEqual(Math.min(width, 120));
    tool.updateResult({ ...result, isError: false }, true);
    expect(stripTerminalSequences(tool.render(100)[1]!)).not.toContain("(+3 -2)");
    tool.updateResult({ content: result.content, isError: false });
    expect(stripTerminalSequences(tool.render(100)[1]!)).not.toContain("(1 line)");
    tool.updateResult({ ...result, isError: true });
    expect(stripTerminalSequences(tool.render(100)[1]!)).toContain("error");
    expect(stripTerminalSequences(tool.render(100)[1]!)).not.toContain("(+3 -2)");
    tool.updateResult({ ...result, isError: false });
    const second = new ToolExecutionComponent("edit", "unsupported-fixture", args, {}, definition, { requestRender: vi.fn() } as never, dir);
    second.updateResult({ content: [{ type: "text", text: "No patch metadata" }], isError: false });
    chat.addChild(second);
    expect(stripTerminalSequences(tool.render(100)[2]!)).toContain("  ▾ Edit sample.txt (+3 -2)");
    expect(tool.render(100).slice(3)).toEqual(native);
    expect(stripTerminalSequences(second.render(100)[0]!)).not.toContain("(1 line)");
    for (const width of [12, 35, 80, 240]) expect(visibleWidth(tool.render(width)[2]!)).toBeLessThanOrEqual(Math.min(width, 120));
  } finally { dispose?.(); await rm(dir, { recursive: true, force: true }); }
});
