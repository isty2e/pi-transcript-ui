import {afterEach, describe, expect, it, vi} from "vitest";
import {initTheme, ToolExecutionComponent, type ToolRenderers} from "@earendil-works/pi-coding-agent";
import {Container, Spacer, Text, getCapabilities, setCapabilities, stripTerminalSequences, type Component} from "@earendil-works/pi-tui";
import {inlineNativeToolBody} from "../src/codemode/native-body.js";

initTheme();
const originalCapabilities = getCapabilities();
afterEach(() => setCapabilities(originalCapabilities));
const image = {type: "image" as const, mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9kAAAAASUVORK5CYII="};

function host(definition?: ToolRenderers) {
  return new ToolExecutionComponent("fixture", "actual", {}, {outputPad: 0}, definition,
    {requestRender() {}} as never, "/tmp");
}

describe("native tool body mounting", () => {
  it.each(["default", "self"] as const)("removes the native separator but keeps renderer blanks in the %s shell", renderShell => {
    const native = host({renderShell, renderCall: () => new Text("\nCALL", 0, 0), renderResult: () => new Text("RESULT", 0, 0)});
    native.updateResult({content: [{type: "text", text: "DATA"}], isError: false});
    const expected = native.render(80), body = inlineNativeToolBody(native, native);
    const lines = body.render(80);
    expect(lines).toEqual(expected.slice(1));
    if (renderShell === "self") expect(stripTerminalSequences(lines[0]!).trim()).toBe("");
    expect(body.children.flatMap(child => child.render(80))).toEqual(lines);
    expect(native.render(80)).toEqual(expected);
  });

  it.each(["default", "self"] as const)("maps displayed result clicks into the original %s host", renderShell => {
    const native = host({renderShell, renderCall: () => new Text("CALL", 0, 0), renderResult: () => new Text("RESULT", 0, 0)});
    native.setExpanded(true); native.updateResult({content: [], isError: false});
    const body = inlineNativeToolBody(native, native), lines = body.render(80);
    const y = lines.findIndex(line => stripTerminalSequences(line).trim() === "RESULT");
    expect(y).toBeGreaterThanOrEqual(0);
    const x = stripTerminalSequences(lines[y]!).indexOf("RESULT");
    body.handleMouse?.({type: "click", button: "left", x, y, width: 80, height: lines.length,
      screenX: x, screenY: y, shift: false, alt: false, ctrl: false});
    expect(Reflect.get(native, "expanded")).toBe(false);
  });

  it("preserves unknown/replaced root chrome and refuses stale input until a new paint", () => {
    const native = host(), body = inlineNativeToolBody(native, native);
    body.render(80);
    const clicked = vi.fn(), replacement: Component[] = [new Spacer(1), {
      render: () => ["FOREIGN"], invalidate() {}, handleMouse: clicked,
    }];
    native.children = replacement;
    expect(body.children).toBe(replacement);
    body.handleMouse?.({type: "click", button: "left", x: 0, y: 1, width: 80, height: 2,
      screenX: 0, screenY: 1, shift: false, alt: false, ctrl: false});
    expect(clicked).not.toHaveBeenCalled();
    expect(body.render(80)).toEqual(["", "FOREIGN"]);
    body.handleMouse?.({type: "click", button: "left", x: 0, y: 1, width: 80, height: 2,
      screenX: 0, screenY: 1, shift: false, alt: false, ctrl: false});
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("requires a current-width paint after invalidation before native result input", () => {
    const native = host({renderShell: "self", renderCall: () => new Text("CALL", 0, 0),
      renderResult: () => new Text("RESULT", 0, 0)});
    native.setExpanded(true); native.updateResult({content: [], isError: false});
    const body = inlineNativeToolBody(native, native), lines = body.render(80);
    const y = lines.findIndex(line => stripTerminalSequences(line).trim() === "RESULT");
    const x = stripTerminalSequences(lines[y]!).indexOf("RESULT");
    const event = {type: "click" as const, button: "left" as const, x, y, width: 80, height: lines.length,
      screenX: x, screenY: y, shift: false, alt: false, ctrl: false};
    body.handleMouse?.({...event, width: 40}); expect(Reflect.get(native, "expanded")).toBe(true);
    body.invalidate(); body.handleMouse?.(event); expect(Reflect.get(native, "expanded")).toBe(true);
    body.render(80); body.handleMouse?.(event); expect(Reflect.get(native, "expanded")).toBe(false);
  });

  it("does not guess that an arbitrary empty leading child is native spacing", () => {
    const native = new Container(); native.addChild(new Text("", 0, 0)); native.addChild(new Text("CONTENT", 0, 0));
    const expected = native.render(80), body = inlineNativeToolBody(native, native);
    expect(body.render(80)).toEqual(expected); expect(body.children).toBe(native.children);
  });

  it.each([false, true])("keeps image-only self spacing and native bytes (text: %s)", text => {
    setCapabilities({...originalCapabilities, images: "kitty"});
    const native = host({renderShell: "self", renderCall: () => new Text(text ? "CALL" : "", 0, 0),
      renderResult: () => new Text("", 0, 0)});
    native.updateResult({content: [image], isError: false});
    const expected = native.render(80), body = inlineNativeToolBody(native, native), lines = body.render(80);
    expect(lines).toEqual(text ? expected.slice(1) : expected);
    expect(lines.some(line => line.includes("\x1b_G"))).toBe(true);
    expect(body.children.flatMap(child => child.render(80))).toEqual(lines);
  });

  it("exposes no phantom descendants for an empty native self body", () => {
    const native = host({renderShell: "self", renderCall: () => new Text("", 0, 0)});
    native.updateResult({content: [], isError: false});
    const body = inlineNativeToolBody(native, native);
    expect(body.render(80)).toEqual([]); expect(body.children).toEqual([]);
  });
});
