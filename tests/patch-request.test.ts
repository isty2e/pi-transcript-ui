import { describe, expect, it } from "vitest";
import { createPatchRequestParser } from "../src/patch-request.js";

const string = { type: "string" };
const schema = (key = "input") => ({ type: "object", properties: { [key]: string }, required: [key] });
const structured = { type: "object", properties: { type: { type: "string", enum: ["create_file", "update_file", "delete_file"] }, path: string, diff: string }, required: ["type", "path"] };
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const edit = patch("*** Update File: src/a.ts", "@@", " context", "-old", "+new", " tail");

describe.each(["input", "patch", "patchText"])("%s field recognition", key => {
  const parse = createPatchRequestParser(schema(key))!;
  const read = (value: string) => parse({ [key]: value });

  it("counts requested +/- only, not hunk context", () => {
    expect(read(edit)).toEqual({ targets: [{ kind: "update", path: "src/a.ts" }], delta: { added: 1, removed: 1 } });
  });

  it("retains target order, repeated entries and move pairs without fictitious file identity", () => {
    const value = patch("*** Add File: first", "+one", "*** Update File: first", "*** Move to: renamed", "@@", " one", "+two");
    expect(read(value)).toEqual({ targets: [{ kind: "add", path: "first" }, { kind: "update", path: "first", moveTo: "renamed" }], delta: { added: 2, removed: 0 } });
  });

  it("does not fabricate deleted contents or a zero removal count", () => {
    expect(read(patch("*** Add File: first", "+one", "*** Delete File: old"))).toEqual({ targets: [{ kind: "add", path: "first" }, { kind: "delete", path: "old" }], delta: undefined });
  });

  it("handles CRLF, multiple hunks, EOF markers and header-looking added text", () => {
    expect(read(patch("*** Update File: a", "@@ first", "-one", "+*** Add File: not-a-target", "@@ second", " two", "+three", "*** End of File").replaceAll("\n", "\r\n") + "\r\n"))
      .toEqual({ targets: [{ kind: "update", path: "a" }], delta: { added: 2, removed: 1 } });
  });

  it("distinguishes known zero requests from unavailable deltas", () => {
    expect(read(patch("*** Add File: empty"))?.delta).toEqual({ added: 0, removed: 0 });
    expect(read(patch("*** Update File: same", "@@", " unchanged"))?.delta).toEqual({ added: 0, removed: 0 });
  });
});

it.each([
  "*** Add File: missing-envelope\n+one",
  patch(),
  patch("*** Add File: valid", "+one") + "\ntrailing garbage",
  patch("*** Add File: valid", "+one", "*** Create File: unknown", "+two"),
  patch("*** Add File: a", "unprefixed"),
  patch("*** Delete File: a", "-unknown deletion content"),
  patch("*** Update File: a", "*** Move to: b"),
  patch("*** Update File: a", "@@"),
  patch("*** Update File: a", "@@", "@@", "+one"),
  patch("*** Update File: a", "+without hunk"),
  patch("*** Update File: a", "@@", "unprefixed"),
  patch("*** Update File: a", "@@", "+one", "*** End of File", "+after eof"),
  patch("*** Add File: a", "+one", "*** Begin Patch", "*** Add File: b", "+two"),
  patch("*** Add File: \u001b[31mhidden", "+one"),
  patch("*** Add File:   ", "+one"),
  patch("*** Add File: a ", "+one"),
  patch("*** Update File:  a", "@@", "-old", "+new"),
  patch("*** Update File: a", "*** Move to: b ", "@@", " same"),
  patch("*** Update File: a", "*** Move to: \tbad", "@@", " same"),
])("refuses the entire unsupported payload, not a misleading prefix (case %#)", value => {
  expect(createPatchRequestParser(schema())!({ input: value })).toBeUndefined();
});

it("recognizes single-file operation fields independently of any provider or name", () => {
  const parse = createPatchRequestParser(structured)!;
  expect(parse({ type: "create_file", path: "a", diff: "+one\n+two" })).toEqual({ targets: [{ kind: "add", path: "a" }], delta: { added: 2, removed: 0 } });
  expect(parse({ type: "update_file", path: "a", diff: "@@\n old\n+new" })).toEqual({ targets: [{ kind: "update", path: "a" }], delta: { added: 1, removed: 0 } });
  expect(parse({ type: "delete_file", path: "a" })).toEqual({ targets: [{ kind: "delete", path: "a" }], delta: undefined });
  for (const args of [
    { type: "delete_file", path: "a", diff: "-one" },
    { type: "create_file", path: "a" },
    { type: "update_file", path: "a", diff: "-one\n+two" },
    { type: "move_file", path: "a" },
    { type: "create_file", path: "a", diff: "+one", input: edit },
    { type: "create_file", path: "a", diff: 3 },
  ]) expect(parse(args)).toBeUndefined();
});

it("requires an unambiguous supported schema and own supplied payload field", () => {
  for (const parameters of [
    undefined, { type: "string" }, { ...schema(), required: [] },
    { ...schema(), properties: { input: { type: "number" } } },
    { ...schema(), properties: { input: string, patch: string } },
    { ...schema(), properties: { input: string, ...structured.properties } },
    { ...schema(), anyOf: [schema()] }, { $ref: "#/patch" },
  ]) expect(createPatchRequestParser(parameters)).toBeUndefined();

  const parse = createPatchRequestParser(schema())!;
  for (const args of [null, [], {}, { patch: edit }, { input: edit, patch: edit }, { input: edit, patchText: undefined }, { input: edit, type: "create_file", path: "a", diff: "+one" }, Object.create({ input: edit })]) expect(parse(args)).toBeUndefined();
  expect(createPatchRequestParser({ ...schema(), properties: { input: string, displaySummary: string } })!({ input: edit, displaySummary: "reason" })?.targets).toHaveLength(1);
});

it("is bounded by source, line, target and path counts", () => {
  const parse = createPatchRequestParser(schema())!;
  expect(parse({ input: patch("*** Add File: a", "+" + "x".repeat(65536)) })).toBeUndefined();
  expect(parse({ input: patch("*** Add File: a", ...Array(4096).fill("+")) })).toBeUndefined();
  expect(parse({ input: patch(...Array.from({ length: 257 }, (_, index) => `*** Add File: a${index}`)) })).toBeUndefined();
  expect(parse({ input: patch("*** Add File: " + "x".repeat(4097)) })).toBeUndefined();
  expect(parse({ input: patch(...Array.from({ length: 256 }, (_, index) => `*** Add File: a${index}`)) })?.targets).toHaveLength(256);
});

it("keys its bounded cache by values and recovers after invalid/throwing inputs", () => {
  const parse = createPatchRequestParser(schema())!;
  const args = { input: edit };
  const original = parse(args);
  expect(parse({ ...args })).toBe(original);
  args.input = patch("*** Add File: other", "+two");
  expect(parse(args)).not.toBe(original);
  expect(parse(args)?.targets[0]?.path).toBe("other");
  expect(parse(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("opaque"); } }))).toBeUndefined();
  expect(parse({ input: edit })).toEqual(original);
  expect(parse({ input: "x".repeat(65537) })).toBeUndefined();
  expect(parse({ input: edit })).toEqual(original);
  expect(createPatchRequestParser(new Proxy({}, { getPrototypeOf() { throw new Error("opaque"); } }))).toBeUndefined();
});
