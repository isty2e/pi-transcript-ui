import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import { isRecord } from "./intent.js";
import { Spacer, stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { classifyTool, type ToolGroupingRules, type ToolClassification } from "./classify.js";
import { changeText, failureText, countResultLines, codemodeLine, displayFor, DEFAULT_DISPLAY_LIMITS, type DisplayLimits, type LineParts, type CommandSpan } from "./display.js";
import { interpretToolSummary, toolSummaryLine } from "./tool-summary.js";
import { intentFromArgs } from "./intent.js";
import type { DisclosureTarget } from "./navigation.js";
import { fileReadFor } from "./read-body.js";
import { fileMutationFor } from "./file-mutation.js";
import { createPatchRequestParser } from "./patch-request.js";
import { summaryMetrics, type FileCapabilities } from "./tool-metrics.js";
import { groupSummary, groupSummaryRequirements, type GroupMemberSummary } from "./group-summary.js";
import type { CodemodePresentation, CodemodeScope, GroupRow, ItemToolkit, CodemodeProjection } from "./codemode/view.js";
import { createCommandColorizer } from "./shell-colors.js";
import { codemodeSummary } from "./codemode/summary.js";
import { shellSessionSummary } from "./shell-session-summary.js";
import { toolDurationMs } from "./tool-duration.js";
import { toolPhase, type ToolPhase } from "./tool-phase.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

export interface RowTheme {
  getFgAnsi?: Theme["getFgAnsi"];
  bold(text: string): string;
  fg(style: "error" | "toolDiffAdded" | "toolDiffRemoved" | "thinkingText", text: string): string;
}

/** Structural boundary for the actual Pi instance, not a locally imported class. */
export interface NativeToolComponent extends Component {
  children: Component[];
  toolName: string;
  toolCallId: string;
  args: unknown;
  cwd?: string;
  toolDefinition?: { parameters?: unknown };
  result?: { content?: unknown; isError?: boolean; details?: unknown; durationMs?: unknown };
  expanded: boolean;
  isPartial: boolean;
  readonly executionStarted?: boolean;
  updateDisplay(): void;
  setExpanded(expanded: boolean): void;
  updateArgs(args: unknown): void;
  updateResult(result: unknown, isPartial?: boolean): void;
  addChild(child: Component): void;
  removeChild(child: Component): void;
  clear(): void;
}
interface ChatContainer extends Component {
  children: Component[];
  addChild(child: Component): void;
  removeChild(child: Component): void;
  clear(): void;
}

function isTool(value: Component): value is NativeToolComponent {
  const c = value as Partial<NativeToolComponent>;
  return typeof c.toolName === "string" && typeof c.toolCallId === "string" &&
    typeof c.expanded === "boolean" && typeof c.isPartial === "boolean" &&
    typeof c.setExpanded === "function" && typeof c.updateDisplay === "function" &&
    typeof c.updateArgs === "function" && typeof c.updateResult === "function" &&
    typeof c.addChild === "function" && typeof c.removeChild === "function" && typeof c.clear === "function";
}

function phaseFor(tool: NativeToolComponent): ToolPhase {
  return toolPhase({ hasResult: Boolean(tool.result), isPartial: tool.isPartial, executionStarted: tool.executionStarted === true });
}

type SummaryTool = Pick<NativeToolComponent, "toolName" | "toolCallId" | "args" | "result" | "cwd">;

function shellSessionFor(tool: SummaryTool, capabilities: FileCapabilities, phase: ToolPhase, parameters?: unknown) {
  if (tool.toolName !== "exec_command" && tool.toolName !== "write_stdin") return undefined;
  if (capabilities.mutation || capabilities.read || capabilities.patch) return undefined;
  return shellSessionSummary({ toolName: tool.toolName, parameters, args: tool.args,
    result: tool.result, isPartial: phase !== "settled" });
}

interface NativeAssistantComponent extends Component {
  updateContent(...args: unknown[]): unknown;
  isStreaming: boolean;
  hasToolCalls: boolean;
  children: Component[];
  contentContainer: Component & { children: Component[] };
}
function isAssistant(component: Component): component is NativeAssistantComponent {
  const value = component as Partial<NativeAssistantComponent>;
  return component.constructor?.name === "AssistantMessageComponent" && typeof value.updateContent === "function" &&
    typeof value.isStreaming === "boolean" && typeof value.hasToolCalls === "boolean" &&
    Array.isArray(value.children) && Array.isArray(value.contentContainer?.children);
}
function transparentAssistant(component: Component): boolean {
  return isAssistant(component) && !component.isStreaming && component.hasToolCalls &&
    component.children.length === 1 && component.children[0] === component.contentContainer && component.contentContainer.children.length === 0;
}
function readPathKey(tool: Pick<NativeToolComponent, "args" | "cwd">, requireBase = false): string | undefined {
  if (!isRecord(tool.args) || typeof tool.args.path !== "string" || !tool.args.path || tool.args.path.includes("\0")) return undefined;
  let path = tool.args.path.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
  if (!path || path.startsWith("file:") || (process.platform === "win32" && path.startsWith("/"))) return undefined;
  if (path === "~" || path.startsWith("~/")) path = homedir() + path.slice(1);
  if (isAbsolute(path)) return JSON.stringify(["absolute", normalize(path)]);
  return typeof tool.cwd === "string" && isAbsolute(tool.cwd)
    ? JSON.stringify(["absolute", resolve(tool.cwd, path)]) : requireBase ? undefined : JSON.stringify(["relative", normalize(path)]);
}

export function styleLine(theme: RowTheme, parts: LineParts, error = false,
  colorCommand?: (command: CommandSpan, text: string, theme: RowTheme) => string): string {
  let rest = parts.intent ? parts.rest.slice(0, parts.intent.offset) : parts.rest;
  if (parts.change && !error) {
    const { offset } = parts.change;
    const original = ` ${changeText(parts.change)}`;
    rest = rest.slice(0, offset) + ` ${changeText(parts.change, (kind, text) => theme.fg(kind, text))}` + rest.slice(offset + original.length);
  }
  if (parts.failure && !error) {
    const { count, offset } = parts.failure;
    const text = failureText(count);
    rest = rest.slice(0, offset) + theme.fg("error", text) + rest.slice(offset + text.length);
  }
  if (parts.command && colorCommand && !error) {
    const { offset, length } = parts.command;
    rest = rest.slice(0, offset) + colorCommand(parts.command, rest.slice(offset, offset + length), theme) + rest.slice(offset + length);
  }
  const line = `${parts.marker} ${theme.bold(parts.action)}${rest}`;
  const prefix = error ? theme.fg("error", line) : line;
  if (!parts.intent) return prefix;
  const { offset, length } = parts.intent;
  const purpose = theme.fg("thinkingText", stripTerminalSequences(parts.rest.slice(offset, offset + length)));
  const ending = parts.rest.slice(offset + length);
  return prefix + purpose + (error && ending ? theme.fg("error", ending) : ending);
}

/** text is a getter so the delegate's content fingerprint observes partial updates. */
class SummaryRow implements Component {
  private fitted: { width: number; text: string; line: string }[] = [];
  constructor(private readonly readText: (width?: number) => string, private readonly maxWidth = DEFAULT_DISPLAY_LIMITS.rowMaxWidth) {}
  private fit(width: number): string {
    const text = this.readText(width).replace(/[\r\n\t]/g, " ");
    const cached = this.fitted.find(entry => entry.width === width && entry.text === text);
    if (cached) return cached.line;
    const line = truncateToWidth(text, width);
    this.fitted.unshift({ width, text, line });
    this.fitted.length = Math.min(this.fitted.length, 2);
    return line;
  }
  get text(): string { return this.fit(this.maxWidth); }
  render(width: number): string[] {
    const available = Math.max(0, Math.min(width, this.maxWidth));
    return [this.fit(available)];
  }
  invalidate(): void { this.fitted = []; }
}

function createSummaryRow(read: Parameters<ItemToolkit["row"]>[0], getTheme: () => RowTheme, maxWidth?: number): ReturnType<ItemToolkit["row"]> {
  let colorizer: ReturnType<typeof createCommandColorizer> | undefined;
  let active = true;
  const format = (parts: LineParts, error = false): string => {
    if (error || !parts.command) colorizer?.clear();
    return styleLine(getTheme(), parts, error, (command, text, theme) =>
      active ? (colorizer ??= createCommandColorizer()).format(command, text, theme) : text);
  };
  const row = new SummaryRow(width => read(width, format), maxWidth);
  return Object.assign(row, { dispose(): void { active = false; row.invalidate(); colorizer?.clear(); colorizer = undefined; } });
}

class DisclosureGroup extends SummaryRow implements GroupRow {
  readonly kind = "group" as const;
  get label(): string { return this.text; }
  readonly toolName = "__group__";
  protected open = false;
  constructor(readonly toolCallId: string, read: () => string, private readonly busy: () => boolean,
    private readonly redraw: () => void, maxWidth?: number, private readonly getParent?: () => DisclosureTarget) { super(read, maxWidth); }
  get parent(): DisclosureTarget | undefined { return this.getParent?.(); }
  get expanded(): boolean { return this.open || this.busy(); }
  setExpanded(value: boolean): void { this.open = value; this.redraw(); }
  inheritExpansion(other: DisclosureTarget): void { if (other instanceof DisclosureGroup) this.open ||= other.open; }
  handleMouse(event: Parameters<NonNullable<Component["handleMouse"]>>[0]) {
    if (event.button !== "left") return undefined;
    if (event.type === "press") return { handled: true };
    if (event.type === "click") { this.setExpanded(!this.expanded); return { handled: true }; }
    return undefined;
  }
}

class ToolGroup extends DisclosureGroup {
  readonly members: NativeToolComponent[] = [];
  private readonly classifications = new Map<NativeToolComponent, ToolClassification>();
  private revision = 0;
  private busySnapshot: { revision: number; value: boolean } | undefined;
  override invalidate(): void { this.revision++; this.busySnapshot = undefined; super.invalidate(); }
  addMember(tool: NativeToolComponent, classification: ToolClassification, inheritMemberExpansion = true): void {
    this.members.push(tool);
    this.classifications.set(tool, classification);
    if (inheritMemberExpansion) this.open ||= tool.expanded;
    this.invalidate();
  }
  resetMembers(): void { this.members.length = 0; this.classifications.clear(); this.invalidate(); }
  removeMember(tool: NativeToolComponent): void {
    const index = this.members.indexOf(tool);
    if (index >= 0) this.members.splice(index, 1);
    this.classifications.delete(tool);
    this.invalidate();
  }
  constructor(id: number, readonly classification: ToolClassification,
    private readonly getCapability: (tool: NativeToolComponent) => FileCapabilities | undefined,
    private readonly getTheme: () => RowTheme, requestRender: () => void, maxWidth?: number,
    private readonly getParameters: (tool: NativeToolComponent) => unknown = tool => tool.toolDefinition?.parameters) {
    super(`pi-transcript-ui:group:${id}`, () => this.summary(), () => this.isBusy(), requestRender, maxWidth);
  }
  private isBusy(): boolean {
    const revision = this.revision;
    if (this.busySnapshot?.revision === revision) return this.busySnapshot.value;
    const value = this.members.some(member => phaseFor(member) !== "settled");
    this.busySnapshot = { revision, value };
    return value;
  }
  private summary(): string {
    const members = this.members.map(tool => {
      const classification = this.classifications.get(tool)!;
      const capabilities = this.getCapability(tool) ?? { mutation: undefined, read: undefined };
      const phase = phaseFor(tool);
      return {
        toolName: tool.toolName,
        classification,
        capabilities,
        shellSession: shellSessionFor(tool, capabilities, phase, this.getParameters(tool)) !== undefined,
        phase,
        isError: tool.result?.isError === true,
        metrics: summaryMetrics({ toolName: tool.toolName, args: tool.args, result: tool.result,
          isPartial: phase !== "settled", classification, capabilities }),
      };
    });
    const input = { classification: this.classification, members, expanded: this.expanded };
    const required = groupSummaryRequirements(input);
    const completeMembers = members.map((member, index) => ({
      ...member,
      readPath: required.readIdentity ? readPathKey(this.members[index]!) : undefined,
      outputLines: required.outputLines && Array.isArray(this.members[index]!.result?.content) ? countResultLines(this.members[index]!.result?.content) : undefined,
    }));
    const parts = groupSummary({ ...input, members: completeMembers });
    return styleLine(this.getTheme(), parts);
  }
}

export interface PresentationOptions {
  getTheme(): RowTheme;
  requestRender(): void;
  rules?: ToolGroupingRules | null;
  displayLimits?: Readonly<Partial<DisplayLimits>>;
  resolveIntent?(toolCallId: string, args: unknown): string | undefined;
  resolveParameters?(toolName: string): unknown;
  codemode?: CodemodePresentation;
  onUnsupported?(toolName: string, error: unknown): void;
  onCleanupIncomplete?(source: CleanupSource, failure: CleanupIncomplete): void;
}
export interface PresentationAttachment {
  (): void;
  targets(): readonly DisclosureTarget[];
}

interface CleanupFailure { readonly slot: string; readonly error: unknown }
interface CleanupIncomplete { readonly kind: "cleanup-incomplete"; readonly failures: readonly CleanupFailure[] }
type CleanupOutcome = { readonly kind: "complete" } | CleanupIncomplete;
type CleanupSource = { readonly kind: "tool"; readonly toolName: string } | { readonly kind: "attachment" };
const COMPLETE: CleanupOutcome = { kind: "complete" };

function cleanupOutcome(failures: readonly CleanupFailure[]): CleanupOutcome {
  return failures.length ? { kind: "cleanup-incomplete", failures } : COMPLETE;
}

function combineCleanup(outcomes: Iterable<CleanupOutcome>): CleanupOutcome {
  const failures: CleanupFailure[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "cleanup-incomplete") for (const failure of outcome.failures) failures.push(failure);
  }
  return cleanupOutcome(failures);
}

