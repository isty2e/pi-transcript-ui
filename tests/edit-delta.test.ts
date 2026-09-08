import { expect, it, vi } from "vitest";
import { NO_SUMMARY_METRICS } from "../src/tool-metrics.js";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { fileMutationFor } from "../src/file-mutation.js";
const edit = fileMutationFor(createEditToolDefinition("/tmp").parameters);
const write = fileMutationFor(createWriteToolDefinition("/tmp").parameters);
import { countPatchChanges, editDeltaFor } from "../src/edit-delta.js";
import { displayFor, settledLine } from "../src/display.js";
import { styleLine } from "../src/wiring.js";
import { generateUnifiedPatch } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js";

it.each([
  ["a\n", "a\nb\nc\n", 2, 0], ["a\nb\nc\n", "a\n", 0, 2],
  ["a\nb\n", "a\nc\nd\n", 2, 1], ["same\n", "same\n", 0, 0],
  ["old", "new", 1, 1], ["same", "same\nnew", 2, 1], ["--- old\n", "+++ new\n", 1, 1],
] as const)("counts actual Pi patch payloads", (before, after, added, removed) => {
  expect(countPatchChanges(generateUnifiedPatch("file.txt", before, after))).toEqual({ added, removed });
});

it("counts separated hunks without counting headers or context", () => {
  const middle = "unchanged\n".repeat(30);
  expect(countPatchChanges(generateUnifiedPatch("file.txt", `old\n${middle}old2\n`, `new\n${middle}new2\n`))).toEqual({ added: 2, removed: 2 });
});

it.each([
  "not a patch", "--- f\n+++ f\n@@ -0 +0 @@\n-old\n+new\n",
  "--- f\n+++ f\n@@ -1,2 +1 @@\n-old\n\\ No newline at end of file\n-more\n+new\n", "--- f\n+++ f\n@@ -1,2 +1,1 @@\n-old\n+new\n",
  "--- f\n+++ f\n@@ -1 +1 @@\n-old\n", "--- f\n+++ f\n@@ -1 +1 @@\n-old\n+new\ntruncated",
  "--- f\n+++ f\n@@ -1 +1 @@\n-old\n+new\n@@ -1 +1 @@\n-old\n+new\n",
  "--- f\n+++ f\n@@ -1 +1 @@\n\\ No newline at end of file\n-old\n+new\n",
])("refuses incomplete or unsupported patches", (patch) => { expect(countPatchChanges(patch)).toBeUndefined(); });

it("requires capability and completed patch evidence; invalidates in-place patch changes", () => {
  const patch = generateUnifiedPatch("f", "old\n", "new\n");
  const result = { isError: false, details: { patch } };
  expect(editDeltaFor(edit, result)).toEqual({ added: 1, removed: 1 });
  expect(editDeltaFor(write, result)).toEqual({ added: 1, removed: 1 });
  expect(editDeltaFor(undefined, result)).toBeUndefined();
  expect(editDeltaFor(edit, result, true)).toBeUndefined();
  expect(editDeltaFor(edit, { ...result, isError: true })).toBeUndefined();
  expect(editDeltaFor(edit, { details: { patch } })).toBeUndefined();
  expect(editDeltaFor(edit, { isError: false, details: { diff: "+1 new" } })).toBeUndefined();
  result.details.patch = generateUnifiedPatch("f", "old\n", "new\nextra\n");
  expect(editDeltaFor(edit, result)).toEqual({ added: 2, removed: 1 });
  expect(countPatchChanges(patch + patch)).toBeUndefined();
});

it("styles only the derived outcome, not identical text in arguments or intent", () => {
  const theme = { bold: (s: string) => s, fg: vi.fn((key: string, s: string) => `<${key}>${s}</${key}>`) };
  const display = displayFor("edit", { path: "(+2 -1).txt", edits: [] }, edit);
  const parts = settledLine({ toolName: "edit", display, content: [], isError: false, intent: "keep (+2 -1)", layout: {}, metrics: { ...NO_SUMMARY_METRICS, patch: { kind: "known", value: { added: 2, removed: 1 } } } });
  const shown = styleLine(theme, parts);
  expect(shown).toContain("(+2 -1).txt");
  expect(shown).toContain("keep (+2 -1)");
  expect(theme.fg.mock.calls).toEqual([["toolDiffAdded", "+2"], ["toolDiffRemoved", "-1"]]);
  const error = settledLine({ toolName: "edit", display, content: [], isError: true, intent: undefined, layout: {}, metrics: { ...NO_SUMMARY_METRICS, patch: { kind: "known", value: { added: 2, removed: 1 } } } });
  expect(error.change).toBeUndefined();
});
