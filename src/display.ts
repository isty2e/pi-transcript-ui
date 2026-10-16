/** Display-only targets and bounded summary rows; native inputs are never mutated or executed. */

import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { FileRead } from "./read-body.js";
import type { SummaryMetrics } from "./tool-metrics.js";
import type { EditDelta } from "./edit-delta.js";
import { fileMutationPath, type FileMutation } from "./file-mutation.js";
import { commandPreview, type CommandPreviewMode } from "./command-preview.js";
import { pathPreview } from "./path-preview.js";
import type { PatchRequest } from "./patch-request.js";
import type { CodemodeSummary } from "./codemode-summary.js";
import type { ShellSessionSummary } from "./shell-session-summary.js";

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
  toolDuration: boolean;
}
export const DEFAULT_DISPLAY_LIMITS: Readonly<DisplayLimits> = { rowMaxWidth: 120, commandMaxWidth: 120, intentMaxWidth: 48, commandPreview: "compact", toolDuration: true };
export interface RowLayout {
  limits?: Readonly<Partial<DisplayLimits>>;
  width?: number;
}
interface ToolSummaryContext {
  readonly intent?: string | null | undefined;
  readonly layout?: RowLayout;
  readonly durationMs?: number | undefined;
}

export type DisplayTarget =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "path"; path: string }>
  | Readonly<{ kind: "query"; query: string }>
  | Readonly<{ kind: "command"; command: string; shell?: "powershell" }>
  | Readonly<{ kind: "opaque-command"; command: string }>
  | Readonly<{ kind: "patch-request"; request: PatchRequest }>
  | Readonly<{ kind: "nested-calls"; calls: CodemodeSummary["calls"] }>;

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
 * Prefer recognized file and patch inputs, otherwise legacy built-in display.
 * Returns null on argument mismatch; the caller renders the
 * safe generic line instead. Never throws.
 */
