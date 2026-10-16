import { isRecord } from "./intent.js";

export function toolDurationMs(result: unknown, isPartial: boolean): number | undefined {
  if (isPartial) return undefined;

  try {
    if (!isRecord(result)) return undefined;
    const duration = result.durationMs;
    return typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : undefined;
  } catch {
    return undefined;
  }
}
