import { expect, it, vi } from "vitest";
import { initTheme, VERSION, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { attachTranscriptPresentation, type NativeToolComponent, type RowTheme } from "../../src/wiring.js";
import { piCapabilities } from "../fixtures/pi-capabilities.js";
import { theme } from "../fixtures/pi-theme.js";
import { nativeTool, nativeTranscript } from "./fixtures/native-components.js";

const string = { type: "string" } as const;
const number = { type: "number" } as const;
const patch = "*** Begin Patch\n*** Add File: a.txt\n+one\n*** End Patch";
const receipt = (isError = false) => ({ content: [{ type: "text" as const, text: "Native result" }], isError,
  details: { calls: [{ name: "read", status: "ok" }], output: "Native result", wall_time_seconds: 0.1, session_id: 42 } });

function definition(name: string, properties: Record<string, { readonly type: "string" | "number" }> = {}, required: string[] = []): ToolDefinition {
  return {
    name, label: name, description: "Phase fixture",
    parameters: { type: "object", properties, required } as ToolDefinition["parameters"],
    execute: vi.fn(async () => receipt()),
    renderCall: () => new Text("Native heading", 0, 0),
    renderResult: () => new Text("Native body", 0, 0),
  };
}

const cases = [
  { name: "read", args: { path: "a.txt" }, fields: { path: string, offset: number, limit: number }, required: ["path"],
    pending: "Read", running: "Reading", settled: "Read" },
  { name: "write", args: { path: "a.txt", content: "one\n" }, fields: { path: string, content: string }, required: ["path", "content"],
    pending: "Write", running: "Writing", settled: "Wrote" },
  { name: "edit", args: { path: "a.txt", oldText: "one", newText: "two" }, fields: { path: string, oldText: string, newText: string }, required: ["path", "oldText", "newText"],
    pending: "Edit", running: "Editing", settled: "Edited" },
  { name: "apply_patch", args: { input: patch }, fields: { input: string }, required: ["input"],
    pending: "Patch", running: "Patching", settled: "Patched" },
  ...["bash", "powershell"].map(name => ({ name, args: { command: "echo ready" }, fields: { command: string }, required: ["command"],
    pending: "Run", running: "Running", settled: "Ran" })),
  { name: "exec_command", args: { cmd: "echo ready" }, fields: { cmd: string }, required: ["cmd"],
    pending: "Run", running: "Running", settled: "Ran" },
  { name: "write_stdin", args: { session_id: 42 }, fields: { session_id: number, chars: string }, required: ["session_id"],
    pending: "Check output", running: "Checking output", settled: "Checked output" },
  { name: "write_stdin", args: { session_id: 42, chars: "\n" }, fields: { session_id: number, chars: string }, required: ["session_id"],
    pending: "Send input", running: "Sending input", settled: "Sent input" },
  { name: "grep", args: { pattern: "missing" }, fields: { pattern: string }, required: ["pattern"],
    pending: "Search", running: "Searching", settled: "Searched" },
  { name: "find", args: { pattern: "*.absent" }, fields: { pattern: string }, required: ["pattern"],
    pending: "Find", running: "Searching files", settled: "Searched files" },
  { name: "ls", args: { path: "." }, fields: { path: string }, required: [],
    pending: "List", running: "Listing", settled: "Listed" },
  { name: "codemode", args: { code: "return 1" }, fields: { code: string }, required: ["code"],
    pending: "Code", running: "Running code", settled: "Ran code" },
].filter(scenario => scenario.name !== "codemode" || piCapabilities(VERSION).codemode);

it.each(cases)("uses native lifecycle facts for $name / $settled without changing outcome styling", scenario => {
  initTheme();
  const def = definition(scenario.name, scenario.fields, scenario.required);
  const component = nativeTool({ name: def.name, id: "live", args: scenario.args, definition: def });
  const native = component as unknown as NativeToolComponent;
  const { root, chat } = nativeTranscript(); chat.addChild(component);
  const fg = vi.fn<RowTheme["fg"]>((kind, text) => theme.fg(kind, text));
  const rowTheme: RowTheme = { bold: text => theme.bold(text), fg };
  const dispose = attachTranscriptPresentation(root, { getTheme: () => rowTheme, requestRender: vi.fn(), rules: null });
  const header = () => stripTerminalSequences(component.render(120)[1]!);
  try {
    expect(header()).toMatch(new RegExp(`^▸ ${scenario.pending}(?: |…)`));
    component.setArgsComplete();
    expect(header()).toMatch(new RegExp(`^▸ ${scenario.pending}(?: |…)`));
    component.markExecutionStarted();
    expect(header()).toMatch(new RegExp(`^▸ ${scenario.running}(?: |…)`));
    component.updateResult(receipt(), true);
    expect(header()).toMatch(new RegExp(`^▸ ${scenario.running}(?: |…)`));
    component.updateResult(scenario.name === "find" ? { ...receipt(), content: [] } : receipt());
    expect(header()).toMatch(new RegExp(`^▸ ${scenario.settled}(?: |$)`));
    if (scenario.name === "exec_command") expect(header()).not.toContain("(exit ");
    if (scenario.name === "find") expect(header()).toContain("(0 matches)");

    const error = receipt(true);
    component.updateResult(error);
    fg.mockClear();
    expect(header()).toMatch(new RegExp(`^▸ ${scenario.settled} `));
    expect(header()).toContain("— error");
    expect(fg.mock.calls.some(([kind, text]) => kind === "error" && stripTerminalSequences(text).startsWith(`▸ ${scenario.settled} `))).toBe(true);
    for (const width of [1, 8, 24, 80, 120]) {
      expect(component.render(width).every(row => visibleWidth(row) <= width)).toBe(true);
    }
    expect(native.args).toBe(scenario.args);
    expect(native.result).toBe(error);
    expect(native.toolDefinition).toBe(def);
    expect(def.execute).not.toHaveBeenCalled();
    component.setExpanded(true);
    const expanded = component.render(120);
    dispose();
    expect(expanded.slice(2)).toEqual(component.render(120));

    const history = nativeTool({ name: def.name, id: "history", args: scenario.args, definition: def });
    history.updateResult(error);
    chat.clear(); chat.addChild(history);
    const release = attachTranscriptPresentation(root, { getTheme: () => rowTheme, requestRender: vi.fn(), rules: null });
    try {
      expect(stripTerminalSequences(history.render(120)[1]!)).toMatch(new RegExp(`^▸ ${scenario.settled} `));
    } finally { release(); }
  } finally { dispose(); }
});

it("uses partial and final evidence when a host has no start flag, including partial patch failure", () => {
  initTheme();
  const def = definition("apply_patch", { input: string }, ["input"]);
  const component = nativeTool({ name: def.name, id: "patch", args: { input: patch }, definition: def });
  Reflect.deleteProperty(component, "executionStarted");
  const { root, chat } = nativeTranscript(); chat.addChild(component);
  const release = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), rules: null });
  const header = () => stripTerminalSequences(component.render(120)[1]!);
  try {
    expect(header()).toBe("▸ Patch a.txt (requested +1 -0)…");
    component.updateResult(receipt(), true);
    expect(header()).toBe("▸ Patching a.txt (requested +1 -0)…");
    component.updateResult({ ...receipt(true), details: { status: "partial_failure" } });
    expect(header()).toBe("▸ Patched a.txt — error (requested +1 -0)");
  } finally { release(); }
});

