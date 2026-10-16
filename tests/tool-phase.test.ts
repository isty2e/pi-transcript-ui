import { expect, it } from "vitest";
import { toolPhase } from "../src/tool-phase.js";

it.each([
  [false, false, false, "pending"],
  [false, true, false, "pending"],
  [false, false, true, "running"],
  [false, true, true, "running"],
  [true, true, false, "running"],
  [true, true, true, "running"],
  [true, false, false, "settled"],
  [true, false, true, "settled"],
] as const)("projects result=%s partial=%s started=%s as %s", (hasResult, isPartial, executionStarted, expected) => {
  expect(toolPhase({ hasResult, isPartial, executionStarted })).toBe(expected);
});
