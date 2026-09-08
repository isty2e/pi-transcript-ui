import { expect, it } from "vitest";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { fileReadFor, readBodyCount, readCountText } from "../src/read-body.js";

const schema = createReadToolDefinition("/tmp").parameters;
const capability = fileReadFor(schema)!;
const args = { path: "a" };
const result = (text: string) => ({ content: [{ type: "text", text }] });

it("recognizes only the bounded complete native-compatible read schema", () => {
  expect(capability).toEqual({ kind: "native-compatible-read" });
  for (const parameters of [undefined, {}, { type: "object" },
    { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    { ...schema, required: [] }, { ...schema, required: ["path", "limit"] },
    { ...schema, properties: Object.assign(Object.create(schema.properties), { a: { type: "string" }, b: { type: "number" }, c: { type: "number" } }) },
    { ...schema, properties: { ...schema.properties, limit: { type: "string" } } },
    { ...schema, properties: { ...schema.properties, content: { type: "string" } } },
    { ...schema, allOf: [] }, { ...schema, $ref: "elsewhere" },
    { ...schema, properties: { ...schema.properties, path: { type: ["string", "null"] } } },
    new Proxy({}, { get() { throw new Error("opaque"); } }),
    { ...schema, properties: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), { type: "string" }])) },
  ]) expect(fileReadFor(parameters)).toBeUndefined();
});

it("rejects unknown/nontext/failed/pending bodies and malformed or missing evidence instead of fabricating zero", () => {
  for (const output of [undefined, {}, { content: [] }, { content: [{ text: "a" }] },
    { content: [{ type: "image", text: "not body" }] },
    { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    { ...result("a"), isError: true }, result("Read image file [image/png]\nDecode failed"),
    { ...result("a"), details: { truncation: null } },
    { ...result("a"), details: { truncation: { outputLines: 0 } } },
    result("a\n\n[Showing lines 1-1 of 99. Use offset=2 to continue.]"),
  ]) expect(readBodyCount(capability, args, output)).toBeUndefined();
  expect(readBodyCount(capability, args, result(""))).toEqual({ lines: 0, source: "body" });
  expect(readBodyCount(undefined, args, result("a"))).toBeUndefined();
  expect(readBodyCount(capability, args, result("a"), true)).toBeUndefined();
  expect(readBodyCount(capability, { path: 42 }, result("a"))).toBeUndefined();
  expect(readBodyCount(capability, { ...args, limit: 1 }, result("a\n\n[9 more lines in file. Use offset=99 to continue.]"))).toBeUndefined();
  expect(readBodyCount(capability, { ...args, limit: 1 }, result("a\nb"))).toBeUndefined();
});

it("uses metadata for a final selected blank line, invalidates changed metadata, and rejects contradictory output", () => {
  const truncation = { content: "a\n", outputLines: 2, outputBytes: 2, totalLines: 10, firstLineExceedsLimit: false, truncated: true, truncatedBy: "lines" };
  const output = { ...result("a\n\n\n[Showing lines 1-2 of 10. Use offset=3 to continue.]"), details: { truncation } };
  expect(readBodyCount(capability, args, output)).toEqual({ lines: 2, source: "truncation" });
  expect(readBodyCount(capability, { ...args, limit: 1 }, output)).toBeUndefined();
  for (const update of [{ outputLines: -1 }, { outputLines: 1 }, { outputLines: 2.5 }, { outputLines: Infinity }, { outputBytes: 50 }, { content: "other" }, { totalLines: 1 }, { truncatedBy: "bytes" }, { firstLineExceedsLimit: true }]) {
    expect(readBodyCount(capability, args, { ...output, details: { truncation: { ...truncation, ...update } } })).toBeUndefined();
  }
  truncation.outputLines = 1;
  expect(readBodyCount(capability, args, output)).toBeUndefined();
  expect(readBodyCount(capability, args, { ...result(""), details: { truncation: { content: "", outputLines: 0, outputBytes: 0, totalLines: 0, firstLineExceedsLimit: false, truncated: false } } })).toEqual({ lines: 0, source: "truncation" });
});

it("places partial coverage before numbers and never fabricates an all-unknown zero", () => {
  expect(readCountText(3, 3, 420)).toBe("(420 lines)");
  expect(readCountText(2, 3, 420)).toBe("(partial 2/3: 420 lines)");
  expect(readCountText(0, 3, 0)).toBe("");
  expect(readCountText(1, 3, 0)).toBe("(partial 1/3: 0 lines)");
  expect(readCountText(1, 1, 1)).toBe("(1 line)");
});

it("does not count a missing first-line-too-large notice with a newline path as body text", () => {
  const output = result("[Line 1 is 50.1KB, exceeds 50.0KB limit. Use bash: sed -n '1p' path\nname | head -c 51200]");
  expect(readBodyCount(capability, { path: "path\nname" }, output)).toBeUndefined();
  const metadata = { content: "", outputLines: 0, outputBytes: 0, totalLines: 1, firstLineExceedsLimit: true, truncated: true, truncatedBy: "bytes" };
  expect(readBodyCount(capability, { path: "path\nname" }, { ...output, details: { truncation: metadata } })?.lines).toBe(0);
  expect(readBodyCount(capability, { path: "path\nname", offset: 2 }, { ...output, details: { truncation: metadata } })).toBeUndefined();
});
