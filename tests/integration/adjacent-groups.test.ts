import { expect, it, vi } from "vitest";
import { Container, Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, ToolExecutionComponent, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { attachTranscriptPresentation } from "../../src/wiring.js";

const theme = { bold: (s: string) => s, fg: (_kind: string, s: string) => s };
const call = { type: "toolCall", id: "call", name: "read", arguments: { path: "a" } };
const message = (content: unknown[] = [call], stopReason = "toolUse") => ({ role: "assistant", content, stopReason }) as never;
function assistant(content: unknown[] = [call], streaming = false, stopReason = "toolUse") {
  const component = new AssistantMessageComponent();
  component.updateContent(message(content, stopReason), streaming);
  return component;
}
function tool(path: string, name = "read", cwd = "/tmp") {
  const def = name === "read" ? createReadToolDefinition(cwd) : name === "edit" ? createEditToolDefinition(cwd) : createWriteToolDefinition(cwd);
  const component = new ToolExecutionComponent(name, path, { path, content: "one\ntwo\nthree", edits: [{ oldText: "old", newText: "new" }] }, {}, def, { requestRender: vi.fn() } as never, cwd);
  component.updateResult({ content: [{ type: "text", text: name === "read" ? "body" : "Successfully wrote file" }], isError: false });
  return component;
}
function fixture() {
  initTheme();
  const root = new Container(), chat = new Container(); root.addChild(chat);
  return { root, chat, attach: () => attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() }) };
}
const render = (chat: Container, width = 120) => stripTerminalSequences(chat.render(width).join("\n"));

it("merges only after native streaming completion, splits on later text, and preserves tool targets and bodies", () => {
  const { chat, attach } = fixture();
  const a = tool("same"), b = tool("./same");
  b.setExpanded(true); const body = b.render(120); b.setExpanded(false);
  chat.addChild(assistant()); chat.addChild(a);
  const detach = attach();
  const bridge = new AssistantMessageComponent(); chat.addChild(bridge);
  bridge.updateContent(message(), true); chat.addChild(b);
  const targets = detach.targets().filter(t => t.kind === "tool");
  expect(render(chat)).not.toContain("2 reads");
  bridge.updateContent(message(), false);
  expect(render(chat)).toContain("Read 1 file (2 reads, 2 lines)");
  detach.targets()[0]!.setExpanded(true);
  expect(detach.targets().filter(t => t.kind === "tool")).toEqual(targets);
  b.setExpanded(true); expect(b.render(120).slice(1)).toEqual(body);
  bridge.updateContent(message([call, { type: "text", text: "Actual explanation" }]), false);
  expect(render(chat)).not.toContain("2 reads");
  expect(render(chat)).toContain("Actual explanation");
  expect(detach.targets().filter(t => t.kind === "tool")).toEqual(targets);
  expect(b.render(120).slice(2)).toEqual(body);
  chat.removeChild(bridge);
  expect(render(chat)).toContain("Read 1 file (2 reads, 2 lines)");
  detach();
  expect(b.render(120)).toEqual(body);
});

it.each(["read", "write", "edit"])("groups restored %s calls across separate empty assistant responses and survives detach/reattach", (name) => {
  const { chat, attach } = fixture();
  const first = assistant(), second = assistant();
  const original = second.updateContent;
  chat.addChild(first); chat.addChild(tool("a", name)); chat.addChild(second); chat.addChild(tool("b", name));
  let detach = attach();
  const expected = name === "read" ? "Read 2 files (2 lines)" : "Edited 2 calls";
  expect(render(chat)).toContain(expected);
  detach.targets()[0]!.setExpanded(true);
  if (name !== "read") {
    expect(render(chat)).toContain(name === "write" ? "Write a" : "Edit a");
    expect(render(chat)).not.toContain("(1 line)");
  }
  detach(); expect(second.updateContent).toBe(original);
  detach = attach(); expect(render(chat)).toContain(expected);
  chat.clear(); expect(second.updateContent).toBe(original);
  chat.addChild(tool("c", name)); chat.addChild(assistant()); chat.addChild(tool("d", name));
  expect(render(chat)).toContain(expected);
  detach();
});

