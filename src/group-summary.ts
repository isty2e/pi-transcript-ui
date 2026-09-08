import type { ToolClassification } from "./classify.js";
import { changeText, failureText, type LineParts } from "./display.js";
import { readCountText } from "./read-body.js";
import type { FileCapabilities, SummaryMetrics } from "./tool-metrics.js";

export interface GroupMemberSummary {
  readonly toolName: string;
  readonly classification: ToolClassification;
  readonly capabilities: FileCapabilities;
  readonly settled: boolean;
  readonly isError: boolean;
  readonly readPath: string | undefined;
  readonly metrics: SummaryMetrics;
  readonly outputLines: number;
}

interface GroupSelectionInput {
  readonly classification: ToolClassification;
  readonly members: readonly Omit<GroupMemberSummary, "readPath" | "outputLines">[];
}

interface GroupSummaryInput extends GroupSelectionInput {
  readonly members: readonly GroupMemberSummary[];
  readonly expanded: boolean;
}

const verbs = {
  read: ["Reading", "Read", "calls"],
  search: ["Searching", "Searched", "patterns"],
  list: ["Listing", "Listed", "paths"],
  mutate: ["Editing", "Edited", "calls"],
  explore: ["Exploration", "Exploration", "calls"],
  change: ["Mutation", "Mutation", "calls"],
} as const;

function groupOperation({ classification, members }: GroupSelectionInput) {
  if (classification.family === "mutation") {
    return members.every(member => member.capabilities.mutation) ? "mutate" : "change";
  }

  const operations = new Set(members.map(member => member.classification.operation));
  const first = members[0]?.classification.operation;
  if (members.some(member => member.capabilities.mutation) || operations.size !== 1 || first === "unknown") {
    return "explore";
  }
  return first;
}

function selectSummary(input: GroupSelectionInput) {
  const { classification, members } = input;
  const done = members.every(member => member.settled);
  const operation = groupOperation(input);
  const readGroup = operation === "read" || members.some(member =>
    member.capabilities.read || (!member.capabilities.mutation && member.classification.operation === "read"));

  let verb: readonly [string, string, string];
  if (readGroup && classification.family === "exploration") {
    verb = operation === "read" || members.every(member => member.capabilities.read) ? verbs.read : verbs.explore;
  } else {
    verb = operation && operation !== "execute" ? verbs[operation] : verbs.explore;
  }

  const countOutput = !readGroup && classification.family !== "mutation" && done &&
    !members.some(member => member.toolName === "bash" || member.capabilities.mutation || member.metrics.patch.kind === "known");
  return { done, verb, readGroup, countOutput };
}

/** Request only the native identity/content facts that the selected summary will consume. */
export function groupSummaryRequirements(input: GroupSelectionInput): { readIdentity: boolean; outputLines: boolean } {
  const selection = selectSummary(input);
  return { readIdentity: selection.verb === verbs.read, outputLines: selection.countOutput };
}

/** Aggregate current evidence only; native identity, membership and disclosure live in the adapter. */
export function groupSummary(input: GroupSummaryInput): LineParts {
  const { members, expanded } = input;
  const { done, verb, readGroup, countOutput } = selectSummary(input);
  const paths = verb === verbs.read ? members.map(member => member.readPath) : [];
  const files = paths.length > 0 && paths.every(path => path !== undefined) ? new Set(paths).size : undefined;
  const quantity = files === undefined ? `${members.length} ${verb[2]}` : `${files} ${files === 1 ? "file" : "files"}`;
  const repeated = files !== undefined && files < members.length;
  const failed = members.filter(member => member.settled && member.isError).length;
  const failure = failed ? { count: failed, offset: ` ${quantity} — `.length } : undefined;
  const prefix = ` ${quantity}${failed ? ` — ${failureText(failed)}` : ""}`;

  let added = 0;
  let removed = 0;
  let counted = 0;
  let readLines = 0;
  let readCounted = 0;
  for (const member of members) {
    if (member.metrics.patch.kind === "known") {
      added += member.metrics.patch.value.added;
      removed += member.metrics.patch.value.removed;
      counted++;
    }
    if (readGroup && member.metrics.read.kind === "known") {
      readLines += member.metrics.read.value.lines;
      readCounted++;
    }
  }
  const change = counted ? { added, removed, counted, total: members.length, offset: prefix.length } : undefined;

  let metric = "";
  if (change) {
    metric = changeText(change);
  } else if (readGroup) {
    metric = readCountText(readCounted, members.length, readLines, repeated);
  } else if (countOutput) {
    metric = `(${members.reduce((total, member) => total + member.outputLines, 0)} lines)`;
  }

  return {
    marker: expanded ? "▾" : "▸",
    action: done ? verb[1] : verb[0],
    rest: `${prefix}${metric ? ` ${metric}` : ""}${done ? "" : "…"}`,
    ...(change ? { change } : {}),
    ...(failure ? { failure } : {}),
  };
}
