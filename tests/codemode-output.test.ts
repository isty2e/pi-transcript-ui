import { describe, expect, it } from "vitest";
import { createCodemodeExtension, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CodemodeOutputObserver } from "../src/codemode/output-observer.js";
import { CodemodeFacts } from "../src/codemode/model.js";
import { outputPartContent, outputPartPreview, scriptOutput, type OutputBlock, type OutputWitness } from "../src/codemode/output.js";

const header = { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" };
const result = (content: OutputBlock[], details: Record<string, unknown> = {}) => ({content: [header, ...content], details: {calls: [], ...details}});
const text = (value: string) => ({type: "text" as const, text: value});
const witness = (items: OutputWitness["items"], value?: string): OutputWitness => ({items,
  terminal: value === undefined ? {ok: true} : {ok: true, value}});

function bodies(value: ReturnType<typeof scriptOutput>) {
  expect(value?.parts).toBeDefined();
  return value!.parts!.map(part => ({kind: part.kind, content: outputPartContent(value!, part)}));
}

async function execute(code: string) {
  let definition: ToolDefinition | undefined;
  createCodemodeExtension({models: false, mode: "on"})({
    registerTool: (tool: ToolDefinition) => { if (tool.name === "codemode") definition = tool; },
    getAllTools: () => [], getSettings: () => ({}), appendEntry: () => { throw new Error("Unexpected storage mutation"); },
  } as unknown as ExtensionAPI);
  if (!definition) throw new Error("Native codemode definition unavailable");

  let observed: OutputWitness | undefined;
  const observer = new CodemodeOutputObserver(id => id === "output-test" ? value => { observed = value; } : undefined);
  expect(observer.watch(definition)).toBe(true);
  const context = {tools: [], sessionManager: {getBranch: () => []},
    executeTool: () => { throw new Error("Unexpected tool invocation"); }} as unknown as Parameters<ToolDefinition["execute"]>[4];
  try {
    const native = await definition.execute("output-test", {code}, undefined, undefined, context);
    expect(observed).toBeDefined();
    return {native, output: scriptOutput(native, observed)};
  } finally { observer.dispose(); }
}

describe("verified native script-output partitions", () => {
  it("distinguishes observed emissions from lossless printed-format display regions", () => {
    const literal = "==> text 1/2 <==\nA\n==> text 2/2 <==\nB";
    const native = result([text(literal)]);
    const formatted = scriptOutput(native)!;
    expect(formatted.partition).toBe("formatted");
    expect(formatted.parts!.every(part => part.kind === "formatted")).toBe(true);
    expect(formatted.parts!.flatMap(part => outputPartContent(formatted, part)).map(block => block.text).join("")).toBe(literal);
    expect(bodies(scriptOutput(native, witness([text(literal)])))).toEqual([{kind: "text", content: [text(literal)]}]);
    expect(bodies(scriptOutput(native, witness([text("A"), text("B")])))).toEqual([
      {kind: "text", content: [text("A")]}, {kind: "text", content: [text("B")]},
    ]);
  });

  it("uses only final provided data when a witness mismatches and printed formatting remains usable", () => {
    const native = result([text("==> text 1/2 <==\nA\n==> text 2/2 <==\nREDACTED")]);
    const output = scriptOutput(native, witness([text("A"), text("B")]))!;
    expect(output.partition).toBe("formatted");
    expect(output.content).toEqual(native.content.slice(1));
    expect(output.parts!.flatMap(part => outputPartContent(output, part)).map(block => block.text).join("")).toBe(native.content[1]!.text);
  });

  it.each([
    "prefix ==> text 1/2 <==\nA\n==> text 2/2 <==\nB",
    "==> text 1/2 <== suffix\nA\n==> text 2/2 <==\nB",
    "==> text 1/3 <==\nA\n==> text 3/3 <==\nC",
    "==> text 1/2 <==\nA\n==> text 1/2 <==\nB",
    "==> text 1/2 <==\nA\n==> text 2/3 <==\nB",
    "==> text 1/1 <==\nA",
    "==> text 1/99999999999999999999 <==\nA",
    "==> text 1/2 <==\nA\n==> text 2/2 <==\nB\n==> text 1/2 <==\nC\n==> text 2/2 <==\nD",
  ])("keeps combined output for incomplete, inline or ambiguous numbering: %j", value => {
    const output = scriptOutput(result([text(value)]))!;
    expect(output.parts).toBeUndefined();
    expect(output.content).toEqual([text(value)]);
  });

  it("preserves all formatting, prelude, images and console/error suffixes across display regions", () => {
    const image = {type: "image" as const, data: "AA==", mimeType: "image/png"};
    const content = [text("PRELUDE\n==> text 1/2 <==\r\nA\n[Image saved by native]"), image,
      text("==> text 2/2 <==\nB\n<console_output>\nC\n</console_output>\nScript error:\nE")];
    const output = scriptOutput(result(content))!;
    expect(output.partition).toBe("formatted");
    expect(output.parts!.map(part => part.kind)).toEqual(["additional", "formatted", "formatted"]);
    const selected = output.parts!.flatMap(part => outputPartContent(output, part));
    expect(selected.filter(block => block.type === "image")).toEqual([image]);
    expect(selected.filter(block => block.type === "text").map(block => block.text).join(""))
      .toBe(content.filter(block => block.type === "text").map(block => block.text).join(""));
    const sequence = (blocks: readonly OutputBlock[]) => blocks.flatMap<string | OutputBlock>(block =>
      block.type === "text" ? Array.from(String(block.text)) : [block]);
    expect(sequence(selected)).toEqual(sequence(content));
    expect(outputPartPreview(output, output.parts![1]!)).toBe("A");
  });

  it("does not mistake a final marker-only region for a data preview", () => {
    const output = scriptOutput(result([text("==> text 1/2 <==\nA\n==> text 2/2 <==")]))!;
    expect(output.partition).toBe("formatted");
    expect(outputPartPreview(output, output.parts![1]!)).toBeUndefined();
    expect(outputPartContent(output, output.parts![1]!)).toEqual([text("==> text 2/2 <==")]);
  });

  it.each(["/tmp/native-spill.txt", ""])("does not bypass native spill/truncation for %j", fullOutputPath => {
    const native = result([text("visible")], {fullOutputPath});
    const output = scriptOutput(native, witness([text("visible")]))!;
    expect(output.parts).toBeUndefined();
    expect(output.fullOutputPath).toBe(fullOutputPath);
    expect(output.content).toEqual([text("visible")]);
  });

  it.each(["[Image saved to /tmp/native.png (image/png, 1 B)]", "[Image (image/png, 1 B) could not be saved: disk\nfull]"])(
    "keeps the native image caption and bytes: %s", caption => {
      const image = {type: "image" as const, data: "AA==", mimeType: "image/png"};
      const output = scriptOutput(result([text(`hello\n${caption}`), image, text("after")]), witness([text("hello"), image, text("after")]));
      // Two text emissions receive native framing even when separated by an image.
      expect(output?.parts).toBeUndefined();
      const framed = scriptOutput(result([text(`==> text 1/2 <==\nhello\n${caption}`), image, text("==> text 2/2 <==\nafter")]),
        witness([text("hello"), image, text("after")]));
      expect(bodies(framed)).toEqual([{kind: "text", content: [text("hello")]},
        {kind: "image", content: [text(caption), image]}, {kind: "text", content: [text("after")]}]);
    });

  it("preserves native appended notices and unknown blocks rather than assigning them to tools", () => {
    const extra = {type: "file", name: "provided-native-file"};
    const output = scriptOutput(result([text("A\nNATIVE NOTICE"), extra]), witness([text("A")]));
    expect(bodies(output)).toEqual([{kind: "text", content: [text("A")]},
      {kind: "additional", content: [text("\nNATIVE NOTICE"), extra]}]);
  });

  it("seals content and member identity against later native updates and forged selections", () => {
    const block = text("==> text 1/2 <==\nA\n==> text 2/2 <==\nB");
    const native = result([block]);
    const facts = new CodemodeFacts("parent");
    facts.observe(native, false, witness([text("A"), text("B")]));
    const output = facts.output!, selected = output.parts![0]!;
    block.text = "MUTATED";
    facts.observe(result([text("LATE")]), true, witness([text("LATE")]));
    expect(outputPartContent(output, selected)).toEqual([text("A")]);
    expect(outputPartPreview(output, selected)).toBe("A");
    expect(facts.ownsOutput(selected)).toBe(true);
    expect(facts.ownsOutput({...selected})).toBe(false);
    expect(() => outputPartContent(output, {...selected})).toThrow();
    facts.dispose();
    expect(facts.ownsOutput(selected)).toBe(false);
  });

  it.each([
    {code: "text('A'); text('B');", expected: [{kind: "text", content: [text("A")]}, {kind: "text", content: [text("B")]}]},
    {code: "console.log('C\\nD'); text('A'); return {value:2};", expected: [
      {kind: "text", content: [text("A")]}, {kind: "return", content: [text('{"value":2}')]}, {kind: "console", content: [text("C\nD")]}]},
    {code: "text(''); text('\\n'); return '';", expected: [
      {kind: "text", content: [text("")]}, {kind: "text", content: [text("\n")]}, {kind: "return", content: [text("")]}]},
    {code: "return null;", expected: [{kind: "return", content: [text("null")]}]},
    {code: "console.log('');", expected: [{kind: "console", content: [text("")]}]},
  ])("reconciles actual native VM output for $code", async ({code, expected}) => {
    const {output} = await execute(code);
    expect(bodies(output)).toEqual(expected);
  });

  it("keeps actual native script failure text after any emitted output", async () => {
    const {native, output} = await execute("text('before'); throw new Error('EXPECTED-SCRIPT-FAILURE');");
    const parts = bodies(output);
    expect(native.isError).toBe(true);
    expect(parts[0]).toEqual({kind: "text", content: [text("before")]});
    expect(parts[1]!.kind).toBe("additional");
    expect(parts[1]!.content.some(block => String(block.text).includes("EXPECTED-SCRIPT-FAILURE"))).toBe(true);
  });
});
