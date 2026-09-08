import { expect, it } from "vitest";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { commandPreview } from "../src/command-preview.js";

const sample = `cd /Users/example/Desktop/git/example-project && git diff --check && test -z "$(git diff --cached --name-only)" && kata --project example-project close demo-1 --message '${"검증 결과 기록 ".repeat(30)}' --agent; if tmux -L example-preview has-session -t verify 2>/dev/null; then echo 'verification still active'; else echo 'verification process exited'; fi`;

it("keeps useful outer heads in the reported compound command without flattening the conditional", () => {
  const preview = stripTerminalSequences(commandPreview(sample, 110));
  for (const head of ["cd", "git diff", "test", "kata", "if […]"]) expect(preview).toContain(head);
  expect(preview.match(/&&/g)).toHaveLength(3);
  expect(preview).toContain('test -z "$(…)"');
  expect(preview).not.toContain("tmux");
  expect(preview).not.toContain("then echo");
  expect(visibleWidth(preview)).toBeLessThanOrEqual(110);
});

it.each([
  `printf '%s' "$(echo 'inner && text')"`,
  'test -z "$(git diff --cached --name-only)"',
  'echo "$(printf \'%s\' "$(date)")"',
  'echo $HOME',
  String.raw`echo "$(printf '%s' ') && not_outer')"`,
  String.raw`echo "$(printf '%s' \))"`,
  String.raw`echo "$(echo \"quoted\")"`,
  'echo ok 2>/dev/null',
  'echo ok > /tmp/output',
  'cat < input >> output',
])("retains outer operators around supported opaque arguments: %s", (first) => {
  const command = `${first} && git status -- ${"long ".repeat(30)}`;
  const preview = commandPreview(command, 65);
  expect(preview).toContain("git status");
  expect(preview).not.toContain("[more]");
  expect(preview).not.toContain("[…]");
  expect(visibleWidth(preview)).toBeLessThanOrEqual(65);
});

it.each([
  'echo "$(case x in x) echo hidden;; esac)" && hidden_after',
  'echo "$((1 + 2))" && hidden_after',
  'echo $[1 | 2] && hidden_after',
  'cat <(echo hidden) && hidden_after',
  'echo ${VALUE:-hidden} && hidden_after',
  'echo `date` && hidden_after',
  'echo "$(cat <<EOF)" && hidden_after',
  'echo "$(echo # comment )" && hidden_after',
  'echo \'unclosed && hidden_after',
  'echo ok 2>&1 && hidden_after',
])("retains a prefix but refuses to invent boundaries beyond unsupported syntax: %s", (tail) => {
  const command = `cd /Users/example/Desktop/long/project && ${tail} ${"padding".repeat(20)}`;
  const preview = commandPreview(command, 80);
  expect(preview).toContain("cd …/project &&");
  expect(preview).toContain("[…]");
  expect(preview).not.toContain("hidden_after");
});

it.each([String.raw`'$(literal && text)'`, String.raw`"\$(literal && text)"`])("does not treat a quoted or escaped literal as a substitution: %s", (literal) => {
  const preview = commandPreview(`echo ${literal} && git status -- ${"padding".repeat(20)}`, 100);
  expect(preview).toContain(literal);
});

it("handles simple substitutions at the nesting bound", () => {
  const command = 'echo ' + '$(echo '.repeat(8) + 'x' + ')'.repeat(8) + ' && git status';
  expect(commandPreview(command, 40)).toBe('echo $(…) && git status');
});

it.each(["\u00a0echo", "echo\u00a0file"])("does not interpret Unicode filename spacing as a shell delimiter: %s", (head) => {
  const command = `cd /a/b/c/project && ${head} ` + '${VALUE} ' + 'padding'.repeat(30);
  expect(commandPreview(command, 80)).toBe('cd …/project && […]');
});

it("reserves the opaque annotation even when the unparsed command name is long", () => {
  const command = `cd /a/b/c/project && ${"x".repeat(80)} $'unsupported' && hidden_after`;
  expect(commandPreview(command, 80)).toContain("[…]");
  expect(commandPreview(command, 80)).not.toContain("hidden_after");
});

it("uses more without a numeric subtotal when an omitted remainder is unknown", () => {
  const previews = Array.from({ length: 121 }, (_, width) => commandPreview(sample, width));
  expect(previews.some(s => s.includes("[more]"))).toBe(true);
  expect(previews.some(s => s.includes("tail"))).toBe(false);
  for (const [width, preview] of previews.entries()) {
    expect(visibleWidth(preview)).toBeLessThanOrEqual(width);
    expect(preview).not.toMatch(/\[\+\d+\]/);
  }
});

it("shortens whole relative and option-value tokens without claiming filesystem identity", () => {
  expect(commandPreview('cp src/components/presentation/summary.ts --output=build/artifacts/reports/result.txt', 65))
    .toBe('cp …/summary.ts --output=…/result.txt');
  expect(commandPreview('tool --output="/Users/example/long space/directory/result.txt"', 40))
    .toBe('tool --output="…/result.txt"');
  expect(commandPreview('cd "/Users/example/long space/project"', 28)).toBe('cd "…/project"');
});

it("does not shorten URL-like, parent-relative or embedded prose fragments as paths", () => {
  for (const arg of ['https://host/long/path/to/file', '/a/../b/long/path/file', "'prose /a/b/c/d text'", '$HOME/long/path/to/file']) {
    const command = `echo ${arg} && git status -- ${"x".repeat(200)}`;
    const preview = commandPreview(command, 100);
    expect(preview).not.toMatch(/…\/(?:file|d)/);
    expect(preview).toContain("git status");
  }
});

it("retains raw fallback for unsupported initial single-line syntax and substitution-depth limits", () => {
  const deep = 'echo ' + '$(echo '.repeat(9) + 'x' + ')'.repeat(9) + ' && git status';
  for (const command of ['if true; then echo x; fi', deep]) {
    expect(commandPreview(command, 12)).toBe(truncateToWidth(command.split("\n")[0]!, 12, "…"));
  }
});
