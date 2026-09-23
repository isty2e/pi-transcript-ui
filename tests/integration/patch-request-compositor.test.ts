import { expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { Container, Text } from "@earendil-works/pi-tui";
import { initTheme, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { attachTranscriptPresentation, type NativeToolComponent } from "../../src/wiring.js";

const source = process.env["PI_ALT_COMPOSITOR_SOURCE"];
it.skipIf(!source)("maps regrouped patch requests to one native body per call through compositor SGR clicks", async () => {
  const load = (path: string) => import(pathToFileURL(join(source!, "src", path)).href);
  const [{ ComponentRangeMapper }, { CollapseController }, { MouseHandler }, { SelectionManager }] = await Promise.all([
    load("terminal/range-mapper.ts"), load("collapse/collapse-controller.ts"), load("terminal/mouse-handler.ts"), load("terminal/selection-manager.ts"),
  ]);
  initTheme();
  const def: ToolDefinition = {
    name: "apply_patch", label: "Patch", description: "Fixture",
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
    execute: vi.fn(async () => ({ content: [], details: undefined })),
    renderCall: () => new Text("Native call", 0, 0),
    renderResult: result => new Text(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"), 0, 0),
  };
  const chat = new Container(), document = new Container(), root = new Container();
  document.addChild(new Container()); document.addChild(new Container()); document.addChild(chat); root.addChild(document);
  const args = (id: string) => ({ input: `*** Begin Patch\n*** Add File: ${id}.txt\n+one\n*** End Patch` });
  const members = ["a", "b", "c"].map(id => {
    const member = new ToolExecutionComponent("apply_patch", id, id === "b" ? {} : args(id), {}, def, { requestRender: vi.fn() } as never, "/tmp");
    member.updateResult({ content: [{ type: "text", text: `PATCH_BODY_${id}` }], isError: false });
    chat.addChild(member);
    return member as unknown as NativeToolComponent;
  });
  const dispose = attachTranscriptPresentation(root, { getTheme: () => ({ bold: value => value, fg: (_kind, value) => value }), requestRender: vi.fn() });
  const mapper = new ComponentRangeMapper(), collapse = new CollapseController();
  const lines = () => root.render(100);
  let ranges: { component: object; startLine: number; lineCount: number }[] = [];
  const refresh = () => { mapper.clear(); ranges = mapper.buildRanges(root.children, 100, 0, 200, 0); };
  const handler = new MouseHandler({
    selectionManager: new SelectionManager(), modeManager: { pauseMouseReportingForContextMenu: vi.fn() }, collapseState: collapse,
    onCopySelection: null, getRootComponentPathAtLine: (line: number) => ranges.filter(range => line >= range.startLine && line < range.startLine + range.lineCount),
    getRootLines: lines, getVisibleClusterLines: () => [], scrollBy: vi.fn(), repaint: refresh,
  });
  const click = (line: number) => {
    refresh();
    for (const final of ["M", "m"]) handler.handleMousePacket({ code: 0, row: line + 1, col: 2, final }, 0, 200, lines(), [], 100, 0, 0);
  };
  try {
    expect(dispose.targets().filter(target => target.kind === "group")).toHaveLength(0);
    members[1]!.updateArgs(args("b"));
    expect(lines()).toEqual(["", "▸ Edited 3 calls (requested 3 targets: +3 -0)"]);
    click(1);
    for (const member of members) {
      const row = lines().findIndex(line => line.includes(`${member.toolCallId}.txt`));
      expect(row).toBeGreaterThan(1);
      click(row);
      expect(member.expanded).toBe(true);
      expect(lines().filter(line => line.includes(`PATCH_BODY_${member.toolCallId}`))).toHaveLength(1);
      expect(members.filter(value => value.expanded)).toHaveLength(1);
      click(row);
      expect(member.expanded).toBe(false);
    }
    chat.removeChild(members[1]!);
    expect(lines()[1]).toBe("▾ Edited 2 calls (requested 2 targets: +2 -0)");
    click(1);
    expect(lines()).toEqual(["", "▸ Edited 2 calls (requested 2 targets: +2 -0)"]);
    members[0]!.setExpanded(true);
    expect(members[0]!.expanded).toBe(false);
    expect(def.execute).not.toHaveBeenCalled();
  } finally { dispose(); }
});
