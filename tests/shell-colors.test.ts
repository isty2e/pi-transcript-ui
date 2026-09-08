import { expect, it, vi } from "vitest";
import { initTheme, highlightCode } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { commandPreview, commandPreviewPlan } from "../src/command-preview.js";
import { createCommandColorizer } from "../src/shell-colors.js";

function characterColors(ansi: string, expected: string): string[] {
  let offset = 0, text = "", color = "";
  const colors: string[] = [];
  const append = (part: string) => { text += part; colors.push(...Array<string>(part.length).fill(color)); };
  for (const match of ansi.matchAll(/\x1b\[([0-9;]*)m/g)) {
    append(ansi.slice(offset, match.index));
    color = ["", "0", "39"].includes(match[1]!) ? "" : match[0];
    offset = match.index + match[0].length;
  }
  append(ansi.slice(offset));
  expect(text).toBe(expected);
  return colors;
}

it("preserves the actual occurrence behind duplicate text and distinguishes literal markers", () => {
  const plan = commandPreviewPlan('X="pwd" pwd', 8);
  expect(plan.text).toBe("[env] p…");
  expect(plan.spans?.filter(span => typeof span.origin === "number")).toEqual([{ start: 6, end: 7, origin: 8 }]);
  const literal = commandPreviewPlan("echo '[env]'\npwd", 80);
  expect(literal.spans?.some(span => span.origin === 5 && literal.text.slice(span.start, span.end) === "'[env]'" )).toBe(true);
  const long = commandPreviewPlan('echo "' + 'x'.repeat(1000) + '"\npwd', 80);
  expect(long.spans!.length).toBeLessThan(10);
});

it("maps 400 projections to original native colors or the unchanged plain fallback", () => {
  const sources = [
    'echo "pwd" && pwd', 'X="pwd" pwd; echo "$HOME"', 'echo "$HOME"\npwd',
    'printf "%s" $(echo "$HOME")\npwd', 'pri\\\nntf "%s" "$HOME"\npwd',
    'echo "e\\\n\u0301"\npwd', 'echo "👩‍💻 한글 é"\npwd',
    'echo "[env] $(…) ↵ […]"\npwd', 'echo "first\npwd\nlast"\necho done',
    'python - <<\'PY\'\nprint("x")\nPY', 'echo hi\n# comment\npwd',
    'echo "$HOME" &&\npwd', 'set -- foo bar\npwd', 'echo\t\t"  a\t b  "\npwd',
    'cmd /a/repeated/repeated/result.txt /b/repeated/repeated/result.txt',
    'echo "unterminated', 'pwd() { printf x; }', 'pwd long_argument',
    'echo "\x1b[31m"', 'echo "' + 'x'.repeat(1000) + ' $HOME"\npwd',
  ];
  for (const palette of ["dark", "light"]) {
    initTheme(palette);
    for (const source of sources) {
      const colorizer = createCommandColorizer();
      try {
        for (const width of [1, 2, 3, 8, 12, 16, 24, 40, 80, 120]) {
          const raw = commandPreview(source, width), plan = commandPreviewPlan(source, width);
          const rendered = colorizer.format({ source, width, offset: 0, length: raw.length }, raw, theme);
          expect(stripTerminalSequences(rendered)).toBe(stripTerminalSequences(raw));
          if (!plan.spans) { expect(rendered).toBe(raw); continue; }
          const native = characterColors(highlightCode(source, "bash").join("\n"), source);
          const expected = Array<string>(plan.text.length).fill("");
          let previousEnd = 0;
          for (const span of plan.spans) {
            if (typeof span.origin === "number") {
              expect(span.origin).toBeGreaterThanOrEqual(previousEnd);
              previousEnd = span.origin + span.end - span.start;
              expect(plan.text.slice(span.start, span.end)).toBe(source.slice(span.origin, previousEnd));
            }
            for (let i = span.start; i < span.end; i++) expected[i] = span.origin === "marker" ? theme.getFgAnsi("muted") : native[span.origin + i - span.start]!;
          }
          expect(characterColors(rendered, plan.text)).toEqual(expected);
        }
      } finally { colorizer.clear(); }
    }
  }
});

it("colors confirmed regions without interpreting opaque tails, including long clipped names", () => {
  const prefixes = ['set -e\ncd /tmp\n', 'echo "cd"\ncd /tmp\n', 'pri\\\nntf x\ncd /tmp\n'];
  const tails = ["node <<'JS'\ncd fake\nJS\npwd", "very_long_opaque_program_name <<EOF\ncd fake\nEOF", 'echo "first\ncd\nlast"', 'for x in a; do cd /tmp; done', 'echo `pwd`', '# cd comment\npwd'];
  for (const palette of ["dark", "light"]) {
    initTheme(palette);
    for (const prefix of prefixes) for (const tail of tails) {
      const source = prefix + tail;
      const colorizer = createCommandColorizer();
      try {
        for (const width of [1, 8, 24, 80, 120]) {
          const raw = commandPreview(source, width), plan = commandPreviewPlan(source, width);
          const actual = colorizer.format({ source, width, offset: 0, length: raw.length }, raw, theme);
          expect(stripTerminalSequences(actual)).toBe(stripTerminalSequences(raw));
          if (width === 120) expect(actual).toContain(theme.fg("syntaxType", "cd"));
          const native = characterColors(highlightCode(source, "bash").join("\n"), source);
          const expected = Array<string>(plan.text.length).fill("");
          for (const span of plan.spans ?? []) {
            if (typeof span.origin === "number") expect(span.origin + span.end - span.start).toBeLessThanOrEqual(prefix.length);
            for (let i = span.start; i < span.end; i++) expected[i] = span.origin === "marker" ? theme.getFgAnsi("muted") : native[span.origin + i - span.start]!;
          }
          expect(characterColors(actual, plan.text)).toEqual(expected);
        }
      } finally { colorizer.clear(); }
    }
  }
});

it("retains bounds and cache invalidation for partially colored requests", () => {
  initTheme("dark");
  const highlight = vi.fn((source: string) => highlightCode(source, "bash").join("\n"));
  const colorizer = createCommandColorizer(highlight);
  const render = (source: string, width = 80) => colorizer.format({ source, width, offset: 0, length: 0 }, commandPreview(source, width), theme);
  const source = 'cd /tmp\nnode <<EOF\nx\nEOF';
  try {
    expect(render(source)).toContain(theme.fg("syntaxType", "cd"));
    render(source, 120); render(source, 120);
    expect(highlight).toHaveBeenCalledTimes(1);
    initTheme("light"); render(source);
    expect(highlight).toHaveBeenCalledTimes(2);
    render(source.replace('/tmp', '/other'));
    expect(highlight).toHaveBeenCalledTimes(3);
    for (const refused of ['cd /tmp\nnode <<EOF\n' + 'x'.repeat(17000) + '\nEOF', 'cd /tmp\nnode <<EOF\n\x1b[31m\nEOF']) expect(render(refused)).toBe(commandPreview(refused, 80));
    expect(highlight).toHaveBeenCalledTimes(3);
    render(source);
    expect(highlight).toHaveBeenCalledTimes(4);
  } finally { colorizer.clear(); }
});

it("reuses source styles across widths and invalidates by source/palette value or clear", () => {
  initTheme("dark");
  const highlight = vi.fn((source: string) => highlightCode(source, "bash").join("\n"));
  const colorizer = createCommandColorizer(highlight);
  const input = { source: 'echo "' + 'x'.repeat(1000) + ' $HOME"\npwd', width: 20, offset: 0, length: 0 };
  const render = () => colorizer.format(input, commandPreview(input.source, input.width), theme);
  try {
    for (const width of [20, 80, 120]) { input.width = width; render(); render(); }
    expect(highlight).toHaveBeenCalledTimes(1);
    const proxy = theme;
    initTheme("light");
    expect(theme).toBe(proxy);
    expect(render()).toContain(theme.fg("syntaxType", "echo"));
    expect(highlight).toHaveBeenCalledTimes(2);
    input.source = 'echo "$PATH"'; render();
    expect(highlight).toHaveBeenCalledTimes(3);
    colorizer.clear(); render();
    expect(highlight).toHaveBeenCalledTimes(4);
  } finally { colorizer.clear(); }
});

it("does not conflate identical clipped previews with different original contexts", () => {
  initTheme("dark");
  const colorizer = createCommandColorizer();
  try {
    const render = (source: string) => colorizer.format({ source, width: 2, offset: 0, length: 2 }, commandPreview(source, 2), theme);
    const declaration = render('pwd() { printf x; }'), command = render('pwd long_argument');
    expect(stripTerminalSequences(declaration)).toBe(stripTerminalSequences(command));
    expect(declaration).not.toBe(command);
  } finally { colorizer.clear(); }
});

it("declines opaque bodies, controls and over-budget input without invoking highlighting", () => {
  initTheme("dark");
  const highlight = vi.fn(() => { throw new Error("must not be called"); });
  const colorizer = createCommandColorizer(highlight);
  try {
    for (const source of ["python - <<'PY'\n" + 'print("hello")\n'.repeat(700) + "PY", 'echo "\x1b[31m"', 'echo ' + 'x'.repeat(16384)]) {
      const raw = commandPreview(source, 80);
      expect(colorizer.format({ source, width: 80, offset: 0, length: raw.length }, raw, theme)).toBe(raw);
    }
    expect(highlight).not.toHaveBeenCalled();
  } finally { colorizer.clear(); }
});

it.each(["throw", "unsupported SGR", "changed source"])("contains %s highlighter failure and retries after clear", failure => {
  initTheme("dark");
  let fail = true;
  const highlight = vi.fn((source: string) => {
    if (fail && failure === "throw") throw new Error("injected failure");
    if (fail) return failure === "unsupported SGR" ? '\x1b[1m' + source : source + "changed";
    return highlightCode(source, "bash").join("\n");
  });
  const colorizer = createCommandColorizer(highlight);
  const source = 'echo "$HOME"', raw = commandPreview(source, 80);
  const input = { source, width: 80, offset: 0, length: raw.length };
  try {
    expect(colorizer.format(input, raw, theme)).toBe(raw);
    expect(colorizer.format(input, raw, theme)).toBe(raw);
    expect(highlight).toHaveBeenCalledTimes(1);
    colorizer.clear(); fail = false;
    expect(colorizer.format(input, raw, theme)).not.toBe(raw);
    expect(highlight).toHaveBeenCalledTimes(2);
  } finally { colorizer.clear(); }
});
