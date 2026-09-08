import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createWriteToolDefinition, createBashToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { attachTranscriptPresentation } from "../../src/wiring.js";
const theme = { bold: (s: string) => s, fg: (_kind: string, s: string) => s };

it("uses real Write contents, keeps native bodies, and handles partial/error/recovery and changed args", async () => {
  initTheme();
  const dir = await mkdtemp(join(tmpdir(), "write-lines-"));
  const root = new Container(), chat = new Container(); root.addChild(chat);
  let detach = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
  try {
    const definition = { ...createWriteToolDefinition(dir), name: "renamed_writer" };
    const args = { path: "file.txt", content: "a\nb\nc\n" };
    const output = await definition.execute("write", args, undefined, undefined, {} as never);
    expect(await readFile(join(dir, args.path), "utf8")).toBe(args.content);
    const tool = new ToolExecutionComponent(definition.name, "write", args, {}, definition, { requestRender: vi.fn() } as never, dir);
    tool.updateResult({ ...output, isError: false }); tool.setExpanded(true);
    const widths = [1, 12, 48, 120, 180];
    const native = new Map(widths.map(w => [w, tool.render(w)]));
    chat.addChild(tool);
    const summary = () => stripTerminalSequences(tool.render(120).slice(0, 2).join("\n"));
    expect(summary()).toContain('Write file.txt (3 lines)');
    for (const width of widths) {
      expect(tool.render(width).slice(2)).toEqual(native.get(width));
      expect(tool.render(width).slice(0, 2).every(s => visibleWidth(s) <= Math.min(width, 120))).toBe(true);
    }
    tool.updateResult({ ...output, isError: true });
    expect(summary()).toContain('— error'); expect(summary()).not.toContain('3 lines');
    tool.updateResult({ ...output, isError: false }, true);
    expect(summary()).not.toContain('3 lines');
    args.content = '';
    const emptyOutput = await definition.execute('empty', args, undefined, undefined, {} as never);
    expect(await readFile(join(dir, args.path), 'utf8')).toBe('');
    tool.updateResult({ ...emptyOutput, isError: false });
    expect(summary()).toContain('(0 lines)');
    detach();
    detach = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
    expect(summary()).toContain('(0 lines)');
    tool.updateArgs({ path: 'file.txt', content: undefined });
    expect(summary()).not.toMatch(/\(\d+ lines?\)/);
  } finally { detach(); await rm(dir, { recursive: true, force: true }); }
});

it("does not sum Write receipts when writers are explicitly grouped as exploration", () => {
  initTheme();
  const root = new Container(), chat = new Container(); root.addChild(chat);
  for (const id of ['one', 'two']) {
    const definition = { ...createWriteToolDefinition('/tmp'), name: 'writer' };
    const tool = new ToolExecutionComponent('writer', id, { path: id, content: 'a\nb' }, {}, definition, { requestRender: vi.fn() } as never, '/tmp');
    tool.updateResult({ content: [{ type: 'text', text: 'receipt' }], isError: false }); chat.addChild(tool);
  }
  const detach = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), rules: { writer: 'explore' } });
  try {
    expect(stripTerminalSequences(chat.render(120).join('\n'))).toBe('\n▸ Exploration 2 calls');
    detach.targets()[0]!.setExpanded(true);
    expect(stripTerminalSequences(chat.render(120).join('\n'))).toContain('Write one (2 lines)');
  } finally { detach(); }
});

it.each([false, true])("removes Bash output totals including failures and explicitly grouped calls (%s)", grouped => {
  initTheme();
  const root = new Container(), chat = new Container(); root.addChild(chat);
  const tools = [0, 1].map(i => {
    const tool = new ToolExecutionComponent('bash', String(i), { command: 'echo example' }, {}, createBashToolDefinition('/tmp'), { requestRender: vi.fn() } as never, '/tmp');
    tool.updateResult({ content: [{ type: 'text', text: 'a\nb\nc' }], isError: i === 1 });
    chat.addChild(tool); return tool;
  });
  const detach = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), ...(grouped ? { rules: { bash: 'explore' as const } } : {}) });
  try {
    for (const tool of tools) {
      const summary = stripTerminalSequences(tool.render(120).slice(0, grouped && tool === tools[0] ? 3 : 2).join('\n'));
      expect(summary).not.toMatch(/\(\d+ lines?\)/);
    }
    expect(stripTerminalSequences(chat.render(120).join('\n'))).toContain(grouped ? '1 failed' : 'error');
  } finally { detach(); }
});
