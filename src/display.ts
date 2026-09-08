/** Display-only targets and bounded summary rows; native inputs are never mutated or executed. */

import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { FileRead } from "./read-body.js";
import type { SummaryMetrics } from "./tool-metrics.js";
import type { EditDelta } from "./edit-delta.js";
import { fileMutationPath, type FileMutation } from "./file-mutation.js";
import { commandPreview, type CommandPreviewMode } from "./command-preview.js";
import { pathPreview } from "./path-preview.js";

export interface CommandSpan {
  readonly source: string;
  readonly width: number;
  readonly offset: number;
  readonly length: number;
}

export interface DisplayLimits {
  rowMaxWidth: number;
  commandMaxWidth: number;
  intentMaxWidth: number;
  commandPreview: CommandPreviewMode;
}
export const DEFAULT_DISPLAY_LIMITS: Readonly<DisplayLimits> = { rowMaxWidth: 120, commandMaxWidth: 120, intentMaxWidth: 48, commandPreview: "compact" };
export interface RowLayout {
  limits?: Readonly<Partial<DisplayLimits>>;
  width?: number;
}

export type DisplayTarget =
  | Readonly<{ kind: "path"; path: string }>
  | Readonly<{ kind: "query"; query: string }>
  | Readonly<{ kind: "command"; command: string; shell?: "powershell" }>;

export interface ToolDisplay {
  readonly action: string;
  readonly target: DisplayTarget;
}

const MAX_TARGET_WIDTH = 120;

