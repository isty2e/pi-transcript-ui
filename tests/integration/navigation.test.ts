import { expect, it, vi } from "vitest";
import { initTheme, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, TuiAltScreen, visibleWidth, stripTerminalSequences, type Terminal } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js";
import { AssistantMessageComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js";
import { createChatViewport } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { attachTranscriptPresentation, type NativeToolComponent } from "../../src/wiring.js";
import { ToolNavigation, navigationComponent } from "../../src/navigation.js";

function fixture() {
  initTheme();
  const chat = new Container(), document = new Container(), root = new Container();
  document.addChild(new Container()); document.addChild(new Container()); document.addChild(chat); root.addChild(document);
  const def: ToolDefinition = { name: "read", label: "Read", description: "fixture", parameters: { type: "object" }, execute: async () => ({ content: [], details: undefined }),
    renderCall: (args) => new Text(`ORIGINAL ${String((args as { path: string }).path)}`, 0, 0), renderResult: () => new Text("ORIGINAL RESULT", 0, 0) };
  const attachment = attachTranscriptPresentation(root, { getTheme: () => ({ bold: (s) => s, fg: (_k, s) => s }), requestRender: vi.fn() });
  const members = ["first", "second", "third"].map((id) => {
    const tool = new ToolExecutionComponent("read", id, { path: `${id}.txt` }, {}, def, { requestRender: vi.fn() } as never, "/tmp");
    chat.addChild(tool); tool.updateResult({ content: [{ type: "text", text: id }], isError: false }); return tool as unknown as NativeToolComponent;
  });
  return { chat, document, root, attachment, members, navigation: new ToolNavigation(() => attachment.targets()) };
}

it("navigates the group and every member independently without a compositor", () => {
  const h = fixture();
  try {
    const group = h.navigation.view().selected!;
    expect(group.kind).toBe("group"); expect(group.expanded).toBe(false);
    h.navigation.act("right"); expect(group.expanded).toBe(true);
    expect(h.navigation.view().selected).toBe(group);
    h.navigation.act("right");
    for (const [index, member] of h.members.entries()) {
      expect(h.navigation.view().selected!.label).toContain(member.toolCallId);
      h.navigation.act("toggle"); expect(member.expanded).toBe(true);
      expect(h.chat.render(100).join("\n")).toContain(`ORIGINAL ${member.toolCallId}.txt`);
      h.navigation.act("left"); expect(member.expanded).toBe(false);
      if (index < h.members.length - 1) h.navigation.act("down");
    }
    h.navigation.act("left"); expect(h.navigation.view().selected).toBe(group);
    h.navigation.act("left"); expect(h.attachment.targets()).toEqual([group]);
    h.navigation.act("up"); expect(h.navigation.view().selected).toBe(group);
    h.navigation.act("toggle"); h.navigation.act("down");
    expect(h.navigation.view().selected!.label).toContain("first.txt");
  } finally { h.attachment(); }
});

it("shares bulk expansion, mouse collapse and removal with keyboard selection", () => {
  const h = fixture();
  try {
    const group = h.attachment.targets()[0]!;
    for (const member of h.members) member.setExpanded(true);
    expect(group.expanded).toBe(true); expect(h.attachment.targets()).toHaveLength(4);
    h.navigation.act("left"); h.navigation.act("left");
    group.setExpanded(false);
    expect(h.navigation.view().selected).toBe(group);
    group.setExpanded(true); h.navigation.act("right");
    const removed = h.navigation.view().selected!;
    h.chat.removeChild(h.members[0]!);
    expect(h.attachment.targets()).not.toContain(removed);
    const state = h.members[0]!.expanded;
    removed.setExpanded(!state); expect(h.members[0]!.expanded).toBe(state);
    h.chat.clear(); expect(h.navigation.view().selected).toBeUndefined();
    expect(() => h.navigation.act("toggle")).not.toThrow();
  } finally { h.attachment(); }
});

it("handles real keyboard sequences with bounded rows and returns focus through close", () => {
  const h = fixture(), close = vi.fn(), toggleAll = vi.fn();
  try {
    const component = navigationComponent(h.navigation, { close, requestRender: vi.fn(), toggleAll, isBulkToggle: (key) => key === "\x0f" });
    component.handleInput!("\x1b[C"); component.handleInput!("\x1b[C"); component.handleInput!(" ");
    expect(h.members.map((m) => m.expanded)).toEqual([true, false, false]);
    component.handleInput!("\x1b[B"); component.handleInput!("\r");
    expect(h.members.map((m) => m.expanded)).toEqual([true, true, false]);
    component.handleInput!("x"); expect(h.navigation.view().selected!.label).toContain("second.txt");
    for (const width of [1, 12, 80]) expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    component.handleInput!("\x0f"); expect(toggleAll).toHaveBeenCalledOnce();
    component.handleInput!("\x1b"); expect(close).toHaveBeenCalledOnce();
  } finally { h.attachment(); }
});

it("restores one blank above the compact block while keeping native assistant spacing below", () => {
  const h = fixture();
  try {
    const assistant = (text: string) => new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text }] } as never);
    const before = assistant("BEFORE"), after = assistant("AFTER");
    h.chat.children.unshift(before); h.chat.addChild(after);
    const lines = h.chat.render(100).map((line) => stripTerminalSequences(line).trim());
    const header = lines.findIndex((line) => line.startsWith("▸ Read"));
    expect(lines.slice(header - 2, header + 3)).toEqual(["BEFORE", "", "▸ Read 3 files", "", "AFTER"]);
    h.attachment.targets()[0]!.setExpanded(true);
    const open = h.chat.render(100).map((line) => stripTerminalSequences(line).trim());
    const first = open.findIndex((line) => line.includes("first.txt"));
    expect(open.slice(first, first + 3).every((line) => line.startsWith("▸ Read"))).toBe(true);
  } finally { h.attachment(); }
});

it("routes native fullscreen SGR press/release through the actual viewport without the compositor", () => {
  const h = fixture();
  let input: (data: string) => void = () => {};
  const terminal: Terminal = { columns: 100, rows: 50, kittyProtocolActive: false,
    start: (onInput) => { input = onInput; }, stop: vi.fn(), drainInput: async () => {}, write: vi.fn(), moveBy: vi.fn(),
    hideCursor: vi.fn(), showCursor: vi.fn(), clearLine: vi.fn(), clearFromCursor: vi.fn(), clearScreen: vi.fn(), setTitle: vi.fn(), setProgress: vi.fn() };
  const tui = new TuiAltScreen(terminal);
  const viewport = createChatViewport({ document: h.document, pendingMessages: new Container(), status: new Container(), editor: new Text("EDITOR"), footer: new Text("FOOTER") });
  tui.addChild(h.document); tui.setLayoutRoot(viewport.root);
  const click = (line: number) => { tui.renderNow(); input(`\x1b[<0;2;${line + 1}M`); input(`\x1b[<0;2;${line + 1}m`); tui.renderNow(); };
  try {
    tui.start(); tui.renderNow();
    const group = h.attachment.targets()[0]!;
    click(0); expect(group.expanded).toBe(false);
    click(1); expect(group.expanded).toBe(true);
    for (const member of h.members) {
      const row = h.chat.render(100).findIndex((line) => line.includes(`${member.toolCallId}.txt`));
      click(row); expect(member.expanded).toBe(true);
      click(row); expect(member.expanded).toBe(false);
    }
    click(1); expect(group.expanded).toBe(false);
  } finally { tui.stop(); h.attachment(); }
});
