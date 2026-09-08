import type { ToolClassification } from "./classify.js";
import { editDeltaFor, type EditDelta } from "./edit-delta.js";
import { writtenLineCount, type FileMutation } from "./file-mutation.js";
import { readBodyCount, type FileRead, type ReadBodyCount } from "./read-body.js";

export interface FileCapabilities {
  readonly mutation: FileMutation | undefined;
  readonly read: FileRead | undefined;
}

export type Measurement<T> =
  | Readonly<{ kind: "not-applicable" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "known"; value: T }>;

export interface SummaryMetrics {
  readonly read: Measurement<ReadBodyCount>;
  readonly written: Measurement<number>;
  readonly patch: Measurement<EditDelta>;
}

const notApplicable = Object.freeze({ kind: "not-applicable" } as const);
const unavailable = Object.freeze({ kind: "unavailable" } as const);
export const NO_SUMMARY_METRICS: SummaryMetrics = Object.freeze({
  read: notApplicable,
  written: notApplicable,
  patch: notApplicable,
});

function measured<T>(applicable: boolean, value: T | undefined): Measurement<T> {
  if (!applicable) return notApplicable;
  return value === undefined ? unavailable : { kind: "known", value };
}

interface MetricInput {
  readonly toolName: string;
  readonly classification: ToolClassification;
  readonly capabilities: FileCapabilities;
  readonly args: unknown;
  readonly result: unknown;
  readonly isPartial: boolean;
}

/** Derive current evidence, never a cached copy of the native tool's lifecycle. */
export function summaryMetrics(input: MetricInput): SummaryMetrics {
  const { toolName, classification, capabilities, args, result, isPartial } = input;
  const readApplicable = !capabilities.mutation &&
    (capabilities.read !== undefined || toolName === "read" || classification.operation === "read");
  const writeApplicable = capabilities.mutation?.shape === "content";

  return {
    read: measured(readApplicable, readApplicable ? readBodyCount(capabilities.read, args, result, isPartial) : undefined),
    written: measured(writeApplicable, writeApplicable ? writtenLineCount(capabilities.mutation, args, result, isPartial) : undefined),
    patch: measured(capabilities.mutation !== undefined, editDeltaFor(capabilities.mutation, result, isPartial)),
  };
}
