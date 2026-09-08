import { highlightCode, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { COMMAND_SOURCE_LIMIT, commandPreviewPlan, type CommandPreviewPlan } from "./command-preview.js";
import type { CommandSpan } from "./display.js";

type Palette = { getFgAnsi?: Theme["getFgAnsi"] };
interface ColorRun { start: number; end: number; color: string }
const tokens: ThemeColor[] = ["syntaxKeyword", "syntaxType", "syntaxString", "syntaxVariable", "syntaxNumber", "syntaxComment", "syntaxFunction", "syntaxOperator", "syntaxPunctuation", "muted"];

function colorRuns(source: string, ansi: string): ColorRun[] {
  const runs: ColorRun[] = [];
  let cursor = 0, offset = 0, color = "";
  const append = (text: string): void => {
    if (!text) return;
    if (text.includes("\x1b") || source.slice(cursor, cursor + text.length) !== text) throw new Error("Source mismatch");
    const end = cursor + text.length, last = runs.at(-1);
    if (last && last.color === color) last.end = end;
    else runs.push({ start: cursor, end, color });
    cursor = end;
  };
  const pattern = /\x1b\[([0-9;]*)m/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(ansi))) {
    append(ansi.slice(offset, match.index));
    const parameters = match[1]!;
    if (parameters === "" || parameters === "0" || parameters === "39") color = "";
    else if (/^(?:3[0-7]|9[0-7]|38;5;\d+|38;2;\d+;\d+;\d+)$/.test(parameters)) color = match[0];
    else throw new Error("Unsupported foreground sequence");
    offset = match.index + match[0].length;
  }
  append(ansi.slice(offset));
  if (cursor !== source.length) throw new Error("Incomplete source");
  return runs;
}

function projectColors(source: string, plan: CommandPreviewPlan, runs: readonly ColorRun[], markerColor: string): string {
  let run = 0, cursor = 0, previousSourceEnd = 0, current = "", result = "";
  const append = (text: string, color: string) => {
    if (!text) return;
    if (color !== current) { result += color || "\x1b[39m"; current = color; }
    result += text;
  };
  for (const span of plan.spans!) {
    if (span.start < cursor || span.end <= span.start || span.end > plan.text.length) throw new Error("Invalid preview span");
    append(plan.text.slice(cursor, span.start), "");
    if (span.origin === "marker") append(plan.text.slice(span.start, span.end), markerColor);
    else {
      const end = span.origin + span.end - span.start;
      if (span.origin < previousSourceEnd || end > source.length || source.slice(span.origin, end) !== plan.text.slice(span.start, span.end)) throw new Error("Invalid source span");
      let position = span.origin;
      while (position < end) {
        while (runs[run] && runs[run]!.end <= position) run++;
        const style = runs[run];
        if (!style || style.start > position) throw new Error("Unmapped source");
        const next = Math.min(end, style.end);
        append(plan.text.slice(span.start + position - span.origin, span.start + next - span.origin), style.color);
        position = next;
      }
      previousSourceEnd = end;
    }
    cursor = span.end;
  }
  append(plan.text.slice(cursor), "");
  return result + (current ? "\x1b[39m" : "");
}

/** One native component owns this cache; inactive callbacks must not repopulate it. */
export function createCommandColorizer(highlight: (source: string) => string = source => highlightCode(source, "bash").join("\n")) {
  let styles: { source: string; palette: string; runs: ColorRun[] } | undefined;
  let last: { source: string; palette: string; width: number; raw: string; result: string } | undefined;
  const clear = (): void => { styles = undefined; last = undefined; };
  const remember = (input: CommandSpan, palette: string, raw: string, result: string): string => {
    last = { source: input.source, palette, width: input.width, raw, result };
    return result;
  };
  return {
    clear,
    format(input: CommandSpan, raw: string, theme: Palette): string {
      if (!theme.getFgAnsi || input.source.length > COMMAND_SOURCE_LIMIT) { clear(); return raw; }
      let key = "";
      try {
        const fg = theme.getFgAnsi.bind(theme);
        key = tokens.map(token => fg(token)).join("|");
        if (last?.source === input.source && last.palette === key && last.width === input.width && last.raw === raw) return last.result;
        if (styles && (styles.source !== input.source || styles.palette !== key)) clear();
        const plan = commandPreviewPlan(input.source, input.width);
        if (!plan.spans || plan.text !== stripTerminalSequences(raw)) { clear(); return remember(input, key, raw, raw); }
        if (plan.spans.some(span => typeof span.origin === "number") && !styles) {
          styles = { source: input.source, palette: key, runs: colorRuns(input.source, highlight(input.source)) };
        }
        return remember(input, key, raw, projectColors(input.source, plan, styles?.runs ?? [], fg("muted")));
      } catch {
        clear();
        return remember(input, key, raw, raw);
      }
    },
  };
}