function attemptCleanup(slot: string, action: () => void): CleanupOutcome {
  try { action(); return COMPLETE; }
  catch (error) { return cleanupOutcome([{ slot, error }]); }
}

function reportSafely(report: () => void): void {
  try { report(); } catch { /* A diagnostic cannot interrupt Pi's caller. */ }
}

function sameDescriptor(current: PropertyDescriptor | undefined, expected: PropertyDescriptor): boolean {
  if (!current || current.configurable !== expected.configurable || current.enumerable !== expected.enumerable ||
    ("value" in current) !== ("value" in expected)) return false;
  return "value" in expected ? current.value === expected.value && current.writable === expected.writable
    : current.get === expected.get && current.set === expected.set;
}

function restoreDescriptor(target: Component, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else if (!Reflect.deleteProperty(target, key)) throw new TypeError(`Cannot remove presentation property: ${key}`);
}

function restoreIfOwned(target: Component, key: string, expected: PropertyDescriptor, restore: () => void): CleanupOutcome {
  return attemptCleanup(key, () => {
    if (sameDescriptor(Object.getOwnPropertyDescriptor(target, key), expected)) restore();
  });
}

function propertyDescriptor(target: Component, key: string): PropertyDescriptor | undefined {
  let owner: object | null = target;
  while (owner) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) return descriptor;
    owner = Object.getPrototypeOf(owner);
  }
  return undefined;
}