it("keeps real text, thinking, truncation notices, opaque empty components and user text as boundaries", () => {
  const { chat, attach } = fixture();
  const boundaries = [assistant([call, { type: "text", text: "explanation" }]), assistant([call, { type: "thinking", thinking: "reasoning" }]), assistant([call], false, "length"), new Container(), new Text("User message", 0, 0)];
  for (const boundary of boundaries) {
    chat.clear(); chat.addChild(tool("a")); chat.addChild(boundary); chat.addChild(tool("b"));
    const detach = attach(); expect(render(chat)).not.toContain("Read 2 files"); detach();
  }
});

it("counts lexical requested files, preserves call-based partial provenance and width limits", () => {
  const { chat, attach } = fixture();
  const a = tool("same"), b = tool("/tmp/same"), c = tool("other");
  c.updateResult({ content: [{ type: "text", text: "failure" }], isError: true });
  chat.addChild(a); chat.addChild(assistant()); chat.addChild(b); chat.addChild(assistant()); chat.addChild(c);
  const detach = attach();
  expect(render(chat)).toContain("Read 2 files — 1 failed (partial 2/3: 3 reads, 2 lines)");
  for (let width = 1; width <= 120; width++) {
    const row = chat.render(width)[1]!;
    expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    if (row.includes("2 lines")) expect(row).toContain("partial 2/3:");
  }
  b.updateArgs({ path: "/tmp/third" });
  expect(render(chat)).toContain("Read 3 files — 1 failed (partial 2/3: 2 lines)");
  b.updateArgs({});
  expect(render(chat)).toContain("Read 3 calls — 1 failed (partial 1/3: 1 line)");
  detach();
});

it("retains a later foreign assistant wrapper after detach and refuses an unpatchable boundary", () => {
  const { root, chat, attach } = fixture();
  const bridge = assistant(); chat.addChild(tool("a")); chat.addChild(bridge); chat.addChild(tool("b"));
  const detach = attach();
  const wrapped = bridge.updateContent;
  const foreign: typeof wrapped = function (this: AssistantMessageComponent, ...args) { return wrapped.apply(this, args); };
  bridge.updateContent = foreign;
  detach(); expect(bridge.updateContent).toBe(foreign);
  bridge.updateContent(message([{ type: "text", text: "native after detach" }]), false);
  expect(render(chat)).toContain("native after detach");
  chat.clear();
  const fixed = assistant();
  Object.defineProperty(fixed, "updateContent", { value: fixed.updateContent, writable: false });
  chat.addChild(tool("a")); chat.addChild(fixed); chat.addChild(tool("b"));
  const onUnsupported = vi.fn();
  const release = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), onUnsupported });
  expect(onUnsupported).toHaveBeenCalledOnce();
  expect(render(chat)).not.toContain("Read 2 files");
  release();
});

it("does not reopen a closed earlier group whose native members remain expanded", () => {
  const { chat, attach } = fixture();
  const a = tool("a"), b = tool("b"); a.setExpanded(true); b.setExpanded(true);
  chat.addChild(a); chat.addChild(b);
  const detach = attach(); const earlier = detach.targets()[0]!;
  earlier.setExpanded(false);
  chat.addChild(new Text("Next user message", 0, 0)); chat.addChild(tool("c"));
  const bridge = assistant([call], true); chat.addChild(bridge); chat.addChild(tool("d"));
  bridge.updateContent(message(), false);
  expect(earlier.expanded).toBe(false);
  expect(detach.targets()[0]).toBe(earlier);
  detach();
});

it("keeps different working directories distinct and does not claim file identity for unsupported paths", () => {
  const { chat, attach } = fixture();
  const a = tool("same", "read", "/tmp/a"), b = tool("same", "read", "/tmp/b");
  chat.addChild(a); chat.addChild(b);
  const detach = attach();
  expect(render(chat)).toContain("Read 2 files (2 lines)");
  b.updateArgs({ path: "/tmp/a/same" });
  expect(render(chat)).toContain("Read 1 file (2 reads, 2 lines)");
  b.updateArgs({ path: "file:///tmp/a/same" });
  expect(render(chat)).toContain("Read 2 calls (2 lines)");
  detach();
});
