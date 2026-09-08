import { expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { generateUnifiedPatch } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { attachTranscriptPresentation } from "../../src/wiring.js";
import { defaultSettings, groupingRules } from "../../src/settings.js";
import { nativeTool, nativeTranscript as tree, type NativeToolDefinition } from "./fixtures/native-components.js";

const result = (before = "old\n", after = "new\n") => ({ content: [{ type: "text" as const, text: "success" }], isError: false, details: { patch: generateUnifiedPatch("same.txt", before, after) } });
const text = (chat: Container, width = 120) => stripTerminalSequences(chat.render(width).join("\n"));
function component(def: NativeToolDefinition | undefined, id: string, args: unknown = { path: "same.txt", edits: [{ oldText: "old", newText: "new" }] }, name = def?.name ?? "edit") {
  return nativeTool({ name, id, args, definition: def });
}
const attach = (root: Container) => attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });

it.each(["dark", "light"])("sums renamed native edit/write patches, preserves bodies and %s theme/widths", (themeName) => {
  initTheme(themeName, false);
  const { chat, root } = tree();
  const edit = component({ ...createEditToolDefinition("/tmp"), name: "mcp__replace" }, "a");
  const write = component({ ...createWriteToolDefinition("/tmp"), name: "external_write" }, "b", { path: "same.txt", content: "new\nextra\n" });
  edit.updateResult(result()); write.updateResult(result("new\n", "new\nextra\n"));
  edit.setExpanded(true); write.setExpanded(true);
  chat.addChild(edit); chat.addChild(write);
  const widths = [1, 4, 12, 35, 80, 120, 240];
  const bodies = [edit, write].map((tool) => new Map(widths.map((width) => [width, tool.render(width)])));
  const originalDefinition = (edit as any).toolDefinition;
  let dispose = attach(root);
  try {
    expect(text(chat)).toContain("Edited 2 calls (+2 -1)");
    expect(text(chat)).toContain("Edit same.txt (+1 -1)");
    expect(text(chat)).toContain("Write same.txt (2 lines)");
    expect(chat.render(120)[1]).toContain(theme.fg("toolDiffAdded", "+2"));
    expect(chat.render(120)[1]).toContain(theme.fg("toolDiffRemoved", "-1"));
    for (const width of widths) for (const [index, tool] of [edit, write].entries()) {
      const lines = tool.render(width), prefix = index === 0 ? 3 : 1;
      expect(lines.slice(prefix)).toEqual(bodies[index]!.get(width));
      expect(lines.slice(0, prefix).every((line) => visibleWidth(line) <= Math.min(width, 120))).toBe(true);
    }
    expect((edit as any).toolDefinition).toBe(originalDefinition);
    dispose();
    expect(edit.render(120)).toEqual(bodies[0]!.get(120));
    // Restored/history instances use the same original definition on reattachment.
    dispose = attach(root);
    expect(text(chat)).toContain("(+2 -1)");
    edit.setExpanded(false); write.setExpanded(false);
    dispose.targets()[0]!.setExpanded(false);
    expect(text(chat)).toBe("\n▸ Edited 2 calls (+2 -1)");
  } finally { dispose(); }
});

it("counts native written content, while repeated native edits sum deltas rather than net change", async () => {
  initTheme();
  const dir = await mkdtemp(join(tmpdir(), "file-capability-"));
  const { chat, root } = tree();
  const dispose = attach(root);
  try {
    const path = join(dir, "same.txt");
    await writeFile(path, "original\n");
    const writeDef = createWriteToolDefinition(dir);
    const writeArgs = { path, content: "old\n" };
    const writeResult = await writeDef.execute("w", writeArgs, undefined, undefined, {} as never);
    expect(writeResult.details).toBeUndefined();
    const write = component(writeDef, "w", writeArgs); write.updateResult({ ...writeResult, isError: false }); chat.addChild(write);
    expect(text(chat)).toContain("Write");
    expect(text(chat)).toContain("(1 line)");
    expect(text(chat)).not.toContain("(+");
    const editDef = { ...createEditToolDefinition(dir), name: "renamed_editor" };
    for (const [id, oldText, newText] of [["a", "old", "new"], ["b", "new", "old"]]) {
      const args = { path, edits: [{ oldText: oldText!, newText: newText! }] };
      const output = await editDef.execute(id!, args, undefined, undefined, {} as never);
      const edit = component(editDef, id!, args); edit.updateResult({ ...output, isError: false }); chat.addChild(edit);
    }
    expect(text(chat)).toContain("Edited 3 calls (partial 2/3: +2 -2)");
    chat.removeChild(write);
    expect(text(chat)).toContain("Edited 2 calls (+2 -2)");
  } finally { dispose(); await rm(dir, { recursive: true, force: true }); }
});

