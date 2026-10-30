import { isRecord } from "./intent.js";
import type { ToolClassification } from "./classify.js";
import { displayFor, recordedActivityLine, requestOnlyLine, runningLine, settledLine, shellSessionDisplay,
  type LineParts, type ToolDisplay, type RowLayout } from "./display.js";
import { summaryMetrics, type FileCapabilities, type SummaryMetrics } from "./tool-metrics.js";
import { requestedWrittenLineCount } from "./file-mutation.js";
import { shellSessionSummary, type ShellSessionSummary } from "./shell-session-summary.js";
import type { ToolPhase } from "./tool-phase.js";

export interface SummaryRequest {
  readonly args: unknown;
  readonly complete: boolean;
  readonly source: "live" | "recorded" | "preview";
}
export type SummaryStatus = "running" | "ok" | "error" | "cancelled" | "unknown";
export interface SummaryResult { readonly content?: unknown; readonly details?: unknown; readonly isError?: boolean; readonly durationMs?: unknown }
interface SummaryInput {
  readonly toolName: string;
  readonly request: SummaryRequest | undefined;
  readonly result: SummaryResult | undefined;
  readonly lifecycle: Readonly<{kind: "native"; phase: ToolPhase}> | Readonly<{kind: "activity"; status: Exclude<SummaryStatus, "unknown">; parentFinal: boolean}>;
  readonly parameters: unknown;
  readonly classification: ToolClassification;
  readonly capabilities: FileCapabilities;
  readonly preview?: string | undefined;
  readonly declaredAction?: ToolDisplay["action"] | undefined;
}
export interface ToolSummary {
  readonly toolName: string;
  readonly display: ToolDisplay | null;
  readonly metrics: SummaryMetrics;
  readonly shell: ShellSessionSummary | undefined;
  readonly phase: ToolPhase;
  readonly status: SummaryStatus;
  readonly result: SummaryResult | undefined;
  readonly requestedExtent: string | undefined;
  readonly requestedLines: number | undefined;
  readonly preview: string | undefined;
  readonly declaredAction: ToolDisplay["action"] | undefined;
}

function requestedExtent(request: SummaryRequest | undefined): string | undefined {
  if (!request || !isRecord(request.args)) return undefined;
  const args = request.args;
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

  const explicitStart = valid(args.offset) ? Math.max(1, args.offset) : undefined;
  const limit = valid(args.limit) ? args.limit : undefined;
  const start = explicitStart ?? (request.complete && !Object.hasOwn(args, "offset") && limit !== undefined ? 1 : undefined);

  if (limit === 0) return "requested 0 lines";
  if (start !== undefined && limit !== undefined && Number.isSafeInteger(start + limit - 1)) return `requested lines ${start}–${start + limit - 1}`;
  if (start !== undefined) return `requested from line ${start}${limit === undefined ? "" : `; up to ${limit} lines`}`;
  return limit === undefined ? undefined : `requested up to ${limit} lines`;
}

/** Interpret one selected request and independently supplied outcome; a body is not summary authority. */
export function interpretToolSummary(input: SummaryInput): ToolSummary {
  const {toolName, request, result, lifecycle, parameters, classification, capabilities, preview} = input;
  const completionUnknown = lifecycle.kind === "activity" && lifecycle.status === "running" && lifecycle.parentFinal && !result;
  const phase = lifecycle.kind === "native" ? lifecycle.phase : result || lifecycle.parentFinal || lifecycle.status !== "running" ? "settled" : "running";
  let status: SummaryStatus;
  if (lifecycle.kind === "native") status = result?.isError === true ? "error" : phase === "settled" ? "ok" : "running";
  else if (completionUnknown) status = "unknown";
  else if (lifecycle.status === "cancelled") status = "cancelled";
  else status = result ? result.isError === true ? "error" : "ok" : lifecycle.status;

  const args = request?.args;
  let display = displayFor(toolName, args, capabilities.mutation, capabilities.read, capabilities.patch);
  if (!display && request && isRecord(args) && (capabilities.mutation || capabilities.read)) {
    display = {action: capabilities.mutation?.action ?? "Read", target: {kind: "none"}};
  }
  if (toolName === "ls" && request?.complete === false && isRecord(args) && !Object.hasOwn(args, "path")) {
    display = {action: "List", target: {kind: "none"}};
  }

  const shell = capabilities.mutation || capabilities.read || capabilities.patch ? undefined
    : shellSessionSummary({toolName, parameters, args, result, isPartial: phase !== "settled", completeRequest: request?.complete ?? false});
  if (shell) display = shellSessionDisplay(shell);

  return {toolName, display, shell, phase, status, result, preview, declaredAction: input.declaredAction,
    metrics: summaryMetrics({toolName, args, result, isPartial: phase !== "settled", classification, capabilities}),
    requestedExtent: !result && phase === "settled" && display?.action === "Read" ? requestedExtent(request) : undefined,
    requestedLines: !result && phase === "settled" ? requestedWrittenLineCount(capabilities.mutation, args) : undefined};
}

export function toolSummaryLine(summary: ToolSummary, context: {intent?: string | null | undefined; layout?: RowLayout; durationMs?: number | undefined} = {}): LineParts {
  const {toolName, display, shell, phase, status, result, metrics} = summary;
  const isError = status === "error";
  if (phase !== "settled") return shell ? requestOnlyLine({toolName, display, status, phase, ...context})
    : runningLine(toolName, display, context.intent, context.layout, phase);

  if (result && status !== "cancelled" && status !== "unknown") {
    if (shell) return requestOnlyLine({toolName, display, status, phase, exitCode: shell.exitCode, ...context});
    return settledLine({toolName, display, content: result.content, isError, metrics, ...context});
  }

  if (!display) return recordedActivityLine(toolName, summary.preview, status, context.layout ?? {}, context.durationMs, summary.declaredAction);
  return requestOnlyLine({toolName, display, status, phase, requestedExtent: summary.requestedExtent,
    requestedLines: summary.requestedLines, ...context});
}
