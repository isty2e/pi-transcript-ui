import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type CommandPreviewMode = "compact" | "raw";
export const COMMAND_SOURCE_LIMIT = 16384;

interface PreviewSpan { start: number; end: number; origin: number | "marker" }
export interface CommandPreviewPlan {
  readonly text: string;
  readonly spans: readonly Readonly<PreviewSpan>[] | undefined;
}

type Operator = "|" | "&&" | "||" | ";" | "\n";
type Before = { operator: Operator; start: number } | undefined;
type Stage = { kind: "command"; before: Before; words: CommandPreviewPlan[] }
  | { kind: "tail"; before: Before; source: string };
const reserved = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "time", "coproc", "!", "[[", "]]"]);
const subcommands = new Set(["git", "npm", "pnpm", "yarn", "bun", "uv", "pip", "cargo", "go", "docker", "kubectl", "kata"]);
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
const widthOf = (value: CommandPreviewPlan) => visibleWidth(value.text);
const plain = (text: string): CommandPreviewPlan => ({ text, spans: undefined });

function appendSpan(spans: PreviewSpan[], start: number, end: number, origin: number | "marker"): void {
  if (start === end) return;
  const last = spans.at(-1);
  if (last && last.end === start && (origin === "marker" ? last.origin === "marker"
    : typeof last.origin === "number" && last.origin + last.end - last.start === origin)) last.end = end;
  else spans.push({ start, end, origin });
}

function literal(text: string, tracing: boolean, origin?: number | "marker"): CommandPreviewPlan {
  return { text, spans: tracing ? origin === undefined || !text ? [] : [{ start: 0, end: text.length, origin }] : undefined };
}

function concat(...values: CommandPreviewPlan[]): CommandPreviewPlan {
  const spans: PreviewSpan[] | undefined = values.every(value => value.spans !== undefined) ? [] : undefined;
  let text = "";
  for (const value of values) {
    if (spans) for (const span of value.spans!) appendSpan(spans, text.length + span.start, text.length + span.end, span.origin);
    text += value.text;
  }
  return { text, spans };
}

function slice(value: CommandPreviewPlan, start: number, end = value.text.length): CommandPreviewPlan {
  const spans = value.spans?.flatMap(span => {
    const left = Math.max(start, span.start), right = Math.min(end, span.end);
    return left < right ? [{ start: left - start, end: right - start,
      origin: typeof span.origin === "number" ? span.origin + left - span.start : span.origin }] : [];
  });
  return { text: value.text.slice(start, end), spans };
}

function clip(value: CommandPreviewPlan, width: number): CommandPreviewPlan {
  const raw = truncateToWidth(value.text, Math.max(0, width), "…");
  if (!value.spans) return plain(raw);
  const text = stripTerminalSequences(raw);
  if (text === value.text) return value;
  if (!text) return literal("", true);
  const length = text.length - 1;
  if (!text.endsWith("…") || text.slice(0, length) !== value.text.slice(0, length)) return plain(text);
  return concat(slice(value, 0, length), literal("…", true, "marker"));
}

