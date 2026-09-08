import { expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { Container, Text } from "@earendil-works/pi-tui";
import { initTheme, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { attachTranscriptPresentation, type NativeToolComponent } from "../../src/wiring.js";

const source = process.env["PI_ALT_COMPOSITOR_SOURCE"];
// Executes the installed delegate's actual mapper + SGR mouse + collapse code;
// intentionally not labeled a terminal-screen test.
it.skipIf(!source)("routes SGR clicks to independent group and every actual member through the installed delegate", async () => {
  const load = (path: string) => import(pathToFileURL(join(source!, "src", path)).href);
  const [{ ComponentRangeMapper }, { CollapseController }, { MouseHandler }, { SelectionManager }] = await Promise.all([
    load("terminal/range-mapper.ts"), load("collapse/collapse-controller.ts"), load("terminal/mouse-handler.ts"), load("terminal/selection-manager.ts"),
  ]);
  initTheme();
  const def: ToolDefinition = {
    name: "read", label: "Read", description: "fixture", parameters: { type: "object" }, execute: async () => ({ content: [], details: undefined }),
    renderCall: () => new Text("CUSTOM CALL", 0, 0), renderResult: () => new Text("CUSTOM RESULT", 0, 0),
  };
  const chat = new Container();
  const document = new Container();
  document.addChild(new Container());
  document.addChild(new Container());
  document.addChild(chat);
  const root = new Container();
  root.addChild(document);
  const dispose = attachTranscriptPresentation(root, { getTheme: () => ({ bold: (s) => s, fg: (_k, s) => s }), requestRender: vi.fn() });
  const members = ["first", "second", "third"].map((id) => {
    const tool = new ToolExecutionComponent("read", id, { path: `${id}.txt` }, {}, def, { requestRender: vi.fn() } as never, "/tmp");
    chat.addChild(tool);
    tool.updateResult({ content: [{ type: "text", text: id }], isError: false });
    return tool as unknown as NativeToolComponent;
  });
  const mapper = new ComponentRangeMapper(); const collapse = new CollapseController();
  const getLines = () => root.render(100);
  let ranges: { component: object; startLine: number; lineCount: number }[] = [];
  const refresh = () => { mapper.clear(); ranges = mapper.buildRanges(root.children, 100, 0, 200, 0); };
  const handler = new MouseHandler({
    selectionManager: new SelectionManager(), modeManager: { pauseMouseReportingForContextMenu: vi.fn() }, collapseState: collapse,
    onCopySelection: null, getRootComponentPathAtLine: (line: number) => ranges.filter((r) => line >= r.startLine && line < r.startLine + r.lineCount),
    getRootLines: getLines, getVisibleClusterLines: () => [], scrollBy: vi.fn(), repaint: refresh,
  });
  const click = (line: number) => {
    refresh();
    for (const final of ["M", "m"]) {
      handler.handleMousePacket({ code: 0, row: line + 1, col: 2, final }, 0, 200, getLines(), [], 100, 0, 0);
    }
  };
  try {
    expect(getLines()).toEqual(["", "▸ Read 3 files"]);
    click(1);
    expect(getLines()).toHaveLength(5);
    expect(members.every((tool) => !tool.expanded)).toBe(true);
    for (const member of members) {
      const line = getLines().findIndex((text) => text.includes(`${member.toolCallId}.txt`));
      expect(line).toBeGreaterThan(0);
      click(line);
      expect(member.expanded).toBe(true);
      expect(getLines()[1]).toBe("▾ Read 3 files");
      expect(getLines().join("\n")).toContain("CUSTOM RESULT");
      click(line);
      expect(member.expanded).toBe(false);
    }
    click(1);
    expect(getLines()).toEqual(["", "▸ Read 3 files"]);
    // Mouse-only policy preserves the delegate's per-item override of native bulk changes.
    members[0]!.setExpanded(true);
    expect(members[0]!.expanded).toBe(false);
    expect(getLines()).toEqual(["", "▸ Read 3 files"]);
    click(1);
    expect(getLines()[1]).toBe("▾ Read 3 files");
  } finally { dispose(); }
});
