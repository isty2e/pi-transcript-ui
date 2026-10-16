import { expect, it } from "vitest";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { codemodeSummary } from "../src/codemode-summary.js";
import { codemodeLine, joinLine } from "../src/display.js";

const { formatToolDuration } = await import(join(getPackageDir(), "dist/core/tools/render-utils.js")) as {
  formatToolDuration(ms: number): string;
};

const summarize = (calls: unknown, durationMs: unknown = 42, isPartial = false) => codemodeSummary({
  toolName: "codemode", args: { code: "" }, result: { details: { calls }, durationMs }, isPartial,
})!;

it.each([0, 42, 999, 1000, 1234, 59_950, 59_999, 60_000, 60_123, 125_300, 3_599_999, 3_600_000, 7_384_999])(
  "matches native parent duration formatting at %d ms", durationMs => {
    const line = joinLine(codemodeLine({ summary: summarize([], durationMs), isError: false }));
    expect(line).toBe(`▸ Code (0 nested calls; ${formatToolDuration(durationMs)})`);
  },
);

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
  expect(summary.durationMs).toBe(42);
  expect(joinLine(codemodeLine({ summary, isError: false }))).toBe("▸ Code (0.0s)");
});

it.each([undefined, NaN, Infinity, -1, "1234"])("does not invent elapsed time from unusable duration: %s", duration => {
  const summary = codemodeSummary({ toolName: "codemode", args: { code: "text('no prediction');" },
    result: { details: { calls: [] }, durationMs: duration, content: [{ type: "text", text: "Wall time 9 seconds" }] }, isPartial: false })!;
  expect(summary.durationMs).toBeUndefined();
  expect(joinLine(codemodeLine({ summary, isError: false }))).toBe("▸ Code (0 nested calls)");
});

it.each([null, undefined, {}, { code: null }, { code: 42 }, "tools.read({})"])("requires a native normalized code input: %j", args => {
  expect(codemodeSummary({ toolName: "codemode", args, result: { details: { calls: [] } }, isPartial: false })).toBeUndefined();
});

it("does not recognize another tool from a code field or matching result text", () => {
  expect(codemodeSummary({ toolName: "other", args: { code: "return 1" },
    result: { details: { calls: [] } }, isPartial: false })).toBeUndefined();
  const summary = codemodeSummary({ toolName: "codemode", args: { code: "return tools.never_called({});" },
    result: { content: [{ type: "text", text: "Script completed\nNo tool calls were made." }] }, isPartial: false })!;
  expect(summary.calls).toBeUndefined();
  expect(joinLine(codemodeLine({ summary, isError: true }))).toBe("▸ Code — error");
});

it("uses a bounded, plain, non-sequential name preview and retains partial/intent semantics", () => {
  const summary = summarize([{ name: "\u001b[31mread\u001b[0m\n\u0007", status: "ok" },
    { name: "very_long_".repeat(30), status: "ok" }, { name: "models.classify", status: "ok" },
    { name: "omitted", status: "error" }], 42, true);
  const line = joinLine(codemodeLine({ summary, isError: false, intent: "Check actual activity" }));
  expect(line).not.toContain("\u001b[31m");
  expect(stripTerminalSequences(line)).not.toMatch(/[\r\n\u0007]/);
  expect(line).not.toContain("omitted");
  expect(line).not.toContain("0.0s");
  expect(line).toContain("4 nested calls so far; 1 error");
  expect(line).toContain(" — Check actual activity…");
  expect(line).not.toContain("→");
  expect(visibleWidth(line)).toBeLessThanOrEqual(120);
});
