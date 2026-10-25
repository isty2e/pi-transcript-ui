import { isRecord } from "../intent.js";
import { toolDurationMs } from "../tool-duration.js";

export type ActivityStatus = "running" | "ok" | "error" | "cancelled";
export interface ActivityRecord {
  readonly ordinal: number;
  readonly name: string;
  readonly status: ActivityStatus;
  readonly id: string | undefined;
  readonly preview: string | undefined;
  readonly durationMs: number | undefined;
  readonly error: string | undefined;
  readonly cost: number | undefined;
}

const evidenceBrand = Symbol("codemode-evidence");
const terminalBrand = Symbol("matched-codemode-terminal");
export type EvidenceHandle = Readonly<{ [evidenceBrand]: true }>;
export function evidenceHandle(): EvidenceHandle { return Object.freeze({ [evidenceBrand]: true as const }); }

export interface MatchedTerminal {
  readonly [terminalBrand]: CodemodeFacts;
  readonly id: string;
  readonly name: string;
  readonly request: EvidenceHandle;
  readonly terminal: EvidenceHandle;
}
interface Invocation {
  readonly name: string;
  readonly request: EvidenceHandle;
  terminal?: EvidenceHandle;
}

export interface OutputBlock { readonly type: string; readonly [key: string]: unknown }
export interface ScriptOutput {
  readonly content: readonly OutputBlock[];
  readonly fullOutputPath: string | undefined;
}
export interface ParentOutcome {
  readonly isError: boolean;
  readonly durationMs: number | undefined;
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function activityRecords(value: unknown): readonly ActivityRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const records: ActivityRecord[] = [];
  for (const [ordinal, item] of value.entries()) {
    if (!isRecord(item) || typeof item.name !== "string" || !item.name || typeof item.status !== "string" ||
      !["running", "ok", "error", "cancelled"].includes(String(item.status))) return undefined;
    records.push(Object.freeze({ ordinal, name: item.name, status: item.status as ActivityStatus,
      id: typeof item.id === "string" && item.id ? item.id : undefined,
      preview: typeof item.args === "string" ? item.args : undefined,
      durationMs: nonnegative(item.durationMs), error: typeof item.error === "string" ? item.error : undefined,
      cost: nonnegative(item.cost) }));
  }
  return Object.freeze(records);
}

export function scriptOutput(result: unknown): ScriptOutput | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  if (!result.content.every(block => isRecord(block) && typeof block.type === "string")) return undefined;
  let content = result.content as OutputBlock[];
  const first = content[0];
  if (first?.type === "text" && typeof first.text === "string" &&
    /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/.test(first.text)) content = content.slice(1);
  if (!content.some(block => block.type !== "text" || typeof block.text !== "string" || block.text.length > 0)) return undefined;
  return Object.freeze({ content: Object.freeze([...content]),
    fullOutputPath: isRecord(result.details) && typeof result.details.fullOutputPath === "string" ? result.details.fullOutputPath : undefined });
}

/** Supplied record order is authoritative; execution IDs are association evidence, not row identity. */
export class CodemodeFacts {
  private readonly known = new Map<number, ActivityRecord>();
  private readonly invocations = new Map<string, Invocation>();
  private readonly ambiguous = new Set<string>();
  private captureClosed = false;
  private sealed = false;
  private invalid = false;
  private current: readonly ActivityRecord[] | undefined;
  private outputValue: ScriptOutput | undefined;
  private outcomeValue: ParentOutcome | undefined;
  revision = 0;

  constructor(readonly parentId: string) {}
  get records(): readonly ActivityRecord[] | undefined { return this.current; }
  get output(): ScriptOutput | undefined { return this.outputValue; }
  get outcome(): ParentOutcome | undefined { return this.outcomeValue; }
  get faulted(): boolean { return this.invalid; }
  get final(): boolean { return this.sealed; }
  private realId(record: ActivityRecord): string | undefined {
    return record.id === `${this.parentId}/?` ? undefined : record.id;
  }

  start(id: string, name: string, request: EvidenceHandle): boolean {
    if (this.captureClosed || this.ambiguous.has(id)) return false;
    if (this.invocations.has(id)) {
      this.invocations.delete(id); this.ambiguous.add(id); this.revision++;
      return false;
    }
    this.invocations.set(id, { name, request });
    return true;
  }

  end(id: string, name: string, terminal: EvidenceHandle): boolean {
    if (this.captureClosed) return false;
    const invocation = this.invocations.get(id);
    if (!invocation || invocation.name !== name || invocation.terminal) return false;
    invocation.terminal = terminal;
    this.revision++;
    return true;
  }

  closeCapture(): void { this.captureClosed = true; }

  discardExecutionEvidence(): void {
    this.closeCapture(); this.invocations.clear(); this.ambiguous.clear();
    this.revision++;
  }

  private fault(): void {
    this.invalid = true; this.captureClosed = true; this.invocations.clear(); this.ambiguous.clear(); this.known.clear();
    this.revision++;
  }

  observe(result: unknown, isPartial: boolean): void {
    if (this.sealed || this.invalid) return;
    const calls = isRecord(result) && isRecord(result.details) ? result.details.calls : undefined;
    const records = activityRecords(calls);
    if (!records) {
      if (this.current !== undefined || calls !== undefined || (result !== undefined && !isPartial)) this.fault();
      else this.revision++;
      return;
    }
    const ids = new Set<string>();
    for (const record of records) {
      const previous = this.known.get(record.ordinal);
      const id = this.realId(record), priorId = previous && this.realId(previous);
      if ((previous && previous.name !== record.name) || (id && priorId && id !== priorId) || (id && ids.has(id))) {
        this.fault(); return;
      }
      if (id) ids.add(id);
      this.known.set(record.ordinal, priorId && !id ? previous! : record);
    }
    this.current = records;
    if (!isPartial) {
      this.closeCapture();
      this.sealed = true;
      this.outputValue = scriptOutput(result);
      this.outcomeValue = Object.freeze({ isError: isRecord(result) && result.isError === true, durationMs: toolDurationMs(result, false) });
      const retained = new Set(records.flatMap(record => this.realId(record) ?? []));
      for (const id of this.invocations.keys()) if (!retained.has(id)) this.invocations.delete(id);
      this.known.clear(); this.ambiguous.clear();
    }
    this.revision++;
  }

  matched(record: ActivityRecord): MatchedTerminal | undefined {
    const id = this.realId(record);
    const invocation = id && this.invocations.get(id);
    if (!id || !invocation || invocation.name !== record.name || !invocation.terminal) return undefined;
    return Object.freeze({ [terminalBrand]: this, id, name: record.name, request: invocation.request, terminal: invocation.terminal });
  }

  owns(terminal: MatchedTerminal): boolean {
    const invocation = this.invocations.get(terminal.id);
    return terminal[terminalBrand] === this && invocation?.name === terminal.name &&
      invocation.request === terminal.request && invocation.terminal === terminal.terminal;
  }

  retainedEvidence(): ReadonlySet<EvidenceHandle> {
    const handles = new Set<EvidenceHandle>();
    for (const call of this.invocations.values()) { handles.add(call.request); if (call.terminal) handles.add(call.terminal); }
    return handles;
  }

  dispose(): void {
    this.captureClosed = true; this.invocations.clear(); this.ambiguous.clear(); this.known.clear();
    this.current = undefined; this.outputValue = undefined; this.outcomeValue = undefined;
  }
}