export function displayFor(toolName: unknown, args: unknown, capability?: FileMutation, reader?: FileRead, patch?: PatchRequest): ToolDisplay | null {
  try {
    if (capability) {
      const path = fileMutationPath(capability, args);
      return path === undefined ? null : { action: capability.action, target: { kind: "path", path: compactHome(path) } };
    }
    if (reader) return readDisplay(args);
    if (patch) return { action: "Patch", target: { kind: "patch-request", request: patch } };
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
    case "none":
      return "";
    case "path":
      return pathPreview(target.path, Math.min(MAX_TARGET_WIDTH, width));
    case "patch-request": {
      const { targets } = target.request;
      if (targets.length !== 1) return clip(`${targets.length} targets`, width);
      const entry = targets[0]!;
      const available = Math.min(MAX_TARGET_WIDTH, width);
      if (entry.kind !== "update" || entry.moveTo === undefined) return pathPreview(compactHome(entry.path), available);
      const half = Math.max(0, Math.floor((available - 3) / 2));
      return clip(`${pathPreview(compactHome(entry.path), half)} → ${pathPreview(compactHome(entry.moveTo), half)}`, available);
    }
    case "query":
      return clip(`"${clip(target.query, MAX_TARGET_WIDTH)}"`, width);
    case "nested-calls": {
      if (!target.calls) return "";
      const names = target.calls.names.map(({ name, count }) => {
        const label = clip(stripTerminalSequences(name).replace(/[\u0000-\u001f\u007f-\u009f]/g, " "), 24);
        return `${label}${count > 1 ? ` ×${count}` : ""}`;
      });
      if (target.calls.moreNames) names.push("…");
      return clip(names.join(", "), Math.min(MAX_TARGET_WIDTH, width));
    }
    case "opaque-command":
      return commandPreview(target.command, Math.min(width, limits.commandMaxWidth ?? DEFAULT_DISPLAY_LIMITS.commandMaxWidth),
        undefined, "raw");
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
  { intent, layout = {}, durationMs }: ToolSummaryContext, delta?: EditDelta): LineParts {
  const limits = { ...DEFAULT_DISPLAY_LIMITS, ...layout.limits };
  const width = Math.min(layout.width ?? limits.rowMaxWidth, limits.rowMaxWidth);
  const action = display?.action ?? toolName;
  const ending = streaming ? "…" : "";
  const duration = !streaming && limits.toolDuration && durationMs !== undefined ? toolDurationText(durationMs) : undefined;
  const timing = duration !== undefined && visibleWidth(`▸ ${action}${outcome} (${duration})${ending}`) <= width
    ? ` (${duration})` : "";
  const shownOutcome = outcome + timing;
  const remaining = Math.max(0, width - visibleWidth(`▸ ${action}${shownOutcome}${ending}`));
  const target = display ? targetText(display.target, limits) : "";
  const targetReserve = target ? Math.min(visibleWidth(target) + 1, Math.ceil(remaining / 2)) : 0;
  const purpose = intent?.trim();
  const intentBudget = Math.max(0, Math.min(limits.intentMaxWidth, remaining - targetReserve - 3));
  const shownIntent = purpose && intentBudget > 0 ? clip(purpose, intentBudget) : "";
  const tail = shownIntent && stripTerminalSequences(shownIntent) !== "…" ? ` — ${shownIntent}` : "";
  const targetBudget = Math.max(0, remaining - visibleWidth(tail) - 1);
  const shownTarget = display && targetBudget > 0 ? targetText(display.target, limits, targetBudget) : "";
  const head = shownTarget ? ` ${shownTarget}` : "";
  return { marker: "▸", action, rest: `${head}${shownOutcome}${tail}${ending}`,
    ...(shownTarget && display?.target.kind === "command" && display.target.shell === undefined && limits.commandPreview === "compact"
      ? { command: { source: display.target.command, width: Math.min(targetBudget, limits.commandMaxWidth), offset: 1, length: shownTarget.length } } : {}),
    ...(tail ? { intent: { offset: head.length + shownOutcome.length, length: tail.length } } : {}),
    ...(delta ? { change: { ...delta, offset: head.length } } : {}) };
}

export function runningLine(
  toolName: string,
  display: ToolDisplay | null,
  intent?: string | null,
  layout: RowLayout = {},
): LineParts {
  const outcome = display?.target.kind === "patch-request" ? ` ${requestedPatchText(display.target.request.delta)}` : "";
  return summaryParts(toolName, display, outcome, true, { intent, layout });
}

export function shellSessionLine(summary: ShellSessionSummary, isError: boolean, isPartial: boolean,
  context: ToolSummaryContext = {}): LineParts {
  const outcome = `${isError ? " — error" : ""}${summary.exitCode === undefined ? "" : ` (exit ${summary.exitCode})`}`;
  return summaryParts(summary.action, { action: summary.action, target: summary.action === "Run"
    ? { kind: summary.commandSyntax === "bash" ? "command" : "opaque-command", command: summary.command }
    : { kind: "none" } }, outcome, isPartial, context);
}

function toolDurationText(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return minutes < 60 ? `${minutes}m ${remainder}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

export function codemodeLine({ summary, isError, ...context }: {
  readonly summary: CodemodeSummary;
  readonly isError: boolean;
} & ToolSummaryContext): LineParts {
  const facts: string[] = [];
  if (summary.calls) {
    const { total, running, errors, cancelled } = summary.calls;
    facts.push(`${total} nested ${total === 1 ? "call" : "calls"}${summary.isPartial ? " so far" : ""}`);
    if (running) facts.push(`${running} running`);
    if (errors) facts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
    if (cancelled) facts.push(`${cancelled} cancelled`);
  }
  const outcome = `${isError ? " — error" : ""}${facts.length ? ` (${facts.join("; ")})` : ""}`;
  return summaryParts("codemode", { action: "Code", target: { kind: "nested-calls", calls: summary.calls } },
    outcome, summary.isPartial, context);
}

export interface SettledLineInput extends ToolSummaryContext {
  readonly toolName: string;
  readonly display: ToolDisplay | null;
  readonly content: unknown;
  readonly isError: boolean;
  readonly metrics: SummaryMetrics;
}

export function settledLine({
  toolName, display, content, isError, metrics, ...context
}: SettledLineInput): LineParts {
  if (display?.target.kind === "patch-request") {
    const outcome = `${isError ? " — error" : ""} ${requestedPatchText(display.target.request.delta)}`;
    return summaryParts(toolName, display, outcome, false, context);
  }
  if (metrics.read.kind !== "not-applicable") {
    const outcome = isError ? "— error" : metrics.read.kind === "known"
      ? `(${pluralLines(metrics.read.value.lines)})` : "(lines unknown)";
    return summaryParts(toolName, display, ` ${outcome}`, false, context);
  }
  if (metrics.written.kind !== "not-applicable") {
    const outcome = isError ? " — error" : metrics.written.kind === "known"
      ? ` (${pluralLines(metrics.written.value)})` : "";
    return summaryParts(toolName, display, outcome, false, context);
  }
  const delta = metrics.patch.kind === "known" ? metrics.patch.value : undefined;
  if (!delta && toolName === "bash" && display?.action !== "Write" && display?.action !== "Edit") {
    return summaryParts(toolName, display, isError ? " — error" : "", false, context);
  }
  if (!delta && (display?.action === "Write" || display?.action === "Edit" || toolName === "write" || toolName === "edit")) {
    return summaryParts(toolName, display, isError ? " — error" : "", false, context);
  }
  const lines = countResultLines(content);
  const unit = unitFor(toolName);
  const outcome = delta && !isError ? changeText(delta) : isError
    ? `— error (${pluralLines(lines)})`
    : unit === "lines"
      ? `(${pluralLines(lines)})`
      : `(${lines} ${unit})`;
  return summaryParts(toolName, display, ` ${outcome}`, false, context, isError ? undefined : delta);
}

export type CountedChange = EditDelta & (
  Readonly<{ counted: number; total: number }> | Readonly<{ counted?: never; total?: never }>
);

export function failureText(count: number): string { return `${count} failed`; }

export function requestedPatchText(delta: EditDelta | undefined, targets?: number): string {
  const count = targets === undefined ? "" : ` ${targets} ${targets === 1 ? "target" : "targets"}`;
  const changes = delta ? `${count ? ":" : ""} +${delta.added} -${delta.removed}` : "";
  return `(requested${count}${changes})`;
}

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
