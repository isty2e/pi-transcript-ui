import { afterEach, expect, it, vi } from "vitest";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { displayFor, targetText } from "../src/display.js";
import { commandPreview } from "../src/command-preview.js";
import { fileReadFor } from "../src/read-body.js";
import { fileMutationFor } from "../src/file-mutation.js";

const preview = (path: string, width: number) => targetText({ kind: "path", path }, {}, width);
afterEach(() => vi.unstubAllEnvs());

it.each([
  ["packages/ui/src/components/forms/Button.tsx", "packages/…/components/forms/Button.tsx"],
  ["packages/ui/src/components/forms/Button.tsx", "packages/…/forms/Button.tsx"],
  ["packages/ui/src/components/forms/Button.tsx", "packages/…/Button.tsx"],
  ["/workspace/app/deep/Button.tsx", "/workspace/…/Button.tsx"],
  ["~/project/app/deep/index.ts", "~/project/…/index.ts"],
  ["C:\\workspace\\app\\deep\\Button.tsx", "C:\\workspace\\…\\Button.tsx"],
  ["C:/workspace/app/deep/Button.tsx", "C:/workspace/…/Button.tsx"],
  ["\\\\server\\share\\deep\\nested\\file.ts", "\\\\server\\…\\nested\\file.ts"],
  ["packages//ui/src//deep/file.ts", "packages//…//deep/file.ts"],
  ["packages/ui/src/components/", "packages/…/components/"],
  ["./packages/ui/src/index.ts", "./…/src/index.ts"],
  ["../packages/ui/src/index.ts", "../…/src/index.ts"],
])("retains the first segment and longest fitting contiguous tail: %s", (source, expected) => {
  expect(preview(source, visibleWidth(expected))).toBe(expected);
});

it.each([
  ["overlong-directory-name/file.ts", "overlo…/file.ts"],
  ["overlong-directory-name/middle/file.ts", "overlo…/…/file.ts"],
  ["packages/middle/file.ts", "…/file.ts"],
  ["/workspace/middle/file.ts", "/…/file.ts"],
  ["/workspace/middle/file.ts", "/…file.ts"],
  ["C:\\file.ts", "C…file.ts"],
  ["really-long-file-name.test.ts", "really-….test.ts"],
  ["packages/deep/really-long-file-name.test.ts", "…/really-….test.ts"],
])("sacrifices the beginning before the filename, then middle-clips oversized names: %s", (source, expected) => {
  expect(preview(source, visibleWidth(expected))).toBe(expected);
});

it.each(["", "/", "~/", "C:\\", "a.ts", "./a/../b.ts", "a//b/", "dir with spaces/file name.ts"]) (
  "leaves fitting path text unchanged: %s", source => expect(preview(source, 120)).toBe(source),
);

it("keeps literal POSIX backslashes inside filenames", () => {
  if (process.platform === "win32") return;
  const source = "packages/deep/name\\with\\slashes.ts";
  expect(preview(source, visibleWidth("packages/…/name\\with\\slashes.ts"))).toBe("packages/…/name\\with\\slashes.ts");
  expect(preview(source, visibleWidth("…/name\\with\\slashes.ts"))).toBe("…/name\\with\\slashes.ts");
});

it("does not treat a home-prefix sibling as the home directory", () => {
  vi.stubEnv("HOME", "/home/alice");
  expect(displayFor("read", { path: "/home/alice/project/file.ts" })?.target).toEqual({ kind: "path", path: "~/project/file.ts" });
  expect(displayFor("read", { path: "/home/alice-other/project/file.ts" })?.target).toEqual({ kind: "path", path: "/home/alice-other/project/file.ts" });
});

it("uses the path projection for built-ins and renamed compatible tools, not queries or commands", () => {
  const path = "packages/ui/src/components/forms/Button.tsx";
  const expected = "packages/…/Button.tsx", width = visibleWidth(expected);
  const reader = fileReadFor(createReadToolDefinition("/tmp").parameters)!;
  const writer = fileMutationFor(createWriteToolDefinition("/tmp").parameters)!;
  const editor = fileMutationFor(createEditToolDefinition("/tmp").parameters)!;
  const aliasWriter = fileMutationFor({ type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] })!;
  for (const display of [displayFor("read", { path }), displayFor("ls", { path }),
    displayFor("renamed_read", { path }, undefined, reader),
    displayFor("renamed_write", { path, content: "text" }, writer),
    displayFor("renamed_edit", { path, edits: [] }, editor),
    displayFor("mcp_writer", { file_path: path, content: "text" }, aliasWriter)]) {
    expect(display).not.toBeNull();
    expect(targetText(display!.target, {}, width)).toBe(expected);
  }
  for (const name of ["grep", "find"]) {
    expect(targetText(displayFor(name, { pattern: path })!.target, {}, width)).toBe(truncateToWidth(`"${path}"`, width, "…"));
  }
  for (const mode of ["compact", "raw"] as const) {
    const command = `cat ${path}`;
    expect(targetText({ kind: "command", command }, { commandPreview: mode }, width)).toBe(commandPreview(command, width, "bash", mode));
  }
  expect(displayFor("generic", { path })).toBeNull();
});

it("respects all target widths, complete graphemes and display control normalization", () => {
  const sources = ["/workspace/" + "nested/".repeat(1000) + "file.test.ts", "~/프로젝트/" + "문서/".repeat(5) + "보고서👩‍🔬.ts", "a/" + "e\u0301".repeat(60) + ".test.ts", "C:\\workspace\\" + "🧑‍💻".repeat(40) + ".ts", "\x1b[31mpackages\x1b[0m/long\tname/deep/file.ts"];
  for (const source of sources) for (let width = 0; width <= 140; width++) {
    const result = preview(source, width);
    expect(visibleWidth(result)).toBeLessThanOrEqual(Math.min(width, 120));
    expect(result).toBe(stripTerminalSequences(result));
    expect(result).not.toMatch(/[\r\n\t\u001b]/);
    expect(result).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(result).not.toMatch(/(?:^|…)\p{Mark}|\u200d(?:…|$)/u);
  }
  expect(preview("~/프로젝트/깊은/폴더/보고서👩‍🔬.ts", 32)).toContain("보고서👩‍🔬.ts");
});