it.each(["Run", "Read", "Write", "Edit", "Patch", "Code"])("does not conjugate the arbitrary tool name %s", name => {
  initTheme();
  const def = definition(name);
  const component = nativeTool({ name, id: name, args: {}, definition: def });
  const { root, chat } = nativeTranscript(); chat.addChild(component);
  const release = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), rules: null });
  try {
    component.markExecutionStarted();
    expect(stripTerminalSequences(component.render(120)[1]!)).toBe(`▸ ${name}…`);
    component.updateResult(receipt(true));
    expect(stripTerminalSequences(component.render(120)[1]!)).toBe(`▸ ${name} — error (1 line)`);
  } finally { release(); }
});

it("keeps group phase separate from mixed/all failures and recomputes it after membership changes", () => {
  initTheme();
  const read = definition("read", { path: string, offset: number, limit: number }, ["path"]);
  const grep = definition("grep", { pattern: string }, ["pattern"]);
  const a = nativeTool({ name: read.name, id: "a", args: { path: "a.txt" }, definition: read });
  const b = nativeTool({ name: grep.name, id: "b", args: { pattern: "value" }, definition: grep });
  const { root, chat } = nativeTranscript(); chat.addChild(a); chat.addChild(b);
  const fg = vi.fn<RowTheme["fg"]>((kind, text) => theme.fg(kind, text));
  const release = attachTranscriptPresentation(root, { getTheme: () => ({ bold: text => theme.bold(text), fg }), requestRender: vi.fn() });
  const header = () => stripTerminalSequences(chat.render(120)[1]!);
  try {
    expect(header()).toBe("▾ Exploration 2 calls…");
    a.markExecutionStarted();
    expect(header()).toBe("▾ Exploring 2 calls…");
    a.updateResult(receipt(true)); b.markExecutionStarted();
    expect(header()).toBe("▾ Exploring 2 calls — 1 failed…");
    b.updateResult(receipt(true));
    fg.mockClear();
    expect(header()).toBe("▸ Explored 2 calls — 2 failed");
    expect(fg.mock.calls).toContainEqual(["error", "2 failed"]);

    const c = nativeTool({ name: grep.name, id: "c", args: { pattern: "other" }, definition: grep });
    chat.addChild(c);
    expect(header()).toBe("▾ Exploration 3 calls — 2 failed…");
    c.markExecutionStarted();
    expect(header()).toBe("▾ Exploring 3 calls — 2 failed…");
    chat.removeChild(c);
    expect(header()).toBe("▸ Explored 2 calls — 2 failed");
  } finally { release(); }
});
