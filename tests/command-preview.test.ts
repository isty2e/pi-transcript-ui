import { expect, it } from "vitest";
import { NO_SUMMARY_METRICS } from "../src/tool-metrics.js";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { commandPreview } from "../src/command-preview.js";
import { displayFor, joinLine, settledLine } from "../src/display.js";

it("preserves command heads and operator kinds before spending columns on arguments", () => {
  const command = `cd /Users/example/Desktop/very/long/project && CONFIG=/long/private/value npm test -- ${"x".repeat(120)} | grep pattern && git diff --check`;
  const line = stripTerminalSequences(commandPreview(command, 90));
  for (const head of ["cd", "[env] npm test", "grep", "git diff"]) expect(line).toContain(head);
  expect(line.match(/&&/g)).toHaveLength(2);
  expect(line.match(/\|/g)).toHaveLength(1);
  expect(visibleWidth(line)).toBeLessThanOrEqual(90);
  expect(line).not.toContain("/long/private/value");
});

it("compacts literal paths without dropping quote delimiters or resolving dot segments", () => {
  expect(stripTerminalSequences(commandPreview('cd "/Users/example/long space/project"', 28))).toBe('cd "…/project"');
  const dot = "cd /a/../b/very/long/path/to/project";
  expect(stripTerminalSequences(commandPreview(dot, 30))).not.toContain("/a/…/");
  expect(commandPreview("echo ok", 80)).toBe("echo ok");
});

it("keeps quoted and escaped operators inside their arguments", () => {
  const command = `echo 'a|b && c' "quoted;value" escaped\\|value ${"long ".repeat(20)} && git status`;
  const line = stripTerminalSequences(commandPreview(command, 65));
  expect(line).toContain("git status");
  expect(line).not.toMatch(/\[\+\d+\]/);
  expect(line).toContain("a|b && c");
});

it.each([
  "echo `date` && git status",
  "cat <<EOF\nx\nEOF", "echo x & git status",
  "if true; then echo x; fi", "echo x &&", "echo 'unclosed", "echo x;",
  "echo x # comment && hidden", "(echo x) && git status", "echo x\n git status",
  "echo x |& grep x", "echo x \\",
])("falls back without pretending to understand unsupported syntax: %s", (command) => {
  const first = command.split("\n")[0]!;
  expect(commandPreview(command, 12)).toBe(truncateToWidth(first, 12, "…"));
});

it.each(["echo $(date) && git status", "echo $HOME && git status", 'echo "$HOME" && git status', "echo x > output && git status"])("keeps known omission counts for supported outer chains: %s", (command) => {
  expect(commandPreview(command, 12)).toContain("[+1]");
  expect(visibleWidth(commandPreview(command, 12))).toBeLessThanOrEqual(12);
});

it("does not apply Bash interpretation to PowerShell", () => {
  const command = "Set-Location /Users/example/long/project; Get-ChildItem | Select-Object Name";
  expect(commandPreview(command, 35, "powershell")).toBe(truncateToWidth(command, 35, "…"));
  const display = displayFor("powershell", { command })!;
  expect(display.target.kind === "command" && display.target.shell).toBe("powershell");
});

it("does not spend reserved command-name columns on argument ellipses", () => {
  const command = `abcdef ${"x".repeat(100)} | ghijkl ${"y".repeat(100)}`;
  expect(stripTerminalSequences(commandPreview(command, 15))).toBe("abcdef | ghijkl");
});

it("marks omitted stages and stays bounded at tiny and wide widths", () => {
  const command = Array.from({ length: 12 }, (_, i) => `command${i} /long/path/to/argument`).join(" && ");
  expect(stripTerminalSequences(commandPreview(command, 60))).toMatch(/\[\+\d+\]/);
  for (const width of [0, 1, 5, 15, 40, 60, 120]) expect(visibleWidth(commandPreview(command, width))).toBeLessThanOrEqual(width);
});

it("keeps Unicode previews inside the allocated terminal columns", () => {
  const command = `echo '가나다👩‍💻 ${"긴 인자 ".repeat(30)}' || git status; npm test`;
  for (const width of [1, 8, 16, 33, 60, 120]) expect(visibleWidth(commandPreview(command, width))).toBeLessThanOrEqual(width);
});

it("enforces the token bound at an operator without preceding whitespace", () => {
  const command = `echo ${Array.from({ length: 256 }, () => "x").join(" ")}&&git status`;
  expect(commandPreview(command, 40)).toBe(truncateToWidth(command, 40, "…"));
});

it("falls back for input beyond the scanner budget", () => {
  const command = `echo ${"x".repeat(16384)} && git status`;
  expect(commandPreview(command, 40)).toBe(truncateToWidth(command, 40, "…"));
});

it("allocates stages at the final row target width and retains original arguments", () => {
  const command = `cd /Users/example/Desktop/very/long/project && npm test -- ${"x".repeat(200)} | grep error && git diff --check`;
  const display = displayFor("bash", { command })!;
  const row = joinLine(settledLine({ toolName: "bash", display, content: [{ type: "text", text: "done" }], isError: false, intent: "Check tests", layout: { width: 240 }, metrics: NO_SUMMARY_METRICS }));
  expect(visibleWidth(row)).toBeLessThanOrEqual(120);
  for (const head of ["npm test", "grep", "git diff"]) expect(row).toContain(head);
  expect(display.target).toEqual({ kind: "command", command });
});
