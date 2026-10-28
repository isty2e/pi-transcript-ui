import * as Pi from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import { isRecord } from "../intent.js";
import type { DisplayLimits } from "../display.js";
import type { NativeToolComponent } from "../wiring.js";
import { CodemodeFacts, evidenceHandle, type ActivityRecord, type EvidenceHandle, type MatchedTerminal, type ScriptOutput } from "./model.js";
import { argumentPreview } from "./argument-preview.js";
import type { SummaryRequest } from "../tool-summary.js";
import { CodemodeOutputObserver } from "./output-observer.js";
import { formattedOutput } from "./output-format.js";
import { outputPartContent, type OutputBlock, type OutputPart, type OutputWitness } from "./output.js";
import { inlineNativeToolBody } from "./native-body.js";

export interface Appearance { showImages: boolean; imageWidthCells: number; outputPad: number }
interface Host extends NativeToolComponent {
  setOutputPad(value: number): void;
  setShowImages(value: boolean): void;
  setImageWidthCells(value: number): void;
}
interface Mode {
  ui: { requestRender(): void };
  sessionManager: ExtensionContext["sessionManager"];
  session: { getToolDefinition(name: string): unknown };
  settingsManager: { getShowImages(): boolean; getImageWidthCells(): number };
  outputPad: number;
  toolOutputExpanded: boolean;
  getRegisteredToolDefinition(name: string): ToolRenderers | undefined;
}
type BodyConstructor = new (name: string, id: string, args: unknown, options: Appearance, definition: ToolRenderers | undefined,
  ui: { requestRender(): void }, cwd?: string) => Host;
type Payload = { kind: "request"; args: unknown } | { kind: "terminal"; result: unknown; isError: boolean; durationMs: number | undefined };
interface Execution {
  facts: CodemodeFacts;
  eligible: boolean;
  closed: boolean;
  admitted: boolean;
}
export interface CompletedInput {
  readonly name: string;
  readonly id: string;
  readonly args: unknown;
  readonly result: { content?: unknown; details?: unknown; isError: boolean; durationMs: number | undefined };
}
export interface CompletedBody extends Component {
  readonly children: Component[];
  setExpanded(value: boolean): void;
  appearance(value: Appearance): void;
  suspend(value: boolean): void;
  dispose(): void;
}
export type ActivitySummarySource = Readonly<{kind: "preview"; request: SummaryRequest | undefined}> |
  Readonly<{kind: "history"; request: SummaryRequest | undefined; parameters: unknown}>;
type StoredRequest = Readonly<{name: string; request: SummaryRequest | undefined; supplied: boolean}>;
interface HistoryRequests {
  readonly source: object;
  readonly calls: ReadonlyMap<string, StoredRequest | undefined>;
  readonly parameters: ReadonlyMap<string, unknown>;
}
interface HistoricalDeclaration { readonly id: string; readonly name: string; readonly parameters: ReadonlyMap<string, unknown> }

function recordedRequest(args: unknown): SummaryRequest | undefined {
  try {
    if (!isRecord(args) || ![null, Object.prototype].includes(Object.getPrototypeOf(args))) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(args);
    if (Object.values(descriptors).some(field => !("value" in field))) return undefined;
    const copy = Object.create(null) as Record<string, unknown>;
    for (const [key, field] of Object.entries(descriptors)) Object.defineProperty(copy, key, {value: field.value, enumerable: true});
    return {args: Object.freeze(copy), complete: true, source: "recorded"};
  } catch { return undefined; }
}

function renderable(value: unknown): value is Component {
  return isRecord(value) && typeof value.render === "function" && typeof value.invalidate === "function";
}

