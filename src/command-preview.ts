import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type CommandPreviewMode = "compact" | "raw";

type Operator = "|" | "&&" | "||" | ";";
type Stage = { kind: "command"; before: Operator | undefined; words: string[] }
  | { kind: "tail"; before: Operator | undefined; source: string };
const reserved = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "time", "coproc", "!", "[[", "]]"]);
const subcommands = new Set(["git", "npm", "pnpm", "yarn", "bun", "uv", "pip", "cargo", "go", "docker", "kubectl", "kata"]);
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
const clip = (text: string, width: number) => truncateToWidth(text, Math.max(0, width), "…");

/** Find only simple substitution boundaries; contents never become outer command stages. */
function substitutionEnd(source: string, start: number, depth = 1): number | undefined {
  if (depth > 8) return undefined;
  let quote: "'" | '"' | undefined, word = "";
  for (let i = start + 2; i < source.length; i++) {
    const char = source[i]!;
    if (char === "\\" && quote !== "'") {
      if (i + 1 === source.length) return undefined;
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
function stages(command: string): Stage[] | undefined {
  if (command.length > 16384 || /[\r\n\x00-\x08\x0b-\x1f\x7f]/.test(command)) return undefined;
  const result: Stage[] = [];
  let words: string[] = [], word = "", before: Operator | undefined, start = 0;
  let quote: "'" | '"' | undefined, executable: string | undefined;
  const flush = () => {
    if (word) {
      words.push(word);
      if (!executable && !assignment.test(word)) executable = word;
      word = "";
    }
  };
  const tail = (): Stage[] | undefined => result.length && result.length < 64
    ? [...result, { kind: "tail", before, source: command.slice(start).replace(/^[ \t]+/, "") }] : undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === "\\" && quote !== "'") {
      if (i + 1 === command.length) return tail();
      word += char + command[++i]!; continue;
    }
    if (quote === "'") { word += char; if (char === quote) quote = undefined; continue; }
    if (char === "`") return tail();
    if (char === "$" && command[i + 1] === "(") {
      const end = substitutionEnd(command, i);
      if (end === undefined) return tail();
      word += "$(…)"; i = end; continue;
    }
    if (char === "$" && /[\[{'"]/.test(command[i + 1] ?? "")) return tail();
    if (quote) { word += char; if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === '"') { quote = char; word += char; continue; }
    if ("(){}".includes(char) || (char === "#" && !word)) return tail();
    if (char === "<" || char === ">") {
      const next = command[i + 1];
      if (next === "(" || next === "&" || next === "|" || (char === "<" && (next === "<" || next === ">"))) return tail();
      if (!/^\d+$/.test(word)) flush();
      if (!executable) return tail();
      if (words.length > 256) return undefined;
      word += char;
      if (char === ">" && next === ">") { word += next; i++; }
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
      if (char === "&") { if (command[i + 1] !== "&") return tail(); operator = "&&"; i++; }
      else if (char === "|" && command[i + 1] === "&") return tail();
      else if (char === "|" && command[i + 1] === "|") { operator = "||"; i++; }
      else operator = char as "|" | ";";
      result.push({ kind: "command", before, words });
      words = []; executable = undefined; before = operator; start = i + 1;
    } else word += char;
  }
  if (quote) return tail();
  flush();
  if (words.length > 256 || result.length >= 64) return undefined;
  if (!words.length) return undefined;
  if (reserved.has(executable ?? "") || !executable) return tail();
  result.push({ kind: "command", before, words });
  return result;
}

/** Lossy token-local heuristic, not filesystem identity or command-argument validation. */
function compactPath(token: string): string {
  const option = /^(--?[A-Za-z][A-Za-z0-9_-]*=)(.+)$/.exec(token);
  const prefix = option?.[1] ?? "", value = option?.[2] ?? token;
  const quote = value[0] === "'" || value[0] === '"' ? value[0] : "";
  const path = quote && value.at(-1) === quote ? value.slice(1, -1) : value;
  if (/[\\'"$`*?\[\]:]/.test(path)) return token;
  const explicit = /^(?:\/|~\/|\.\.?\/)/.test(path);
  const relative = /^(?:[\p{L}\p{N}_.-]+\/){3,}[\p{L}\p{N}_.-]+$/u.test(path);
  if (!explicit && !relative) return token;
  const pieces = path.split("/");
  if (pieces.length < 4 || !pieces.at(-1) || pieces.includes("..")) return token;
  const shortened = `…/${pieces.at(-1)}`;
  return visibleWidth(shortened) < visibleWidth(path) ? `${prefix}${quote}${shortened}${quote}` : token;
}

function stageText(stage: Stage): { head: string; full: string } | undefined {
  if (stage.kind === "tail") {
    const name = /^([A-Za-z_][A-Za-z0-9_.-]*)(?=[ \t]|$)/.exec(stage.source)?.[1];
    const text = name ? `${clip(name, 20)} […]` : "[…]";
    return { head: text, full: text };
  }
  let index = 0;
  while (assignment.test(stage.words[index] ?? "")) index++;
  const executable = stage.words[index];
  if (!executable || reserved.has(executable)) return undefined;
  const tokens = stage.words.slice(index).map(compactPath);
  let head = tokens[0]!;
  if (subcommands.has(executable) && /^[A-Za-z][A-Za-z0-9_-]*$/.test(tokens[1] ?? "")) head += ` ${tokens[1]}`;
  const prefix = index ? "[env] " : "";
  return { head: prefix + head, full: prefix + tokens.join(" ") };
}

/** Compact prioritizes command heads; Raw retains the width-bounded first-line fallback. */
export function commandPreview(command: string, width: number, shell: "bash" | "powershell" = "bash", mode: CommandPreviewMode = "compact"): string {
  const firstLine = command.slice(0, command.indexOf("\n") < 0 ? command.length : command.indexOf("\n")).replace(/[\r\t]/g, " ");
  const fallback = () => clip(firstLine, width);
  if (mode === "raw" || shell !== "bash" || visibleWidth(firstLine) <= width && !command.includes("\n")) return fallback();
  const parsed = stages(command);
  if (!parsed) return fallback();
  const descriptions = parsed.map(stageText);
  if (descriptions.some((value) => !value)) return fallback();
  const parts = descriptions.map((value, i) => ({ ...value!, separator: i ? ` ${parsed[i]!.before} ` : "" }));
  let count = parts.length;
  let marker = "";
  const minimum = (n: number) => parts.slice(0, n).reduce((sum, part) => sum + visibleWidth(part.separator) + Math.min(24, visibleWidth(part.head)), 0);
  while (count > 1 && minimum(count) + visibleWidth(marker) > width) {
    count--;
    const tail = parsed.at(-1)?.kind === "tail";
    marker = tail ? " [more]" : ` [+${parts.length - count}]`;
  }
  if (minimum(count) + visibleWidth(marker) > width) {
    if (visibleWidth(marker) + 1 > width) return clip(parts[0]!.head, width);
    return clip(parts[0]!.head, width - visibleWidth(marker)) + marker;
  }
  const shown = parts.slice(0, count);
  const budgets = shown.map((part) => Math.min(24, visibleWidth(part.head)));
  let extra = width - minimum(count) - visibleWidth(marker);
  // Finish short stages before creating more fragments of long arguments.
  const finishOrder = shown.map((part, i) => ({ i, needed: visibleWidth(part.full) - budgets[i]! })).sort((a, b) => a.needed - b.needed);
  for (const { i, needed } of finishOrder) {
    if (needed > extra) break;
    budgets[i] = budgets[i]! + needed; extra -= needed;
  }
  while (extra > 0) {
    const hungry = shown.map((part, i) => visibleWidth(part.full) > budgets[i]! ? i : -1).filter((i) => i >= 0);
    if (!hungry.length) break;
    const share = Math.max(1, Math.floor(extra / hungry.length));
    for (const i of hungry) {
      const add = Math.min(share, extra, visibleWidth(shown[i]!.full) - budgets[i]!);
      budgets[i] = budgets[i]! + add; extra -= add;
    }
  }
  return shown.map((part, i) => {
    const budget = budgets[i]!;
    const headWidth = visibleWidth(part.head);
    const detailWidth = budget - headWidth;
    const detail = part.full.slice(part.head.length);
    const fragment = detailWidth <= 3 && visibleWidth(detail) > detailWidth ? " …" : detail;
    const text = budget < headWidth ? clip(part.head, budget)
      : part.head + clip(fragment, detailWidth);
    return part.separator + text;
  }).join("") + marker;
}