interface NativeChildrenAccess {
  readonly enumerable: boolean;
  read(): Component[];
  write(children: Component[]): void;
  restoreIfOwned(get: () => Component[], set: (children: Component[]) => void): CleanupOutcome;
}

function captureNativeChildren(tool: NativeToolComponent): NativeChildrenAccess {
  const own = Object.getOwnPropertyDescriptor(tool, "children");
  let read: () => Component[];
  let write: (children: Component[]) => void;
  let restore: () => void;
  let enumerable: boolean;

  if (own) {
    if (!("value" in own) || !own.configurable || !own.writable || !Array.isArray(own.value)) {
      throw new TypeError("Unsupported tool children descriptor");
    }
    let children: Component[] = own.value;
    enumerable = own.enumerable ?? false;
    read = () => children;
    write = next => { children = next; };
    restore = () => Object.defineProperty(tool, "children", { ...own, value: children });
  } else {
    const inherited = propertyDescriptor(tool, "children");
    if (!inherited?.get || !inherited.set) throw new TypeError("Unsupported tool children descriptor");
    const get = inherited.get, set = inherited.set;
    read = () => get.call(tool) as Component[];
    if (!Array.isArray(read())) throw new TypeError("Unsupported native children collection");
    enumerable = inherited.enumerable ?? false;
    write = children => { set.call(tool, children); };
    restore = () => restoreDescriptor(tool, "children", undefined);
  }

  return {
    enumerable, read, write,
    restoreIfOwned(get, set) {
      return restoreIfOwned(tool, "children", { configurable: true, enumerable, get, set }, restore);
    },
  };
}

type ToolDecoration = {
  readonly toolName: string;
  target: DisclosureTarget;
  readonly group: ToolGroup | null;
  setGroup(group: ToolGroup | null): void;
  setClassification(classification: ToolClassification): void;
  setProjection(projection: CodemodeProjection): void;
  release(): CleanupOutcome;
};
type DecorationAttempt = { kind: "decorated"; binding: ToolDecoration } |
  { kind: "native"; error: unknown } | { kind: "cleanup-incomplete"; error: unknown; cleanup: CleanupIncomplete };

