import { expect, it, vi } from "vitest";
import { Container, Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { attachTranscriptPresentation, type NativeToolComponent } from "../../src/wiring.js";
import { ToolNavigation } from "../../src/navigation.js";
import { nativeTool, nativeTranscript } from "./fixtures/native-components.js";

const call = (name: string, status = "ok") => ({ id: name, name, args: "{}", status, durationMs: 99_000 });
const result = <T>(calls: T, isError = false, durationMs = 1234) => ({
  content: [{ type: "text" as const, text: "Script completed\nWall time 1.2 seconds\nOutput:\n" },
    { type: "text" as const, text: "Actual output" }],
  details: { calls }, isError, durationMs,
});
const text = (chat: Container, width = 120) => stripTerminalSequences(chat.render(width).join("\n"));

function tool(id = "code", args: unknown = { code: "throw new Error('do not execute');" }) {
  const definition: ToolDefinition = {
    name: "codemode", label: "codemode", description: "Recorded codemode fixture",
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    execute: vi.fn(async () => result([])),
    renderCall: () => new Text("Original script renderer", 0, 0),
    renderResult: receipt => new Text(receipt.content.filter(block => block.type === "text").map(block => block.text).join("\n"), 0, 0),
  };
  return nativeTool({ name: "codemode", id, args, definition }) as unknown as NativeToolComponent;
}

it("uses only observed nested calls and final parent time, not source predictions or header lines", () => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const component = tool();
  chat.addChild(component);
  const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
  try {
    expect(text(chat)).toBe("\n▸ Code…");
    component.updateResult(result([]), true);
    expect(text(chat)).toBe("\n▸ Code (0 nested calls so far)…");

    const receipt = result([call("read", "running"), call("read")]);
    component.updateResult(receipt, true);
    expect(text(chat)).toBe("\n▸ Code read ×2 (2 nested calls so far; 1 running)…");
    expect(text(chat)).not.toContain("1.2s");
    receipt.details.calls[0]!.status = "error";
    component.updateResult(receipt, true);
    expect(text(chat)).toContain("2 nested calls so far; 1 error");
    component.updateResult(receipt);
    expect(text(chat)).toBe("\n▸ Code read ×2 (2 nested calls; 1 error; 1.2s)");
    expect(component.result?.isError).toBe(false);
    expect(text(chat)).not.toContain("— error");
    expect(text(chat)).not.toContain("99.0s");

    component.updateResult({ ...receipt, isError: true });
    expect(text(chat)).toBe("\n▸ Code read ×2 — error (2 nested calls; 1 error; 1.2s)");
  } finally { dispose(); }
});

it.each([undefined, null, {}, [call("read"), { name: "bash", status: "new-status" }]].map(calls => ({ calls })))(
  "omits unknown nested activity rather than manufacturing zero: $calls", ({ calls }) => {
    initTheme();
    const { root, chat } = nativeTranscript();
    const component = tool();
    component.updateResult(result(calls));
    chat.addChild(component);
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
    try { expect(text(chat)).toBe("\n▸ Code (1.2s)"); }
    finally { dispose(); }
  },
);

it("preserves empty, cancelled and running records without converting nested status to parent failure", () => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const component = tool();
  chat.addChild(component);
  const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
  try {
    component.updateResult(result([], false, 0));
    expect(text(chat)).toBe("\n▸ Code (0 nested calls; 0ms)");
    component.updateResult(result([call("models.classify", "cancelled"), call("bash", "running")], false, NaN));
    expect(text(chat)).toBe("\n▸ Code models.classify, bash (2 nested calls; 1 running; 1 cancelled)");
  } finally { dispose(); }
});

it.each(["dark", "light"])("keeps the native body, identities, optional intent and bounded rows in %s", themeName => {
  initTheme(themeName, false);
  const { root, chat } = nativeTranscript();
  const args = { code: "tools.not_observed({})", displaySummary: "실제 호출 확인" };
  const component = tool("code", args);
  const receipt = result([call("read"), call("read"), call("bash"), call("models.classify")]);
  component.updateResult(receipt);
  component.setExpanded(true);
  const widths = [0, 1, 5, 24, 40, 80, 120, 240];
  const native = new Map(widths.map(width => [width, component.render(width)]));
  const definition = component.toolDefinition as ToolDefinition;
  chat.addChild(component);
  const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
  try {
    expect(text(chat)).toContain("Code read ×2, bash, models.classify (4 nested calls; 1.2s) — 실제 호출 확인");
    expect(text(chat)).not.toContain("not_observed");
    for (const width of widths) {
      const rows = component.render(width);
      expect(rows.slice(2)).toEqual(native.get(width));
      expect(rows.slice(0, 2).every(row => visibleWidth(row) <= Math.min(width, 120))).toBe(true);
    }
    expect(component.args).toBe(args);
    expect(component.result).toBe(receipt);
    expect(component.toolDefinition).toBe(definition);
    expect(definition.execute).not.toHaveBeenCalled();
  } finally { dispose(); }
  expect(component.render(120)).toEqual(native.get(120));
});

it("counts native parents under explicit grouping without adding nested calls or protocol header lines", () => {
  initTheme();
  const { root, chat } = nativeTranscript();
  for (const id of ["a", "b"]) {
    const component = tool(id);
    component.updateResult(result([call("read"), call("read")]));
    chat.addChild(component);
  }
  const options = { getTheme: () => theme, requestRender: vi.fn() };
  const first = attachTranscriptPresentation(root, options);
  expect(first.targets()).toHaveLength(2);
  expect(first.targets().every(target => target.parent === undefined)).toBe(true);
  first();

  const dispose = attachTranscriptPresentation(root, { ...options, rules: { codemode: "explore" } });
  try {
    expect(text(chat)).toBe("\n▸ Exploration 2 calls");
    const navigation = new ToolNavigation(dispose.targets);
    navigation.act("right");
    expect(dispose.targets()).toHaveLength(3);
    expect(text(chat).match(/Code read ×2 \(2 nested calls/g)).toHaveLength(2);
    expect(text(chat)).not.toContain("files");
  } finally { dispose(); }
});

it("re-reads current facts after removal, clear and re-attachment, without stale wrapper state", () => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const component = tool();
  const originalRender = component.render;
  const options = { getTheme: () => theme, requestRender: vi.fn() };
  chat.addChild(component);
  const dispose = attachTranscriptPresentation(root, options);
  const staleUpdate = component.updateDisplay;
  component.updateResult(result([call("read")]));
  expect(text(chat)).toContain("1 nested call;");
  chat.removeChild(component);
  expect(component.render).toBe(originalRender);
  component.updateResult(result([call("bash", "cancelled")]));
  staleUpdate();
  chat.addChild(component);
  expect(text(chat)).toContain("bash (1 nested call; 1 cancelled");
  chat.clear();
  expect(dispose.targets()).toHaveLength(0);
  dispose();
  chat.addChild(component);
  const again = attachTranscriptPresentation(root, options);
  try { expect(text(chat)).toContain("bash (1 nested call; 1 cancelled"); }
  finally { again(); }
});
