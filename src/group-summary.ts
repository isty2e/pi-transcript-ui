import type { ToolClassification } from "./classify.js";
import { changeText, failureText, requestedPatchText, type LineParts } from "./display.js";
import { readCountText } from "./read-body.js";
import type { FileCapabilities, SummaryMetrics } from "./tool-metrics.js";
import type { ToolPhase } from "./tool-phase.js";

export interface GroupMemberSummary {
  readonly toolName: string;
  readonly classification: ToolClassification;
  readonly capabilities: FileCapabilities;
  readonly phase: ToolPhase;
  readonly isError: boolean;
  readonly readPath: string | undefined;
  readonly metrics: SummaryMetrics;
  readonly outputLines: number;
  readonly shellSession: boolean;
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
  read: { pending: "Read", running: "Reading", settled: "Read", unit: "calls" },
  search: { pending: "Search", running: "Searching", settled: "Searched", unit: "patterns" },
  list: { pending: "List", running: "Listing", settled: "Listed", unit: "paths" },
  mutate: { pending: "Edit", running: "Editing", settled: "Edited", unit: "calls" },
  explore: { pending: "Exploration", running: "Exploring", settled: "Explored", unit: "calls" },
  change: { pending: "Mutation", running: "Mutation", settled: "Mutation", unit: "calls" },
} as const;

function groupOperation({ classification, members }: GroupSelectionInput) {
  if (classification.family === "mutation") {
    return members.every(member => member.capabilities.mutation || member.capabilities.patch) ? "mutate" : "change";
  }

  const operations = new Set(members.map(member => member.classification.operation));
  const first = members[0]?.classification.operation;
  if (members.some(member => member.capabilities.mutation || member.capabilities.patch) || operations.size !== 1 || first === "unknown") {
    return "explore";
  }
  return first;
}

function selectSummary(input: GroupSelectionInput) {
  const { classification, members } = input;
  const phase: ToolPhase = members.every(member => member.phase === "settled") ? "settled"
    : members.some(member => member.phase === "running") ? "running" : "pending";
  const done = phase === "settled";
  const operation = groupOperation(input);
  const readGroup = operation === "read" || members.some(member =>
    member.capabilities.read || (!member.capabilities.mutation && !member.capabilities.patch && member.classification.operation === "read"));

  let verb: Readonly<Record<ToolPhase, string> & { unit: string }>;
  if (readGroup && classification.family === "exploration") {
    verb = operation === "read" || members.every(member => member.capabilities.read) ? verbs.read : verbs.explore;
  } else {
    verb = operation && operation !== "execute" ? verbs[operation] : verbs.explore;
  }

  const countOutput = !readGroup && classification.family !== "mutation" && done &&
    !members.some(member => member.shellSession || member.toolName === "bash" || member.toolName === "codemode" || member.capabilities.mutation || member.capabilities.patch || member.metrics.patch.kind === "known");
  return { done, phase, verb, readGroup, countOutput };
}

/** Request only the native identity/content facts that the selected summary will consume. */
export function groupSummaryRequirements(input: GroupSelectionInput): { readIdentity: boolean; outputLines: boolean } {
  const selection = selectSummary(input);
  return { readIdentity: selection.verb === verbs.read, outputLines: selection.countOutput };
}

/** Aggregate current evidence only; native identity, membership and disclosure live in the adapter. */
export function groupSummary(input: GroupSummaryInput): LineParts {
  const { members, expanded } = input;
  const { done, phase, verb, readGroup, countOutput } = selectSummary(input);
  const paths = verb === verbs.read ? members.map(member => member.readPath) : [];
  const files = paths.length > 0 && paths.every(path => path !== undefined) ? new Set(paths).size : undefined;
  const quantity = files === undefined ? `${members.length} ${verb.unit}` : `${files} ${files === 1 ? "file" : "files"}`;
  const repeated = files !== undefined && files < members.length;
  const failed = members.filter(member => member.phase === "settled" && member.isError).length;
  const failure = failed ? { count: failed, offset: ` ${quantity} — `.length } : undefined;
  const prefix = ` ${quantity}${failed ? ` — ${failureText(failed)}` : ""}`;

  const requests = members.map(member => member.capabilities.patch);
  if (requests.length && requests.every(request => request !== undefined)) {
    const targets = requests.reduce((total, request) => total + request.targets.length, 0);
    const delta = requests.every(request => request.delta !== undefined) ? requests.reduce((total, request) => ({
      added: total.added + request.delta!.added, removed: total.removed + request.delta!.removed,
    }), { added: 0, removed: 0 }) : undefined;
    return {
      marker: expanded ? "▾" : "▸",
      action: verb[phase],
      rest: `${prefix} ${requestedPatchText(delta, targets)}${done ? "" : "…"}`,
      ...(failure ? { failure } : {}),
    };
  }

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
    action: verb[phase],
    rest: `${prefix}${metric ? ` ${metric}` : ""}${done ? "" : "…"}`,
    ...(change ? { change } : {}),
    ...(failure ? { failure } : {}),
  };
}