/** Find only simple substitution boundaries; contents never become outer command stages. */
function substitutionEnd(source: string, start: number, depth = 1): number | undefined {
  if (depth > 8) return undefined;
  let quote: "'" | '"' | undefined, word = "";
  for (let i = start + 2; i < source.length; i++) {
    const char = source[i]!;
    if (char === "\n") return undefined;
    if (char === "\\" && quote !== "'") {
      if (i + 1 === source.length || source[i + 1] === "\n") return undefined;
      word += source.slice(i, i + 2); i++; continue;
    }
    if (quote === "'") { word += char; if (char === quote) quote = undefined; continue; }
    if (char === "`") return undefined;
    if (char === "$" && source[i + 1] === "(") {
      const end = substitutionEnd(source, i, depth + 1);
      if (end === undefined) return undefined;
      word += source.slice(i, end + 1); i = end; continue;
    }
    if (char === "$" && /[\[{'"]/.test(source[i + 1] ?? "")) return undefined;
    if (quote) { word += char; if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === '"') { quote = char; word += char; continue; }
    if ("(<>{}#".includes(char)) return undefined;
    if (char === ")") return reserved.has(word) ? undefined : i;
    if (/[ \t|&;]/.test(char)) {
      if (reserved.has(word)) return undefined;
      word = "";
    } else word += char;
  }
  return undefined;
}

/** Bounded Bash preview with a known prefix and, at most, one unparsed remainder. */
function stages(command: string, tracing: boolean): Stage[] | undefined {
  if (command.length > COMMAND_SOURCE_LIMIT || /[\r\x00-\x08\x0b-\x1f\x7f]/.test(command)) return undefined;
  const result: Stage[] = [];
  let words: CommandPreviewPlan[] = [], word = "", before: Before, start = 0;
  let wordSpans: PreviewSpan[] | undefined = tracing ? [] : undefined;
  let quote: "'" | '"' | undefined, executable: string | undefined;
  const append = (text: string, origin: number | "marker") => {
    if (wordSpans) appendSpan(wordSpans, word.length, word.length + text.length, origin);
    word += text;
  };
  const flush = () => {
    if (word) {
      words.push({ text: word, spans: wordSpans });
      if (!executable && !assignment.test(word)) executable = word;
      word = ""; wordSpans = tracing ? [] : undefined;
    }
  };
  const tail = (): Stage[] | undefined => (result.length || command.includes("\n")) && result.length < 64
    ? [...result, { kind: "tail", before, source: command.slice(start).replace(/^[ \t]+/, "") }] : undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === "\\" && quote !== "'") {
      if (i + 1 === command.length) return tail();
      if (command[i + 1] === "\n") { i++; continue; }
      append(command.slice(i, i + 2), i); i++; continue;
    }
    if (char === "\n") {
      if (quote) return tail();
      flush();
      if (words.length > 256 || result.length >= 64) return undefined;
      if (words.length) {
        if (!executable || reserved.has(executable)) return tail();
        result.push({ kind: "command", before, words });
        words = []; executable = undefined; before = { operator: "\n", start: i };
      }
      start = i + 1;
      continue;
    }
    if (quote === "'") { append(char, i); if (char === quote) quote = undefined; continue; }
    if (char === "`") return tail();
    if (char === "$" && command[i + 1] === "(") {
      const end = substitutionEnd(command, i);
      if (end === undefined) return tail();
      append("$(…)", "marker"); i = end; continue;
    }
    if (char === "$" && /[\[{'"]/.test(command[i + 1] ?? "")) return tail();
    if (quote) { append(char, i); if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === '"') { quote = char; append(char, i); continue; }
    if ("(){}".includes(char) || (char === "#" && !word)) return tail();
    if (char === "<" || char === ">") {
      const next = command[i + 1];
      if (next === "(" || next === "&" || next === "|" || (char === "<" && (next === "<" || next === ">"))) return tail();
      if (!/^\d+$/.test(word)) flush();
      if (!executable) return tail();
      if (words.length > 256) return undefined;
      append(char, i);
      if (char === ">" && next === ">") { append(next, i + 1); i++; }
      continue;
    }
    if (char === " " || char === "\t") {
      flush();
      if (words.length > 256) return undefined;
      if (reserved.has(executable ?? "")) return tail();
      continue;
    }
    if (char === "|" || char === "&" || char === ";") {
      flush();
      if (words.length > 256 || result.length >= 64) return undefined;
      if (!words.length || reserved.has(executable ?? "")) return tail();
      let operator: Operator;
      const operatorStart = i;
      if (char === "&") { if (command[i + 1] !== "&") return tail(); operator = "&&"; i++; }
      else if (char === "|" && command[i + 1] === "&") return tail();
      else if (char === "|" && command[i + 1] === "|") { operator = "||"; i++; }
      else operator = char as "|" | ";";
      result.push({ kind: "command", before, words });
      words = []; executable = undefined; before = { operator, start: operatorStart }; start = i + 1;
    } else append(char, i);
  }
  if (quote) return tail();
  flush();
  if (words.length > 256 || result.length >= 64) return undefined;
  if (!words.length) return command.includes("\n") && (before?.operator === "\n" || before === undefined) ? result : undefined;
  if (reserved.has(executable ?? "") || !executable) return tail();
  result.push({ kind: "command", before, words });
  return result;
}

/** Lossy token-local heuristic, not filesystem identity or command-argument validation. */
function compactPath(token: CommandPreviewPlan, tracing: boolean): CommandPreviewPlan {
  const option = /^(--?[A-Za-z][A-Za-z0-9_-]*=)(.+)$/.exec(token.text);
  const prefix = option?.[1] ?? "", value = option?.[2] ?? token.text;
  const quote = value[0] === "'" || value[0] === '"' ? value[0] : "";
  const path = quote && value.at(-1) === quote ? value.slice(1, -1) : value;
  if (/[\\'"$`*?\[\]:]/.test(path)) return token;
  const explicit = /^(?:\/|~\/|\.\.?\/)/.test(path);
  const relative = /^(?:[\p{L}\p{N}_.-]+\/){3,}[\p{L}\p{N}_.-]+$/u.test(path);
  if (!explicit && !relative) return token;
  const pieces = path.split("/");
  if (pieces.length < 4 || !pieces.at(-1) || pieces.includes("..")) return token;
  if (visibleWidth(`…/${pieces.at(-1)}`) >= visibleWidth(path)) return token;
  const slash = prefix.length + quote.length + path.lastIndexOf("/");
  return concat(slice(token, 0, prefix.length + quote.length), literal("…", tracing, "marker"), slice(token, slash));
}

function stageText(stage: Stage, tracing: boolean): { head: CommandPreviewPlan; full: CommandPreviewPlan } | undefined {
  if (stage.kind === "tail") {
    const name = /^([A-Za-z_][A-Za-z0-9_.-]*)(?=[ \t\n]|$)/.exec(stage.source)?.[1];
    const text = literal(name ? `${clip(literal(name, tracing), 20).text} […]` : "[…]", tracing);
    return { head: text, full: text };
  }
  let index = 0;
  while (assignment.test(stage.words[index]?.text ?? "")) index++;
  const executable = stage.words[index]?.text;
  if (!executable || reserved.has(executable)) return undefined;
  const tokens = stage.words.slice(index).map(token => compactPath(token, tracing));
  let head = tokens[0]!;
  if (subcommands.has(executable) && /^[A-Za-z][A-Za-z0-9_-]*$/.test(tokens[1]?.text ?? "")) head = concat(head, literal(" ", tracing), tokens[1]!);
  const prefix = literal(index ? "[env] " : "", tracing, "marker");
  return { head: concat(prefix, head), full: concat(prefix, ...tokens.flatMap((token, i) => i ? [literal(" ", tracing), token] : [token])) };
}

function preview(command: string, width: number, shell: "bash" | "powershell", mode: CommandPreviewMode, tracing: boolean): CommandPreviewPlan {
  const newline = command.indexOf("\n");
  const first = command.slice(0, newline < 0 ? command.length : newline);
  let firstLine = plain(first.replace(/[\r\t]/g, " "));
  if (tracing) {
    const spans: PreviewSpan[] = [];
    let start = 0;
    for (const match of first.matchAll(/[\r\t]/g)) { appendSpan(spans, start, match.index, start); start = match.index + 1; }
    appendSpan(spans, start, first.length, start);
    firstLine = { text: firstLine.text, spans };
  }
  const fallback = () => {
    if (newline < 0) return plain(clip(firstLine, width).text);
    const marker = " […]";
    return plain(width <= visibleWidth(marker) ? clip(plain(marker.trimStart()), width).text
      : clip(firstLine, width - visibleWidth(marker)).text + marker);
  };
  if (mode === "raw" || shell !== "bash" || widthOf(firstLine) <= width && newline < 0) return clip(firstLine, width);
  const parsed = stages(command, tracing);
  if (!parsed) return fallback();
  const descriptions = parsed.map(stage => stageText(stage, tracing));
  if (descriptions.some(value => !value)) return fallback();
  const parts = descriptions.map((value, i) => {
    const before = parsed[i]!.before;
    const separator = !i ? literal("", tracing) : before?.operator === "\n" ? literal(" ↵ ", tracing, "marker")
      : concat(literal(" ", tracing), literal(before!.operator, tracing, before!.start), literal(" ", tracing));
    return { ...value!, separator };
  });
  let count = parts.length;
  let marker = literal("", tracing);
  const minimum = (n: number) => parts.slice(0, n).reduce((sum, part) => sum + widthOf(part.separator) + Math.min(24, widthOf(part.head)), 0);
  while (count > 1 && minimum(count) + widthOf(marker) > width) {
    count--;
    marker = literal(parsed.at(-1)?.kind === "tail" ? " [more]" : ` [+${parts.length - count}]`, tracing, "marker");
  }
  if (minimum(count) + widthOf(marker) > width) {
    if (widthOf(marker) + 1 > width) return clip(parts[0]!.head, width);
    return concat(clip(parts[0]!.head, width - widthOf(marker)), marker);
  }
  const shown = parts.slice(0, count);
  const budgets = shown.map(part => Math.min(24, widthOf(part.head)));
  let extra = width - minimum(count) - widthOf(marker);
  // Finish short stages before creating more fragments of long arguments.
  const finishOrder = shown.map((part, i) => ({ i, needed: widthOf(part.full) - budgets[i]! })).sort((a, b) => a.needed - b.needed);
  for (const { i, needed } of finishOrder) {
    if (needed > extra) break;
    budgets[i] = budgets[i]! + needed; extra -= needed;
  }
  while (extra > 0) {
    const hungry = shown.map((part, i) => widthOf(part.full) > budgets[i]! ? i : -1).filter(i => i >= 0);
    if (!hungry.length) break;
    const share = Math.max(1, Math.floor(extra / hungry.length));
    for (const i of hungry) {
      const add = Math.min(share, extra, widthOf(shown[i]!.full) - budgets[i]!);
      budgets[i] = budgets[i]! + add; extra -= add;
    }
  }
  return concat(...shown.map((part, i) => {
    const budget = budgets[i]!, headWidth = widthOf(part.head), detailWidth = budget - headWidth;
    const detail = slice(part.full, part.head.text.length);
    const fragment = detailWidth <= 3 && widthOf(detail) > detailWidth ? literal(" …", tracing, "marker") : detail;
    const text = budget < headWidth ? clip(part.head, budget) : concat(part.head, clip(fragment, detailWidth));
    return concat(part.separator, text);
  }), marker);
}

/** Compact prioritizes command heads; Raw retains the width-bounded first-line fallback. */
export function commandPreview(command: string, width: number, shell: "bash" | "powershell" = "bash", mode: CommandPreviewMode = "compact"): string {
  return preview(command, width, shell, mode, false).text;
}

/** Optional source spans share the plain preview's scanner and allocation rules. */
export function commandPreviewPlan(command: string, width: number): CommandPreviewPlan {
  const tracing = command.length <= COMMAND_SOURCE_LIMIT && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(command);
  return preview(command, width, "bash", "compact", tracing);
}