/** A short-lived observation of Pi's normal lookup, never an execution interceptor. */
function discover(receive: (mode: unknown) => void): () => void {
  let prototype: object;
  try { prototype = Pi.InteractiveMode.prototype; } catch { return () => {}; }
  const before = Object.getOwnPropertyDescriptor(prototype, "getRegisteredToolDefinition");
  if (!before || typeof before.value !== "function" || !before.configurable || !before.writable) return () => {};
  const original = before.value as (this: unknown, name: string) => unknown;
  let active = true;
  const release = () => {
    active = false;
    if (Object.getOwnPropertyDescriptor(prototype, "getRegisteredToolDefinition")?.value === observe)
      Object.defineProperty(prototype, "getRegisteredToolDefinition", before);
  };
  function observe(this: unknown, name: string): unknown {
    if (active) {
      try { release(); receive(this); } catch { /* Discovery cannot replace Pi's result or exception. */ }
    }
    return original.call(this, name);
  }
  Object.defineProperty(prototype, "getRegisteredToolDefinition", { ...before, value: observe });
  return release;
}

export class CodemodeRuntime {
  private captured: unknown;
  private root: unknown;
  private context: ExtensionContext | undefined;
  private active = false;
  private readonly completed = new Set<string>();
  private indexed = false;
  private readonly executions = new Map<string, Execution>();
  private readonly bindings = new Map<NativeToolComponent, CodemodeParent>();
  private readonly dirtyParents = new Set<string>();
  private readonly payloads = new Map<EvidenceHandle, { owner: CodemodeFacts; payload: Payload }>();
  private outputs = new WeakMap<CodemodeFacts, {execution: Execution; witness: OutputWitness}>();
  private outputObserver: CodemodeOutputObserver | undefined;
  private releaseLookup: () => void;
  private history: {manager: ExtensionContext["sessionManager"]; session: string; leaf: string | null;
    sources: WeakMap<object, HistoricalDeclaration>} | undefined;

  constructor(private readonly pi: ExtensionAPI, readonly requested: () => DisplayLimits["codemode"]) {
    this.releaseLookup = discover(mode => { this.captured = mode; this.watchOutput(); });
    pi.on("tool_execution_start", event => {
      if (!this.active) return;
      if (event.parentToolCallId) {
        const execution = this.executions.get(event.parentToolCallId);
        if (!execution || !execution.eligible || execution.closed || (this.requested() === "native" && !execution.admitted)) return;
        const handle = evidenceHandle();
        if (execution.facts.start(event.toolCallId, event.toolName, handle))
          this.payloads.set(handle, { owner: execution.facts, payload: { kind: "request", args: event.args } });
        this.changed(execution.facts);
        return;
      }
      if (event.toolName !== "codemode") return;
      const prior = this.executions.get(event.toolCallId);
      if (prior) { prior.eligible = false; prior.facts.closeCapture(); }
      const execution: Execution = { facts: new CodemodeFacts(event.toolCallId), closed: false, admitted: false,
        eligible: this.indexed && !this.completed.has(event.toolCallId) && !prior };
      this.executions.set(event.toolCallId, execution);
      const [binding] = this.resolveParentBindings(event.toolCallId);
      binding?.replaceFacts(execution.facts, execution.eligible);
    });
    pi.on("tool_execution_end", event => {
      if (!this.active) return;
      if (event.parentToolCallId) {
        const execution = this.executions.get(event.parentToolCallId);
        if (!execution || !execution.eligible || execution.closed) return;
        const handle = evidenceHandle();
        if (execution.facts.end(event.toolCallId, event.toolName, handle)) {
          this.payloads.set(handle, { owner: execution.facts, payload: { kind: "terminal", result: event.result,
            isError: event.isError, durationMs: event.durationMs } });
          this.changed(execution.facts);
        }
        return;
      }
      this.completed.add(event.toolCallId);
      const execution = this.executions.get(event.toolCallId);
      if (execution) {
        execution.closed = true; execution.facts.closeCapture(); this.executions.delete(event.toolCallId);
        if (![...this.bindings.values()].some(binding => binding.facts === execution.facts)) { execution.facts.dispose(); this.prune(execution.facts); }
      }
    });
    pi.on("message_end", event => {
      const message = event.message;
      if (this.active && message.role === "toolResult" && message.toolName === "codemode" &&
        [...this.bindings.values()].some(binding => binding.parent.toolCallId === message.toolCallId)) this.dirtyParents.add(message.toolCallId);
    });
    pi.on("turn_end", () => this.reconcile());
    pi.on("agent_end", () => this.reconcile());
    pi.on("session_tree", () => this.reconcile(true));
    pi.on("session_compact", () => this.reconcile(true));
  }

