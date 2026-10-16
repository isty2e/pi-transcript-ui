import { expect, it } from "vitest";
import { piCapabilities } from "./fixtures/pi-capabilities.js";

it.each([
  ["0.85.1", "legacy-string", false, false],
  ["0.86.0", "structured-positional", false, false],
  ["0.98.0", "structured-positional", false, false],
  ["0.99.0", "structured-positional", true, false],
  ["1.0.0", "structured-positional", true, false],
  ["1.1.0", "structured-positional", true, true],
  ["1.2.0", "structured-trigger", true, true],
  ["1.3.0", "structured-trigger", true, true],
  ["1.10.0", "structured-trigger", true, true],
] as const)("selects the release capabilities of Pi %s", (version, promptApi, codemode, recordedToolDuration) => {
  expect(piCapabilities(version)).toEqual({ promptApi, codemode, recordedToolDuration });
});
