import { expect, it } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { codemodeSummary } from "../src/codemode/summary.js";
import { codemodeLine, joinLine } from "../src/display.js";

const summarize = (calls: unknown, isPartial = false) => codemodeSummary({
  toolName: "codemode", args: { code: "" }, result: { details: { calls } }, phase: isPartial ? "running" : "settled",
})!;

it("aggregates every observed status while bounding only the name preview", () => {
  const calls = Array.from({ length: 1000 }, (_, index) => ({ name: ["read", "bash", "models.classify", "edit"][index % 4],
    status: ["ok", "running", "error", "cancelled"][index % 4] }));
  const before = structuredClone(calls);
  const summary = summarize(calls);
  expect(summary.calls).toEqual({ total: 1000, running: 250, errors: 250, cancelled: 250,
    names: [{ name: "read", count: 250 }, { name: "bash", count: 250 }, { name: "models.classify", count: 250 }], moreNames: true });
  expect(calls).toEqual(before);
});

it.each([undefined, null, false, {}, [null], [{}], [{ name: "read", status: "done" }],
  [{ name: "read", status: "ok" }, { name: "", status: "error" }]].map(calls => ({ calls })))("refuses an unusable whole calls list: $calls", ({ calls }) => {
  const summary = summarize(calls);
  expect(summary.calls).toBeUndefined();
  expect(joinLine(codemodeLine({ summary, isError: false, durationMs: 42 }))).toBe("▸ Ran code (0.0s)");
});

it.each([null, undefined, {}, { code: null }, { code: 42 }, "tools.read({})"])("requires a native normalized code input: %j", args => {
  expect(codemodeSummary({ toolName: "codemode", args, result: { details: { calls: [] } }, phase: "settled" })).toBeUndefined();
});

it("does not recognize another tool from a code field or matching result text", () => {
  expect(codemodeSummary({ toolName: "other", args: { code: "return 1" },
    result: { details: { calls: [] } }, phase: "settled" })).toBeUndefined();
  const summary = codemodeSummary({ toolName: "codemode", args: { code: "return tools.never_called({});" },
    result: { content: [{ type: "text", text: "Script completed\nNo tool calls were made." }] }, phase: "settled" })!;
  expect(summary.calls).toBeUndefined();
  expect(joinLine(codemodeLine({ summary, isError: true }))).toBe("▸ Ran code — error");
});

it("uses a bounded, plain, non-sequential name preview and retains partial/intent semantics", () => {
  const summary = summarize([{ name: "\u001b[31mread\u001b[0m\n\u0007", status: "ok" },
    { name: "very_long_".repeat(30), status: "ok" }, { name: "models.classify", status: "ok" },
    { name: "omitted", status: "error" }], true);
  const line = joinLine(codemodeLine({ summary, isError: false, durationMs: 42, intent: "Check actual activity" }));
  expect(line).not.toContain("\u001b[31m");
  expect(stripTerminalSequences(line)).not.toMatch(/[\r\n\u0007]/);
  expect(line).not.toContain("omitted");
  expect(line).not.toContain("0.0s");
  expect(line).toContain("4 nested calls so far; 1 error");
  expect(line).toContain(" — Check actual activity…");
  expect(line).not.toContain("→");
  expect(visibleWidth(line)).toBeLessThanOrEqual(120);
});
