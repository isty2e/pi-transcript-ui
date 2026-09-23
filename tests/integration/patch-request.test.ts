import { expect, it, vi } from "vitest";
import { Container, Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, initTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { generateUnifiedPatch } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { attachTranscriptPresentation, type NativeToolComponent } from "../../src/wiring.js";
import type { ToolGroupingRules } from "../../src/classify.js";
import { ToolNavigation } from "../../src/navigation.js";
import { nativeTool, nativeTranscript } from "./fixtures/native-components.js";

const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const input = patch("*** Update File: src/a.ts", "@@", " context", "-old", "+new");
const receipt = (isError = false) => ({ content: [{ type: "text" as const, text: "native receipt\nsecond line\n" }], isError, details: { arbitrary: "provider-owned" } });
const text = (chat: Container, width = 120) => stripTerminalSequences(chat.render(width).join("\n"));
const attach = (root: Container, rules?: ToolGroupingRules) => attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), rules: rules ?? null });

function definition(key = "input", name = "apply_patch"): ToolDefinition {
  return {
    name, label: "Native patch", description: "Fixture patch producer",
    parameters: { type: "object", properties: { [key]: { type: "string" } }, required: [key] } as ToolDefinition["parameters"],
    execute: vi.fn(async () => receipt()),
    renderCall: () => new Text("Native call renderer", 0, 0),
    renderResult: result => new Text(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"), 0, 0),
  };
}
function tool(id: string, args: unknown = { input }, def = definition()) {
  return nativeTool({ name: def.name, id, args, definition: def }) as unknown as NativeToolComponent;
}

it.each(["dark", "light"])("preserves native bodies, status and object identities in %s", themeName => {
  initTheme(themeName, false);
  for (const [key, name] of [["input", "apply_patch"], ["patchText", "renamed_patch"], ["patch", "external_patch"]]) {
    const def = definition(key, name);
    const args = { [key!]: input, displaySummary: "Adjust configuration" };
    const result = receipt();
    const component = tool("a", args, def);
    const { root, chat } = nativeTranscript();
    component.updateResult(result);
    component.setExpanded(true);
    const widths = [1, 5, 20, 40, 80, 120, 240];
    const nativeRows = new Map(widths.map(width => [width, component.render(width)]));
    chat.addChild(component);
    const dispose = attach(root);
    try {
      expect(text(chat)).toContain("Patch src/a.ts (requested +1 -1) — Adjust configuration");
      for (const width of widths) {
        const rows = component.render(width);
        expect(rows.slice(2)).toEqual(nativeRows.get(width));
        expect(rows.slice(0, 2).every(row => visibleWidth(row) <= Math.min(width, 120))).toBe(true);
      }
      const native = component as unknown as NativeToolComponent;
      expect(native.args).toBe(args);
      expect(native.result).toBe(result);
      expect(native.toolDefinition).toBe(def);
      expect(def.execute).not.toHaveBeenCalled();
    } finally { dispose(); }
    expect(component.render(120)).toEqual(nativeRows.get(120));
  }
});

it("keeps requested deltas distinct from arbitrary receipt fields and call-level errors", () => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const component = tool("a");
  chat.addChild(component);
  const dispose = attach(root);
  try {
    expect(text(chat)).toContain("Patch src/a.ts (requested +1 -1)…");
    const result = { ...receipt(), details: { patch: generateUnifiedPatch("a", "old\n", "one\ntwo\nthree\n"), status: "partial_failure" } };
    component.updateResult(result, true);
    expect(text(chat)).toContain("(requested +1 -1)…");
    component.updateResult(result);
    expect(text(chat)).toContain("Patch src/a.ts (requested +1 -1)");
    expect(text(chat)).not.toContain("+3");
    expect(text(chat)).not.toContain("— error");
    component.updateResult({ ...result, isError: true });
    expect(text(chat)).toContain("Patch src/a.ts — error (requested +1 -1)");
    expect(text(chat)).not.toContain("(3 lines)");
  } finally { dispose(); }
});

it("groups native calls rather than targets, with request-only aggregates and unknown deletion size", () => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const a = tool("a", { input: patch("*** Add File: one", "+one", "*** Add File: two", "+two") });
  const b = tool("b");
  chat.addChild(a); chat.addChild(b);
  const dispose = attach(root);
  try {
    expect(text(chat).split("\n")[1]).toBe("▾ Editing 2 calls (requested 3 targets: +3 -1)…");
    a.updateResult(receipt()); b.updateResult(receipt());
    expect(text(chat)).toBe("\n▸ Edited 2 calls (requested 3 targets: +3 -1)");
    b.updateResult(receipt(true));
    expect(text(chat)).toBe("\n▸ Edited 2 calls — 1 failed (requested 3 targets: +3 -1)");
    b.updateArgs({ input: patch("*** Delete File: old") });
    expect(text(chat)).toBe("\n▸ Edited 2 calls — 1 failed (requested 3 targets)");
    dispose.targets()[0]!.setExpanded(true);
    expect(dispose.targets()).toHaveLength(3);
    expect(text(chat)).toContain("Patch old — error (requested)");
  } finally { dispose(); }
});

