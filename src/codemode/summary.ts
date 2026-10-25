import { isRecord } from "../intent.js";
import type { ToolPhase } from "../tool-phase.js";
import { activityRecords, type ActivityRecord } from "./model.js";

export interface CodemodeSummary {
  readonly phase: ToolPhase;
  readonly calls: Readonly<{
    total: number;
    running: number;
    errors: number;
    cancelled: number;
    names: readonly Readonly<{ name: string; count: number }>[];
    moreNames: boolean;
  }> | undefined;
}

function nestedCalls(records: readonly ActivityRecord[] | undefined): CodemodeSummary["calls"] {
  if (!records) return undefined;
  const names = new Map<string, number>();
  let running = 0, errors = 0, cancelled = 0, moreNames = false;

  for (const call of records) {
    switch (call.status) {
      case "running": running++; break;
      case "error": errors++; break;
      case "cancelled": cancelled++; break;
      case "ok": break;
      default: return undefined;
    }

    // Bound the name preview, not the observed call/status totals.
    if (names.has(call.name) || names.size < 3) names.set(call.name, (names.get(call.name) ?? 0) + 1);
    else moreNames = true;
  }

  return { total: records.length, running, errors, cancelled,
    names: [...names].map(([name, count]) => ({ name, count })), moreNames };
}

export function summarizeActivity(records: readonly ActivityRecord[] | undefined, phase: ToolPhase): CodemodeSummary {
  return { phase, calls: nestedCalls(records) };
}

/** Project Pi's recorded codemode facts without interpreting the script or result text. */
export function codemodeSummary({ toolName, args, result, phase }: {
  readonly toolName: string;
  readonly args: unknown;
  readonly result: unknown;
  readonly phase: ToolPhase;
}): CodemodeSummary | undefined {
  try {
    if (toolName !== "codemode" || !isRecord(args) || typeof args.code !== "string") return undefined;
    const details = isRecord(result) && isRecord(result.details) ? result.details : undefined;
    return summarizeActivity(activityRecords(details?.calls), phase);
  } catch { return undefined; }
}
