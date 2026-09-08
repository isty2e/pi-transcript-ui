import { expect, it } from "vitest";
import { classifyTool } from "../src/classify.js";
import { joinLine } from "../src/display.js";
import { groupSummary, groupSummaryRequirements, type GroupMemberSummary } from "../src/group-summary.js";
import { NO_SUMMARY_METRICS } from "../src/tool-metrics.js";

const reader = { kind: "native-compatible-read" } as const;
const writer = { pathKey: "path", action: "Write", shape: "content" } as const;
function readMember(path: string, lines: number): GroupMemberSummary {
  return {
    toolName: "read", classification: classifyTool("read"), capabilities: { read: reader, mutation: undefined },
    settled: true, isError: false, readPath: path, outputLines: 100,
    metrics: { ...NO_SUMMARY_METRICS, read: { kind: "known", value: { lines, source: "body" } } },
  };
}
const summarize = (members: GroupMemberSummary[], classification = classifyTool("read"), expanded = false) =>
  groupSummary({ members, classification, expanded });

it("uses original identity for file count, calls for coverage and preserves known zero", () => {
  const first = readMember("same", 0);
  const failed: GroupMemberSummary = { ...readMember("same", 0), isError: true, metrics: { ...NO_SUMMARY_METRICS, read: { kind: "unavailable" } } };
  expect(joinLine(summarize([first, failed]))).toBe("▸ Read 1 file — 1 failed (partial 1/2: 2 reads, 0 lines)");
  expect(joinLine(summarize([failed, first]))).toBe(joinLine(summarize([first, failed])));
  expect(joinLine(summarize([first, { ...first, readPath: "other" }]))).toBe("▸ Read 2 files (0 lines)");
});

it("keeps unknown totals absent instead of falling through to receipt totals", () => {
  const member: GroupMemberSummary = { ...readMember("same", 0), metrics: { ...NO_SUMMARY_METRICS, read: { kind: "unavailable" } } };
  expect(joinLine(summarize([member, member]))).toBe("▸ Read 1 file (2 reads)");
  expect(joinLine(summarize([member, { ...member, readPath: "other" }]))).toBe("▸ Read 2 files");
  expect(joinLine(summarize([member, { ...member, readPath: undefined }]))).toBe("▸ Read 2 calls");
});

it("uses patch sums, not Write sizes, in a mixed capability group", () => {
  const mutation = classifyTool("write", null, writer);
  const write: GroupMemberSummary = {
    toolName: "write", classification: mutation, capabilities: { mutation: writer, read: undefined },
    settled: true, isError: false, readPath: undefined, outputLines: 100,
    metrics: { ...NO_SUMMARY_METRICS, written: { kind: "known", value: 200 }, patch: { kind: "known", value: { added: 1, removed: 1 } } },
  };
  const parts = summarize([write, readMember("same", 5)], mutation);
  expect(joinLine(parts)).toBe("▸ Mutation 2 calls (partial 1/2: +1 -1)");
  expect(parts.change).toEqual({ added: 1, removed: 1, counted: 1, total: 2, offset: " 2 calls".length });
  const withoutPatch = { ...write, metrics: { ...write.metrics, patch: { kind: "unavailable" } as const } };
  expect(joinLine(summarize([withoutPatch, readMember("same", 5)], mutation))).toBe("▸ Mutation 2 calls (partial 1/2: 5 lines)");
});

it("does not treat a partial error as a settled group failure", () => {
  const partial = { ...readMember("other", 0), settled: false, isError: true, metrics: { ...NO_SUMMARY_METRICS, read: { kind: "unavailable" } as const } };
  const parts = summarize([readMember("same", 2), partial], classifyTool("read"), true);
  expect(joinLine(parts)).toBe("▾ Reading 2 files (partial 1/2: 2 lines)…");
  expect(parts.failure).toBeUndefined();
});

it("requests native path identity only for Read labels and output counts only for generic completed groups", () => {
  const read = readMember("same", 1);
  const input = { members: [read, read], classification: classifyTool("read"), expanded: false };
  expect(groupSummaryRequirements(input)).toEqual({ readIdentity: true, outputLines: false });
  const search: GroupMemberSummary = { ...read, toolName: "grep", classification: classifyTool("grep"), capabilities: { read: undefined, mutation: undefined }, metrics: NO_SUMMARY_METRICS, outputLines: 3 };
  expect(groupSummaryRequirements({ ...input, members: [search, search] })).toEqual({ readIdentity: false, outputLines: true });
  expect(joinLine(summarize([search, search]))).toBe("▸ Searched 2 patterns (6 lines)");
  const bash = { ...search, toolName: "bash" };
  expect(groupSummaryRequirements({ ...input, members: [search, bash] })).toEqual({ readIdentity: false, outputLines: false });
  expect(joinLine(summarize([search, bash]))).toBe("▸ Searched 2 patterns");
});
