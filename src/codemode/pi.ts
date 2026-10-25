import { InteractiveMode, type ExtensionAPI, type ExtensionContext, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { isRecord } from "../intent.js";
import type { NativeToolComponent } from "../wiring.js";
import { CodemodeFacts, evidenceHandle, type EvidenceHandle, type MatchedTerminal, type ScriptOutput } from "./model.js";

export interface Appearance { showImages: boolean; imageWidthCells: number; outputPad: number }
interface Host extends NativeToolComponent {
  setOutputPad(value: number): void;
  setShowImages(value: boolean): void;
  setImageWidthCells(value: number): void;
}
interface Mode {
  ui: { requestRender(): void };
  sessionManager: ExtensionContext["sessionManager"];
  session: { extensionRunner: { resolveToolRenderers(name: string, base: () => undefined): ToolRenderers | undefined }; getToolDefinition(name: string): unknown };
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

function renderable(value: unknown): value is Component {
  return isRecord(value) && typeof value.render === "function" && typeof value.invalidate === "function";
}

/** A short-lived observation of Pi's normal lookup, never an execution interceptor. */
function discover(receive: (mode: unknown) => void): () => void {
  let prototype: object;
  try { prototype = InteractiveMode.prototype; } catch { return () => {}; }
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
  private readonly payloads = new Map<EvidenceHandle, { owner: CodemodeFacts; payload: Payload }>();
  private releaseLookup: () => void;

  constructor(private readonly pi: ExtensionAPI, readonly requested: () => "items" | "native") {
    this.releaseLookup = discover(mode => { this.captured = mode; });
    pi.on("tool_execution_start", event => {
      if (!this.active) return;
      if (event.parentToolCallId) {
        const execution = this.executions.get(event.parentToolCallId);
        if (!execution || !execution.eligible || execution.closed || (this.requested() !== "items" && !execution.admitted)) return;
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
      binding?.replaceFacts(execution.facts);
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
  }

  start(context: ExtensionContext): void {
    this.stop();
    this.context = context;
    if (context.mode !== "tui") { this.releaseLookup(); return; }
    this.active = true;
    try {
      for (const entry of context.sessionManager.getEntries()) {
        if (entry.type === "message" && entry.message.role === "toolResult") this.completed.add(entry.message.toolCallId);
      }
      this.indexed = true;
    } catch { this.indexed = false; }
  }
  setRoot(root: unknown): void { this.root = root; }

  mode(): Mode | undefined {
    if (!this.active || !this.context || !isRecord(this.captured)) return undefined;
    const value = this.captured;
    if (value.ui !== this.root || value.sessionManager !== this.context.sessionManager ||
      typeof value.getRegisteredToolDefinition !== "function" || !isRecord(value.settingsManager) ||
      typeof value.settingsManager.getShowImages !== "function" || typeof value.settingsManager.getImageWidthCells !== "function" ||
      typeof value.outputPad !== "number" || typeof value.toolOutputExpanded !== "boolean" || !isRecord(value.session) ||
      !isRecord(value.session.extensionRunner) || typeof value.session.extensionRunner.resolveToolRenderers !== "function" ||
      typeof value.session.getToolDefinition !== "function") return undefined;
    return value as unknown as Mode;
  }

  parameters(name: string): unknown {
    if (!this.active) return undefined;
    return this.pi.getAllTools().find(tool => tool.name === name)?.parameters;
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
        if (execution && candidate === binding) binding.replaceFacts(execution.facts);
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
    for (const value of facts) value.discardExecutionEvidence();

    for (const value of facts) this.changed(value);
    return [];
  }
  admit(facts: CodemodeFacts): void {
    const execution = this.executions.get(facts.parentId);
    if (execution?.facts === facts) execution.admitted = true;
  }
  input(matched: MatchedTerminal): CompletedInput | undefined {
    const request = this.payloads.get(matched.request)?.payload, end = this.payloads.get(matched.terminal)?.payload;
    if (request?.kind !== "request" || end?.kind !== "terminal" || !isRecord(end.result)) return undefined;
    return { name: matched.name, id: matched.id, args: request.args,
      result: { ...end.result, isError: end.isError, durationMs: end.durationMs } };
  }
  private changed(facts: CodemodeFacts): void {
    this.prune(facts);
    for (const binding of this.bindings.values()) if (binding.facts === facts) binding.changed();
  }
  prune(facts: CodemodeFacts): void {
    const retained = facts.retainedEvidence();
    for (const [handle, value] of this.payloads) if (value.owner === facts && !retained.has(handle)) this.payloads.delete(handle);
  }
  retire(parent: NativeToolComponent): void {
    const binding = this.bindings.get(parent);
    if (!binding) return;
    this.bindings.delete(parent);
    binding.facts.dispose(); this.prune(binding.facts);
    const execution = this.executions.get(parent.toolCallId);
    if (execution?.facts === binding.facts) { execution.eligible = false; execution.facts.closeCapture(); }
  }
  stop(): void {
    this.active = false;
    for (const binding of this.bindings.values()) binding.facts.dispose();
    this.bindings.clear(); this.executions.clear(); this.payloads.clear(); this.completed.clear();
    this.context = undefined; this.root = undefined; this.indexed = false;
  }
  shutdown(): void { this.stop(); this.releaseLookup(); this.captured = undefined; }
}

export class CodemodeParent {
  onChange: () => void = () => {};
  private readonly codeSchema: boolean;
  constructor(readonly runtime: CodemodeRuntime, readonly parent: NativeToolComponent, public facts: CodemodeFacts) {
    const parameters = runtime.parameters("codemode");
    this.codeSchema = isRecord(parameters) && isRecord(parameters.properties) &&
      isRecord(parameters.properties.code) && parameters.properties.code.type === "string";
  }
  changed(): void { this.onChange(); }
  replaceFacts(facts: CodemodeFacts): void { if (this.facts === facts) return; this.facts.dispose(); this.runtime.prune(this.facts); this.facts = facts; this.changed(); }
  observe(): void { this.facts.observe(this.parent.result, this.parent.isPartial); this.runtime.prune(this.facts); this.changed(); }
  source(): Component | undefined {
    const value: unknown = Reflect.get(this.parent, "callRendererComponent");
    return renderable(value) ? value : undefined;
  }
  supported(): boolean {
    return Boolean(this.runtime.mode() && this.codeSchema && isRecord(this.parent.args) && typeof this.parent.args.code === "string" && this.source());
  }

  createBody(input: MatchedTerminal | ScriptOutput, expanded: boolean, setExpanded: (value: boolean) => void,
    invalidate: () => void): CompletedBody {
    const mode = this.runtime.mode();
    if (!mode) throw new Error("Codemode host unavailable");
    if ("request" in input ? !this.facts.owns(input) : !this.facts.final || this.facts.output !== input)
      throw new Error("Completed display evidence unavailable");
    const tool = "request" in input ? this.runtime.input(input) : undefined;
    if ("request" in input && !tool) throw new Error("Completed invocation unavailable");
    const outputName = "pi-transcript-ui:codemode-output";
    const selected = tool ? mode.getRegisteredToolDefinition(tool.name)
      : mode.session.getToolDefinition(outputName) ? undefined : mode.session.extensionRunner.resolveToolRenderers(outputName, () => undefined);
    const definition = tool ? selected : { ...(selected ?? {}), renderCall: () => new Text("", 0, 0) };
    const Constructor = this.parent.constructor as unknown as BodyConstructor;
    let alive = true, suspended = false;
    const host = new Constructor(tool?.name ?? outputName, tool?.id ?? this.parent.toolCallId, tool?.args ?? {},
      this.runtime.appearance(), definition, { requestRender: () => { if (alive && !suspended) invalidate(); } }, this.parent.cwd);
    const nativeInvalidate = host.invalidate.bind(host), nativeExpanded = host.setExpanded.bind(host);
    host.invalidate = () => { if (alive && !suspended) { nativeInvalidate(); invalidate(); } };
    const output = !tool && "content" in input ? input : undefined;
    host.updateResult(tool?.result ?? { content: output!.content, details: output?.fullOutputPath === undefined ? {} : { fullOutputPath: output.fullOutputPath },
      isError: this.facts.outcome?.isError === true }, false);
    nativeExpanded(expanded);
    host.setExpanded = value => { if (alive && !suspended) setExpanded(value); };
    return {
      get children() { return alive && !suspended ? host.children : []; }, render: width => alive && !suspended ? host.render(width) : [],
      handleMouse: event => alive && !suspended ? host.handleMouse?.(event) : { handled: true },
      invalidate: () => host.invalidate(), setExpanded: value => { if (alive && !suspended) nativeExpanded(value); },
      appearance(value) { if (!alive || suspended) return;
        if (Reflect.get(host, "showImages") !== value.showImages) host.setShowImages(value.showImages);
        if (Reflect.get(host, "imageWidthCells") !== value.imageWidthCells) host.setImageWidthCells(value.imageWidthCells);
        if (Reflect.get(host, "outputPad") !== value.outputPad) host.setOutputPad(value.outputPad);
      },
      suspend: value => { suspended = value; },
      dispose: () => { alive = false; suspended = true; },
    };
  }
}