it("never adds request counts to applied edit totals in mixed mutation groups", () => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const edit = nativeTool({ id: "edit", name: "edit", definition: createEditToolDefinition("/tmp"), args: { path: "a", edits: [{ oldText: "old", newText: "new" }] } });
  edit.updateResult({ ...receipt(), details: { patch: generateUnifiedPatch("a", "old\n", "new\n") } });
  const request = tool("patch", { input: patch("*** Add File: b", "+one", "+two") });
  request.updateResult(receipt());
  chat.addChild(edit); chat.addChild(request);
  const dispose = attach(root);
  try {
    expect(text(chat)).toBe("\n▸ Edited 2 calls (partial 1/2: +1 -1)");
    dispose.targets()[0]!.setExpanded(true);
    expect(text(chat)).toContain("Patch b (requested +2 -0)");
  } finally { dispose(); }
});

it("regroups on streamed argument completion, revocation and same-object updates", () => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const a = tool("a"), b = tool("b", {}), c = tool("c");
  for (const member of [a, b, c]) { member.updateResult(receipt()); chat.addChild(member); }
  const dispose = attach(root);
  try {
    expect(dispose.targets().filter(target => target.kind === "group")).toHaveLength(0);
    b.updateArgs({ input: input.slice(0, -6) });
    expect(dispose.targets().filter(target => target.kind === "group")).toHaveLength(0);
    const args = { input };
    b.updateArgs(args);
    expect(text(chat)).toBe("\n▸ Edited 3 calls (requested 3 targets: +3 -3)");
    args.input = "invalid";
    b.updateArgs(args);
    expect(dispose.targets().filter(target => target.kind === "group")).toHaveLength(0);
    args.input = input;
    b.updateArgs(args);
    expect(text(chat)).toContain("Edited 3 calls");
    chat.removeChild(b);
    expect(text(chat)).toBe("\n▸ Edited 2 calls (requested 2 targets: +2 -2)");
    chat.clear();
    expect(dispose.targets()).toHaveLength(0);
    chat.addChild(b);
    expect(text(chat)).toBe("\n▸ Patch src/a.ts (requested +1 -1)");
  } finally { dispose(); }
});

it.each(["standalone", "mutation", "read"] as const)("preserves explicit %s grouping rules without redefining request evidence", rule => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const a = tool("a"), b = tool("b");
  for (const member of [a, b]) { member.updateResult(receipt()); chat.addChild(member); }
  const dispose = attach(root, { apply_patch: rule });
  try {
    if (rule === "standalone") {
      expect(dispose.targets()).toHaveLength(2);
      expect(text(chat).match(/Patch src\/a.ts/g)).toHaveLength(2);
    } else {
      expect(text(chat)).toContain(`${rule === "read" ? "Exploration" : "Edited"} 2 calls (requested 2 targets: +2 -2)`);
    }
    expect(text(chat)).not.toContain("2 files");
    expect(text(chat)).not.toContain("(6 lines)");
  } finally { dispose(); }
});

it("renders structured single-file requests without confusing them with native edits", () => {
  initTheme();
  const def = definition();
  def.parameters = { type: "object", properties: { type: { type: "string" }, path: { type: "string" }, diff: { type: "string" } }, required: ["type", "path"] };
  const { root, chat } = nativeTranscript();
  const component = tool("a", { type: "create_file", path: "a.txt", diff: "+one\n+two" }, def);
  component.updateResult(receipt()); chat.addChild(component);
  const dispose = attach(root);
  try {
    expect(text(chat)).toContain("Patch a.txt (requested +2 -0)");
    component.updateArgs({ type: "delete_file", path: "a.txt" });
    expect(text(chat)).toContain("Patch a.txt (requested)");
    component.updateArgs({ type: "update_file", path: "a.txt", diff: "@@\n-old\n+new" });
    expect(text(chat)).toContain("Patch a.txt (requested +1 -1)");
  } finally { dispose(); }
});