function compactHome(p: string): string {
  const home = process.env["HOME"];
  if (typeof home === "string" && home.length > 0 &&
    (p === home || p.startsWith(home + "/") || (process.platform === "win32" && p.startsWith(home + "\\")))) {
    return "~" + p.slice(home.length);
  }
  return p;
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function optString(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  return typeof value === "string" ? value : undefined;
}

function readDisplay(args: unknown): ToolDisplay | null {
  const fields = record(args);
  const path = fields === null ? undefined : optString(fields, "path");
  if (path === undefined) return null;
  return { action: "Read", target: { kind: "path", path: compactHome(path) } };
}

function firstLineOf(text: string): string {
  return text.split("\n")[0] ?? "";
}

function bashDisplay(args: unknown, shell: "bash" | "powershell" = "bash"): ToolDisplay | null {
  const fields = record(args);
  const command = fields === null ? undefined : optString(fields, "command");
  if (command === undefined) return null;
  if (firstLineOf(command).trim().length === 0) return null;
  return { action: "Run", target: { kind: "command", command, ...(shell === "powershell" ? { shell } : {}) } };
}

function grepDisplay(args: unknown): ToolDisplay | null {
  const fields = record(args);
  const pattern = fields === null ? undefined : optString(fields, "pattern");
  if (pattern === undefined) return null;
  return { action: "Search", target: { kind: "query", query: pattern } };
}

function findDisplay(args: unknown): ToolDisplay | null {
  const fields = record(args);
  const pattern = fields === null ? undefined : optString(fields, "pattern");
  if (pattern === undefined) return null;
  return { action: "Find", target: { kind: "query", query: pattern } };
}

function lsDisplay(args: unknown): ToolDisplay | null {
  const fields = record(args);
  if (fields === null) return null;
  const path = optString(fields, "path") ?? ".";
  return { action: "List", target: { kind: "path", path: compactHome(path) } };
}

/**
 * Derive file-mutation display from capability, otherwise legacy built-in display.
 * Returns null on argument mismatch; the caller renders the
 * safe generic line instead. Never throws.
 */
export function displayFor(toolName: unknown, args: unknown, capability?: FileMutation, reader?: FileRead): ToolDisplay | null {
  try {
    if (capability) {
      const path = fileMutationPath(capability, args);
      return path === undefined ? null : { action: capability.action, target: { kind: "path", path: compactHome(path) } };
    }
    if (reader) return readDisplay(args);
    switch (toolName) {
      case "read":
        return readDisplay(args);
      case "bash":
        return bashDisplay(args);
      case "powershell":
        return bashDisplay(args, "powershell");
      case "grep":
        return grepDisplay(args);
      case "find":
        return findDisplay(args);
      case "ls":
        return lsDisplay(args);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Render the target back to its display text. */
export function targetText(target: DisplayTarget, limits: Readonly<Partial<DisplayLimits>> = DEFAULT_DISPLAY_LIMITS, width = Infinity): string {
  switch (target.kind) {
    case "path":
      return pathPreview(target.path, Math.min(MAX_TARGET_WIDTH, width));
    case "query":
      return clip(`"${clip(target.query, MAX_TARGET_WIDTH)}"`, width);
    case "command":
      return commandPreview(target.command, Math.min(width, limits.commandMaxWidth ?? DEFAULT_DISPLAY_LIMITS.commandMaxWidth), target.shell, limits.commandPreview);
  }
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const blocks: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null) {
      const text = (block as Record<string, unknown>)["text"];
      if (typeof text === "string") blocks.push(text);
    }
  }
  return blocks;
}

export function pluralLines(count: number): string {
  return count === 1 ? "1 line" : `${count} lines`;
}

/** Generic result totals use the first text block, independently of file-body metrics. */
export function countResultLines(content: unknown): number {
  const first = textBlocks(content)[0];
  return first === undefined ? 0 : first.split("\n").length;
}

function unitFor(toolName: unknown): string {
  switch (toolName) {
    case "grep":
    case "find":
      return "matches";
    case "ls":
      return "entries";
    default:
      return "lines";
  }
}

/**
 * Build the one-line summary strings. Running lines end with an ellipsis;
 * settled lines carry the outcome count and error marker. Pure strings: the
 * wiring module wraps them in Pi TUI components with theme colors.
 */
function clip(text: string, width: number): string {
  return truncateToWidth(text.replace(/[\r\n\t]/g, " "), Math.max(0, width), "…");
}

function summaryParts(toolName: string, display: ToolDisplay | null, outcome: string, streaming: boolean,
  intent: string | null | undefined, layout: RowLayout, delta?: EditDelta): LineParts {
  const limits = { ...DEFAULT_DISPLAY_LIMITS, ...layout.limits };
  const width = Math.min(layout.width ?? limits.rowMaxWidth, limits.rowMaxWidth);
  const action = display?.action ?? toolName;
  const ending = streaming ? "…" : "";
  const remaining = Math.max(0, width - visibleWidth(`▸ ${action}${outcome}${ending}`));
  const target = display ? targetText(display.target, limits) : "";
  const targetReserve = target ? Math.min(visibleWidth(target) + 1, Math.ceil(remaining / 2)) : 0;
  const purpose = intent?.trim();
  const intentBudget = Math.max(0, Math.min(limits.intentMaxWidth, remaining - targetReserve - 3));
  const shownIntent = purpose && intentBudget > 0 ? clip(purpose, intentBudget) : "";
  const tail = shownIntent && stripTerminalSequences(shownIntent) !== "…" ? ` — ${shownIntent}` : "";
  const targetBudget = Math.max(0, remaining - visibleWidth(tail) - 1);
  const shownTarget = display && targetBudget > 0 ? targetText(display.target, limits, targetBudget) : "";
  const head = shownTarget ? ` ${shownTarget}` : "";
  return { marker: "▸", action, rest: `${head}${outcome}${tail}${ending}`,
    ...(shownTarget && display?.target.kind === "command" && display.target.shell !== "powershell" && limits.commandPreview === "compact"
      ? { command: { source: display.target.command, width: Math.min(targetBudget, limits.commandMaxWidth), offset: 1, length: shownTarget.length } } : {}),
    ...(tail ? { intent: { offset: head.length + outcome.length, length: tail.length } } : {}),
    ...(delta ? { change: { ...delta, offset: head.length } } : {}) };
}

export function runningLine(
  toolName: string,
  display: ToolDisplay | null,
  intent?: string | null,
  layout: RowLayout = {},
): LineParts {
  return summaryParts(toolName, display, "", true, intent, layout);
}

export interface SettledLineInput {
  readonly toolName: string;
  readonly display: ToolDisplay | null;
  readonly content: unknown;
  readonly isError: boolean;
  readonly intent?: string | null | undefined;
  readonly layout?: RowLayout;
  readonly metrics: SummaryMetrics;
}

export function settledLine({
  toolName, display, content, isError, intent, layout = {}, metrics,
}: SettledLineInput): LineParts {
  if (metrics.read.kind !== "not-applicable") {
    const outcome = isError ? "— error" : metrics.read.kind === "known"
      ? `(${pluralLines(metrics.read.value.lines)})` : "(lines unknown)";
    return summaryParts(toolName, display, ` ${outcome}`, false, intent, layout);
  }
  if (metrics.written.kind !== "not-applicable") {
    const outcome = isError ? " — error" : metrics.written.kind === "known"
      ? ` (${pluralLines(metrics.written.value)})` : "";
    return summaryParts(toolName, display, outcome, false, intent, layout);
  }
  const delta = metrics.patch.kind === "known" ? metrics.patch.value : undefined;
  if (!delta && toolName === "bash" && display?.action !== "Write" && display?.action !== "Edit") {
    return summaryParts(toolName, display, isError ? " — error" : "", false, intent, layout);
  }
  if (!delta && (display?.action === "Write" || display?.action === "Edit" || toolName === "write" || toolName === "edit")) {
    return summaryParts(toolName, display, isError ? " — error" : "", false, intent, layout);
  }
  const lines = countResultLines(content);
  const unit = unitFor(toolName);
  const outcome = delta && !isError ? changeText(delta) : isError
    ? `— error (${pluralLines(lines)})`
    : unit === "lines"
      ? `(${pluralLines(lines)})`
      : `(${lines} ${unit})`;
  return summaryParts(toolName, display, ` ${outcome}`, false, intent, layout, isError ? undefined : delta);
}

export type CountedChange = EditDelta & (
  Readonly<{ counted: number; total: number }> | Readonly<{ counted?: never; total?: never }>
);

export function failureText(count: number): string { return `${count} failed`; }

export function changeText(change: CountedChange, format: (kind: "toolDiffAdded" | "toolDiffRemoved", text: string) => string = (_kind, text) => text): string {
  const coverage = change.counted !== undefined && change.counted !== change.total ? `partial ${change.counted}/${change.total}: ` : "";
  return `(${coverage}${format("toolDiffAdded", `+${change.added}`)} ${format("toolDiffRemoved", `-${change.removed}`)})`;
}

/** Action and derived outcome offsets stay addressable for styling without searching text. */
export interface LineParts {
  readonly marker: string;
  readonly action: string;
  /** Everything after the action, leading space included (or "" / "…"). */
  readonly rest: string;
  readonly command?: CommandSpan;
  readonly intent?: Readonly<{ offset: number; length: number }>;
  readonly change?: CountedChange & { offset: number };
  readonly failure?: Readonly<{ count: number; offset: number }>;
}

export function joinLine(parts: LineParts): string {
  return `${parts.marker} ${parts.action}${parts.rest}`;
}

/** Join text blocks; native expanded rendering does not use this helper. */
export function resultBody(content: unknown): string {
  return textBlocks(content).join("\n");
}
