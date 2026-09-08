/**
 * Pure tool-activity classification for homogeneous grouping.
 *
 * Decision table (ported semantics from pi-transcript-ui G2, re-expressed
 * over Pi-native inputs instead of projection nodes):
 * - read/grep/find/ls → exploration (read/search/list)
 * - schema-proven file mutation → mutation (mutate)
 * - otherwise bash and unknown tools → standalone
 * - exact-name user rules supersede capability and built-ins (read/search/list go to
 *   exploration, mutation goes to mutation, standalone forces standalone)
 * - explore/change select only a family, leaving the operation unspecified
 *
 * Fail-closed: non-string, empty, or over-long names classify standalone
 * without ever guessing a family. Grouping consumes the emitted family and
 * must not re-derive it from tool names.
 */

import type { FileMutation } from "./file-mutation.js";

export type OperationKind = "read" | "search" | "list" | "mutate" | "execute" | "unknown";

export type ToolFamily = "exploration" | "mutation" | null;

export type GroupingEvidence = "built-in-read" | "file-mutation-schema" | "user-configured" | "none";

export interface ToolClassification {
  readonly family: ToolFamily;
  readonly evidence: GroupingEvidence;
  readonly operation: OperationKind;
}

/** Exact tool-name rules; unknown names fall through to the built-ins. */
export type ToolGroupingRules = Readonly<
  Record<string, "read" | "search" | "list" | "explore" | "mutation" | "change" | "standalone">
>;

const MAX_TOOL_NAME_LENGTH = 512;

function standalone(operation: OperationKind): ToolClassification {
  return Object.freeze({ family: null, evidence: "none", operation });
}

function configured(
  rules: ToolGroupingRules | null | undefined,
  toolName: string,
): ToolClassification | null {
  if (rules == null) return null;
  let rule: unknown;
  try {
    // Own properties only: inherited entries (including __proto__ pollution)
    // never classify. A throwing proxy fails closed to standalone.
    if (Object.hasOwn(rules as object, toolName) !== true) return null;
    rule = (rules as Record<string, unknown>)[toolName];
  } catch {
    return standalone("unknown");
  }
  switch (rule) {
    case undefined:
      return null;
    case "read":
    case "search":
    case "list":
      return Object.freeze({
        family: "exploration",
        evidence: "user-configured",
        operation: rule,
      });
    case "mutation":
      return Object.freeze({
        family: "mutation",
        evidence: "user-configured",
        operation: "mutate",
      });
    case "explore":
      return Object.freeze({ family: "exploration", evidence: "user-configured", operation: "unknown" });
    case "change":
      return Object.freeze({ family: "mutation", evidence: "user-configured", operation: "unknown" });
    case "standalone":
      return standalone("unknown");
    default:
      return standalone("unknown");
  }
}

function builtIn(toolName: string): ToolClassification {
  switch (toolName) {
    case "read":
      return Object.freeze({ family: "exploration", evidence: "built-in-read", operation: "read" });
    case "grep":
    case "find":
      return Object.freeze({ family: "exploration", evidence: "built-in-read", operation: "search" });
    case "ls":
      return Object.freeze({ family: "exploration", evidence: "built-in-read", operation: "list" });
    case "bash":
    case "powershell":
      return standalone("execute");
    default:
      return standalone("unknown");
  }
}

/**
 * Exact preferences precede schema capability, then legacy exploration names.
 * Never throws; never reads arguments, results,
 * or execution status (status is orthogonal to grouping evidence).
 */
export function classifyTool(
  toolName: unknown,
  rules: ToolGroupingRules | null | undefined = null,
  capability?: FileMutation,
): ToolClassification {
  if (typeof toolName !== "string" || toolName.length === 0 || toolName.length > MAX_TOOL_NAME_LENGTH) {
    return standalone("unknown");
  }
  return configured(rules, toolName) ?? (capability
    ? Object.freeze({ family: "mutation", evidence: "file-mutation-schema", operation: "mutate" })
    : builtIn(toolName));
}