it("preserves visible native bodies and keyboard targets when argument updates create a group", () => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const a = tool("a", {}), b = tool("b");
  for (const member of [a, b]) { member.updateResult(receipt()); chat.addChild(member); }
  const dispose = attach(root);
  const navigation = new ToolNavigation(dispose.targets);
  try {
    a.setExpanded(true);
    a.updateArgs({ input });
    expect(dispose.targets()[0]!.expanded).toBe(true);
    expect(text(chat)).toContain("native receipt");
    navigation.act("up");
    navigation.act("left");
    expect(a.expanded).toBe(false);
    navigation.act("right");
    expect(a.expanded).toBe(true);
    navigation.act("left");
    b.updateArgs({});
    expect(navigation.view().targets).toContain(navigation.view().selected);
    for (const member of [a, b]) member.setExpanded(true);
    b.updateArgs({ input });
    expect(dispose.targets()[0]!.expanded).toBe(true);
    expect(text(chat).match(/native receipt/g)).toHaveLength(2);
    dispose.targets()[0]!.setExpanded(false);
    const c = tool("c", {});
    c.updateResult(receipt()); chat.addChild(c);
    c.updateArgs({ input });
    expect(dispose.targets()[0]!.expanded).toBe(false);
    expect(text(chat)).not.toContain("native receipt");
  } finally { dispose(); }
});

it("keeps incomplete, conflicting and unsupported schemas on existing fallback", () => {
  initTheme();
  for (const [args, def] of [
    [{ input: "not a patch" }, definition()],
    [{ input, patch: input }, definition()],
    [{ input }, { ...definition(), parameters: { type: "string" } as ToolDefinition["parameters"] }],
  ] as const) {
    const { root, chat } = nativeTranscript();
    const a = tool("a", args, def), b = tool("b", args, def);
    a.updateResult(receipt()); b.updateResult(receipt());
    chat.addChild(a); chat.addChild(b);
    const dispose = attach(root);
    expect(text(chat)).toContain("apply_patch (3 lines)");
    expect(text(chat)).not.toContain("requested");
    expect(dispose.targets()).toHaveLength(2);
    dispose();
  }
});

it("preserves existing read/write schema boundaries when patch-like arguments coexist", () => {
  initTheme();
  for (const native of [createReadToolDefinition("/tmp"), createWriteToolDefinition("/tmp")]) for (const hybrid of [false, true]) {
    const def = { ...native, name: "apply_patch", parameters: hybrid
      ? { ...native.parameters, properties: { ...native.parameters.properties, input: { type: "string" } } }
      : native.parameters } as ToolDefinition;
    const { root, chat } = nativeTranscript();
    const component = tool("a", { path: "a", content: "hello", input }, def);
    component.updateResult(receipt()); chat.addChild(component);
    const dispose = attach(root);
    expect(text(chat)).not.toContain("requested");
    expect(text(chat)).toContain(native.name === "read" ? (hybrid ? "apply_patch (3 lines)" : "Read a") : "Write a");
    dispose();
  }
});

it("keeps requested provenance before visible +/- at every narrow width", () => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const a = tool("a"), b = tool("b");
  for (const member of [a, b]) { member.updateResult(receipt()); chat.addChild(member); }
  const dispose = attach(root);
  try {
    expect(dispose.targets()[0]?.kind).toBe("group");
    for (const expanded of [false, true]) {
      dispose.targets()[0]!.setExpanded(expanded);
      for (let width = 1; width <= 120; width++) {
        for (const row of chat.render(width)) {
          const plain = stripTerminalSequences(row);
          expect(visibleWidth(row)).toBeLessThanOrEqual(width);
          if (/[+-]\d/.test(plain)) expect(plain).toContain("requested");
        }
      }
    }
  } finally { dispose(); }
});

it("recreates request views on reattachment and cannot repopulate released parser state", () => {
  initTheme();
  const def = definition();
  const parameters = def.parameters;
  const readSchema = vi.fn(() => parameters);
  Object.defineProperty(def, "parameters", { get: readSchema });
  const readInput = vi.fn(() => input);
  const args = Object.defineProperty({}, "input", { enumerable: true, get: readInput });
  const { root, chat } = nativeTranscript();
  const component = tool("a", args, def);
  component.updateResult(receipt()); chat.addChild(component);
  let dispose = attach(root);
  expect(text(chat)).toContain("requested +1 -1");
  const staleUpdate = (component as unknown as NativeToolComponent).updateDisplay;
  const staleRow = (component as unknown as NativeToolComponent).children.at(-1)!;
  dispose();
  const reads = readInput.mock.calls.length;
  staleUpdate(); staleRow.render(120);
  expect(readInput).toHaveBeenCalledTimes(reads);
  expect(readSchema).toHaveBeenCalledTimes(1);
  dispose = attach(root);
  try {
    expect(readSchema).toHaveBeenCalledTimes(2);
    expect(text(chat)).toContain("requested +1 -1");
  } finally { dispose(); }
});
