import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { initTheme, ToolExecutionComponent, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { attachTranscriptPresentation } from "../../../src/wiring.js";

export default function nativeChildrenFixture(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const cases: string[] = [];
    let executed = 0;
    const output = process.env.PI_TRANSCRIPT_UI_RUNTIME_REPORT;
    if (!output) throw new Error("Missing runtime fixture output path");
    const theme = { bold: (text: string) => text, fg: (_style: string, text: string) => text };
    const response = (text: string) => ({ content: [{ type: "text" as const, text }], isError: false });
    const makeDefinition = (shell: "default" | "self"): ToolDefinition => ({
      name: "runtime_fixture", label: "runtime fixture", description: "Native component fixture",
      parameters: { type: "object", properties: {} }, renderShell: shell,
      execute: async () => { executed++; throw new Error("The fixture must not execute tools"); },
      renderCall: () => new Text("NATIVE CALL", 0, 0),
      renderResult: (result, options) => new Text(`${options.isPartial ? "PARTIAL" : "FINAL"}\n${result.content
        .filter(part => part.type === "text").map(part => part.text).join("\n")}`, 0, 0),
    });
    let storage: string | undefined;

    try {
      initTheme("dark", false);
      for (const shell of ["default", "self"] as const) {
        const definition = makeDefinition(shell);
        const makeTool = (id: string) => new ToolExecutionComponent(definition.name, id, {}, { showImages: true }, definition,
          { requestRender() {} } as never, ctx.cwd);
        const baseline = makeTool("baseline"), native = makeTool("decorated");
        let prototype: object | null = Object.getPrototypeOf(native);
        let descriptor: PropertyDescriptor | undefined;
        while (prototype && !descriptor) {
          descriptor = Object.getOwnPropertyDescriptor(prototype, "children");
          prototype = Object.getPrototypeOf(prototype);
        }
        assert.ok(!Object.hasOwn(native, "children") && typeof descriptor?.get === "function" &&
          typeof descriptor.set === "function", "This fixture requires native inherited read/write children accessors");
        storage = "inherited-accessor";
        const chat = new Container(), root = new Container(); root.addChild(chat); chat.addChild(native);
        const warnings: unknown[] = [];
        const attach = (grouped = false) => attachTranscriptPresentation(root, { getTheme: () => theme, requestRender() {},
          ...(grouped ? { rules: { runtime_fixture: "read" as const } } : {}),
          onUnsupported: (_name, error) => warnings.push(error), onCleanupIncomplete: (_source, error) => warnings.push(error) });
        const dispose = attach();
        try {
          assert.equal(dispose.targets().length, 1);
          for (const [text, partial] of [["FIRST PARTIAL", true], ["LATEST FINAL", false]] as const) {
            for (const component of [baseline, native]) {
              component.setExpanded(false);
              component.updateResult(response(text), partial);
            }
            assert.equal(native.render(80).length, 2);
            native.setExpanded(true); baseline.setExpanded(true);
            for (const width of [27, 80, 120]) assert.deepEqual(native.render(width).slice(2), baseline.render(width));
            assert.deepEqual(chat.render(80), native.render(80));
          }
        } finally { dispose(); }
        for (const width of [27, 80, 120]) assert.deepEqual(native.render(width), baseline.render(width));
        const reattached = attach();
        assert.equal(reattached.targets().length, 1);
        assert.deepEqual(native.render(80).slice(2), baseline.render(80));
        reattached();
        assert.deepEqual(warnings, []);
        cases.push(`${shell}: partial/final, expansion, native body, parent dispatch and reattachment`);

        const capabilities = getCapabilities();
        setCapabilities({ ...capabilities, images: "kitty" });
        try {
          native.updateResult({ content: [{ type: "image", mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" }], isError: false });
          native.setExpanded(true);
          const before = native.render(80);
          assert.ok(before.some(line => line.includes("\x1b_G")), "Native image baseline must render Kitty data");
          const imageAttachment = attach();
          try { assert.deepEqual(native.render(80).slice(2), before); }
          finally { imageAttachment(); }
          assert.deepEqual(native.render(80), before);
          cases.push(`${shell}: native image bytes survive attachment and detach`);
        } finally { setCapabilities(capabilities); }

        native.updateResult(response("GROUP FIRST"));
        const second = makeTool("group-second"); second.updateResult(response("GROUP SECOND"));
        chat.addChild(second);
        const grouped = attach(true);
        try {
          const header = grouped.targets().find(target => target.kind === "group");
          assert.ok(header);
          header.setExpanded(true);
          assert.equal(grouped.targets().length, 3);
          native.setExpanded(false); second.setExpanded(true);
          assert.equal(header.expanded, true);
          const expandedHeight = chat.render(80).length;
          header.setExpanded(false);
          assert.equal(grouped.targets().length, 1);
          assert.ok(chat.render(80).length < expandedHeight);
        } finally { grouped(); }
        assert.deepEqual(warnings, []);
        cases.push(`${shell}: independent group/member disclosure`);
      }
      assert.equal(executed, 0);
      writeFileSync(output, JSON.stringify({ ok: true, storage, cases, executed }));
    } catch (error) {
      writeFileSync(output, JSON.stringify({ ok: false, storage, cases, error: String(error),
        stack: error instanceof Error ? error.stack : undefined }));
    } finally { ctx.shutdown(); }
  });
}
