import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formattedOutput } from "../src/codemode/output-format.js";
import { outputPartContent, scriptOutput, type OutputBlock, type ScriptOutput } from "../src/codemode/output.js";

afterEach(() => vi.restoreAllMocks());
const text = (value: string) => Object.freeze({type: "text", text: value});
const output = (...content: OutputBlock[]): ScriptOutput => Object.freeze({content: Object.freeze(content), fullOutputPath: undefined});
const display = (source: ScriptOutput) => formattedOutput(source)?.get(source) ?? source.content;

describe("script-output display formatting", () => {
  it("reflows nested containers, keeping empty containers inline and the body origin unchanged", () => {
    const source = output(text(' \r\n{ "files": ["a.ts", "b.ts"], "empty": { }, "other": [ ] }\t'));
    expect(display(source)).toEqual([text('{\n  "files": ["a.ts", "b.ts"],\n  "empty": {},\n  "other": []\n}')]);
    expect(display(output(text(" { } \n")))).toEqual([text("{}")]);
    expect(display(output(text("[[], {}, [1]]")))).toEqual([text("[\n  [],\n  {},\n  [1]\n]")]);
  });

  it("keeps scalar arrays inline without rewriting escapes or numeric tokens", () => {
    const source = output(text(String.raw`[9007199254740993,1e400,-0,1.2300e-07,"\u0061","[,{}] \"quote\" \\",true,false,null]`));
    const expected = String.raw`[9007199254740993, 1e400, -0, 1.2300e-07, "\u0061", "[,{}] \"quote\" \\", true, false, null]`;
    expect(display(source)).toEqual([text(expected)]);
  });

  it("only compacts scalar children when an array contains nested containers", () => {
    const source = output(text('{"matrix":[[1,2],[3,4]],"rows":[{"values":[true,null]},{}]}'));
    expect(display(source)).toEqual([text('{\n  "matrix": [\n    [1, 2],\n    [3, 4]\n  ],\n  "rows": [\n    {\n      "values": [true, null]\n    },\n    {}\n  ]\n}')]);
  });

  it("does not add one logical line per element to long scalar arrays", () => {
    const values = Array.from({length: 1500}, (_, index) => String(index));
    const source = output(text(`[${values.join(",")}]`));
    const expected = `[${values.join(", ")}]`;
    expect((display(source)[0]!.text as string).split("\n")).toHaveLength(1);
    expect(display(source)).toEqual([text(expected)]);
    expect(source.content).toEqual([text(`[${values.join(",")}]`)]);
  });

  it("preserves exact number and string tokens, duplicates and key order", () => {
    const value = String.raw`{"z":9007199254740993,"z":1e400,"a":-0,"b":1.2300e-07,"s":"\u0061 \"[,{}]:\" \\ end","unicode":"한😀","nil":null,"yes":true}`;
    const expected = String.raw`{
  "z": 9007199254740993,
  "z": 1e400,
  "a": -0,
  "b": 1.2300e-07,
  "s": "\u0061 \"[,{}]:\" \\ end",
  "unicode": "한😀",
  "nil": null,
  "yes": true
}`;
    expect(display(output(text(value)))).toEqual([text(expected)]);
  });

  it.each([
    "plain\n  text", "42", " true ", "null", '"{\\\"a\\\":1}"',
    '{"a":', '{"a":1,}', '[1,]', '{"a":1}\n{"b":2}', 'before {"a":1}',
    '```json\n{"a":1}\n```', '\x1b[32m{"a":1}\x1b[0m', '\u00a0{"a":1}',
  ])("keeps non-container, partial and mixed text unchanged: %j", value => {
    const source = output(text(value));
    expect(formattedOutput(source)).toBeUndefined();
    expect(display(source)).toBe(source.content);
  });

  it("does not decode envelopes or strings containing JSON", () => {
    const source = output(text(String.raw`{"content":[{"type":"text","text":"{\"x\":1}"}]}`));
    expect(display(source)).toEqual([text(String.raw`{
  "content": [
    {
      "type": "text",
      "text": "{\"x\":1}"
    }
  ]
}`)]);
  });

  it("copies changed text only, retaining other fields, non-text blocks and original data", () => {
    const metadata = Object.freeze({label: "native"});
    const json = Object.freeze({...text('{"x":1}'), metadata});
    const plain = text("unaltered"), image = Object.freeze({type: "image", data: "AA==", mimeType: "image/png"});
    const unknown = Object.freeze({type: "file", path: "provided.txt"}), malformed = Object.freeze({type: "text", text: 3});
    const source = output(json, plain, image, unknown, malformed);
    const content = display(source);
    expect(content[0]).toEqual({...json, text: '{\n  "x": 1\n}'});
    expect(content[0]).not.toBe(json); expect(content[0]!.metadata).toBe(metadata);
    expect(content.slice(1)).toEqual([plain, image, unknown, malformed]);
    for (let index = 1; index < content.length; index++) expect(content[index]).toBe(source.content[index]);
    expect(json.text).toBe('{"x":1}');
    expect(source.content).toEqual([json, plain, image, unknown, malformed]);
    expect(formattedOutput(output(image))).toBeUndefined();
  });

  it("formats already-selected regions without rewriting their ranges, previews or source", () => {
    const raw = '==> text 1/2 <==\n{"a":1}\n==> text 2/2 <==\n[2,3]';
    const source = scriptOutput({content: [text(raw)]})!;
    const parts = source.parts!, before = parts.map(part => outputPartContent(source, part));
    const result = formattedOutput(source)!;
    expect(result.get(parts[0]!)).toEqual([text('{\n  "a": 1\n}')]);
    expect(result.get(parts[1]!)).toEqual([text('[2, 3]')]);
    expect(parts.map(part => outputPartContent(source, part))).toEqual(before);
    expect(source.content).toEqual([text(raw)]);
    expect(result.get(source)).toBeUndefined();
  });

  it("formats valid blocks beside invalid text without joining separate JSON fragments", () => {
    const source = output(text('{"x":1}'), text('{"a":'), text('2}'));
    expect(display(source)).toEqual([text('{\n  "x": 1\n}'), text('{"a":'), text('2}')]);
  });

  it("returns the complete original result when aggregate indentation exceeds the byte budget", () => {
    const json = "[".repeat(250) + "0" + "]".repeat(250);
    const source = output(text('{"small":1}'), text(json));
    expect(formattedOutput(source)).toBeUndefined();
    expect(display(source)).toBe(source.content);
  });

  it("checks multibyte output against the byte boundary without dropping a field", () => {
    const overhead = Buffer.byteLength('{\n  "s": ""\n}');
    const value = "한".repeat(Math.floor((50 * 1024 - overhead) / 3));
    const source = output(text(`{"s":"${value}"}`));
    const expected = `{\n  "s": "${value}"\n}`;
    expect(display(source)).toEqual([text(expected)]);
    const over = output(text(`{"s":"${value}한"}`));
    expect(formattedOutput(over)).toBeUndefined();
    expect(display(over)).toBe(over.content);
  });

  it("counts generated and existing lines across all blocks", () => {
    const atLimit = output(text(`[${Array.from({length: 1998}, () => "{}").join(",")}]`));
    expect((display(atLimit)[0]!.text as string).split("\n")).toHaveLength(2000);
    const over = output(...atLimit.content, text("one more block"));
    expect(formattedOutput(over)).toBeUndefined();
    const alreadyLarge = output(text('{"a":1}'), text("\n".repeat(2000)));
    expect(formattedOutput(alreadyLarge)).toBeUndefined();
  });

  it("does not parse oversized input, including aggregate small blocks", () => {
    const parse = vi.spyOn(JSON, "parse");
    for (const source of [output(text(`{"s":"${"x".repeat(50 * 1024)}"}`)),
      output(...Array.from({length: 1900}, () => text('{"message":"' + "x".repeat(20) + '"}')))]) {
      expect(formattedOutput(source)).toBeUndefined();
      expect(display(source)).toBe(source.content);
    }
    expect(parse).not.toHaveBeenCalled();
  });

  it("falls back as one result rather than giving each fragment a separate formatting quota", () => {
    const section = `[${Array.from({length: 1100}, () => "{}").join(",")}]`;
    const raw = `==> text 1/2 <==\n${section}\n==> text 2/2 <==\n${section}`;
    const source = scriptOutput({content: [text(raw)]})!;
    expect(source.parts).toHaveLength(2);
    expect(formattedOutput(source)).toBeUndefined();
    expect(source.parts!.map(part => outputPartContent(source, part))).toEqual([[text(`${section}\n`)], [text(section)]]);
  });

  it("uses the complete original result if formatting preparation throws", () => {
    const source = output(text('{"a":1}'), text('{"b":2}'));
    vi.spyOn(Buffer, "byteLength").mockImplementationOnce(() => { throw new Error("formatter unavailable"); });
    expect(formattedOutput(source)).toBeUndefined();
    expect(source.content).toEqual([text('{"a":1}'), text('{"b":2}')]);
  });
});
