import { expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { Container, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { initTheme, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { attachTranscriptPresentation, type NativeToolComponent } from "../../src/wiring.js";

const source = process.env["PI_ALT_COMPOSITOR_SOURCE"];

it.skipIf(!source).each(["exec_command", "write_stdin"])("keeps %s disclosure reachable through compositor SGR clicks", async name => {
  const load = (file: string) => import(pathToFileURL(join(source!, "src", file)).href);
  const [{ ComponentRangeMapper }, { CollapseController }, { MouseHandler }, { SelectionManager }] = await Promise.all([
    load("terminal/range-mapper.ts"), load("collapse/collapse-controller.ts"), load("terminal/mouse-handler.ts"), load("terminal/selection-manager.ts"),
  ]);
  initTheme();

  for (const phase of ["done", "pending", "hidden", "intent"]) {
    const parameters = name === "exec_command"
      ? { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] }
      : { type: "object", properties: { session_id: { type: "number" }, chars: { type: "string" } }, required: ["session_id"] };
    const def: ToolDefinition = { name, label: name, description: "Shell fixture", parameters: parameters as ToolDefinition["parameters"],
      execute: vi.fn(async () => ({ content: [], details: {} })),
      renderCall: () => new Text(phase === "hidden" ? "" : "Native title\ncomplete source", 0, 0),
      renderResult: () => new Text(phase === "hidden" ? "" : "Native output", 0, 0) };
    const args = name === "exec_command" ? { cmd: "npm test" } : { session_id: 73 };
    const tool = new ToolExecutionComponent(name, phase, args, {}, def, { requestRender: vi.fn() } as never, "/tmp") as unknown as NativeToolComponent;
    if (phase !== "pending") tool.updateResult({ content: [{ type: "text", text: "receipt" }], isError: false });
    tool.setExpanded(true);
    const native = tool.render(100);
    tool.setExpanded(false);

    const root = new Container(), chat = new Container(); root.addChild(chat); chat.addChild(tool);
    const dispose = attachTranscriptPresentation(root, { getTheme: () => ({ bold: value => value, fg: (_kind, value) => value }),
      requestRender: vi.fn(), ...(phase === "intent" ? { resolveIntent: () => "Checking tests" } : {}) });
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
      const label = name === "exec_command" ? "Run npm test" : "Check output";
      const row = lines().findIndex(line => line.includes(label));
      expect(row).toBeGreaterThanOrEqual(0);
      click(row);
      expect(tool.expanded).toBe(true);
      expect(lines()[0]).toBe("");
      expect(lines()[1]).toContain(`▾ ${label}`);
      expect(lines().slice(2)).toEqual(native);
      if (phase !== "hidden" && phase !== "pending") expect(lines().filter(line => line.includes("Native output"))).toHaveLength(1);
      if (phase === "intent") expect(lines().join("\n")).toContain("Checking tests");

      const fold = lines().findIndex(line => /▾|Native title/.test(stripTerminalSequences(line)));
      expect(fold).toBeGreaterThanOrEqual(0);
      click(fold);
      expect(tool.expanded).toBe(false);
      expect(lines().join("\n")).toContain(label);
      expect(tool.args).toBe(args);
      expect(def.execute).not.toHaveBeenCalled();
    } finally { dispose(); }
  }
});
