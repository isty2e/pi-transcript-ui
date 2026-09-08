import { expect, it, vi } from "vitest";
import { createBashToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { attachTranscriptPresentation } from "../../src/wiring.js";
import { nativeTool, nativeTranscript } from "./fixtures/native-components.js";

it("does not acquire path identities or output counts for a Bash group", () => {
  initTheme();
  const { root, chat } = nativeTranscript();
  const pathRead = vi.fn(() => { throw new Error("Unrelated path must not be read"); });
  const textRead = vi.fn(() => { throw new Error("Bash output must not be counted"); });
  for (const id of ["a", "b"]) {
    const args = { command: "printf example" };
    const result = { content: [{ type: "text", text: "native output" }], isError: false };
    const tool = nativeTool({ name: "bash", id, args, definition: createBashToolDefinition("/tmp") });
    tool.updateResult(result);
    Object.defineProperty(args, "path", { get: pathRead });
    Object.defineProperty(result.content[0], "text", { get: textRead });
    chat.addChild(tool);
  }
  const detach = attachTranscriptPresentation(root, {
    rules: { bash: "explore" }, requestRender() {},
    getTheme: () => ({ bold: text => text, fg: (_style, text) => text }),
  });
  try {
    expect(stripTerminalSequences(chat.render(120).join("\n"))).toBe("\n▸ Exploration 2 calls");
    expect(pathRead).not.toHaveBeenCalled();
    expect(textRead).not.toHaveBeenCalled();
  } finally {
    detach();
  }
});
