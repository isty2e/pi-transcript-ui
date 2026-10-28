import { expect, it } from "vitest";
import { createReadTool, createWriteTool, createEditTool } from "@earendil-works/pi-coding-agent";
import { interpretToolSummary, toolSummaryLine } from "../src/tool-summary.js";
import { argumentPreview } from "../src/codemode/argument-preview.js";
import { fileReadFor } from "../src/read-body.js";
import { fileMutationFor } from "../src/file-mutation.js";
import { classifyTool } from "../src/classify.js";
import { joinLine } from "../src/display.js";

type Input = Parameters<typeof interpretToolSummary>[0];
const schemas = {read: createReadTool("/tmp").parameters, write: createWriteTool("/tmp").parameters, edit: createEditTool("/tmp").parameters};
function summarize(toolName: keyof typeof schemas, args: unknown, change: Partial<Input> = {}) {
  const parameters = schemas[toolName], mutation = fileMutationFor(parameters), read = fileReadFor(parameters);
  return interpretToolSummary({toolName, request: {args, complete: true, source: "recorded"}, result: undefined,
    lifecycle: {kind: "activity", status: "ok", parentFinal: true}, parameters,
    classification: classifyTool(toolName, undefined, mutation), capabilities: {mutation, read, patch: undefined}, ...change});
}
const line = (summary: ReturnType<typeof summarize>) => joinLine(toolSummaryLine(summary));

it("uses identical request meaning for direct, retained and complete-preview facts", () => {
  const args = {path: "/tmp/a.ts", offset: 3, limit: 2};
  const direct = summarize("read", args, {request: {args, complete: true, source: "live"}, lifecycle: {kind: "native", phase: "settled"}});
  const saved = summarize("read", args);
  const preview = summarize("read", args, {request: argumentPreview(JSON.stringify(args))});
  expect(line(direct)).toBe(line(saved)); expect(line(preview)).toBe(line(saved));
  expect(line(saved)).toContain("Read /tmp/a.ts (requested lines 3–4)");
  expect(saved.metrics.read.kind).toBe("unavailable");
});

it("does not turn an absent read result into zero or replace a supplied unknown/error result with a request extent", () => {
  const args = {path: "/tmp/a.ts", limit: 2};
  expect(line(summarize("read", args))).toContain("requested lines 1–2");
  const zero = summarize("read", args, {result: {content: [{type: "text", text: ""}], isError: false}});
  expect(zero.metrics.read.kind).toBe("known"); expect(line(zero)).toContain("(0 lines)");
  expect(line(summarize("read", args, {result: {content: [{type: "image", data: "image"}], isError: false}}))).toContain("(lines unknown)");
  const error = line(summarize("read", args, {result: {content: [{type: "text", text: "failure"}], isError: true}}));
  expect(error).toContain("— error"); expect(error).not.toContain("requested");
});

it("retains a target despite unusable extent fields, and applies defaults only to complete requests", () => {
  expect(line(summarize("read", {path: "/tmp/a.ts", limit: -2}))).toBe("▸ Read /tmp/a.ts");
  expect(line(summarize("read", {}, {request: argumentPreview('{"path":"/tmp/a.ts","limit":2,...')})))
    .toContain("requested up to 2 lines");
  expect(line(summarize("read", {}, {request: argumentPreview('{"limit":2,"path":"unfinished...')})))
    .toBe("▸ Read (requested up to 2 lines)");
  expect(line(summarize("read", {path: "/tmp/a.ts", limit: 0}))).toContain("requested 0 lines");
  expect(line(summarize("read", {path: "/tmp/a.ts", offset: Number.MAX_SAFE_INTEGER, limit: 3})))
    .not.toContain("requested lines");
  expect(line(summarize("read", {path: "/tmp/a.ts", limit: 4}, {lifecycle: {kind: "native", phase: "running"}}))).not.toContain("requested");
});

it("labels supplied write size as requested, not measured output or a patch, and keeps incomplete edit targets", () => {
  const write = summarize("write", {path: "/tmp/a.ts", content: "a\nb\n"});
  expect(line(write)).toContain("Write /tmp/a.ts (requested 2 lines)");
  expect(write.metrics.written.kind).toBe("unavailable"); expect(write.metrics.patch.kind).not.toBe("known");
  expect(line(summarize("write", {path: "/tmp/a.ts", content: ""}))).toContain("requested 0 lines");
  expect(line(summarize("edit", {path: "/tmp/a.ts"}))).toBe("▸ Edit /tmp/a.ts");
  expect(line(summarize("write", {}, {request: argumentPreview('{"path":"/tmp/a.ts","content":"unfinished...')})))
    .toBe("▸ Write /tmp/a.ts");
});

it("settles stale running activity as completion unknown without claiming success or losing cancellation", () => {
  const unknown = summarize("read", {path: "/tmp/a.ts"}, {lifecycle: {kind: "activity", status: "running", parentFinal: true}});
  expect(unknown.phase).toBe("settled"); expect(unknown.status).toBe("unknown");
  expect(line(unknown)).toBe("▸ read /tmp/a.ts — completion unknown");
  expect(line(summarize("read", {path: "/tmp/a.ts"}, {lifecycle: {kind: "activity", status: "cancelled", parentFinal: true}}))).toContain("— cancelled");
  expect(summarize("read", {path: "/tmp/a.ts"}, {lifecycle: {kind: "activity", status: "running", parentFinal: false}}).phase).toBe("running");
});