  private reconcile(reobserve = false): void {
    if (!this.active || !this.context || this.bindings.size === 0) return;
    let branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
    try { branch = this.context.sessionManager.getBranch(); } catch { return; }
    if (reobserve) this.history = undefined;
    const calls = new Map<string, {name: string; position: number} | undefined>();
    const results = new Map<string, {id: string; position: number; message: unknown} | undefined>();
    for (const [position, entry] of branch.entries()) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "assistant") for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        calls.set(block.id, calls.has(block.id) ? undefined : {name: block.name, position});
      }
      if (message.role === "toolResult") results.set(message.toolCallId, results.has(message.toolCallId)
        ? undefined : {id: entry.id, position, message});
    }
    const parents = new Map<string, CodemodeParent[]>();
    for (const binding of this.bindings.values()) {
      const id = binding.parent.toolCallId;
      const group = parents.get(id) ?? [];
      group.push(binding); parents.set(id, group);
    }
    for (const [id, group] of parents) {
      const call = calls.get(id), result = results.get(id);
      const source = group.length === 1 && call?.name === "codemode" && result && call.position < result.position &&
        isRecord(result.message) && result.message.toolName === "codemode" ? result : undefined;
      for (const binding of group) binding.reconcile(source, reobserve || this.dirtyParents.has(id));
    }
    this.dirtyParents.clear();
  }

  start(context: ExtensionContext): void {
    this.stop();
    this.context = context;
    if (context.mode !== "tui") { this.releaseLookup(); return; }
    if (this.captured === undefined) {
      this.releaseLookup();
      this.releaseLookup = discover(mode => { this.captured = mode; this.watchOutput(); });
    }
    this.active = true;
    this.outputObserver = new CodemodeOutputObserver(id => {
      const execution = this.executions.get(id);
      if (!this.active || !execution?.eligible || execution.closed ||
        (this.requested() === "native" && !execution.admitted)) return undefined;
      return witness => {
        if (witness && this.active && execution.eligible && !execution.closed && !execution.facts.final &&
          this.executions.get(id) === execution) this.outputs.set(execution.facts, {execution, witness});
      };
    });
    try {
      for (const entry of context.sessionManager.getEntries()) {
        if (entry.type === "message" && entry.message.role === "toolResult") this.completed.add(entry.message.toolCallId);
      }
      this.indexed = true;
    } catch { this.indexed = false; }
    this.watchOutput();
  }
  setRoot(root: unknown): void { this.root = root; this.watchOutput(); }

  private watchOutput(): void {
    try {
      const definition = this.mode()?.session.getToolDefinition("codemode");
      if (isRecord(definition)) this.outputObserver?.watch(definition);
    } catch { /* Output observation is optional; the native result remains authoritative. */ }
  }
  takeOutput(facts: CodemodeFacts): OutputWitness | undefined {
    const value = this.outputs.get(facts);
    this.outputs.delete(facts);
    return this.active && value?.execution.eligible && value.execution.facts === facts ? value.witness : undefined;
  }

  mode(): Mode | undefined {
    if (!this.active || !this.context || !isRecord(this.captured)) return undefined;
    const value = this.captured;
    if (value.ui !== this.root || value.sessionManager !== this.context.sessionManager ||
      typeof value.getRegisteredToolDefinition !== "function" || !isRecord(value.settingsManager) ||
      typeof value.settingsManager.getShowImages !== "function" || typeof value.settingsManager.getImageWidthCells !== "function" ||
      typeof value.outputPad !== "number" || typeof value.toolOutputExpanded !== "boolean" || !isRecord(value.session) ||
      typeof value.session.getToolDefinition !== "function") return undefined;
    return value as unknown as Mode;
  }

  parameters(name: string): unknown {
    if (!this.active) return undefined;
    return this.pi.getAllTools().find(tool => tool.name === name)?.parameters;
  }
  historicalParameters(parent: NativeToolComponent, source: object): ReadonlyMap<string, unknown> {
    try {
      const manager = this.mode()?.sessionManager;
      if (!manager || typeof Pi.buildSessionProjection !== "function") return new Map();
      const leaf = manager.getLeafId(), session = manager.getSessionId();
      if (this.history?.manager !== manager || this.history.leaf !== leaf || this.history.session !== session || !this.history.sources.has(source)) {
        const branch = manager.getBranch(), sources = new WeakMap<object, HistoricalDeclaration>();
        let parameters = new Map<string, unknown>(), dirty = true, conflicts = new Set<string>();
        let calls = new Map<string, {name: string; parameters: ReadonlyMap<string, unknown>; result?: object} | undefined>();

        for (const [position, entry] of branch.entries()) {
          if (entry.type !== "message") {
            if (entry.type === "compaction" || entry.type === "context_edit") dirty = true;
            continue;
          }
          const message: unknown = entry.message;
          if (!isRecord(message)) continue;
          if (message.role === "system") {
            for (const delta of [message.toolsRemoved, message.toolsAdded]) if (Array.isArray(delta)) {
              dirty = true;
              for (const tool of delta) if (isRecord(tool) && typeof tool.name === "string") conflicts.add(tool.name);
            }
          } else if (message.role === "assistant" && Array.isArray(message.content)) {
            if (dirty) {
              parameters = new Map();
              for (const value of Pi.buildSessionProjection(branch.slice(0, position)).messages) {
                const declaration: unknown = value;
                if (!isRecord(declaration) || declaration.role !== "system") continue;
                if (Array.isArray(declaration.toolsRemoved)) for (const tool of declaration.toolsRemoved) if (isRecord(tool) && typeof tool.name === "string") parameters.delete(tool.name);
                if (Array.isArray(declaration.toolsAdded)) for (const tool of declaration.toolsAdded) if (isRecord(tool) && typeof tool.name === "string") parameters.set(tool.name, tool.parameters);
              }
              dirty = false;
            }
            calls = new Map(); conflicts = new Set();
            for (const part of message.content) {
              if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string" || typeof part.name !== "string") continue;
              calls.set(part.id, calls.has(part.id) ? undefined : {name: part.name, parameters});
            }
          } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
            const call = calls.get(message.toolCallId);
            if (!call || call.name !== message.toolName) continue;
            if (call.result) { sources.delete(call.result); calls.set(message.toolCallId, undefined); continue; }
            call.result = message;
            const applicable = conflicts.size ? new Map([...call.parameters].filter(([name]) => !conflicts.has(name))) : call.parameters;
            sources.set(message, {id: message.toolCallId, name: call.name, parameters: applicable});
          }
        }
        this.history = {manager, session, leaf, sources};
      }
      const declaration = this.history?.sources.get(source);
      return declaration?.id === parent.toolCallId && declaration.name === parent.toolName ? declaration.parameters : new Map();
    } catch { return new Map(); }
  }

  appearance(): Appearance {
    const mode = this.mode();
    if (!mode) throw new Error("Codemode host unavailable");
    return { showImages: mode.settingsManager.getShowImages(), imageWidthCells: mode.settingsManager.getImageWidthCells(), outputPad: mode.outputPad };
  }
  initiallyExpanded(): boolean { return this.mode()?.toolOutputExpanded ?? false; }

  bind(parent: NativeToolComponent): CodemodeParent | undefined {
    if (parent.toolName !== "codemode") return undefined;
    let binding = this.bindings.get(parent);
    if (!binding) {
      const execution = this.executions.get(parent.toolCallId);
      binding = new CodemodeParent(this, parent, new CodemodeFacts(parent.toolCallId));
      this.bindings.set(parent, binding);

      if (parent.isPartial) {
        const [candidate] = this.resolveParentBindings(parent.toolCallId);
        if (execution && candidate === binding) binding.replaceFacts(execution.facts, execution.eligible);
      }
      binding.observe();
    }
    return binding;
  }
  private resolveParentBindings(id: string): readonly CodemodeParent[] {
    const candidates = [...this.bindings].filter(([parent]) => parent.toolCallId === id && parent.isPartial).map(([, binding]) => binding);
    if (candidates.length < 2) return candidates;

    const execution = this.executions.get(id);
    if (execution) execution.eligible = false;
    const facts = new Set(candidates.map(binding => binding.facts));
    if (execution) facts.add(execution.facts);
    for (const value of facts) { this.outputs.delete(value); value.discardExecutionEvidence(); }

    for (const value of facts) this.changed(value);
    return [];
  }
  admit(facts: CodemodeFacts): void {
    const execution = this.executions.get(facts.parentId);
    if (execution?.facts === facts) execution.admitted = true;
  }
  input(matched: MatchedTerminal): CompletedInput | undefined {
    const requestValue = this.payloads.get(matched.request), endValue = this.payloads.get(matched.terminal);
    if (!requestValue || requestValue.owner !== endValue?.owner || !requestValue.owner.owns(matched)) return undefined;
    const request = requestValue.payload, end = endValue.payload;
    if (request?.kind !== "request" || end?.kind !== "terminal" || !isRecord(end.result)) return undefined;
    return { name: matched.name, id: matched.id, args: request.args,
      result: { ...end.result, isError: end.isError, durationMs: end.durationMs } };
  }
  private changed(facts: CodemodeFacts): void {
    this.prune(facts);
    for (const binding of this.bindings.values()) if (binding.facts === facts) binding.changed();
  }
  prune(facts: CodemodeFacts): void {
    if (facts.final || facts.faulted || this.outputs.get(facts)?.execution.eligible === false) this.outputs.delete(facts);
    const retained = facts.retainedEvidence();
    for (const [handle, value] of this.payloads) if (value.owner === facts && !retained.has(handle)) this.payloads.delete(handle);
  }
  retire(parent: NativeToolComponent): void {
    const binding = this.bindings.get(parent);
    if (!binding) return;
    this.bindings.delete(parent);
    this.outputs.delete(binding.facts);
    binding.clearPresentation(); binding.facts.dispose(); this.prune(binding.facts);
    const execution = this.executions.get(parent.toolCallId);
    if (execution?.facts === binding.facts) { execution.eligible = false; execution.facts.closeCapture(); }
  }
  stop(): void {
    this.active = false;
    this.outputObserver?.dispose(); this.outputObserver = undefined; this.outputs = new WeakMap(); this.history = undefined;
    for (const binding of this.bindings.values()) { binding.clearPresentation(); binding.facts.dispose(); }
    this.bindings.clear(); this.executions.clear(); this.payloads.clear(); this.completed.clear(); this.dirtyParents.clear();
    this.context = undefined; this.root = undefined; this.indexed = false;
  }
  shutdown(): void { this.stop(); this.releaseLookup(); this.captured = undefined; }
}

