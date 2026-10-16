/** Pending also covers activity that the host has not confirmed. */
export type ToolPhase = "pending" | "running" | "settled";

export function toolPhase({ hasResult, isPartial, executionStarted }: {
  readonly hasResult: boolean;
  readonly isPartial: boolean;
  readonly executionStarted: boolean;
}): ToolPhase {
  if (hasResult && !isPartial) return "settled";
  if (executionStarted || (hasResult && isPartial)) return "running";
  return "pending";
}
