import { expect, it, vi } from "vitest";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { attachTranscriptPresentation, styleLine } from "../../src/wiring.js";

const patch = "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n";
const result = (text = "a\nb", isError = false) => ({ content: [{ type: "text", text }], isError });
function fixture(kind: "read" | "write" | "edit", paths: string[]) {
  initTheme();
  const root = new Container(), chat = new Container(); root.addChild(chat);
  const def = kind === "read" ? createReadToolDefinition("/tmp") : kind === "write" ? createWriteToolDefinition("/tmp") : createEditToolDefinition("/tmp");
  const tools = paths.map((path, i) => {
    const tool = new ToolExecutionComponent(kind, String(i), { path, content: "text", edits: [{ oldText: "old", newText: "new" }] }, {}, def, { requestRender: vi.fn() } as never, "/tmp");
    tool.updateResult(result()); chat.addChild(tool); return tool;
  });
  const fg = vi.fn((_kind: string, text: string) => text);
  const attach = () => attachTranscriptPresentation(root, { getTheme: () => ({ bold: s => s, fg }), requestRender: vi.fn() });
  return { chat, tools, fg, attach, header: (width = 120) => stripTerminalSequences(chat.render(width)[1]!) };
}

it("shows final failures before partial Read totals, and updates on recovery, pending results, removal and reattach", () => {
  const f = fixture("read", ["a", "b", "c"]);
  const failure = result("failed", true); f.tools[2]!.updateResult(failure);
  let detach = f.attach();
  expect(f.header()).toBe("▸ Read 3 files — 1 failed (partial 2/3: 4 lines)");
  expect(f.fg).toHaveBeenCalledWith("error", "1 failed");
  f.tools[2]!.updateResult(failure, true);
  expect(f.header()).toBe("▾ Reading 3 files (partial 2/3: 4 lines)…");
  f.tools[2]!.updateResult(failure, false);
  failure.isError = false; failure.content[0]!.text = "c\nd";
  expect(f.header()).toContain("Read 3 files (6 lines)");
  failure.isError = true;
  detach(); detach = f.attach();
  expect(f.header()).toContain("— 1 failed (partial 2/3: 4 lines)");
  f.chat.removeChild(f.tools[2]!);
  expect(f.header()).toBe("▸ Read 2 files (4 lines)");
  detach();
});

it("omits unavailable Read totals but retains read multiplicity, failures and genuinely known zero", () => {
  const f = fixture("read", ["same", "same"]);
  f.tools.forEach(tool => tool.updateResult(result("Read image file [image/png]")));
  const detach = f.attach();
  expect(f.header()).toBe("▸ Read 1 file (2 reads)");
  f.tools[1]!.updateArgs({ path: "other" });
  expect(f.header()).toBe("▸ Read 2 files");
  f.tools[1]!.updateArgs({ path: "same" });
  f.tools.forEach(tool => tool.updateResult(result("failed", true)));
  expect(f.header()).toBe("▸ Read 1 file — 2 failed (2 reads)");
  f.tools[0]!.updateResult(result(""));
  expect(f.header()).toBe("▸ Read 1 file — 1 failed (partial 1/2: 2 reads, 0 lines)");
  f.tools[1]!.updateResult(result(""));
  expect(f.header()).toBe("▸ Read 1 file (2 reads, 0 lines)");
  detach();
});

it("does not replace unavailable Write counts with zero coverage or completion-message line counts", () => {
  const f = fixture("write", ["a", "b"]);
  const detach = f.attach();
  expect(f.header()).toBe("▸ Edited 2 calls");
  f.tools[1]!.updateResult(result("failure", true));
  expect(f.header()).toBe("▸ Edited 2 calls — 1 failed");
  f.tools[1]!.updateResult(result("working"), true);
  expect(f.header()).toBe("▾ Editing 2 calls…");
  detach();
});

it("keeps failure and coverage ahead of every visible patch sum and styles both error and diff spans", () => {
  const f = fixture("edit", ["a", "b"]);
  f.tools[0]!.updateResult({ ...result(), details: { patch } });
  f.tools[1]!.updateResult(result("failed", true));
  const detach = f.attach();
  expect(f.header()).toBe("▸ Edited 2 calls — 1 failed (partial 1/2: +1 -1)");
  expect(f.fg).toHaveBeenCalledWith("error", "1 failed");
  expect(f.fg).toHaveBeenCalledWith("toolDiffAdded", "+1");
  expect(f.fg).toHaveBeenCalledWith("toolDiffRemoved", "-1");
  for (let width = 1; width <= 120; width++) {
    const row = f.header(width);
    expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    if (/[+-]\d/.test(row)) { expect(row).toContain("1 failed"); expect(row).toContain("partial 1/2:"); }
  }
  detach();
});

it("colors only the positional failure span, not matching text in the target or intent", () => {
  const rest = " target-1 failed — 1 failed (partial 1/2: +1 -1) — purpose-1 failed";
  const actual = styleLine({ bold: s => s, fg: (kind, s) => `<${kind}>${s}</${kind}>` }, {
    marker: "▸", action: "Edited", rest,
    failure: { count: 1, offset: rest.indexOf("— ") + 2 },
    change: { added: 1, removed: 1, counted: 1, total: 2, offset: rest.indexOf(" (partial") },
  });
  expect(actual).toBe("▸ Edited target-1 failed — <error>1 failed</error> (partial 1/2: <toolDiffAdded>+1</toolDiffAdded> <toolDiffRemoved>-1</toolDiffRemoved>) — purpose-1 failed");
});
