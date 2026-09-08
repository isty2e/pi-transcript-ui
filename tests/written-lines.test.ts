import { expect, it } from "vitest";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { fileMutationFor, writtenLineCount } from "../src/file-mutation.js";

const capability = fileMutationFor(createWriteToolDefinition("/tmp").parameters);
const result = { content: [{ type: "text", text: "receipt\nnot\nfile\nlines" }], isError: false };
it.each([["", 0], ["one", 1], ["one\n", 1], ["\n", 1], ["a\n\nb", 3], ["a\r\nb\r\n", 2]])("counts written content %j as %i lines", (content, expected) => {
  expect(writtenLineCount(capability, { path: "file", content }, result, false)).toBe(expected);
});
it("checks capability, args and final success before using even a cached count", () => {
  const args = { path: "file", content: "a\nb" };
  expect(writtenLineCount(capability, args, result, false)).toBe(2);
  expect(writtenLineCount(capability, args, result, true)).toBeUndefined();
  expect(writtenLineCount(capability, args, { ...result, isError: true }, false)).toBeUndefined();
  expect(writtenLineCount(undefined, args, result, false)).toBeUndefined();
  expect(writtenLineCount(capability, args, undefined, false)).toBeUndefined();
  expect(writtenLineCount(capability, args, {}, false)).toBeUndefined();
  expect(writtenLineCount(capability, { path: "file", content: 3 }, result, false)).toBeUndefined();
  args.content = "";
  expect(writtenLineCount(capability, args, result, false)).toBe(0);
  args.path = "";
  expect(writtenLineCount(capability, args, result, false)).toBeUndefined();
});
