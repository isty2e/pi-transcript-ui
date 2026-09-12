import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { commandPreview, commandPreviewPlan } from "../src/command-preview.js";

const examples = [
  ['cd foo && python <<\'PY\' | grep -i "bar"\nprint("bar")\nPY\ngit status', 'cd foo && python […] | grep -i "bar" ↵ git status'],
  ['python3 - <<"PY"\nprint("bar")\nPY', 'python3 - […]'],
  ['cat <<EOF\nEOF\npwd', 'cat […] ↵ pwd'],
  ['cat <<-\'END-OF\'\n\tbody\n\tEND-OF\npwd', 'cat […] ↵ pwd'],
  ['cat << A |\nbody\nA\ngrep body', 'cat […] | grep body'],
  ['cat <<A &&\nbody\nA\nprintf done', 'cat […] && printf done'],
  ['cat <<A ||\nbody\nA\nprintf done', 'cat […] || printf done'],
  ['cat <<A; printf queued\nbody\nA\nprintf after', 'cat […] ; printf queued ↵ printf after'],
  ['cat <<A | cat <<\'B\'\nfirst\nA\nsecond\nB\npwd', 'cat […] | cat […] ↵ pwd'],
  ['cat 3<<A <<\'B\'\nfirst\nA\nsecond\nB\npwd', 'cat […] […] ↵ pwd'],
  ['cat 3 <<EOF\nbody\nEOF', 'cat 3 […]'],
  ['cat <<A >out\nbody\nA\ncat out', 'cat […] >out ↵ cat out'],
  ['cat <<A \\\n| grep body\nbody\nA', 'cat […] | grep body'],
  ['cat <<A\nfirst\nA\ncat <<B\nsecond\nB\npwd', 'cat […] ↵ cat […] ↵ pwd'],
  ['cat <<EOF\nEO\\\nF\npwd', 'cat […] ↵ pwd'],
  ['cat <<EOF\npayload\\\nEOF\nhidden_command\nEOF\npwd', 'cat […] ↵ pwd'],
  ['cat <<EOF\npayload\\\\\nEOF\npwd', 'cat […] ↵ pwd'],
  ['cat <<\'EOF\'\npayload\\\nEOF\npwd', 'cat […] ↵ pwd'],
  ['cat <<-EOF\nEO\\\n\tF\nhidden_command\nEOF\npwd', 'cat […] ↵ pwd'],
  ['cat <<\'PY\'\nPYsuffix\n PY\nPY \n&& hidden_command | pwd\n$(cat <<INNER)\nPY\npwd', 'cat […] ↵ pwd'],
] as const;

it.each(examples)("keeps outer structure around confirmed documents: %s", (source, expected) => {
  expect(commandPreview(source, 200)).toBe(expected);
  expect(commandPreviewPlan(source, 200).text).toBe(expected);
});

it.each([
  'cat <<EOF\nhidden_command\n EOF\ngit status',
  'cat <<EOF\nhidden_command\nEOF \ngit status',
  'cat <<-EOF\nhidden_command\n EOF\ngit status',
  'cat <<EOF | grep body\nhidden_command\ngit status',
  'cat <<A | cat <<B\nfirst\nA\nhidden_command\ngit status',
  'cat <<A | printf $\'unsupported\'\nhidden_command\nA\ngit status',
  'cat <<A | printf "quoted\nA\nhidden_command\n"\ngit status',
  'cat <<A | grep body\n',
])("rolls back the pending header when a document cannot be confirmed: %s", (source) => {
  const command = `pwd && ${source}`;
  expect(commandPreview(command, 200)).toBe('pwd && cat […]');
  const plan = commandPreviewPlan(command, 200);
  expect(plan.text).toBe('pwd && cat […]');
  for (const span of plan.spans!) {
    if (typeof span.origin === 'number') expect(span.origin + span.end - span.start).toBeLessThanOrEqual(7);
  }
});

it.each(["''", '""', "'P Y'", "'PY'OTHER", '"PY"OTHER', "\\PY", "$'PY'", '${PY}', '$(echo PY)'])
  ("refuses unsupported delimiter words rather than accepting their prefix: %s", delimiter => {
    const source = `pwd && cat <<${delimiter}\nhidden_command\nPY\ngit status`;
    expect(commandPreview(source, 200)).toBe('pwd && cat […]');
  });

it("keeps here-strings, leading redirections and nested heredocs outside this scanner's envelope", () => {
  for (const tail of ['cat <<<body\ngit status', '<<EOF cat\nbody\nEOF\ngit status', 'echo "$(cat <<EOF\nbody\nEOF\n)"\ngit status']) {
    const preview = commandPreview(`pwd && ${tail}`, 200);
    expect(preview).toContain('pwd &&');
    expect(preview).toContain('[…]');
    expect(preview).not.toContain('git status');
  }
});

it.each(['<\\\n<EOF', '<\\\n\\\n<-EOF', '<<\\\nEOF', "<<'EO'F", '<<EOF\\\n'])
  ("refuses unsupported continued or mixed heredoc headers without exposing bodies: %s", header => {
    const source = `pwd && cat ${header}\nhidden_command\nEOF\ngit status`;
    expect(commandPreview(source, 200)).toBe('pwd && cat […]');
  });