/** Scoped native-tree access leaves Pi's state, definition, shell and lifecycle authoritative. */
function decorateTool(tool: NativeToolComponent, initialGroup: ToolGroup | null, options: PresentationOptions, capabilities: FileCapabilities,
  classification: ToolClassification, onUpdate: (() => void) | undefined,
  onFailure: (error: unknown, cleanup: CleanupOutcome) => void, parameters?: unknown): DecorationAttempt {
  let group = initialGroup;
  const toolName = tool.toolName;
  const capability = capabilities.mutation;
  const children = captureNativeChildren(tool);
  const methodKeys = ["render", "invalidate", "updateDisplay", "updateArgs", "updateResult", "handleMouse", "setExpanded", "addChild", "removeChild", "clear"] as const;
  if (!Object.isExtensible(tool) || methodKeys.some((key) => {
    const descriptor = propertyDescriptor(tool, key);
    return descriptor ? !("value" in descriptor) || descriptor.writable !== true ||
      (typeof descriptor.value !== "function" && !(key === "handleMouse" && descriptor.value === undefined))
      : key !== "handleMouse";
  })) throw new Error("Unsupported non-writable tool component; native rendering retained");
  let nativeDepth = 0;
  let active = true;
  const native = <T>(fn: () => T): T => {
    nativeDepth++;
    try { return fn(); } finally { nativeDepth--; }
  };
  const originalRender = tool.render;
  const originalInvalidate = tool.invalidate;
  const originalUpdate = tool.updateDisplay;
  const originalArgs = tool.updateArgs;
  const originalResult = tool.updateResult;
  const originalMouse = tool.handleMouse;
  const originalExpanded = tool.setExpanded;
  const originalAdd = tool.addChild;
  const originalRemove = tool.removeChild;
  const originalClear = tool.clear;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const key of methodKeys) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(tool, key));
  }
  let projection: CodemodeProjection | undefined;
  let summaryRevision = 0;
  let summaries: { revision: number; width: number | undefined; intent: string | undefined; phase: ToolPhase;
    sourceRevision: number | undefined; items: boolean; limits: string; home: string | undefined; parts: LineParts; isError: boolean;
    command: string | undefined; durationMs: number | undefined }[] = [];
  const dirtySummary = () => {
    if (!active) return;
    summaryRevision++; summaries = [];
    row.invalidate(); group?.invalidate();
  };
  const row = createSummaryRow((width, format) => {
    const revision = summaryRevision;
    const indent = group && group.members.length > 1 ? "  " : "";
    const contentWidth = width === undefined ? undefined : Math.max(0, width - indent.length);
    const limits = options.displayLimits ?? DEFAULT_DISPLAY_LIMITS;
    const limitsKey = `${limits.rowMaxWidth}:${limits.commandMaxWidth}:${limits.intentMaxWidth}:${limits.commandPreview}:${limits.toolDuration}`;
    const home = process.env["HOME"];
    const intent = options.resolveIntent ? options.resolveIntent(tool.toolCallId, tool.args) : intentFromArgs(tool.args);
    const itemProjection = projection?.items ? projection : undefined;
    const outcome = itemProjection?.outcome;
    const phase = outcome ? "settled" : phaseFor(tool);
    const sourceRevision = itemProjection?.summaryRevision, items = itemProjection !== undefined;
    const commandValue = tool.toolName === "bash" && isRecord(tool.args) ? tool.args.command : undefined;
    const command = typeof commandValue === "string" ? commandValue : undefined;
    const cacheable = items || (command !== undefined && !capabilities.mutation && !capabilities.read && !capabilities.patch && classification.operation !== "read");
    const isError = outcome?.isError ?? tool.result?.isError === true;
    const durationMs = outcome ? outcome.durationMs : toolDurationMs(tool.result, tool.isPartial);
    let cachedSummary = cacheable ? summaries.find(entry => entry.revision === revision && entry.width === contentWidth &&
      entry.intent === intent && entry.phase === phase && entry.sourceRevision === sourceRevision && entry.items === items &&
      entry.limits === limitsKey && entry.home === home && entry.command === command && entry.isError === isError && entry.durationMs === durationMs) : undefined;
    if (!cachedSummary) {
      const layout = { limits, ...(contentWidth === undefined ? {} : { width: contentWidth }) };
      const display = displayFor(tool.toolName, tool.args, capability, capabilities.read, capabilities.patch);
      const code = itemProjection ? itemProjection.summary(phase) : display === null ? codemodeSummary({ toolName: tool.toolName, args: tool.args,
        result: tool.result, phase }) : undefined;
      const context = { intent, layout, durationMs };
      const parts = code ? codemodeLine({ summary: code, isError, ...context })
        : toolSummaryLine(interpretToolSummary({toolName: tool.toolName, request: {args: tool.args, complete: true, source: "live"},
          result: tool.result, lifecycle: {kind: "native", phase}, parameters, classification, capabilities}), context);
      cachedSummary = { revision, width: contentWidth, intent, phase, sourceRevision, items, limits: limitsKey, home, parts, isError, command, durationMs };
      if (cacheable) { summaries.unshift(cachedSummary); summaries.length = Math.min(summaries.length, 2); }
      else summaries = [];
    }
    const { parts } = cachedSummary;
    return `${indent}${format({ ...parts, rest: `${parts.rest}${projection?.fallback ? " (original)" : ""}`,
      ...(itemProjection ? { action: phase === "pending" ? "Run code" : phase === "running" ? "Running code" : "Ran code" } : {}),
      marker: tool.expanded ? "▾" : "▸" }, isError)}`;
  }, options.getTheme, options.displayLimits?.rowMaxWidth);
  // Items mode paints the live call slot only through its separate Call row.
  const body: Component & { readonly children: Component[] } = {
    get children() { return children.read(); },
    render: (width) => native(() => originalRender.call(tool, width)),
    invalidate: () => native(() => originalInvalidate.call(tool)),
  };
  const spacer = new Spacer(1);
  const projectedChildren = (): Component[] => {
    const current = group;
    const grouped = current !== null && current.members.length > 1;
    const first = !grouped || current.members[0] === tool;
    const header: Component[] = first ? [spacer, ...(grouped ? [current] : [])] : [];
    if (grouped && !current.expanded) return header;
    return [...header, row, ...(!projection?.items && tool.expanded ? [body] : [])];
  };
  const target: DisclosureTarget = {
    kind: "tool",
    get label() { return row.text; },
    get expanded() { return tool.expanded; },
    get parent() { return group && group.members.length > 1 ? group : undefined; },
    setExpanded(expanded) { if (active) tool.setExpanded(expanded); },
  };
  const childrenGet = () => nativeDepth > 0 || !active ? children.read()
    : projection?.items ? projection.parentChildren(projectedChildren) : projectedChildren();
  const childrenSet = (next: Component[]) => children.write(next);
  const render: NativeToolComponent["render"] = function (width) {
    if (!active || nativeDepth > 0) return native(() => originalRender.call(tool, width));
    return projection?.items ? projection.parentLines(width, () => childrenGet().flatMap(child => child.render(width)))
      : projectedChildren().flatMap((child) => child.render(width));
  };
  const update = () => {
    dirtySummary();
    native(() => originalUpdate.call(tool));
    if (active && nativeDepth === 0) {
      try { onUpdate?.(); projection?.changed(); }
      catch (error) { onFailure(error, release()); }
    }
  };
  const invalidate = () => { dirtySummary(); native(() => originalInvalidate.call(tool)); if (active) projection?.changed(); };
  const changedData = () => {
    if (!active) return;
    dirtySummary();
    try { onUpdate?.(); projection?.observe(); }
    catch (error) { onFailure(error, release()); }
  };
  const updateArgs: NativeToolComponent["updateArgs"] = args => { dirtySummary(); native(() => originalArgs.call(tool, args)); changedData(); };
  const updateResult: NativeToolComponent["updateResult"] = (result, partial) => { dirtySummary(); native(() => originalResult.call(tool, result, partial)); changedData(); };
  const mouse: NonNullable<Component["handleMouse"]> = (event) => {
    if (!active || nativeDepth > 0) return native(() => originalMouse?.call(tool, event));
    if (projection?.items && !projection.current(event.width)) { options.requestRender(); return { handled: true }; }
    const children = projectedChildren();
    let offset = 0;
    for (const child of children) {
      const height = child.render(event.width).length;
      if (event.y >= offset && event.y < offset + height) {
        if (child === body) return native(() => originalMouse?.call(tool, { ...event, y: event.y - offset, height }));
        if (child === spacer) return undefined;
        if (event.type === "press" && event.button === "left") return { handled: true };
        if (event.type === "click" && event.button === "left") {
          const selected = child === group ? group : target;
          selected.setExpanded(!selected.expanded);
          options.requestRender();
          return { handled: true };
        }
      }
      offset += height;
    }
    return undefined;
  };
  const setExpanded = (expanded: boolean) => {
    native(() => originalExpanded.call(tool, expanded));
    if (active) projection?.changed();
    if (active && expanded) {
      try { group?.setExpanded(true); }
      catch (error) { onFailure(error, release()); }
    }
  };
  const add = (child: Component) => native(() => originalAdd.call(tool, child));
  const remove = (child: Component) => native(() => originalRemove.call(tool, child));
  const clear = () => native(() => originalClear.call(tool));
  const replacements = { render, invalidate, updateDisplay: update, updateArgs, updateResult, handleMouse: mouse, setExpanded, addChild: add, removeChild: remove, clear };
  const installed = new Map<string, PropertyDescriptor>();
  function release(): CleanupOutcome {
    active = false;
    summaries = []; row.invalidate();
    const outcomes = [attemptCleanup("command colorizer", () => row.dispose())];
    for (const [key, expected] of installed) {
      outcomes.push(restoreIfOwned(tool, key, expected, () => restoreDescriptor(tool, key, descriptors.get(key))));
    }
    outcomes.push(children.restoreIfOwned(childrenGet, childrenSet));
    return combineCleanup(outcomes);
  }

  try {
    Object.defineProperty(tool, "children", { configurable: true, enumerable: children.enumerable, get: childrenGet, set: childrenSet });
    for (const key of methodKeys) {
      const expected = { ...(descriptors.get(key) ?? { configurable: true, enumerable: true, writable: true }), value: replacements[key] };
      installed.set(key, expected);
      Object.defineProperty(tool, key, expected);
    }
  } catch (error) {
    const cleanup = release();
    return cleanup.kind === "complete" ? { kind: "native", error } : { kind: "cleanup-incomplete", error, cleanup };
  }
  return { kind: "decorated", binding: { toolName, target, get group() { return group; }, setGroup(next) { group = next; dirtySummary(); },
    setClassification(next) { classification = next; dirtySummary(); }, setProjection(next) { projection = next; dirtySummary(); }, release } };
}