export class CodemodeParent {
  onChange: () => void = () => {};
  private readonly codeSchema: boolean;
  private displayOutput: {source: ScriptOutput; content: ReturnType<typeof formattedOutput>} | undefined;
  private historyRequests: HistoryRequests | undefined;
  private observedSource: unknown;
  private sourceEntry: string | undefined;
  private liveOwner = false;
  constructor(readonly runtime: CodemodeRuntime, readonly parent: NativeToolComponent, public facts: CodemodeFacts) {
    const parameters = runtime.parameters("codemode");
    this.codeSchema = isRecord(parameters) && isRecord(parameters.properties) &&
      isRecord(parameters.properties.code) && parameters.properties.code.type === "string";
  }
  clearPresentation(): void { this.displayOutput = undefined; this.historyRequests = undefined; this.observedSource = undefined; this.sourceEntry = undefined; }
  changed(): void {
    if (this.displayOutput?.source !== this.facts.output) this.displayOutput = undefined;
    if (this.historyRequests?.source !== this.observedSource) this.historyRequests = undefined;
    this.onChange();
  }
  replaceFacts(facts: CodemodeFacts, liveOwner = false): void {
    if (this.facts === facts) return;

    this.clearPresentation(); this.facts.dispose(); this.runtime.prune(this.facts);

    this.facts = facts; this.liveOwner = liveOwner; this.changed();
  }
  observe(): void {
    if (!this.facts.final || !this.parent.isPartial) {
      this.observedSource = this.parent.result; this.historyRequests = undefined;
    }
    this.facts.observe(this.parent.result, this.parent.isPartial,
      this.parent.isPartial ? undefined : this.runtime.takeOutput(this.facts));
    this.runtime.prune(this.facts); this.changed();
  }
  reconcile(source: {id: string; message: unknown} | undefined, reobserve: boolean): void {
    if (!source || (this.sourceEntry !== undefined && this.sourceEntry !== source.id)) {
      if (this.sourceEntry !== undefined) {
        this.clearPresentation(); this.facts.dispose(); this.runtime.prune(this.facts); this.changed();
      }
      return;
    }
    if (this.facts.faulted || (!this.sourceEntry && !this.liveOwner && this.observedSource !== source.message)) return;
    if (this.sourceEntry === source.id && this.observedSource === source.message && !reobserve) return;
    this.sourceEntry = source.id;
    try { this.parent.updateResult(source.message, false); }
    catch { this.facts.dispose(); this.runtime.prune(this.facts); this.changed(); }
  }
  source(): Component | undefined {
    const value: unknown = Reflect.get(this.parent, "callRendererComponent");
    return renderable(value) ? value : undefined;
  }
  summarySource(record: ActivityRecord): ActivitySummarySource {
    if (this.facts.records?.[record.ordinal] !== record) return {kind: "preview", request: undefined};
    const source: unknown = this.observedSource;
    const preview = () => argumentPreview(record.preview);
    if (!isRecord(source) || source.role !== "toolResult") return {kind: "preview", request: preview()};
    if (source.toolCallId !== this.parent.toolCallId || source.toolName !== this.parent.toolName || !this.facts.final) {
      return {kind: "history", request: undefined, parameters: undefined};
    }
    if (this.historyRequests?.source !== source) {
      const calls = new Map<string, StoredRequest | undefined>();
      const nested = isRecord(source.nestedCalls) ? source.nestedCalls.calls : undefined;
      if (Array.isArray(nested)) for (const call of nested) {
        if (!isRecord(call) || typeof call.id !== "string" || typeof call.name !== "string") continue;
        if (calls.has(call.id)) { calls.set(call.id, undefined); continue; }
        calls.set(call.id, {name: call.name, request: recordedRequest(call.arguments), supplied: Object.hasOwn(call, "arguments")});
      }
      this.historyRequests = {source, calls, parameters: this.runtime.historicalParameters(this.parent, source)};
    }
    const stored = record.id && record.id !== `${this.parent.toolCallId}/?` ? this.historyRequests.calls.get(record.id) : undefined;
    const parameters = this.historyRequests.parameters.get(record.name);
    if (record.id && this.historyRequests.calls.has(record.id) && !stored) return {kind: "history", request: undefined, parameters};
    if (stored && stored.name !== record.name) return {kind: "history", request: undefined, parameters};
    if (stored?.name === record.name && stored.supplied) return {kind: "history", request: stored.request, parameters};
    return {kind: "history", request: preview(), parameters};
  }
  supported(): boolean {
    return Boolean(this.runtime.mode() && this.codeSchema && isRecord(this.parent.args) && typeof this.parent.args.code === "string" && this.source());
  }

