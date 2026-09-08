import { expect, it } from "vitest";
import { createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { classifyTool } from "../src/classify.js";
import { displayFor, joinLine, settledLine } from "../src/display.js";
import { fileMutationFor } from "../src/file-mutation.js";
import { fileReadFor } from "../src/read-body.js";
import { summaryMetrics } from "../src/tool-metrics.js";

const read = fileReadFor(createReadToolDefinition("/tmp").parameters);
const mutation = fileMutationFor(createWriteToolDefinition("/tmp").parameters);
const patch = "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n";

it("distinguishes a known empty Read, unavailable Read evidence and an unrelated tool", () => {
  const input = { toolName: "read", classification: classifyTool("read"), capabilities: { read, mutation: undefined }, args: { path: "f" }, result: { content: [{ type: "text", text: "" }], isError: false }, isPartial: false };
  expect(summaryMetrics(input).read).toEqual({ kind: "known", value: { lines: 0, source: "body" } });
  const unavailable = summaryMetrics({ ...input, result: { ...input.result, content: [{ type: "text", text: "Read image file [image/png]" }] } });
  expect(unavailable.read).toEqual({ kind: "unavailable" });
  expect(joinLine(settledLine({ toolName: "read", display: displayFor("read", input.args), content: [], isError: false, metrics: unavailable }))).toBe("▸ Read f (lines unknown)");
  expect(summaryMetrics({ ...input, toolName: "grep", classification: classifyTool("grep"), capabilities: { read: undefined, mutation: undefined } }).read).toEqual({ kind: "not-applicable" });
});

it("retains simultaneous Write content size and patch evidence, even under a read-name override", () => {
  const args = { path: "f", content: "" };
  const result = { content: [{ type: "text", text: "receipt" }], isError: false, details: { patch } };
  const metrics = summaryMetrics({ toolName: "read", classification: classifyTool("read"), capabilities: { mutation, read: undefined }, args, result, isPartial: false });
  expect(metrics.read).toEqual({ kind: "not-applicable" });
  expect(metrics.written).toEqual({ kind: "known", value: 0 });
  expect(metrics.patch).toEqual({ kind: "known", value: { added: 1, removed: 1 } });
  expect(joinLine(settledLine({ toolName: "read", display: displayFor("read", args, mutation), content: result.content, isError: false, metrics }))).toBe("▸ Write f (0 lines)");
});

it.each(["partial", "failure", "missing"])("does not invent a Write count for %s evidence", state => {
  const result = state === "missing" ? undefined : { content: [], isError: state === "failure", details: { patch } };
  const metrics = summaryMetrics({ toolName: "write", classification: classifyTool("write", null, mutation), capabilities: { mutation, read: undefined }, args: { path: "f", content: "" }, result, isPartial: state === "partial" });
  expect(metrics.written).toEqual({ kind: "unavailable" });
  expect(metrics.patch).toEqual({ kind: "unavailable" });
});

it("reobserves changed content and patch on the same native input objects", () => {
  const args = { path: "f", content: "" };
  const result = { content: [], isError: false, details: { patch } };
  const input = { toolName: "write", classification: classifyTool("write", null, mutation), capabilities: { mutation, read: undefined }, args, result, isPartial: false };
  expect(summaryMetrics(input).written).toEqual({ kind: "known", value: 0 });
  args.content = "one\ntwo\n";
  result.details.patch = "not a patch";
  expect(summaryMetrics(input).written).toEqual({ kind: "known", value: 2 });
  expect(summaryMetrics(input).patch).toEqual({ kind: "unavailable" });
});
