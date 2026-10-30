import { describe, expect, it } from "vitest";
import { activityRecords, CodemodeFacts, evidenceHandle, scriptOutput } from "../src/codemode/model.js";

const result = (calls: unknown[], content: unknown[] = []) => ({ details: { calls }, content });
const record = (id: string, status = "running", name = "read") => ({ id, name, status, args: '{"path":"partial' });

describe("codemode activity facts", () => {
  it("keeps supplied order and refuses malformed records without inventing zero calls", () => {
    expect(activityRecords(undefined)).toBeUndefined();
    expect(activityRecords([])).toEqual([]);
    expect(activityRecords([{ name: "read", status: "future" }])).toBeUndefined();
    expect(activityRecords([{ name: "read", status: { toString: () => "ok" } }])).toBeUndefined();
    expect(activityRecords([record("p/2", "ok", "write"), record("p/1", "ok")])?.map(row => row.id)).toEqual(["p/2", "p/1"]);
  });

  it("never associates concurrent placeholders by preview, name or arrival order", () => {
    const facts = new CodemodeFacts("p"), first = evidenceHandle(), second = evidenceHandle(), end = evidenceHandle();
    facts.start("p/1", "read", first); facts.start("p/2", "read", second);
    facts.end("p/2", "read", end);
    facts.observe(result([record("p/?"), record("p/?")]), true);
    expect(facts.records!.map(row => facts.matched(row))).toEqual([undefined, undefined]);
    facts.observe(result([record("p/?"), record("p/2", "ok")]), true);
    expect(facts.matched(facts.records![1]!)).toMatchObject({ id: "p/2", name: "read", request: second, terminal: end });
    expect(facts.matched(facts.records![0]!)).toBeUndefined();
  });

  it("requires observed start and terminal end, with matching tool identity", () => {
    const facts = new CodemodeFacts("p");
    facts.observe(result([record("p/1")]), true);
    expect(facts.end("p/1", "read", evidenceHandle())).toBe(false);
    facts.start("p/1", "read", evidenceHandle());
    expect(facts.matched(facts.records![0]!)).toBeUndefined();
    expect(facts.end("p/1", "write", evidenceHandle())).toBe(false);
    expect(facts.end("p/1", "read", evidenceHandle())).toBe(true);
    expect(facts.matched(facts.records![0]!)).toBeDefined();
  });

  it("preserves first terminal evidence and quarantines duplicate starts", () => {
    const facts = new CodemodeFacts("p"), end = evidenceHandle();
    facts.start("p/1", "read", evidenceHandle());
    facts.end("p/1", "read", end);
    expect(facts.end("p/1", "read", evidenceHandle())).toBe(false);
    facts.observe(result([record("p/1", "ok")]), true);
    expect(facts.matched(facts.records![0]!)?.terminal).toBe(end);
    expect(facts.start("p/1", "read", evidenceHandle())).toBe(false);
    expect(facts.matched(facts.records![0]!)).toBeUndefined();
  });

  it("revokes existing body proof without losing the supplied records or final output", () => {
    const facts = new CodemodeFacts("p");
    facts.start("p/1", "read", evidenceHandle()); facts.end("p/1", "read", evidenceHandle());
    facts.observe(result([record("p/1", "ok")]), true);
    const proof = facts.matched(facts.records![0]!)!, records = facts.records;
    expect(facts.owns(proof)).toBe(true);

    facts.discardExecutionEvidence();
    expect(facts.records).toBe(records); expect(facts.faulted).toBe(false);
    expect(facts.owns(proof)).toBe(false); expect(facts.matched(records![0]!)).toBeUndefined();
    expect(facts.retainedEvidence().size).toBe(0);
    expect(facts.start("p/2", "read", evidenceHandle())).toBe(false);
    expect(facts.end("p/1", "read", evidenceHandle())).toBe(false);

    facts.observe(result([record("p/1", "ok")], [{ type: "text", text: "FINAL-OUTPUT" }]), false);
    expect(facts.final).toBe(true); expect(facts.output?.content).toEqual([{ type: "text", text: "FINAL-OUTPUT" }]);
  });

  it("accepts the native final snapshot after the public parent-end closes capture", () => {
    const facts = new CodemodeFacts("p"), start = evidenceHandle(), end = evidenceHandle();
    facts.start("p/1", "read", start); facts.end("p/1", "read", end);
    facts.observe(result([record("p/?")]), true);
    facts.closeCapture();
    facts.observe(result([record("p/1", "ok")]), false);
    expect(facts.matched(facts.records![0]!)).toMatchObject({ id: "p/1", name: "read", request: start, terminal: end });
    expect(facts.start("p/2", "read", evidenceHandle())).toBe(false);
  });

  it("seals a copied snapshot against late callbacks and SDK object mutation", () => {
    const facts = new CodemodeFacts("p"), entry = record("p/?", "cancelled");
    facts.observe(result([entry]), false);
    entry.status = "ok"; entry.id = "p/1";
    facts.observe(result([entry, record("p/2", "ok")]), true);
    expect(facts.records).toHaveLength(1);
    expect(facts.records![0]).toMatchObject({ id: "p/?", status: "cancelled" });
    expect(facts.end("p/1", "read", evidenceHandle())).toBe(false);
  });

  it("reconciles later final graphs while retaining only unchanged real child receipts", () => {
    const facts = new CodemodeFacts("p");
    for (const id of ["p/1", "p/2"]) {
      facts.start(id, "read", evidenceHandle()); facts.end(id, "read", evidenceHandle());
    }
    facts.observe(result([record("p/1", "ok"), record("p/2", "ok")], [{type: "text", text: "OLD"}]), false);
    const first = facts.matched(facts.records![0]!)!, second = facts.matched(facts.records![1]!)!, output = facts.output!;
    facts.observe({...result([record("p/2", "error")], [{type: "text", text: "CURRENT"}]), isError: true, durationMs: 42}, false);

    expect(facts.faulted).toBe(false); expect(facts.owns(first)).toBe(false); expect(facts.owns(second)).toBe(true);
    expect(facts.ownsOutput(output)).toBe(false); expect(facts.output?.content).toEqual([{type: "text", text: "CURRENT"}]);
    expect(facts.outcome).toEqual({isError: true, durationMs: 42}); expect(facts.retainedEvidence().size).toBe(2);
    expect(facts.start("p/3", "read", evidenceHandle())).toBe(false);
    expect(facts.end("p/2", "read", evidenceHandle())).toBe(false);

    facts.observe(result([record("p/1", "ok"), record("p/2", "ok")]), false);
    expect(facts.matched(facts.records![0]!)).toBeUndefined();
    expect(facts.matched(facts.records![1]!)?.terminal).toBe(second.terminal);
  });

  it("cannot borrow a retired receipt after a final name change or use an old record as current", () => {
    const facts = new CodemodeFacts("p");
    facts.start("p/1", "read", evidenceHandle()); facts.end("p/1", "read", evidenceHandle());
    facts.observe(result([record("p/1", "ok")]), false);
    const oldRecord = facts.records![0]!, proof = facts.matched(oldRecord)!;
    facts.observe(result([record("p/1", "ok", "write")]), false);
    expect(facts.faulted).toBe(false); expect(facts.owns(proof)).toBe(false);
    expect(facts.matched(oldRecord)).toBeUndefined(); expect(facts.retainedEvidence().size).toBe(0);
    facts.observe(result([record("p/1", "ok")]), false);
    expect(facts.matched(facts.records![0]!)).toBeUndefined();
  });

  it("revokes final output and body capabilities on malformed replacement or disposal", () => {
    for (const retire of [(facts: CodemodeFacts) => facts.dispose(),
      (facts: CodemodeFacts) => facts.observe(result([record("p/1"), record("p/1")]), false)]) {
      const facts = new CodemodeFacts("p");
      facts.start("p/1", "read", evidenceHandle()); facts.end("p/1", "read", evidenceHandle());
      facts.observe(result([record("p/1", "ok")], [{type: "text", text: "OUTPUT"}]), false);
      const proof = facts.matched(facts.records![0]!)!, output = facts.output!, revision = facts.revision;
      retire(facts);
      expect(facts.owns(proof)).toBe(false); expect(facts.ownsOutput(output)).toBe(false);
      expect(facts.retainedEvidence().size).toBe(0); expect(facts.revision).toBeGreaterThan(revision);
    }
  });

  it("retains ordinal identity constraints across shorter replacement prefixes", () => {
    const facts = new CodemodeFacts("p");
    facts.observe(result([record("p/1", "ok"), record("p/?")]), true);
    facts.observe(result([]), true);
    facts.observe(result([record("p/1", "ok"), record("p/2", "ok")]), true);
    expect(facts.faulted).toBe(false);
    facts.observe(result([record("p/3", "ok")]), true);
    expect(facts.faulted).toBe(true);
  });

  it("rejects duplicated established IDs rather than painting two plausible bodies", () => {
    const facts = new CodemodeFacts("p");
    facts.observe(result([record("p/1", "ok"), record("p/1", "ok")]), true);
    expect(facts.faulted).toBe(true);
  });

  it("permits missing initial progress but faults an incompatible replacement and drops its invocation evidence", () => {
    const facts = new CodemodeFacts("p");
    facts.observe({ content: [] }, true);
    expect(facts.faulted).toBe(false);
    facts.start("p/1", "read", evidenceHandle()); facts.end("p/1", "read", evidenceHandle());
    facts.observe(result([record("p/1", "ok")]), true);
    expect(facts.retainedEvidence().size).toBe(2);
    facts.observe({ content: [], details: { calls: "invalid" } }, true);
    expect(facts.faulted).toBe(true); expect(facts.retainedEvidence().size).toBe(0);
    expect(facts.start("p/2", "read", evidenceHandle())).toBe(false);
  });

  it("releases all invocation evidence after a conflicting identity, not just absent final IDs", () => {
    const facts = new CodemodeFacts("p");
    facts.start("p/1", "read", evidenceHandle()); facts.end("p/1", "read", evidenceHandle());
    facts.observe(result([record("p/1", "ok")]), true);
    facts.observe(result([record("p/2", "ok")]), true);
    expect(facts.faulted).toBe(true); expect(facts.retainedEvidence().size).toBe(0);
  });
});

describe("script output ingress", () => {
  it("removes only the complete native producer header block", () => {
    const header = { type: "text", text: "Script completed\nWall time 1.23 seconds\nOutput:\n" };
    const data = { type: "text", text: header.text };
    const image = { type: "image", data: "base64", mimeType: "image/png" };
    const input = result([], [header, data, image]);
    const output = scriptOutput(input)!;
    expect(output.content).toEqual([data, image]);
    expect(output.content[0]).toBe(data);
    expect(input.content).toEqual([header, data, image]);
    expect(scriptOutput(result([], [{ type: "text", text: `notice\n${header.text}` }]))?.content).toHaveLength(1);
  });

  it("distinguishes absent from newline-only output and preserves error/truncation metadata", () => {
    expect(scriptOutput(result([]))).toBeUndefined();
    expect(scriptOutput(result([], [{ type: "text", text: "" }]))).toBeUndefined();
    expect(scriptOutput(result([], [{ type: "text", text: "\n" }]))?.content).toHaveLength(1);
    const error = { type: "text", text: "Script error:\nfailed" };
    expect(scriptOutput({ ...result([], [error]), details: { calls: [], fullOutputPath: "/not-read" } }))
      .toEqual({ content: [error], fullOutputPath: "/not-read" });
  });
});