it("handles a long non-delimiter backslash run within the source budget", () => {
  const source = 'cat <<EOF\n' + '\\'.repeat(16000) + 'x\nEOF\npwd';
  expect(commandPreview(source, 80)).toBe('cat […] ↵ pwd');
});

it("does not interpret quoted heredoc-looking arguments", () => {
  expect(commandPreview('echo "<<EOF" \'<<PY\'\npwd', 200)).toBe('echo "<<EOF" \'<<PY\' ↵ pwd');
});

it("retains literal origins after skipped bodies without matching repeated body text", () => {
  const source = 'cat <<\'EOF\' | grep bar\ngrep bar\npwd\nEOF\npwd';
  const plan = commandPreviewPlan(source, 200);
  expect(plan.text).toBe('cat […] | grep bar ↵ pwd');
  const last = plan.spans!.at(-1)!;
  expect(last.origin).toBe(source.lastIndexOf('pwd'));
  expect(plan.text.slice(last.start, last.end)).toBe('pwd');
  const marker = plan.spans!.find(span => plan.text.slice(span.start, span.end) === '[…]');
  expect(marker?.origin).toBe('marker');

  let end = 0;
  for (const span of plan.spans!) {
    if (typeof span.origin !== 'number') continue;
    expect(span.origin).toBeGreaterThanOrEqual(end);
    end = span.origin + span.end - span.start;
    expect(plan.text.slice(span.start, span.end)).toBe(source.slice(span.origin, end));
    expect(span.origin < source.indexOf('\n') || span.origin >= source.lastIndexOf('pwd')).toBe(true);
  }
});

it("counts only known outer stages and preserves width and mode contracts", () => {
  const source = 'cat <<EOF | grep body\nhidden_command\nEOF\ngit status';
  const previews = Array.from({ length: 161 }, (_, width) => commandPreview(source, width));
  expect(previews.some(preview => preview.includes('[+2]'))).toBe(true);
  for (const [width, preview] of previews.entries()) {
    expect(visibleWidth(preview)).toBeLessThanOrEqual(width);
    expect(preview).not.toMatch(/hidden_command|EOF|\[more\]|\n/);
    expect(stripTerminalSequences(preview)).toBe(commandPreviewPlan(source, width).text);
    const first = truncateToWidth(source.split('\n')[0]!, width, '…');
    expect(commandPreview(source, width, 'bash', 'raw')).toBe(first);
    expect(commandPreview(source, width, 'powershell')).toBe(first);
  }
});

it("retains source, word and stage admission bounds", () => {
  for (const source of [
    'cat <<EOF\n' + 'x'.repeat(16384) + '\nEOF\nhidden_after',
    'cat <<EOF\n\x1b[31m\nEOF\nhidden_after',
    'cat ' + 'arg '.repeat(256) + '<<EOF\nbody\nEOF\nhidden_after',
    'pwd; '.repeat(64) + 'cat <<EOF\nbody\nEOF\nhidden_after',
  ]) {
    const preview = commandPreview(source, 80);
    expect(preview).not.toContain('hidden_after');
    expect(visibleWidth(preview)).toBeLessThanOrEqual(80);
  }
});

const bashProbe = spawnSync('bash', ['--version'], { timeout: 3000 });
const bashMissing = bashProbe.error && 'code' in bashProbe.error && bashProbe.error.code === 'ENOENT';
const shellExamples = [
  ["cat <<'EOF' | grep -i bar\nbar\nbaz\nEOF\nprintf 'AFTER\\n'\n", 'bar\nAFTER\n', "cat […] | grep -i bar ↵ printf 'AFTER\\n'"],
  ["cat <<EOF\nEO\\\nF\nprintf 'AFTER\\n'\n", 'AFTER\n', "cat […] ↵ printf 'AFTER\\n'"],
  ["cat <<EOF\npayload\\\nEOF\nprintf 'BODY_ONLY\\n'\nEOF\nprintf 'AFTER\\n'\n", "payloadEOF\nprintf 'BODY_ONLY\\n'\nAFTER\n", "cat […] ↵ printf 'AFTER\\n'"],
  ["cat <<-EOF\nEO\\\n\tF\nprintf 'BODY_ONLY\\n'\nEOF\nprintf 'AFTER\\n'\n", "EO\tF\nprintf 'BODY_ONLY\\n'\nAFTER\n", "cat […] ↵ printf 'AFTER\\n'"],
  ["cat <<'EOF' |\nbar\nEOF\ngrep bar\n", 'bar\n', 'cat […] | grep bar'],
  ["cat <<A <<'B'\nfirst\nA\nsecond\nB\nprintf 'AFTER\\n'\n", 'second\nAFTER\n', "cat […] […] ↵ printf 'AFTER\\n'"],
  ["cat <<EOF\n$(printf expanded)\nEOF\nprintf 'AFTER\\n'\n", 'expanded\nAFTER\n', "cat […] ↵ printf 'AFTER\\n'"],
] as const;

it.skipIf(bashMissing).each(shellExamples)("agrees with actual Bash on controlled boundary fixtures: %s", (source, output, preview) => {
  const result = spawnSync('bash', ['--noprofile', '--norc', '-s'], { input: source, encoding: 'utf8', timeout: 3000, maxBuffer: 16384 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(output);
  expect(commandPreview(source, 200)).toBe(preview);
});
