import { isRecord } from "./intent.js";

export interface CodemodeSummary {
  readonly isPartial: boolean;
  readonly calls: Readonly<{
    total: number;
    running: number;
    errors: number;
    cancelled: number;
    names: readonly Readonly<{ name: string; count: number }>[];
    moreNames: boolean;
  }> | undefined;
  readonly durationMs: number | undefined;
}

function nestedCalls(value: unknown): CodemodeSummary["calls"] {
  if (!Array.isArray(value)) return undefined;
  const names = new Map<string, number>();
  let running = 0, errors = 0, cancelled = 0, moreNames = false;

  for (const call of value) {
    if (!isRecord(call) || typeof call.name !== "string" || !call.name) return undefined;
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

  return { total: value.length, running, errors, cancelled,
    names: [...names].map(([name, count]) => ({ name, count })), moreNames };
}

/** Project Pi's recorded codemode facts without interpreting the script or result text. */
export function codemodeSummary({ toolName, args, result, isPartial }: {
  readonly toolName: string;
  readonly args: unknown;
  readonly result: unknown;
  readonly isPartial: boolean;
}): CodemodeSummary | undefined {
  try {
    if (toolName !== "codemode" || !isRecord(args) || typeof args.code !== "string") return undefined;
    const details = isRecord(result) && isRecord(result.details) ? result.details : undefined;
    const duration = isRecord(result) ? result.durationMs : undefined;
    return { isPartial, calls: nestedCalls(details?.calls),
      durationMs: !isPartial && typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : undefined };
  } catch { return undefined; }
}