  createBody(input: MatchedTerminal | ScriptOutput | OutputPart, expanded: boolean, setExpanded: (value: boolean) => void,
    invalidate: () => void): CompletedBody {
    const mode = this.runtime.mode();
    if (!mode) throw new Error("Codemode host unavailable");
    const facts = this.facts;
    const owned = () => this.facts === facts && ("request" in input ? facts.owns(input) : facts.ownsOutput(input));
    if (!owned())
      throw new Error("Completed display evidence unavailable");
    const tool = "request" in input ? this.runtime.input(input) : undefined;
    if ("request" in input && !tool) throw new Error("Completed invocation unavailable");
    const outputName = "pi-transcript-ui:codemode-output";
    const definition = tool ? mode.getRegisteredToolDefinition(tool.name) : { renderCall: () => new Text("", 0, 0) };
    const Constructor = this.parent.constructor as unknown as BodyConstructor;
    let alive = true, suspended = false;
    const usable = () => alive && !suspended && owned();
    const host = new Constructor(tool?.name ?? outputName, tool?.id ?? this.parent.toolCallId, tool?.args ?? {},
      this.runtime.appearance(), definition, { requestRender: () => { if (usable()) invalidate(); } }, this.parent.cwd);
    if (!tool) {
      const nativeFrame = host.children[1] as Box | undefined;
      if (!nativeFrame || !Array.isArray(nativeFrame.children) || typeof nativeFrame.setPaddingX !== "function")
        throw new Error("Native output frame unavailable");

      const displayFrame = new Box(0, 0), updateDisplay = host.updateDisplay.bind(host);
      host.children[1] = displayFrame;
      host.updateDisplay = () => {
        updateDisplay();
        const outputPad: unknown = Reflect.get(host, "outputPad");
        if (typeof outputPad !== "number") throw new Error("Native output padding unavailable");

        displayFrame.children = nativeFrame.children;
        displayFrame.setPaddingX(outputPad);
      };
    }
    const nativeInvalidate = host.invalidate.bind(host), nativeExpanded = host.setExpanded.bind(host);
    host.invalidate = () => { if (usable()) { nativeInvalidate(); invalidate(); } };
    const output = "request" in input ? undefined : this.facts.output;
    let content: readonly OutputBlock[] | undefined;
    if (output && !("request" in input)) {
      if (this.displayOutput?.source !== output) this.displayOutput = { source: output, content: formattedOutput(output) };
      content = this.displayOutput.content?.get(input) ??
        ("segments" in input ? outputPartContent(output, input) : output.content);
    }
    host.updateResult(tool?.result ?? { content, details: output?.fullOutputPath === undefined ? {} : { fullOutputPath: output.fullOutputPath },
      isError: this.facts.outcome?.isError === true }, false);
    nativeExpanded(expanded);
    host.setExpanded = value => { if (usable()) setExpanded(value); };
    const body = inlineNativeToolBody(host, {
      get children() { return host.children; }, render: width => host.render(width),
      handleMouse: event => host.handleMouse?.(event), invalidate: () => host.invalidate(),
    });
    return {
      get children() { return usable() ? body.children : []; }, render: width => usable() ? body.render(width) : [],
      handleMouse: event => usable() ? body.handleMouse?.(event) : { handled: true },
      invalidate: () => body.invalidate(), setExpanded: value => { if (usable()) nativeExpanded(value); },
      appearance(value) { if (!usable()) return;
        if (Reflect.get(host, "showImages") !== value.showImages) host.setShowImages(value.showImages);
        if (Reflect.get(host, "imageWidthCells") !== value.imageWidthCells) host.setImageWidthCells(value.imageWidthCells);
        if (Reflect.get(host, "outputPad") !== value.outputPad) host.setOutputPad(value.outputPad);
      },
      suspend: value => { suspended = value; },
      dispose: () => { alive = false; suspended = true; },
    };
  }
}
