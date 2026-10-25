import { expect, it } from "vitest";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { toolDurationMs } from "../src/tool-duration.js";
import { codemodeSummary } from "../src/codemode/summary.js";
import { codemodeLine, displayFor, joinLine, settledLine, shellSessionLine } from "../src/display.js";
import { NO_SUMMARY_METRICS } from "../src/tool-metrics.js";
import { styleLine } from "../src/wiring.js";

const { formatToolDuration } = await import(join(getPackageDir(), "dist/core/tools/render-utils.js")) as {
  formatToolDuration(ms: number): string;
};
const content = [{ type: "text", text: "returned output" }];

it.each([0, 42, 999, 1000, 1234, 59_950, 59_999, 60_000, 60_123, 125_300, 3_599_999, 3_600_000, 7_384_999])(
  "matches the native parent duration format on a normal tool at %d ms", durationMs => {
    const parts = settledLine({ toolName: "read", display: displayFor("read", { path: "f.txt" }), content,
      isError: false, metrics: NO_SUMMARY_METRICS, durationMs: toolDurationMs({ durationMs }, false) });
    expect(joinLine(parts)).toBe(`▸ Read f.txt (1 line) (${formatToolDuration(durationMs)})`);
  },
);

it.each([undefined, null, NaN, Infinity, -Infinity, -1, "1234", {}, []])("omits an unusable duration without reading output text: %j", durationMs => {
  const result = { durationMs, content: [{ type: "text", text: "Wall time 9 seconds" }], details: { durationMs: 9000 } };
  expect(toolDurationMs(result, false)).toBeUndefined();
});

it("does not invent time for missing results and never reads a partial or throwing duration property", () => {
  for (const result of [undefined, null, false, [], {}]) expect(toolDurationMs(result, false)).toBeUndefined();
  let reads = 0;
  const result = Object.defineProperty({}, "durationMs", { get() { reads++; throw new Error("unavailable"); } });
  expect(toolDurationMs(result, true)).toBeUndefined();
  expect(reads).toBe(0);
  expect(toolDurationMs(result, false)).toBeUndefined();
  expect(reads).toBe(1);
  expect(toolDurationMs({ durationMs: 0 }, false)).toBe(0);
  expect(toolDurationMs({ durationMs: 125300 }, false)).toBe(125300);
});

it.each([true, false])("uses one duration policy across row families when toolDuration is %s", toolDuration => {
  const context = { durationMs: 125300, intent: "Verify output", layout: { limits: { toolDuration } } };
  const code = codemodeSummary({ toolName: "codemode", args: { code: "return 1" },
    result: { details: { calls: [{ name: "read", status: "ok" }] } }, phase: "settled" })!;
  const parts = [
    ...["read", "write", "edit", "bash", "powershell", "custom"].map(toolName => settledLine({ toolName,
      display: displayFor(toolName, { path: "f.txt", command: "npm test" }), content, isError: false,
      metrics: NO_SUMMARY_METRICS, ...context })),
    shellSessionLine({ action: "Run", command: "npm test", exitCode: 0 }, false, "settled", context),
    shellSessionLine({ action: "Check output" }, true, "settled", context),
    shellSessionLine({ action: "Send input" }, false, "settled", context),
    codemodeLine({ summary: code, isError: false, ...context }),
    codemodeLine({ summary: { phase: "settled", calls: undefined }, isError: true, ...context }),
  ];

  for (const row of parts) {
    const text = joinLine(row);
    expect(text.includes("(2m 5s)")).toBe(toolDuration);
    expect(text.split("2m 5s")).toHaveLength(toolDuration ? 2 : 1);
    expect(text.endsWith(" — Verify output")).toBe(true);
    expect(row.rest.slice(row.intent!.offset, row.intent!.offset + row.intent!.length)).toBe(" — Verify output");
  }
  expect(joinLine(parts[6]!)).toContain("(exit 0)");
  expect(joinLine(parts[7]!)).toContain("— error");
  expect(joinLine(parts[9]!)).toContain("(1 nested call)");
});

it("does not show a final time on partial shell or codemode rows even if a caller supplies one", () => {
  const context = { durationMs: 1234 };
  const code = { phase: "running" as const, calls: undefined };
  expect(joinLine(codemodeLine({ summary: code, isError: false, ...context }))).toBe("▸ Running code…");
  expect(joinLine(shellSessionLine({ action: "Check output" }, false, "running", context))).toBe("▸ Checking output…");
});

it("keeps mutation, purpose and error styling aligned after the common time metric", () => {
  for (const isError of [false, true]) {
    const parts = settledLine({ toolName: "edit", display: { action: "Edit", target: { kind: "path", path: "f.txt" } },
      content, isError, durationMs: 1234, intent: "Inspect changes", metrics: { ...NO_SUMMARY_METRICS,
        patch: { kind: "known", value: { added: 3, removed: 1 } } } });
    const styled = styleLine({ bold: text => text, fg: (_kind, text) => `\u001b[31m${text}\u001b[0m` }, parts, isError);
    expect(stripTerminalSequences(styled)).toBe(joinLine(parts));
    expect(joinLine(parts)).toContain("(1.2s) — Inspect changes");
    expect(joinLine(parts).includes("— error")).toBe(isError);
    if (!isError) expect(joinLine(parts)).toContain("(+3 -1)");
  }
});

it("fits time before allocating target and purpose widths and drops a token that cannot fit", () => {
  for (const width of [24, 40, 80, 120]) {
    const parts = settledLine({ toolName: "bash", display: displayFor("bash", { command: "echo " + "긴경로/🙂/".repeat(100) }),
      content, isError: false, durationMs: 1234, intent: "변경 확인 ".repeat(10),
      metrics: NO_SUMMARY_METRICS, layout: { width } });
    expect(visibleWidth(joinLine(parts))).toBeLessThanOrEqual(width);
    expect(joinLine(parts)).toContain("(1.2s)");
  }
  const parts = settledLine({ toolName: "bash", display: displayFor("bash", { command: "pwd" }), content,
    isError: false, metrics: NO_SUMMARY_METRICS, durationMs: 1234, layout: { width: 10 } });
  expect(joinLine(parts)).not.toContain("(1.2s)");
});
