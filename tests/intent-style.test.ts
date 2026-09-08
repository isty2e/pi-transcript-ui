import { expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { displayFor, joinLine, runningLine, settledLine } from "../src/display.js";
import { NO_SUMMARY_METRICS } from "../src/tool-metrics.js";
import { styleLine } from "../src/wiring.js";

const purpose = "같은 — 목적";
const display = displayFor("bash", { command: `echo '${purpose}'` });
const theme = {
  bold: (text: string) => text,
  fg: (kind: string, text: string) => `\x1b[${kind === "thinkingText" ? 90 : kind === "error" ? 31 : 32}m${text}\x1b[39m`,
};

it.each(["running", "success", "error"] as const)("colors only the intent and its dash for %s", (state) => {
  const parts = state === "running" ? runningLine("bash", display, purpose)
    : settledLine({ toolName: "bash", display, content: [], isError: state === "error", intent: purpose, metrics: NO_SUMMARY_METRICS });
  const shown = styleLine(theme, parts, state === "error");
  expect(shown).toContain(theme.fg("thinkingText", ` — ${purpose}`));
  expect(shown).toContain(`echo '${purpose}'`);
  expect(stripTerminalSequences(shown)).toBe(joinLine(parts));
  if (state === "running") expect(shown).toMatch(/\x1b\[39m…$/);
  if (state === "error") expect(shown).toContain(theme.fg("error", `▸ Run echo '${purpose}' — error`));
});

it.each([undefined, "", "   "])("does not request intent coloring when purpose is absent: %s", (intent) => {
  const fg = vi.fn(theme.fg);
  const parts = runningLine("bash", display, intent);
  expect(stripTerminalSequences(styleLine({ ...theme, fg }, parts))).toBe(joinLine(parts));
  expect(fg).not.toHaveBeenCalled();
});

it("preserves clipping and does not leave a colored dash when intent cannot fit", () => {
  for (let width = 0; width <= 120; width++) {
    const fg = vi.fn(theme.fg);
    const parts = runningLine("bash", display, "목적 👩‍💻 ".repeat(30), { width });
    const shown = styleLine({ ...theme, fg }, parts);
    expect(stripTerminalSequences(shown)).toBe(stripTerminalSequences(joinLine(parts)));
    expect(visibleWidth(shown)).toBe(visibleWidth(joinLine(parts)));
    if (!parts.intent) expect(fg).not.toHaveBeenCalled();
    for (const [kind, text] of fg.mock.calls) {
      if (kind === "thinkingText") expect(text).toBe(stripTerminalSequences(text));
    }
  }
});

it("uses the supplied theme on each render, without caching a color", () => {
  const parts = runningLine("bash", display, purpose);
  const alternate = { ...theme, fg: (_kind: string, text: string) => `\x1b[94m${text}\x1b[39m` };
  const first = styleLine(theme, parts);
  const second = styleLine(alternate, parts);
  expect(first).toContain(theme.fg("thinkingText", ` — ${purpose}`));
  expect(second).toContain(alternate.fg("thinkingText", ` — ${purpose}`));
  expect(second).not.toContain("\x1b[90m");
  expect(stripTerminalSequences(first)).toBe(stripTerminalSequences(second));
});