it("recomputes partial coverage for running/errors/missing patches, in-place updates and removals", () => {
  initTheme();
  const { chat, root } = tree();
  const def = { ...createEditToolDefinition("/tmp"), name: "external" };
  const a = component(def, "a"), b = component(def, "b"), c = component(def, "c");
  a.updateResult(result()); chat.addChild(a); chat.addChild(b); chat.addChild(c);
  const dispose = attach(root);
  try {
    expect(text(chat)).toContain("Editing 3 calls (partial 1/3: +1 -1)…");
    b.updateResult(result(), true);
    c.updateResult({ ...result(), isError: true });
    expect(text(chat)).toContain("partial 1/3");
    b.updateResult(result());
    expect(text(chat)).toContain("Edited 3 calls — 1 failed (partial 2/3: +2 -2)");
    c.updateResult({ content: [{ type: "text", text: "no metadata" }], isError: false });
    expect(text(chat)).toContain("partial 2/3");
    c.updateResult(result());
    expect(text(chat)).toContain("Edited 3 calls (+3 -3)");
    (c as any).result.details.patch = generateUnifiedPatch("same.txt", "old\n", "new\nextra\n");
    expect(text(chat)).toContain("(+4 -3)");
    (c as any).result.details.patch = "malformed";
    expect(text(chat)).toContain("(partial 2/3: +2 -2)");
    chat.removeChild(a);
    expect(text(chat)).toContain("Edited 2 calls (partial 1/2: +1 -1)");
    b.updateResult({ content: [], isError: false });
    expect(text(chat)).not.toContain("(+");
    chat.clear();
    chat.addChild(b); chat.addChild(c);
    b.updateResult(result("same\n", "same\n")); c.updateResult(result("same\n", "same\n"));
    expect(text(chat)).toContain("Edited 2 calls (+0 -0)");
  } finally { dispose(); }
});

it("keeps partial provenance before every visible group delta under legal narrow row caps", () => {
  initTheme("dark", false);
  const { chat, root } = tree();
  const def = createEditToolDefinition("/tmp");
  const a = component(def, "a"), b = component(def, "b");
  a.updateResult(result()); b.updateResult({ content: [], isError: false });
  chat.addChild(a); chat.addChild(b);
  for (let cap = 1; cap <= 120; cap++) {
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), displayLimits: { rowMaxWidth: cap } });
    try {
      for (const viewport of [1, 12, 35, 80, 240]) {
        const row = stripTerminalSequences(chat.render(viewport)[1]!);
        expect(visibleWidth(row)).toBeLessThanOrEqual(Math.min(viewport, cap));
        if (/[+-]\d/.test(row)) expect(row.indexOf("partial 1/2:")).toBeGreaterThanOrEqual(0);
        if (viewport >= 80 && cap >= 80) expect(row).toContain("Edited 2 calls (partial 1/2: +1 -1)");
      }
    } finally { dispose(); }
  }
});

it("reads the original schema only on attachment while arguments and results stay live", () => {
  initTheme();
  const { chat, root } = tree();
  const definition = { ...createWriteToolDefinition("/tmp"), name: "external_write" };
  const parameters = definition.parameters;
  const readSchema = vi.fn(() => parameters);
  Object.defineProperty(definition, "parameters", { get: readSchema });
  const tool = component(definition, "a", { path: "first.txt", content: "old" });
  tool.updateResult(result()); chat.addChild(tool);
  let dispose = attach(root);
  for (let i = 0; i < 5; i++) expect(text(chat)).toContain("Write first.txt (1 line)");
  expect(readSchema).toHaveBeenCalledTimes(1);
  tool.updateArgs({ path: "second.txt", content: "new" });
  expect(text(chat)).toContain("Write second.txt (1 line)");
  expect(readSchema).toHaveBeenCalledTimes(1);
  dispose(); dispose = attach(root);
  expect(readSchema).toHaveBeenCalledTimes(2);
  expect((tool as any).toolDefinition).toBe(definition);
  dispose();
});

