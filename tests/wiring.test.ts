import { describe, expect, it, vi } from "vitest";
import { initTheme, createEditToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { getCapabilities, setCapabilities } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { attachTranscriptPresentation, type NativeToolComponent } from "../src/wiring.js";
import { defaultSettings, groupingRules } from "../src/settings.js";

initTheme();
const theme = { bold: (s: string) => s, fg: (_style: string, s: string) => s };
const output = { content: [{ type: "text" as const, text: "FIRST\nSECOND" }], details: { tag: "details" }, isError: false };
function definition(shell: "default" | "self" = "default"): ToolDefinition {
  return {
    name: "mcp__any", label: "Any", description: "fixture", parameters: { type: "object", properties: {} },
    execute: async () => output,
    renderShell: shell,
    renderCall: (args, t, context) => {
      const state = context.state as { calls?: number; prepared?: boolean };
      state.calls = (state.calls ?? 0) + 1;
      if (context.argsComplete) state.prepared = true;
      const text = context.lastComponent as Text | undefined ?? new Text("", 0, 0);
      text.setText(t.fg("accent", `FOREIGN CALL ${JSON.stringify(args)} ${context.executionStarted}`));
      return text;
    },
    renderResult: (result, opts, t, context) => {
      const state = context.state as { calls?: number; prepared?: boolean };
      const text = context.lastComponent as Text | undefined ?? new Text("", 0, 0);
      text.setText(t.fg("success", `FOREIGN RESULT ${state.calls} ${state.prepared} ${opts.isPartial} ${opts.expanded}\n${JSON.stringify(result)}`));
      return text;
    },
  };
}
function component(def: ToolDefinition | undefined, id = "call", args: unknown = { displaySummary: "Check interoperability" }): ToolExecutionComponent {
  return new ToolExecutionComponent(def?.name ?? "unknown", id, args,
    { showImages: true }, def, { requestRender: vi.fn() } as never, "/tmp");
}
function setup(def: ToolDefinition | null = definition(), args?: unknown) {
  const baseline = component(def ?? undefined, "baseline", args);
  const decorated = component(def ?? undefined, "decorated", args);
  const chat = new Container(); chat.addChild(decorated);
  const root = new Container(); root.addChild(chat);
  const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
  const each = (fn: (c: ToolExecutionComponent) => void) => { fn(baseline); fn(decorated); };
  const compare = (width = 80) => {
    expect(decorated.render(width).slice(2)).toEqual(baseline.render(width));
  };
  return { baseline, decorated, chat, root, dispose, each, compare };
}

describe("actual ToolExecutionComponent differential rendering", () => {
  it("uses family labels for arbitrary or mixed operations instead of inventing file work", () => {
    for (const [names, family, label] of [
      [["mcp__any", "mcp__other"], "exploration", "Exploration"],
      [["read", "mcp__any"], "exploration", "Exploration"],
      [["read", "grep"], "exploration", "Exploration"],
      [["edit", "mcp__any"], "mutation", "Mutation"],
    ] as const) {
      const settings = defaultSettings(); settings.grouping[family] = [...names];
      const chat = new Container(), root = new Container(); root.addChild(chat);
      for (const [index, name] of names.entries()) {
        const tool = component({ ...definition(), name }, `c${index}`);
        tool.updateResult(output); chat.addChild(tool);
      }
      const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), rules: groupingRules(settings) });
      expect(chat.render(80)).toEqual(["", `▸ ${label} 2 calls${label === "Mutation" || names.some((name) => name === "read") ? "" : " (4 lines)"}`]);
      dispose();
    }
  });
  for (const shell of ["default", "self"] as const) {
    it(`preserves complete ${shell} shell and shared lifecycle across repeated toggles`, () => {
      const h = setup(definition(shell));
      const nativeDefinition = (h.decorated as any).toolDefinition;
      const nativeState = (h.decorated as any).rendererState;
      h.each((c) => c.updateArgs({ query: "alpha", displaySummary: "Check interoperability" }));
      h.each((c) => c.setArgsComplete());
      h.each((c) => c.markExecutionStarted());
      h.each((c) => c.updateResult(output, true));
      expect(h.decorated.render(80)).toHaveLength(2);
      expect((h.decorated as any).rendererState).toEqual((h.baseline as any).rendererState);
      h.each((c) => c.updateResult(output));
      expect(h.baseline.render(80).join("\n")).toContain("FOREIGN CALL");
      expect(h.baseline.render(80).join("\n")).toContain("FOREIGN RESULT");
      for (let i = 0; i < 3; i++) {
        h.each((c) => c.setExpanded(true)); h.compare(80); h.compare(27);
        h.each((c) => c.invalidate()); h.compare();
        h.each((c) => c.setExpanded(false));
        expect(h.decorated.render(80)).toHaveLength(2);
      }
      expect((h.decorated as any).toolDefinition).toBe(nativeDefinition);
      expect((h.decorated as any).rendererState).toBe(nativeState);
      h.dispose();
      expect(h.decorated.render(80)).toEqual(h.baseline.render(80));
    });
  }
  for (const kind of ["definition-less", "both-missing", "call-only", "result-only", "throwing"] as const) {
    it(`delegates ${kind} fallbacks to Pi without reconstruction`, () => {
      let def: ToolDefinition | undefined = definition();
      if (kind === "definition-less") def = undefined;
      else {
        if (kind === "both-missing" || kind === "result-only") delete def.renderCall;
        if (kind === "both-missing" || kind === "call-only") delete def.renderResult;
        if (kind === "throwing") {
          def.renderCall = () => { throw new Error("call failure"); };
          def.renderResult = () => { throw new Error("result failure"); };
        }
      }
      const h = setup(def ?? null);
      expect((h.decorated as any).toolDefinition).toBe(def);
      h.each((c) => c.updateResult({ ...output, isError: true }));
      h.each((c) => c.setExpanded(true)); h.compare();
      h.dispose();
    });
  }
  it("continues async pre-edit preview work while folded against the pre-mutation file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "render-fidelity-"));
    try {
      const path = join(cwd, "sample.txt");
      await writeFile(path, "before\n");
      const def = createEditToolDefinition(cwd);
      const args = { path, edits: [{ oldText: "before", newText: "after" }] };
      const h = setup(def as unknown as ToolDefinition, args);
      h.each((c) => c.setArgsComplete());
      // Wait for actual native async preview completion before executing once.
      await vi.waitFor(() => {
        expect((h.decorated as any).rendererState.callComponent.preview).toBeDefined();
        expect((h.baseline as any).rendererState.callComponent.preview).toBeDefined();
      });
      h.each((c) => c.markExecutionStarted());
      const result = await def.execute("edit", args, undefined, undefined, {} as never);
      expect(await readFile(path, "utf8")).toBe("after\n");
      h.each((c) => c.updateResult({ ...result, isError: false }));
      h.each((c) => c.setExpanded(true)); h.compare();
      expect((h.decorated as any).rendererState.callComponent.preview).toEqual((h.baseline as any).rendererState.callComponent.preview);
      h.dispose();
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it("keeps theme changes in the original render pipeline", () => {
    const h = setup(); h.each((c) => c.updateResult(output)); h.each((c) => c.setExpanded(true));
    const dark = h.baseline.render(80);
    try {
      initTheme("light", false);
      h.each((c) => c.invalidate()); h.compare();
      expect(h.baseline.render(80)).not.toEqual(dark);
    } finally { initTheme("dark", false); h.dispose(); }
  });
  for (const shell of ["default", "self"] as const) {
    it(`preserves exact Kitty image bytes and IDs for the same ${shell} native component`, () => {
      const caps = getCapabilities(); setCapabilities({ ...caps, images: "kitty" });
      try {
        const h = setup(definition(shell));
        h.decorated.updateResult({ content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" }], isError: false });
        h.decorated.setExpanded(true);
        const decorated = h.decorated.render(80);
        expect(decorated.some((line) => line.includes("\x1b_G"))).toBe(true);
        const image = (h.decorated as any).imageComponents[0];
        h.dispose();
        expect(decorated.slice(2)).toEqual(h.decorated.render(80));
        expect((h.decorated as any).imageComponents[0]).toBe(image);
      } finally { setCapabilities(caps); }
    });
  }
  it("retains the native image tree and image visibility/width transitions", () => {
    const caps = getCapabilities();
    setCapabilities({ ...caps, images: "iterm2" });
    try {
      const h = setup(definition("self"));
      const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };
      h.each((c) => c.updateResult({ ...output, content: [...output.content, image] }));
      expect(h.decorated.render(80)).toHaveLength(2);
      h.each((c) => c.setExpanded(true)); h.compare();
      h.each((c) => c.setImageWidthCells(12)); h.compare();
      h.each((c) => c.setShowImages(false)); h.compare();
      h.each((c) => c.setShowImages(true)); h.compare();
      h.dispose();
    } finally { setCapabilities(caps); }
  });
});

describe("actual transcript attachment and grouping", () => {
  function grouped() {
    const chat = new Container(); const root = new Container(); root.addChild(chat);
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(),
      rules: { mcp__any: "read" } });
    const a = component(definition(), "a"); const b = component(definition(), "b");
    chat.addChild(a); chat.addChild(b);
    a.updateResult(output); b.updateResult(output);
    return { chat, root, a, b, dispose };
  }
  it("makes configured custom tools groupable with an independent header and first member", () => {
    const h = grouped();
    expect(h.chat.children).toEqual([h.a, h.b]);
    expect(h.chat.render(100)).toEqual(["", "▸ Read 2 calls"]);
    const header = h.a.children[1] as Component & { expanded: boolean; setExpanded(v: boolean): void };
    expect(header).not.toBe(h.a);
    expect(header.expanded).toBe(false);
    header.setExpanded(true);
    expect(h.chat.render(100)).toHaveLength(4);
    for (const member of [h.a, h.b]) {
      member.setExpanded(true);
      expect(member.render(100).join("\n")).toContain("FOREIGN CALL");
      expect(h.a.children[1]).toBe(header);
      member.setExpanded(false);
    }
    header.setExpanded(false);
    expect(h.chat.render(100)).toEqual(["", "▸ Read 2 calls"]);
    h.dispose();
  });
  it("tracks partial results and updated totals without dropping native updates", () => {
    const h = grouped();
    h.b.updateResult(output, true);
    expect(h.chat.render(100)).toHaveLength(4);
    h.b.updateResult({ ...output, content: [{ type: "text", text: "1\n2\n3" }] });
    expect(h.chat.render(100)).toEqual(["", "▸ Read 2 calls"]);
    h.dispose();
  });
  it("does not group across transcript boundaries; clear restores and reattaches new history", () => {
    const h = grouped(); h.chat.addChild(new Text("assistant boundary"));
    const c = component(definition(), "c"); h.chat.addChild(c); c.updateResult(output);
    expect(c.render(100)[1]).toContain("▸ mcp__any");
    h.chat.clear();
    expect(h.a.render(100).join("\n")).toContain("FOREIGN CALL");
    h.chat.addChild(c);
    expect(c.render(100)).toHaveLength(2);
    h.chat.removeChild(c);
    expect(c.render(100).join("\n")).toContain("FOREIGN CALL");
    h.dispose();
  });
  it("preserves pre-existing component render wrappers and post-attachment native children", () => {
    const native = component(definition());
    native.updateResult(output); native.setExpanded(true);
    const original = native.render;
    native.render = function (width) { return ["EXTENSION FRAME", ...original.call(this, width), "EXTENSION FOOT"]; };
    const unwrapped = native.render(80);
    const chat = new Container(); chat.addChild(native);
    const root = new Container(); root.addChild(chat);
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
    expect(native.render(80).slice(2)).toEqual(unwrapped);
    const added = new Text("LATER EXTENSION CHILD", 0, 0);
    native.addChild(added);
    expect(native.render(80).join("\n")).toContain("LATER EXTENSION CHILD");
    native.removeChild(added);
    expect(native.render(80).slice(2)).toEqual(unwrapped);
    const ours = native.render;
    const later = function (width: number) { return ["LATER FRAME", ...ours.call(native, width)]; };
    native.render = later;
    dispose();
    expect(native.render).toBe(later);
    expect(native.render(80)).toEqual(["LATER FRAME", ...unwrapped]);
  });
  it("reports unsupported frozen instances without breaking dynamic transcript insertion", () => {
    const chat = new Container(); const root = new Container(); root.addChild(chat);
    const warn = vi.fn();
    const dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), onUnsupported: warn });
    const tool = component(definition()); tool.updateResult(output);
    const before = tool.render(80);
    Object.preventExtensions(tool);
    expect(() => chat.addChild(tool)).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(tool.render(80)).toEqual(before);
    dispose();
  });
  it("restores inherited methods and actual native children after teardown", () => {
    const h = setup();
    h.each((c) => c.updateResult(output));
    h.dispose(); h.dispose();
    expect(Object.hasOwn(h.decorated, "render")).toBe(false);
    expect(Object.getOwnPropertyDescriptor(h.decorated, "children")?.value).toBe(h.decorated.children);
    expect(Object.hasOwn(h.chat, "addChild")).toBe(false);
    expect(h.decorated.render(80)).toEqual(h.baseline.render(80));
  });
});
