import { expect, it } from "vitest";
import { NO_SUMMARY_METRICS } from "../src/tool-metrics.js";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { displayFor, joinLine, runningLine, settledLine } from "../src/display.js";

const content = [{ type: "text", text: Array(34).fill("output").join("\n") }];
const display = displayFor("bash", { command: "echo " + "Z".repeat(400) })!;
const countTarget = (line: string) => (stripTerminalSequences(line).match(/Z/g) ?? []).length;

it("lets shorter and absent intent lend their unused columns to the description", () => {
  const render = (intent?: string) => joinLine(settledLine({ toolName: "bash", display, content, isError: false, intent, layout: { width: 240 }, metrics: NO_SUMMARY_METRICS }));
  const long = render("i".repeat(48)), short = render("inspect"), absent = render();
  for (const line of [long, short, absent]) expect(visibleWidth(line)).toBe(120);
  expect(short).toContain(" — inspect");
  expect(countTarget(short) - countTarget(long)).toBe(48 - "inspect".length);
  expect(countTarget(absent) - countTarget(short)).toBe(3 + "inspect".length);
});

it("bounds the whole line, not just the command, across outcomes and custom caps", () => {
  for (const rowMaxWidth of [60, 120, 180]) for (const width of [40, 80, 240]) {
    const layout = { width, limits: { rowMaxWidth, commandMaxWidth: 400, intentMaxWidth: 48 } };
    const lines = [joinLine(runningLine("bash", display, "최종 검사와 출력 확인", layout)),
      ...[true, false].map((error) => joinLine(settledLine({ toolName: "bash", display, content, isError: error, intent: "최종 검사와 출력 확인", layout, metrics: NO_SUMMARY_METRICS })))];
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(Math.min(rowMaxWidth, width));
    expect(lines[1]).toContain("error");
    expect(lines[1]).not.toContain("34 lines");
  }
});

it("allows short descriptions to leave space for longer intent", () => {
  const short = displayFor("bash", { command: "pwd" });
  const purpose = "i".repeat(48);
  const line = joinLine(settledLine({ toolName: "bash", display: short, content, isError: false, intent: purpose, layout: { width: 80 }, metrics: NO_SUMMARY_METRICS }));
  expect(line).toContain(`pwd — ${purpose}`);
  expect(visibleWidth(line)).toBeLessThanOrEqual(80);
});

it("applies the same budget to file, query and fallback summaries", () => {
  for (const [name, args] of [["read", { path: "/" + "한글/".repeat(60) }], ["grep", { pattern: "pattern".repeat(80) }], ["custom", {}]] as const) {
    const line = joinLine(settledLine({ toolName: name, display: displayFor(name, args), content, isError: false, intent: "설치 확인 ".repeat(20), layout: { width: 240 }, metrics: NO_SUMMARY_METRICS }));
    expect(visibleWidth(line)).toBeLessThanOrEqual(120);
  }
});
