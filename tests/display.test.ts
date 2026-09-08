import { describe, expect, it } from "vitest";
import { NO_SUMMARY_METRICS } from "../src/tool-metrics.js";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { fileMutationFor } from "../src/file-mutation.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { countResultLines, displayFor, joinLine, resultBody, runningLine, settledLine } from "../src/display.js";

describe("displayFor", () => {
  it("derives action plus target for every built-in shape", () => {
    expect(displayFor("read", { path: "/a/b.txt" })).toEqual({
      action: "Read",
      target: { kind: "path", path: "/a/b.txt" },
    });
    expect(displayFor("write", { path: "x.txt", content: "hi" }, fileMutationFor(createWriteToolDefinition("/tmp").parameters))?.action).toBe("Write");
    expect(displayFor("edit", { path: "x.txt", edits: [] }, fileMutationFor(createEditToolDefinition("/tmp").parameters))?.action).toBe("Edit");
    expect(displayFor("powershell", { command: "Get-ChildItem" })?.action).toBe("Run");
    expect(displayFor("bash", { command: "ls -la" })).toEqual({
      action: "Run",
      target: { kind: "command", command: "ls -la" },
    });
    expect(displayFor("grep", { pattern: "foo" })?.action).toBe("Search");
    expect(displayFor("find", { pattern: "*.ts" })?.action).toBe("Find");
    expect(displayFor("ls", {})?.action).toBe("List");
  });

  it("fails to null on shape mismatch and hostile input", () => {
    expect(displayFor("read", {})).toBeNull();
    expect(displayFor("read", { path: 42 })).toBeNull();
    expect(displayFor("bash", { command: "" })).toBeNull();
    expect(displayFor("custom", { anything: true })).toBeNull();
    for (const hostile of [undefined, null, 42, "x", []] as const) {
      expect(displayFor("read", hostile)).toBeNull();
      expect(displayFor(hostile, {})).toBeNull();
    }
  });

  it("compresses home and truncates commands to one line", () => {
    const home = process.env["HOME"] ?? "";
    expect(displayFor("read", { path: `${home}/a.txt` })?.target).toEqual({
      kind: "path",
      path: "~/a.txt",
    });
    expect(displayFor("bash", { command: `echo hi\nrm -rf /` })?.target).toEqual({
      kind: "command",
      command: "echo hi\nrm -rf /",
    });
    expect(displayFor("bash", { command: "x".repeat(100) })?.target?.kind).toBe("command");
  });
});

describe("row lines", () => {
  const content = [{ type: "text", text: "a\nb\nc" }];

  it("builds running and settled lines in our wording", () => {
    const display = displayFor("read", { path: "f.txt" })!;
    expect(joinLine(runningLine("read", display))).toBe("▸ Read f.txt…");
    expect(joinLine(settledLine({ toolName: "read", display, content, isError: false, metrics: NO_SUMMARY_METRICS }))).toBe("▸ Read f.txt (3 lines)");
    expect(joinLine(settledLine({ toolName: "read", display, content, isError: true, metrics: NO_SUMMARY_METRICS }))).toBe("▸ Read f.txt — error (3 lines)");
    expect(joinLine(settledLine({ toolName: "grep", display: displayFor("grep", { pattern: "p" }), content, isError: false, metrics: NO_SUMMARY_METRICS }))).toBe(
      '▸ Search "p" (3 matches)',
    );
  });

  it("falls back to the safe generic line without rendering arguments", () => {
    expect(joinLine(runningLine("read", null))).toBe("▸ read…");
    expect(joinLine(settledLine({ toolName: "read", display: null, content, isError: false, metrics: NO_SUMMARY_METRICS }))).toBe("▸ read (3 lines)");
  });

  it("counts lines and joins bodies like the reference core", () => {
    expect(countResultLines(content)).toBe(3);
    expect(countResultLines([])).toBe(0);
    expect(resultBody(content)).toBe("a\nb\nc");
  });
});

describe("long commands", () => {
  it("keeps one-liners short while retaining the full command", () => {
    const cmd = `cd /Users/example/Desktop/git/transcript-ui-tests and run the full verification suite twice with coverage enabled plus verbose output plus fail-fast disabled plus retries`;
    const display = displayFor("bash", { command: cmd })!;
    const summary = joinLine(runningLine("bash", display));
    expect(visibleWidth(summary)).toBeGreaterThan(60);
    expect(visibleWidth(summary)).toBeLessThanOrEqual(120);
    expect(display.target.kind === "command" && display.target.command).toContain("plus retries");
  });
});

describe("intent suffix", () => {
  const content = [{ type: "text", text: "a\nb" }];
  it("appends model intent and omits it when absent", () => {
    const display = displayFor("read", { path: "f.txt", displaySummary: "Check setup" })!;
    expect(joinLine(settledLine({ toolName: "read", display, content, isError: false, intent: "Check setup", metrics: NO_SUMMARY_METRICS }))).toBe(
      "▸ Read f.txt (2 lines) — Check setup",
    );
    expect(joinLine(settledLine({ toolName: "read", display, content, isError: false, metrics: NO_SUMMARY_METRICS }))).toBe("▸ Read f.txt (2 lines)");
    expect(joinLine(runningLine("read", display, "Check setup"))).toBe("▸ Read f.txt — Check setup…");
  });
});

describe("pluralLines", () => {
  it("uses the singular for one line", () => {
    const content = [{ type: "text", text: "solo" }];
    const display = displayFor("read", { path: "f.txt" })!;
    expect(joinLine(settledLine({ toolName: "read", display, content, isError: false, metrics: NO_SUMMARY_METRICS }))).toBe("▸ Read f.txt (1 line)");
  });
});