export class UnsupportedTranscriptContainerError extends Error {
  constructor() {
    super("Unsupported Pi transcript container; native tools left unchanged");
    this.name = "UnsupportedTranscriptContainerError";
  }
}

/** Attach to the actual chat container without owning the editor or footer. */
export function attachTranscriptPresentation(root: unknown, options: PresentationOptions): PresentationAttachment {
  const children = isRecord(root) ? root.children : undefined;
  const document = (Array.isArray(children) ? children[0] : undefined) as Partial<ChatContainer> | undefined;
  // Pi 0.85.1 puts header, resource notices and chat inside its document.
  // A directly supplied chat container remains supported by the adapter API.
  const sections = isRecord(document) ? document.children : undefined;
  if (!Array.isArray(sections)) throw new UnsupportedTranscriptContainerError();
  for (const section of sections) if (!isRecord(section)) throw new UnsupportedTranscriptContainerError();
  const nested = sections.length === 3 && sections.every((section) =>
    !isTool(section) && Array.isArray((section as Partial<ChatContainer>).children) &&
    typeof (section as Partial<ChatContainer>).addChild === "function" &&
    typeof (section as Partial<ChatContainer>).clear === "function");
  const chat = (nested ? sections[2] : document) as Partial<ChatContainer> | undefined;
  if (!chat || !Array.isArray(chat.children) || typeof chat.addChild !== "function" ||
    typeof chat.removeChild !== "function" || typeof chat.clear !== "function") {
    throw new UnsupportedTranscriptContainerError();
  }
  const container = chat as ChatContainer;
  const renderDescriptor = propertyDescriptor(container, "render");
  const canProject = Boolean(options.codemode && Object.isExtensible(container) && renderDescriptor &&
    "value" in renderDescriptor && renderDescriptor.writable && typeof renderDescriptor.value === "function");
  const releases = new Map<Component, () => CleanupOutcome>();
  const declined = new WeakSet<Component>();
  const decorations = new Map<NativeToolComponent, ToolDecoration>();
  const classifications = new Map<NativeToolComponent, ToolClassification>();
  const assistants = new Set<Component>();
  const capabilities = new Map<NativeToolComponent, FileCapabilities>();
  const parameters = new Map<NativeToolComponent, unknown>();
  const scopes = new Map<NativeToolComponent, CodemodeScope>();
  const sources = new Map<Component, NativeToolComponent>();
  const childParameters = new Map<string, unknown>();
  const sourceChildren = () => container.children.map(child => sources.get(child) ?? child);
  let run: ToolGroup | null = null;
  let groupId = 0;
  let active = true;
  let structureDirty = true;
  let observedChildren: Component[] = [];
  const originalAdd = container.addChild;
  const originalRemove = container.removeChild;
  const originalClear = container.clear;
  const originalRender = container.render;
  const originalDescriptors = new Map(["addChild", "removeChild", "clear", "render"].map((key) => [key, Object.getOwnPropertyDescriptor(container, key)]));
  const toolkit: ItemToolkit = {
    row: read => createSummaryRow(read, options.getTheme, options.displayLimits?.rowMaxWidth),
    requestRender: options.requestRender,
    describe(record, matched, source, parent) {
      const input = matched ? options.codemode?.runtime.input(matched) : undefined;
      if (source?.kind !== "history" && !childParameters.has(record.name)) childParameters.set(record.name, options.resolveParameters?.(record.name));
      const schema = source?.kind === "history" ? source.parameters : childParameters.get(record.name);
      const request = input ? {args: input.args, complete: true, source: "live" as const} : source?.request;
      const args = request?.args, result = input?.result;
      const mutation = fileMutationFor(schema), read = fileReadFor(schema);
      const patchParser = !mutation && !read ? createPatchRequestParser(schema) : undefined;
      const patch = patchParser?.(args);
      const caps: FileCapabilities = { mutation, read, patch };
      const classification = classifyTool(record.name, options.rules, mutation ?? patch);
      const summary = interpretToolSummary({toolName: record.name, request, result, parameters: schema, classification, capabilities: caps,
        lifecycle: {kind: "activity", status: record.status, parentFinal: parent.final}, preview: record.preview,
        declaredAction: mutation?.action ?? (read ? "Read" : patchParser ? "Patch" : undefined)});
      const member: GroupMemberSummary = { toolName: record.name, classification, capabilities: caps, phase: summary.phase,
        isError: summary.status === "error", completion: summary.status === "unknown" || summary.status === "cancelled" ? summary.status : undefined,
        metrics: summary.metrics,
        readPath: summary.display?.action === "Read" && summary.display.target.kind === "path"
          ? readPathKey({ args, ...(parent.cwd === undefined ? {} : { cwd: parent.cwd }) }, true) : undefined,
        outputLines: Array.isArray(result?.content) ? countResultLines(result.content) : undefined,
        shellSession: summary.shell !== undefined };
      return { classification, member, line(width) {
        const layout = { limits: options.displayLimits ?? DEFAULT_DISPLAY_LIMITS, ...(width === undefined ? {} : { width }) };
        const intent = input && options.resolveIntent ? options.resolveIntent(input.id, args) : intentFromArgs(args);
        const context = { intent, layout, durationMs: result?.durationMs ?? record.durationMs };
        return toolSummaryLine(summary, context);
      } };
    },
    group(id, classification, members, parent, indent) {
      const header: DisclosureGroup = new DisclosureGroup(id, () => " ".repeat(indent()) + styleLine(options.getTheme(), groupSummary({ classification,
        members: members(), expanded: header.expanded })), () => members().some(member => member.phase !== "settled"),
      options.requestRender, options.displayLimits?.rowMaxWidth, parent);
      return header;
    },
  };
  const reportUnsupported = (name: string, error: unknown) => reportSafely(() => options.onUnsupported?.(name, error));
  const reportCleanup = (source: CleanupSource, outcome: CleanupOutcome) => {
    if (outcome.kind === "cleanup-incomplete") reportSafely(() => options.onCleanupIncomplete?.(source, outcome));
  };
  const unpublishTool = (child: NativeToolComponent, binding: ToolDecoration): CleanupOutcome => {
    if (decorations.get(child) !== binding) return COMPLETE;
    structureDirty = true;
    releases.delete(child);
    decorations.delete(child);
    classifications.delete(child);
    capabilities.delete(child);
    parameters.delete(child);
    return attemptCleanup("group membership", () => binding.group?.removeMember(child));
  };
  const releaseChild = (child: Component): CleanupOutcome => {
    const release = releases.get(child);
    if (!release) return COMPLETE;
    structureDirty = true;
    releases.delete(child);
    try { return release(); }
    catch (error) { return cleanupOutcome([{ slot: "component release", error }]); }
  };
  const observe = (child: Component): void => {
    if (!active || releases.has(child) || declined.has(child)) return;
    if (!isTool(child)) {
      if (isAssistant(child) && !assistants.has(child)) {
        const original = child.updateContent;
        const descriptor = Object.getOwnPropertyDescriptor(child, "updateContent");
        let observing = true;
        const update: typeof original = function (this: NativeAssistantComponent, ...args) {
          if (!active || !observing) return original.apply(this, args);
          let before: boolean | undefined;
          let observationError: unknown;
          try { before = transparentAssistant(child); } catch (error) { observationError = error; }
          const result = original.apply(this, args);
          try {
            if (before === undefined) throw observationError;
            if (active && before !== transparentAssistant(child)) reconcile();
          } catch (error) {
            declined.add(child);
            const cleanup = releaseChild(child);
            if (cleanup.kind === "complete") reportUnsupported("assistant", error);
            else reportCleanup({ kind: "attachment" }, cleanup);
          }
          return result;
        };
        const expected = { ...(descriptor ?? { configurable: true, enumerable: true, writable: true }), value: update };
        const release = () => {
          observing = false;
          assistants.delete(child);
          return restoreIfOwned(child, "updateContent", expected, () => restoreDescriptor(child, "updateContent", descriptor));
        };
        try {
          Object.defineProperty(child, "updateContent", expected);
          assistants.add(child);
          releases.set(child, release);
        } catch (error) {
          declined.add(child);
          const cleanup = release();
          if (cleanup.kind === "complete") reportUnsupported("assistant", error);
          else reportCleanup({ kind: "attachment" }, cleanup);
        }
      }
      if (!assistants.has(child) || !transparentAssistant(child)) run = null;
      return;
    }
    let capability: FileCapabilities = { mutation: undefined, read: undefined };
    let parsePatch: ReturnType<typeof createPatchRequestParser>;
    try {
      const schema = options.resolveParameters?.(child.toolName) ?? child.toolDefinition?.parameters;
      parameters.set(child, schema);
      const mutation = fileMutationFor(schema), read = fileReadFor(schema);
      parsePatch = !mutation && !read ? createPatchRequestParser(schema) : undefined;
      capability = { mutation, read, get patch() { return parsePatch?.(child.args); } };
    } catch {
      // Opaque definitions retain native fallback.
    }
    const classify = () => classifyTool(child.toolName, options.rules, capability.mutation ?? capability.patch);
    const refresh = () => {
      const previous = classifications.get(child);
      if (!active || !previous) return;
      const next = classify();
      if (previous.family === next.family && previous.operation === next.operation && previous.evidence === next.evidence) return;
      classifications.set(child, next);
      decorations.get(child)?.setClassification(next);
      reconcile();
    };
    const classification = classify();
    if (classification.family === null) run = null;
    else if (run === null || run.classification.family !== classification.family) {
      run = new ToolGroup(groupId++, classification, (tool) => capabilities.get(tool), options.getTheme, options.requestRender, options.displayLimits?.rowMaxWidth, tool => parameters.get(tool));
    }
    const group = run;
    const name = child.toolName;
    let decorated: ToolDecoration | undefined;
    const failed = (error: unknown, cleanup: CleanupOutcome) => {
      declined.add(child);
      parameters.delete(child);
      run = null;
      parsePatch = undefined;
      const published = decorated !== undefined && decorations.get(child) === decorated;
      const outcomes = [cleanup, decorated ? unpublishTool(child, decorated) : COMPLETE];
      if (published) outcomes.push(attemptCleanup("group reconciliation", reconcileGroups));
      const outcome = combineCleanup(outcomes);
      if (outcome.kind === "complete") reportUnsupported(name, error);
      else reportCleanup({ kind: "tool", toolName: name }, outcome);
    };
    let attempt: DecorationAttempt;
    try { attempt = decorateTool(child, group, options, capability, classification, parsePatch ? refresh : undefined, failed, parameters.get(child)); }
    catch (error) {
      declined.add(child);
      parameters.delete(child);
      run = null;
      reportUnsupported(name, error);
      return;
    }
    if (attempt.kind !== "decorated") {
      failed(attempt.error, attempt.kind === "native" ? COMPLETE : attempt.cleanup);
      return;
    }
    const binding = attempt.binding;
    decorated = binding;
    try {
      decorations.set(child, binding);
      capabilities.set(child, capability);
      classifications.set(child, classification);
      group?.addMember(child, classification);
      const scope = canProject ? options.codemode?.attach(child, binding.target, toolkit, () => !binding.group || binding.group.members.length < 2 || binding.group.expanded) : undefined;
      if (scope) { scopes.set(child, scope); sources.set(scope, child); binding.setProjection(scope); }
      releases.set(child, () => {
        parsePatch = undefined;
        return combineCleanup([binding.release(), unpublishTool(child, binding)]);
      });
    } catch (error) { failed(error, binding.release()); }
  };
  const observeSafely = (child: Component) => {
    try { observe(child); }
    catch (error) {
      declined.add(child);
      parameters.delete(child as NativeToolComponent);
      run = null;
      const cleanup = releaseChild(child);
      if (cleanup.kind === "complete") reportUnsupported("component", error);
      else reportCleanup({ kind: "attachment" }, cleanup);
    }
  };
  const reconcileGroups = () => {
    const visibleExpanded = new Set([...decorations].filter(([tool, { group }]) =>
      tool.expanded && (!group || group.members.length < 2 || group.expanded)).map(([tool]) => tool));
    const previous = new Map([...decorations].map(([tool, binding]) => [tool, binding.group]));
    const oldGroups = new Set(previous.values());
    for (const group of oldGroups) group?.resetMembers();
    const used = new Set<ToolGroup>();
    run = null;
    for (const child of sourceChildren()) {
      const binding = isTool(child) ? decorations.get(child) : undefined;
      if (!binding || !isTool(child)) {
        if (!assistants.has(child) || !transparentAssistant(child)) run = null;
        continue;
      }
      const classification = classifications.get(child)!;
      const old = previous.get(child);
      if (classification.family === null) run = null;
      else if (!run || run.classification.family !== classification.family) {
        run = old && !used.has(old) && old.classification.family === classification.family ? old
          : new ToolGroup(groupId++, classification, (tool) => capabilities.get(tool), options.getTheme, options.requestRender, options.displayLimits?.rowMaxWidth, tool => parameters.get(tool));
        used.add(run);
      }
      if (run && old) run.inheritExpansion(old);
      binding.setGroup(run);
      run?.addMember(child, classification, visibleExpanded.has(child));
    }
  };
  const reconcile = () => { reconcileGroups(); options.requestRender(); };
  // Native entries can splice the actual array without calling our add/remove hooks.
  const sameChildSequence = (): boolean => {
    const children = container.children;
    if (children.length !== observedChildren.length) return false;
    for (let index = 0; index < children.length; index++) if (children[index] !== observedChildren[index]) return false;
    return true;
  };
  const replaceScopeSlot = (index: number, expected: Component, replacement: Component): void => {
    const children = container.children;
    if (children[index] !== expected) { structureDirty = true; return; }
    if (expected !== replacement) children[index] = replacement;
    if (observedChildren[index] === expected) observedChildren[index] = replacement;
  };
  let reconciling = false;
  const project = () => {
    if (!active || reconciling || !canProject || !options.codemode) return;
    if (!structureDirty && sameChildSequence()) return;
    reconciling = true;
    structureDirty = false;
    try {
      observedChildren = container.children.slice();
      const current = observedChildren.map(child => sources.get(child) ?? child), present = new Set(current);
      for (const child of releases.keys()) if (!present.has(child)) reportCleanup({ kind: "attachment" }, releaseChild(child));
      for (const child of current) observeSafely(child);
      const parents = new Set(current.filter(isTool));
      for (const [parent, scope] of scopes) if (!parents.has(parent) || !decorations.has(parent)) {
        const index = container.children.indexOf(scope);
        if (index >= 0) replaceScopeSlot(index, scope, parent);
        scopes.delete(parent); sources.delete(scope);
      }
      options.codemode.prune(new Set([...parents].filter(parent => decorations.has(parent))));
      reconcileGroups();
      for (let index = 0; index < container.children.length; index++) {
        const value = container.children[index]!, parent = sources.get(value) ?? (isTool(value) ? value : undefined);
        const scope = parent && scopes.get(parent);
        if (scope) replaceScopeSlot(index, value, scope.items ? scope : parent!);
      }
    } catch (error) {
      structureDirty = true;
      throw error;
    } finally { reconciling = false; }
  };
  const unproject = () => {
    for (let index = 0; index < container.children.length; index++) {
      const source = sources.get(container.children[index]!);
      if (source) container.children[index] = source;
    }
  };
  const clearDecorations = () => {
    const outcomes: CleanupOutcome[] = [];
    for (const child of releases.keys()) outcomes.push(releaseChild(child));
    run = null;
    return combineCleanup(outcomes);
  };
  const add = function (this: ChatContainer, child: Component): void {
    originalAdd.call(this, child);
    if (active) { observeSafely(child); project(); }
  };
  const remove = function (this: ChatContainer, child: Component): void {
    const scope = isTool(child) ? scopes.get(child) : undefined;
    originalRemove.call(this, scope && this.children.includes(scope) ? scope : child);
    if (!active) return;
    const binding = decorations.get(child as NativeToolComponent);
    const source: CleanupSource = binding ? { kind: "tool", toolName: binding.toolName } : { kind: "attachment" };
    const cleanup = releaseChild(child);
    const reconciled = attemptCleanup("transcript reconciliation", reconcileGroups);
    project();
    reportCleanup(source, combineCleanup([cleanup, reconciled]));
    try { options.requestRender(); }
    catch { /* A failed redraw does not mean restoration failed. */ }
  };
  const clear = function (this: ChatContainer): void {
    unproject();
    const cleanup = active ? clearDecorations() : COMPLETE;
    try { originalClear.call(this); }
    finally { project(); reportCleanup({ kind: "attachment" }, cleanup); }
  };
  const render = function (this: ChatContainer, width: number): string[] {
    project();
    // New metadata can admit an unchanged parent; keep view preparation outside the membership cache.
    if (active && scopes.size) for (let index = 0; index < this.children.length; index++) {
      const value = this.children[index]!, source = sources.get(value) ?? value as NativeToolComponent;
      const scope = scopes.get(source);
      if (scope) replaceScopeSlot(index, value, scope.items && scope.prepare(width) ? scope : source);
    }
    return originalRender.call(this, width);
  };
  const installedChat = new Map<string, PropertyDescriptor>();
  const restoreChatMethods = () => {
    const outcomes: CleanupOutcome[] = [];
    for (const [key, expected] of installedChat) {
      outcomes.push(restoreIfOwned(container, key, expected, () => restoreDescriptor(container, key, originalDescriptors.get(key))));
    }
    return combineCleanup(outcomes);
  };
  try {
    for (const child of sourceChildren()) observeSafely(child);
    for (const [key, replacement] of [["addChild", add], ["removeChild", remove], ["clear", clear], ...(canProject ? [["render", render] as const] : [])] as const) {
      const expected = { ...(originalDescriptors.get(key) ?? { configurable: true, enumerable: true, writable: true }), value: replacement };
      installedChat.set(key, expected);
      Object.defineProperty(container, key, expected);
    }
    project();
  } catch (error) {
    active = false;
    observedChildren = [];
    unproject(); options.codemode?.suspend();
    reportCleanup({ kind: "attachment" }, combineCleanup([clearDecorations(), restoreChatMethods()]));
    throw error;
  }
  return Object.assign(() => {
    active = false;
    observedChildren = [];
    unproject(); options.codemode?.suspend();
    reportCleanup({ kind: "attachment" }, combineCleanup([clearDecorations(), restoreChatMethods()]));
  }, {
    targets: (): readonly DisclosureTarget[] => {
      const visible: DisclosureTarget[] = [];
      const groups = new Set<DisclosureTarget>();
      for (const child of sourceChildren()) {
        const target = isTool(child) ? decorations.get(child)?.target : undefined;
        if (!target) continue;
        const parent = target.parent;
        if (parent && !groups.has(parent)) { groups.add(parent); visible.push(parent); }
        if (!parent || parent.expanded) { visible.push(target); visible.push(...(isTool(child) ? scopes.get(child)?.targets() ?? [] : [])); }
      }
      return visible;
    },
  });
}