it("keeps read-shaped/definitionless edit tools generic even with patch metadata and explicit mutation grouping", () => {
  initTheme();
  for (const definition of [undefined, { ...createReadToolDefinition("/tmp"), name: "edit" }]) {
    const { chat, root } = tree();
    const a = component(definition, "a"), b = component(definition, "b");
    a.updateResult(result()); b.updateResult(result()); chat.addChild(a); chat.addChild(b);
    let dispose = attach(root);
    expect(text(chat)).not.toContain("(+");
    expect(dispose.targets().filter((t) => t.kind === "group")).toHaveLength(0);
    dispose();
    dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), rules: { edit: "mutation" } });
    expect(text(chat)).toContain(definition ? "Mutation 2 calls (2 lines)" : "Mutation 2 calls");
    expect(text(chat)).not.toContain("files");
    expect(text(chat)).not.toContain("(+");
    dispose.targets()[0]!.setExpanded(true);
    expect(text(chat)).not.toContain("Edit same.txt");
    dispose();
  }
});

it.each(["read", "grep"])("does not mislabel file-changing schemas under saved %s exploration preferences", (name) => {
  initTheme("dark", false);
  const { chat, root } = tree();
  const definition = { ...createWriteToolDefinition("/tmp"), name };
  const write = component(definition, "write", { path: "same.txt", content: "new\n" });
  const other = component(createReadToolDefinition("/tmp"), "read", { path: "same.txt" });
  write.updateResult(result()); other.updateResult({ content: [], isError: false });
  chat.addChild(write); chat.addChild(other);
  let dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), rules: groupingRules(defaultSettings()) });
  try {
    expect(text(chat)).toContain("Exploration 2 calls (partial 1/2: +1 -1)");
    chat.removeChild(other);
    const second = component(definition, "second", { path: "same.txt", content: "next\n" });
    second.updateResult(result()); chat.addChild(second);
    dispose();
    dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), rules: groupingRules(defaultSettings()) });
    expect(text(chat)).toContain("Exploration 2 calls (+2 -2)");
  } finally { dispose(); }
});

it("honors saved custom family and exclusion choices across detach/reload with honest mixed aggregates", () => {
  initTheme();
  const { chat, root } = tree();
  const file = component({ ...createWriteToolDefinition("/tmp"), name: "external" }, "a", { path: "same.txt", content: "new" });
  const unknownDef = { ...createReadToolDefinition("/tmp"), name: "nonfile" };
  const other = component(unknownDef, "b");
  file.updateResult(result()); other.updateResult(result()); chat.addChild(file); chat.addChild(other);
  const settings = defaultSettings(); settings.grouping.mutation.push("external", "nonfile");
  let dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), rules: groupingRules(settings) });
  expect(text(chat)).toContain("Mutation 2 calls (partial 1/2: +1 -1)");
  chat.removeChild(other);
  const second = component({ ...createEditToolDefinition("/tmp"), name: "external" }, "c"); second.updateResult(result()); chat.addChild(second);
  dispose();
  settings.grouping.mutation = settings.grouping.mutation.filter((name) => name !== "external");
  settings.grouping.standalone = ["external"];
  dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), rules: groupingRules(settings) });
  expect(dispose.targets().filter((t) => t.kind === "group")).toHaveLength(0);
  expect(text(chat)).toContain("Write same.txt (1 line)");
  dispose();
  settings.grouping.standalone = []; settings.grouping.exploration.push("external");
  dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), rules: groupingRules(settings) });
  expect(text(chat)).toContain("Exploration 2 calls (+2 -2)");
  dispose();
});
