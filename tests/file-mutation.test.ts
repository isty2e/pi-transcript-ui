import { expect, it } from "vitest";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { fileMutationFor, fileMutationPath } from "../src/file-mutation.js";
import { classifyTool } from "../src/classify.js";
import { displayFor } from "../src/display.js";
import { defaultSettings, groupingRules } from "../src/settings.js";

const string = { type: "string" };
function object(properties: Record<string, unknown>, required = Object.keys(properties)) { return { type: "object", properties, required }; }
const write = object({ path: string, content: string });

it("recognizes actual native schemas independent of names, never read by its edit name", () => {
  for (const definition of [createEditToolDefinition("/tmp"), createWriteToolDefinition("/tmp")]) {
    const capability = fileMutationFor(definition.parameters);
    expect(capability?.action).toBe(definition.name === "edit" ? "Edit" : "Write");
    for (const name of [definition.name, "anything", "mcp__files__replace", "read"]) {
      expect(classifyTool(name, null, capability)).toEqual({ family: "mutation", evidence: "file-mutation-schema", operation: "mutate" });
    }
  }
  const read = fileMutationFor(createReadToolDefinition("/tmp").parameters);
  expect(read).toBeUndefined();
  expect(classifyTool("edit", null, read).family).toBeNull();
  expect(displayFor("edit", { path: "file", edits: [] }, read)).toBeNull();
  expect(displayFor("write", { path: "file", content: "new" })).toBeNull();
});

it.each(["path", "file_path"])("projects bounded write/replacement aliases using %s", (pathKey) => {
  const capability = fileMutationFor(object({ [pathKey]: string, content: string }))!;
  expect(displayFor("renamed", { [pathKey]: "f", content: "hi" }, capability)).toEqual({ action: "Write", target: { kind: "path", path: "f" } });
  for (const [oldKey, newKey] of [["oldText", "newText"], ["old_string", "new_string"]] as const) {
    for (const array of [true, false]) {
      const fields = { [oldKey]: string, [newKey]: string };
      const schema = object({ [pathKey]: string, ...(array ? { edits: { type: "array", items: object(fields) } } : fields) });
      const cap = fileMutationFor(schema)!;
      const pair = { [oldKey]: "before", [newKey]: "after" };
      const args = { [pathKey]: "f", ...(array ? { edits: [pair] } : pair) };
      expect(cap.action).toBe("Edit");
      expect(fileMutationPath(cap, args)).toBe("f");
      expect(displayFor("external", args, cap)?.action).toBe("Edit");
      expect(fileMutationPath(cap, { ...args, [pathKey]: 12 })).toBeUndefined();
      expect(fileMutationPath(cap, { [pathKey]: "f", edits: [{ oldText: 1 }] })).toBeUndefined();
    }
  }
});

it.each([
  undefined, {}, { type: "object" }, object({ path: string }),
  object({ path: string, content: string }, ["path"]), object({ path: string, content: string }, ["content"]),
  object({ path: string, content: { type: ["string", "null"] } }),
  object({ path: string, file_path: string, content: string }),
  object({ path: string, content: string, oldText: string, newText: string }),
  object({ path: string, edits: { type: "array", items: object({ oldText: string, newText: string }, ["oldText"]) } }),
  object({ path: string, oldText: string, new_string: string }),
  { ...write, $ref: "#/write" }, { ...write, anyOf: [write] }, { ...write, allOf: [write] }, { ...write, oneOf: [write] },
  { ...write, if: write }, { ...write, not: {} },
  object({ path: { type: "string", $ref: "#/path" }, content: string }),
  object({ path: string, content: string, extra: { anyOf: [string] } }),
  object({ path: string, content: string, ...Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), string])) }),
  Object.create(write), object({ path: Object.create(string), content: string }),
  new Proxy({}, { ownKeys() { throw new Error("opaque"); } }),
])("fails closed on unsupported/ambiguous schema %#", (schema) => { expect(fileMutationFor(schema)).toBeUndefined(); });

it("bounds schema depth/nodes and per-frame argument projection", () => {
  let nested: unknown = { type: "object", properties: {} };
  for (let i = 0; i < 6; i++) nested = object({ nested });
  expect(fileMutationFor(object({ path: string, content: string, nested }))).toBeUndefined();
  const many = object(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [String(i), string])));
  expect(fileMutationFor(object({ path: string, content: string, a: many, b: many, c: many, d: many }))).toBeUndefined();
  const cap = fileMutationFor(createEditToolDefinition("/tmp").parameters)!;
  expect(fileMutationPath(cap, { path: "f", edits: Array.from({ length: 4097 }, () => ({ oldText: "a", newText: "b" })) })).toBeUndefined();
  expect(fileMutationPath(cap, new Proxy({}, { get() { throw new Error("opaque args"); } }))).toBeUndefined();
});

it("respects explicit family/standalone preferences without converting them to semantic facts", () => {
  const cap = fileMutationFor(write);
  const settings = defaultSettings();
  settings.grouping.mutation = [];
  settings.grouping.exploration.push("external");
  settings.grouping.standalone = ["excluded"];
  const rules = groupingRules(settings);
  expect(classifyTool("write", rules, cap).family).toBeNull();
  expect(classifyTool("edit", rules, cap).family).toBeNull();
  expect(classifyTool("excluded", rules, cap).family).toBeNull();
  expect(classifyTool("external", rules, cap).family).toBe("exploration");
  expect(classifyTool("automatic", rules, cap).family).toBe("mutation");
  expect(classifyTool("other", { other: "change" }).family).toBe("mutation");
  expect(displayFor("other", { path: "f", content: "x" })).toBeNull();
  expect(displayFor("external", { path: "f", content: "x" }, cap)?.action).toBe("Write");
});
