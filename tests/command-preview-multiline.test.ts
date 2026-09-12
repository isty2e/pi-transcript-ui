import { expect, it } from "vitest";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { commandPreview } from "../src/command-preview.js";
import { displayFor, joinLine, settledLine } from "../src/display.js";
import { NO_SUMMARY_METRICS } from "../src/tool-metrics.js";

it("shows multiline command heads without classifying shell setup", () => {
  expect(commandPreview("set -euo pipefail\nnpm test\ngit diff --check", 120))
    .toBe("set -euo pipefail ↵ npm test ↵ git diff --check");
  expect(commandPreview("set -- one two\nset +e\nprintf '%s' x", 120))
    .toBe("set -- one two ↵ set +e ↵ printf '%s' x");
});

it.each(["&&", "||", "|"])("keeps %s across blank lines rather than inventing another stage", (operator) => {
  expect(commandPreview(`npm test ${operator}\n\n  git diff --check\n`, 120))
    .toBe(`npm test ${operator} git diff --check`);
});

it("ignores empty boundary lines and permits a final newline", () => {
  expect(commandPreview("\n  \nnpm test\n\n  git diff --check\n\n", 120))
    .toBe("npm test ↵ git diff --check");
  expect(commandPreview("\n\n", 120)).toBe("");
});

it("joins escaped newlines without splitting words or arguments", () => {
  expect(commandPreview("np\\\nm test \\\n --runInBand\ngit diff --check", 120))
    .toBe("npm test --runInBand ↵ git diff --check");
  expect(commandPreview('echo "a\\\nb"\ngit status', 120))
    .toBe('echo "ab" ↵ git status');
});

it.each([
  "echo 'payload\nhidden_command'\ngit status",
  'echo "payload\nhidden_command"\ngit status',
  "echo 'payload\\\nhidden_command'\ngit status",
  "python - <<$'PY'\nhidden_command()\nPY\ngit status",
  "if true; then\nhidden_command\nfi\ngit status",
  "echo $(printf x\nhidden_command)\ngit status",
  "echo $(ca\\\nse x in x) echo hidden_command;; esac)\ngit status",
])("retains only known outer boundaries before an opaque multiline remainder: %s", (tail) => {
  const line = commandPreview(`npm test\n${tail}`, 120);
  expect(line).toMatch(/^npm test ↵ .*\[…\]$/);
  expect(line).not.toContain("hidden_command");
  expect(line).not.toContain("git status");
  expect(line.match(/↵/g)).toHaveLength(1);
  expect(commandPreview(tail, 120)).toContain("[…]");
});

it("does not mistake an escaped backslash for a line continuation", () => {
  expect(commandPreview("echo \\\\\ngit status", 120)).toBe("echo \\\\ ↵ git status");
});

it("retains recognized heads when a comment stops interpretation", () => {
  const line = commandPreview("npm test\n# comment\ngit status", 120);
  expect(line).toBe("npm test ↵ […]");
});

it("marks unknown omitted syntax without counting its body lines", () => {
  const source = "npm test\ngit diff --check\npython - <<'PY'\nprint('body')";
  const previews = Array.from({ length: 121 }, (_, width) => commandPreview(source, width));
  expect(previews.some((preview) => preview.includes("[more]"))).toBe(true);
  for (const [width, preview] of previews.entries()) {
    expect(visibleWidth(preview)).toBeLessThanOrEqual(width);
    expect(preview).not.toMatch(/\[\+\d+\]/);
    expect(preview).not.toContain("print");
    expect(preview).not.toContain("\n");
  }
});

it("counts known omitted multiline stages and preserves Unicode width limits", () => {
  const source = Array.from({ length: 12 }, (_, i) => `command${i} '가나다 👩‍💻'`).join("\n");
  expect(commandPreview(source, 60)).toMatch(/\[\+\d+\]/);
  for (const width of [0, 1, 8, 24, 60, 120]) {
    expect(visibleWidth(commandPreview(source, width))).toBeLessThanOrEqual(width);
  }
});

it("marks multiline budget fallback and incomplete operators", () => {
  for (const source of ["echo x\n" + "x".repeat(16384), "npm test &&\n", "echo x\r\ngit status"]) {
    expect(commandPreview(source, 80)).toContain("[…]");
    expect(commandPreview(source, 80)).not.toContain("↵");
  }
});

it("preserves Raw and PowerShell first-line behavior at every width", () => {
  const source = "set -euo pipefail\nnpm test\ngit diff --check";
  for (let width = 0; width <= 120; width++) {
    const firstLine = truncateToWidth("set -euo pipefail", width, "…");
    expect(commandPreview(source, width, "bash", "raw")).toBe(firstLine);
    expect(commandPreview(source, width, "powershell")).toBe(firstLine);
  }
});

it("uses multiline previews in final summaries without changing original arguments", () => {
  const command = "set -euo pipefail\nnpm test\ngit diff --check";
  const display = displayFor("bash", { command })!;
  const line = joinLine(settledLine({ toolName: "bash", display, content: [], isError: false,
    layout: { width: 120 }, metrics: NO_SUMMARY_METRICS }));
  expect(line).toContain("npm test ↵ git diff --check");
  expect(visibleWidth(line)).toBeLessThanOrEqual(120);
  expect(display.target).toEqual({ kind: "command", command });
});
