import { describe, expect, it, vi } from "vitest";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { attachTranscriptPresentation, type NativeToolComponent } from "../src/wiring.js";
import { restorationFault, withAccessorChildren } from "./fixtures/native-children.js";

initTheme();
const theme = { bold: (text: string) => text, fg: (_style: string, text: string) => text };
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: false });
const tool = (id = "call") => new ToolExecutionComponent("fixture", id, {}, {}, undefined,
  { requestRender() {} } as never, "/tmp");

function transcript() {
  const chat = new Container(), root = new Container();
  root.addChild(chat);
  return { chat, root };
}

describe("native children and cleanup boundaries", () => {
  it("keeps accessor backing and body traversal current through clear, replacement and detach", () => {
    const native = tool();
    const readBacking = withAccessorChildren(native);
    const { root, chat } = transcript();
    chat.addChild(native);
    const onUnsupported = vi.fn();
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender() {}, onUnsupported });
    native.setExpanded(true);
    native.clear();
    expect(readBacking()).toEqual([]);

    const children = [new Text("LATEST NATIVE CHILD", 0, 0)];
    native.children = children;
    expect(readBacking()).toBe(children);
    const body = native.children.at(-1) as Component & { children: Component[] };
    expect(body.children).toBe(children);
    const expanded = native.render(80).slice(2);
    expect(expanded.join("\n")).toContain("LATEST NATIVE CHILD");
    dispose();
    expect(native.children).toBe(children);
    expect(native.render(80)).toEqual(expanded);
    expect(onUnsupported).not.toHaveBeenCalled();
  });

  it.each(["own", "inherited"])("refuses a throwing %s children read without blocking later host registration or results", (storage) => {
    const { root, chat } = transcript();
    const onUnsupported = vi.fn();
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender() {}, onUnsupported });
    const bad = tool("bad");
    if (storage === "inherited") withAccessorChildren(bad);
    const owner = storage === "own" ? bad : Object.getPrototypeOf(bad) as object;
    Object.defineProperty(owner, "children", { configurable: true, get() { throw new Error("opaque children"); } });
    const pending = new Map<string, ToolExecutionComponent>();
    expect(() => { chat.addChild(bad); pending.set("bad", bad); }).not.toThrow();
    expect(pending.get("bad")).toBe(bad);
    expect(onUnsupported).toHaveBeenCalledOnce();

    const good = tool("good");
    chat.addChild(good); pending.set("good", good);
    pending.get("good")!.updateResult(result("FINAL RESULT"));
    expect(dispose.targets()).toHaveLength(1);
    expect(good.render(80)).toHaveLength(2);
    dispose();
  });

  it("preserves a foreign setter-only takeover and does not invoke it during detach", () => {
    const { root, chat } = transcript();
    const native = tool(); chat.addChild(native);
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender() {} });
    const ours = Object.getOwnPropertyDescriptor(native, "children")!;
    const setter = vi.fn();
    Object.defineProperty(native, "children", { ...ours, set: setter });
    dispose();
    expect(Object.getOwnPropertyDescriptor(native, "children")?.set).toBe(setter);
    expect(setter).not.toHaveBeenCalled();
    const replacement = [new Text("foreign", 0, 0)];
    native.children = replacement;
    expect(setter).toHaveBeenCalledWith(replacement);
  });

  it("leaves a foreign method getter untouched without invoking it during detach", () => {
    const { root, chat } = transcript();
    const native = tool(); chat.addChild(native);
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender() {} });
    const ours = native.render;
    const get = vi.fn(() => ours);
    Object.defineProperty(native, "render", { configurable: true, get });
    dispose();
    expect(get).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(native, "render")?.get).toBe(get);
    native.updateResult(result("FOREIGN WRAPPER"));
    expect(native.render(80).join("\n")).toContain("FOREIGN WRAPPER");
  });

  it("contains result follow-up failures without repeating native updates", () => {
    const { root, chat } = transcript();
    const parameters = { type: "object", properties: { input: { type: "string" } }, required: ["input"] };
    const native = new ToolExecutionComponent("apply_patch", "patch", { input: "not yet complete" }, {},
      { name: "apply_patch", label: "patch", description: "fixture", parameters, execute: async () => result("unused") },
      { requestRender() {} } as never, "/tmp");
    const originalUpdate = vi.spyOn(native as unknown as NativeToolComponent, "updateDisplay");
    const requestRender = vi.fn(() => { throw new Error("presentation callback failed"); });
    const unsupported = vi.fn();
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender, onUnsupported: unsupported });
    chat.addChild(native);
    originalUpdate.mockClear();
    Reflect.set(native, "args", { input: "*** Begin Patch\n*** Add File: file.txt\n+one\n*** End Patch" });
    expect(() => native.updateResult(result("LATEST RESULT"))).not.toThrow();
    expect(originalUpdate).toHaveBeenCalledOnce();
    expect(requestRender).toHaveBeenCalledOnce();
    expect(unsupported).toHaveBeenCalledOnce();
    expect(dispose.targets()).toEqual([]);
    expect(native.render(80).join("\n")).toContain("LATEST RESULT");
    dispose();
  });

  it("preserves native update exceptions without running presentation follow-up", () => {
    const { root, chat } = transcript();
    const native = tool();
    const error = new Error("native update failed");
    Reflect.set(native, "updateDisplay", () => { throw error; });
    chat.addChild(native);
    const unsupported = vi.fn();
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender() {}, onUnsupported: unsupported });
    expect(() => native.updateResult(result("value"))).toThrow(error);
    expect(unsupported).not.toHaveBeenCalled();
    dispose();
  });

  it("does not group across a member returned to native presentation after an observer failure", () => {
    const { root, chat } = transcript();
    const members = ["a", "b", "c"].map(id => {
      const component = new ToolExecutionComponent("read", id, { path: id }, {}, undefined, { requestRender() {} } as never, "/tmp");
      component.updateResult(result(`FINAL ${id}`));
      chat.addChild(component);
      return component;
    });
    const requestRender = vi.fn(() => { throw new Error("render request failed"); });
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender });
    expect(() => members[1]!.setExpanded(true)).not.toThrow();
    expect(dispose.targets().map(target => target.kind)).toEqual(["tool", "tool"]);
    expect(members[1]!.render(80).join("\n")).toContain("FINAL b");
    expect(requestRender).toHaveBeenCalledOnce();
    dispose();
  });

  it("contains incomplete installation rollback so pending registration and native results continue", () => {
    const { root, chat } = transcript();
    const incomplete = vi.fn(), unsupported = vi.fn();
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender() {},
      onCleanupIncomplete: incomplete, onUnsupported: unsupported });
    const { proxy } = restorationFault(tool(), true);
    const pending = new Map<string, ToolExecutionComponent>();
    expect(() => { chat.addChild(proxy); pending.set("call", proxy); }).not.toThrow();
    expect(pending.get("call")).toBe(proxy);
    pending.get("call")!.updateResult(result("PARTIAL"), true);
    pending.get("call")!.updateResult(result("LATEST FINAL"));
    expect(proxy.render(80).join("\n")).toContain("LATEST FINAL");
    expect(dispose.targets()).toEqual([]);
    expect(incomplete).toHaveBeenCalledOnce();
    expect(incomplete.mock.calls[0]![0]).toEqual({ kind: "tool", toolName: "fixture" });
    expect(unsupported).not.toHaveBeenCalled();
    dispose();
  });

  it("reports clean native retention only after a complete installation rollback", () => {
    const { root, chat } = transcript();
    const incomplete = vi.fn(), unsupported = vi.fn();
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender() {},
      onCleanupIncomplete: incomplete, onUnsupported: unsupported });
    const { proxy } = restorationFault(tool(), true, false);
    expect(() => chat.addChild(proxy)).not.toThrow();
    proxy.updateResult(result("NATIVE AFTER ROLLBACK"));
    expect(proxy.render(80).join("\n")).toContain("NATIVE AFTER ROLLBACK");
    expect(dispose.targets()).toEqual([]);
    expect(unsupported).toHaveBeenCalledOnce();
    expect(incomplete).not.toHaveBeenCalled();
    dispose();
  });

  it("finishes all releases and native clear when one restore and its diagnostic fail", () => {
    const { root, chat } = transcript();
    const clear = vi.spyOn(chat, "clear");
    const incomplete = vi.fn((_source: unknown, _failure: unknown) => { throw new Error("notification unavailable"); });
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender() {}, onCleanupIncomplete: incomplete });
    const first = restorationFault(tool("first"));
    const second = tool("second");
    chat.addChild(first.proxy); chat.addChild(second);
    second.updateResult(result("SECOND FINAL"));
    first.arm();
    expect(() => chat.clear()).not.toThrow();
    expect(clear).toHaveBeenCalledOnce();
    expect(chat.children).toEqual([]);
    expect(dispose.targets()).toEqual([]);
    expect(second.render(80).join("\n")).toContain("SECOND FINAL");
    expect(Object.getOwnPropertyDescriptor(second, "render")).toBeUndefined();
    expect(incomplete).toHaveBeenCalledOnce();
    expect(incomplete.mock.calls[0]![0]).toEqual({ kind: "attachment" });
    expect(() => dispose()).not.toThrow();
  });

  for (const operation of ["addChild", "removeChild", "clear"] as const) {
    it(`preserves the original host ${operation} exception`, () => {
      const { root, chat } = transcript();
      const error = new Error("native operation failure");
      chat[operation] = () => { throw error; };
      const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender() {} });
      try {
        expect(() => operation === "clear" ? chat.clear() : chat[operation](tool())).toThrow(error);
      } finally { dispose(); }
    });
  }
});
