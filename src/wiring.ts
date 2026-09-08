import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import { isRecord } from "./intent.js";
import { Spacer, stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { classifyTool, type ToolGroupingRules, type ToolClassification } from "./classify.js";
import { changeText, failureText, countResultLines, displayFor, runningLine, settledLine, DEFAULT_DISPLAY_LIMITS, type DisplayLimits, type LineParts, type CommandSpan } from "./display.js";
import { intentFromArgs } from "./intent.js";
import type { DisclosureTarget } from "./navigation.js";
import { fileReadFor } from "./read-body.js";
import { fileMutationFor } from "./file-mutation.js";
import { summaryMetrics, type FileCapabilities } from "./tool-metrics.js";
import { groupSummary, groupSummaryRequirements } from "./group-summary.js";
import { createCommandColorizer } from "./shell-colors.js";
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
  result?: { content?: unknown; isError?: boolean };
  expanded: boolean;
  isPartial: boolean;
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
    typeof c.addChild === "function" && typeof c.removeChild === "function" && typeof c.clear === "function" && Array.isArray(c.children);
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
function readPathKey(tool: NativeToolComponent): string | undefined {
  if (!isRecord(tool.args) || typeof tool.args.path !== "string" || !tool.args.path || tool.args.path.includes("\0")) return undefined;
  let path = tool.args.path.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
  if (!path || path.startsWith("file:") || (process.platform === "win32" && path.startsWith("/"))) return undefined;
  if (path === "~" || path.startsWith("~/")) path = homedir() + path.slice(1);
  if (isAbsolute(path)) return JSON.stringify(["absolute", normalize(path)]);
  return typeof tool.cwd === "string" && isAbsolute(tool.cwd)
    ? JSON.stringify(["absolute", resolve(tool.cwd, path)]) : JSON.stringify(["relative", normalize(path)]);
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
  constructor(private readonly readText: (width?: number) => string, private readonly maxWidth = DEFAULT_DISPLAY_LIMITS.rowMaxWidth) {}
  private textAt(width?: number): string { return this.readText(width).replace(/[\r\n\t]/g, " "); }
  get text(): string { return truncateToWidth(this.textAt(this.maxWidth), this.maxWidth); }
  render(width: number): string[] {
    const available = Math.max(0, Math.min(width, this.maxWidth));
    return [truncateToWidth(this.textAt(available), available)];
  }
  invalidate(): void {}
}

class ToolGroup extends SummaryRow implements DisclosureTarget {
  readonly kind = "group" as const;
  get label(): string { return this.text; }
  readonly toolName = "__group__";
  readonly toolCallId: string;
  readonly members: NativeToolComponent[] = [];
  private open = false;
  private readonly classifications = new Map<NativeToolComponent, ToolClassification>();
  addMember(tool: NativeToolComponent, classification: ToolClassification, inheritMemberExpansion = true): void {
    this.members.push(tool);
    this.classifications.set(tool, classification);
    if (inheritMemberExpansion) this.open ||= tool.expanded;
  }
  inheritExpansion(other: ToolGroup): void { this.open ||= other.open; }
  resetMembers(): void { this.members.length = 0; this.classifications.clear(); }
  removeMember(tool: NativeToolComponent): void {
    this.members.splice(this.members.indexOf(tool), 1);
    this.classifications.delete(tool);
  }
  constructor(id: number, readonly classification: ToolClassification,
    private readonly getCapability: (tool: NativeToolComponent) => FileCapabilities | undefined,
    private readonly getTheme: () => RowTheme, private readonly requestRender: () => void, maxWidth?: number) {
    super(() => this.summary(), maxWidth);
    this.toolCallId = `pi-transcript-ui:group:${id}`;
  }
  get expanded(): boolean {
    return this.open || this.members.some((m) => !m.result || m.isPartial);
  }
  setExpanded(expanded: boolean): void { this.open = expanded; this.requestRender(); }
  private summary(): string {
    const members = this.members.map(tool => {
      const classification = this.classifications.get(tool)!;
      const capabilities = this.getCapability(tool) ?? { mutation: undefined, read: undefined };
      return {
        toolName: tool.toolName,
        classification,
        capabilities,
        settled: Boolean(tool.result && !tool.isPartial),
        isError: tool.result?.isError === true,
        metrics: summaryMetrics({ toolName: tool.toolName, args: tool.args, result: tool.result,
          isPartial: tool.isPartial, classification, capabilities }),
      };
    });
    const input = { classification: this.classification, members, expanded: this.expanded };
    const required = groupSummaryRequirements(input);
    const completeMembers = members.map((member, index) => ({
      ...member,
      readPath: required.readIdentity ? readPathKey(this.members[index]!) : undefined,
      outputLines: required.outputLines ? countResultLines(this.members[index]!.result?.content) : 0,
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
  onUnsupported?(toolName: string, error: unknown): void;
}
export interface PresentationAttachment {
  (): void;
  targets(): readonly DisclosureTarget[];
}

/** Scoped native-tree access leaves Pi's state, definition, shell and lifecycle authoritative. */
function decorateTool(tool: NativeToolComponent, initialGroup: ToolGroup | null, options: PresentationOptions, capabilities: FileCapabilities, classification: ToolClassification) {
  let group = initialGroup;
  const capability = capabilities.mutation;
  const childrenDescriptor = Object.getOwnPropertyDescriptor(tool, "children");
  if (!childrenDescriptor || childrenDescriptor.configurable === false || !("value" in childrenDescriptor)) {
    throw new Error("Unsupported tool children descriptor");
  }
  const methodKeys = ["render", "invalidate", "updateDisplay", "handleMouse", "setExpanded", "addChild", "removeChild", "clear"] as const;
  if (!Object.isExtensible(tool) || methodKeys.some((key) => {
    let owner: object | null = tool;
    while (owner) {
      const d = Object.getOwnPropertyDescriptor(owner, key);
      if (d) return !("value" in d) || d.writable !== true;
      owner = Object.getPrototypeOf(owner);
    }
    return false;
  })) throw new Error("Unsupported non-writable tool component; native rendering retained");
  let nativeChildren = tool.children;
  let nativeDepth = 0;
  let active = true;
  const native = <T>(fn: () => T): T => {
    nativeDepth++;
    try { return fn(); } finally { nativeDepth--; }
  };
  const originalRender = tool.render;
  const originalInvalidate = tool.invalidate;
  const originalUpdate = tool.updateDisplay;
  const originalMouse = tool.handleMouse;
  const originalExpanded = tool.setExpanded;
  const originalAdd = tool.addChild;
  const originalRemove = tool.removeChild;
  const originalClear = tool.clear;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const key of methodKeys) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(tool, key));
  }
  let colorizer: ReturnType<typeof createCommandColorizer> | undefined;
  const colorCommand = (command: CommandSpan, text: string, theme: RowTheme): string =>
    active ? (colorizer ??= createCommandColorizer()).format(command, text, theme) : text;
  const row = new SummaryRow((width) => {
    const indent = group && group.members.length > 1 ? "  " : "";
    const layout = { limits: options.displayLimits ?? DEFAULT_DISPLAY_LIMITS, ...(width === undefined ? {} : { width: Math.max(0, width - indent.length) }) };
    const display = displayFor(tool.toolName, tool.args, capability, capabilities.read);
    const intent = options.resolveIntent ? options.resolveIntent(tool.toolCallId, tool.args) : intentFromArgs(tool.args);
    const parts = tool.result && !tool.isPartial
      ? settledLine({ toolName: tool.toolName, display, content: tool.result.content,
        isError: tool.result.isError === true, intent, layout,
        metrics: summaryMetrics({ toolName: tool.toolName, args: tool.args, result: tool.result,
          isPartial: tool.isPartial, classification, capabilities }) })
      : runningLine(tool.toolName, display, intent, layout);
    if (tool.result?.isError === true || !parts.command) colorizer?.clear();
    return `${indent}${styleLine(options.getTheme(), { ...parts, marker: tool.expanded ? "▾" : "▸" }, tool.result?.isError === true, colorCommand)}`;
  }, options.displayLimits?.rowMaxWidth);
  // This body is the entire original rendering, including its leading spacer,
  // shell, fallbacks and images. No text extraction, reindentation or truncation.
  const body: Component & { readonly children: Component[] } = {
    get children() { return nativeChildren; },
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
    return [...header, row, ...(tool.expanded ? [body] : [])];
  };
  const target: DisclosureTarget = {
    kind: "tool",
    get label() { return row.text; },
    get expanded() { return tool.expanded; },
    get parent() { return group && group.members.length > 1 ? group : undefined; },
    setExpanded(expanded) { if (active) tool.setExpanded(expanded); },
  };
  const childrenGet = () => nativeDepth > 0 || !active ? nativeChildren : projectedChildren();
  Object.defineProperty(tool, "children", {
    configurable: true, enumerable: childrenDescriptor.enumerable ?? true,
    get: childrenGet,
    set: (children: Component[]) => { nativeChildren = children; },
  });
  const render: NativeToolComponent["render"] = function (width) {
    if (!active || nativeDepth > 0) return native(() => originalRender.call(tool, width));
    return projectedChildren().flatMap((child) => child.render(width));
  };
  const update = () => native(() => originalUpdate.call(tool));
  const invalidate = () => native(() => originalInvalidate.call(tool));
  const mouse: NonNullable<Component["handleMouse"]> = (event) => {
    if (!active || nativeDepth > 0) return native(() => originalMouse?.call(tool, event));
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
    if (active && expanded) group?.setExpanded(true);
  };
  const add = (child: Component) => native(() => originalAdd.call(tool, child));
  const remove = (child: Component) => native(() => originalRemove.call(tool, child));
  const clear = () => native(() => originalClear.call(tool));
  tool.addChild = add; tool.removeChild = remove; tool.clear = clear;
  tool.render = render;
  tool.updateDisplay = update;
  tool.invalidate = invalidate;
  tool.handleMouse = mouse;
  tool.setExpanded = setExpanded;
  return { target, get group() { return group; }, setGroup(next: ToolGroup | null) { group = next; }, release: () => {
    active = false;
    colorizer?.clear();
    for (const [key, replacement] of [["render", render], ["updateDisplay", update], ["invalidate", invalidate], ["handleMouse", mouse], ["setExpanded", setExpanded], ["addChild", add], ["removeChild", remove], ["clear", clear]] as const) {
      if (Reflect.get(tool, key) !== replacement) continue;
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(tool, key, descriptor);
      else Reflect.deleteProperty(tool, key);
    }
    if (Object.getOwnPropertyDescriptor(tool, "children")?.get === childrenGet) {
      Object.defineProperty(tool, "children", { ...childrenDescriptor, value: nativeChildren });
    }
  } };
}

/** Attach to Pi 0.85's actual chat container. No prototype patch or editor/footer ownership. */
export function attachTranscriptPresentation(root: { children: Component[] }, options: PresentationOptions): PresentationAttachment {
  const document = root.children[0] as Partial<ChatContainer> | undefined;
  // Pi 0.85.1 puts header, resource notices and chat inside its document.
  // A directly supplied chat container remains supported by the adapter API.
  const sections = document?.children;
  const nested = sections?.length === 3 && sections.every((section) =>
    !isTool(section) && Array.isArray((section as Partial<ChatContainer>).children) &&
    typeof (section as Partial<ChatContainer>).addChild === "function" &&
    typeof (section as Partial<ChatContainer>).clear === "function");
  const chat = (nested ? sections[2] : document) as Partial<ChatContainer> | undefined;
  if (!chat || !Array.isArray(chat.children) || typeof chat.addChild !== "function" ||
    typeof chat.removeChild !== "function" || typeof chat.clear !== "function") {
    throw new Error("Unsupported Pi transcript container; native tools left unchanged");
  }
  const container = chat as ChatContainer;
  const releases = new Map<Component, () => void>();
  const decorations = new Map<NativeToolComponent, ReturnType<typeof decorateTool>>();
  const classifications = new Map<NativeToolComponent, ToolClassification>();
  const assistants = new Set<Component>();
  const capabilities = new Map<NativeToolComponent, FileCapabilities>();
  let run: ToolGroup | null = null;
  let groupId = 0;
  let active = true;
  const originalAdd = container.addChild;
  const originalRemove = container.removeChild;
  const originalClear = container.clear;
  const originalDescriptors = new Map(["addChild", "removeChild", "clear"].map((key) => [key, Object.getOwnPropertyDescriptor(container, key)]));
  const observe = (child: Component): void => {
    if (!active || releases.has(child)) return;
    if (!isTool(child)) {
      if (isAssistant(child) && !assistants.has(child)) {
        const original = child.updateContent;
        const descriptor = Object.getOwnPropertyDescriptor(child, "updateContent");
        const update: typeof original = function (this: NativeAssistantComponent, ...args) {
          const before = transparentAssistant(child);
          const result = original.apply(this, args);
          if (active && before !== transparentAssistant(child)) reconcile();
          return result;
        };
        try {
          child.updateContent = update;
          if (child.updateContent !== update) throw new Error("Unsupported assistant update hook");
          assistants.add(child);
          releases.set(child, () => {
            assistants.delete(child);
            if (child.updateContent === update) {
              if (descriptor) Object.defineProperty(child, "updateContent", descriptor);
              else Reflect.deleteProperty(child, "updateContent");
            }
          });
        } catch (error) { options.onUnsupported?.("assistant", error); }
      }
      if (!assistants.has(child) || !transparentAssistant(child)) run = null;
      return;
    }
    let capability: FileCapabilities = { mutation: undefined, read: undefined };
    try {
      const parameters = child.toolDefinition?.parameters;
      capability = { mutation: fileMutationFor(parameters), read: fileReadFor(parameters) };
    } catch {
      // Opaque definitions retain native fallback.
    }
    const classification = classifyTool(child.toolName, options.rules, capability.mutation);
    if (classification.family === null) run = null;
    else if (run === null || run.classification.family !== classification.family) {
      run = new ToolGroup(groupId++, classification, (tool) => capabilities.get(tool), options.getTheme, options.requestRender, options.displayLimits?.rowMaxWidth);
    }
    const group = run;
    let decorated: ReturnType<typeof decorateTool>;
    try { decorated = decorateTool(child, group, options, capability, classification); }
    catch (error) {
      run = null;
      options.onUnsupported?.(child.toolName, error);
      return;
    }
    capabilities.set(child, capability);
    group?.addMember(child, classification);
    decorations.set(child, decorated);
    classifications.set(child, classification);
    releases.set(child, () => {
      decorations.delete(child);
      classifications.delete(child);
      decorated.release();
      decorated.group?.removeMember(child);
      capabilities.delete(child);
    });
  };
  const reconcile = () => {
    const previous = new Map([...decorations].map(([tool, binding]) => [tool, binding.group]));
    const oldGroups = new Set(previous.values());
    for (const group of oldGroups) group?.resetMembers();
    const used = new Set<ToolGroup>();
    run = null;
    for (const child of container.children) {
      const binding = isTool(child) ? decorations.get(child) : undefined;
      if (!binding || !isTool(child)) {
        if (!assistants.has(child) || !transparentAssistant(child)) run = null;
        continue;
      }
      const classification = classifications.get(child)!;
      const old = previous.get(child);
      if (classification.family === null) run = null;
      else if (!run || run.classification.family !== classification.family) {
        run = old && !used.has(old) ? old : new ToolGroup(groupId++, classification, (tool) => capabilities.get(tool), options.getTheme, options.requestRender, options.displayLimits?.rowMaxWidth);
        used.add(run);
      }
      if (run && old) run.inheritExpansion(old);
      binding.setGroup(run);
      run?.addMember(child, classification, false);
    }
    options.requestRender();
  };
  const clearDecorations = () => {
    for (const release of releases.values()) release();
    releases.clear(); run = null;
  };
  const add = function (this: ChatContainer, child: Component): void {
    originalAdd.call(this, child);
    observe(child);
  };
  const remove = function (this: ChatContainer, child: Component): void {
    originalRemove.call(this, child);
    releases.get(child)?.(); releases.delete(child); reconcile();
  };
  const clear = function (this: ChatContainer): void {
    clearDecorations(); originalClear.call(this);
  };
  const restoreChatMethods = () => {
    for (const [key, replacement] of [["addChild", add], ["removeChild", remove], ["clear", clear]] as const) {
      if (container[key] !== replacement) continue;
      const descriptor = originalDescriptors.get(key);
      if (descriptor) Object.defineProperty(container, key, descriptor);
      else Reflect.deleteProperty(container, key);
    }
  };
  try {
    for (const child of container.children) observe(child);
    container.addChild = add; container.removeChild = remove; container.clear = clear;
  } catch (error) {
    active = false;
    clearDecorations(); restoreChatMethods();
    throw error;
  }
  return Object.assign(() => {
    active = false;
    clearDecorations(); restoreChatMethods();
  }, {
    targets: (): readonly DisclosureTarget[] => {
      const visible: DisclosureTarget[] = [];
      const groups = new Set<DisclosureTarget>();
      for (const child of container.children) {
        const target = isTool(child) ? decorations.get(child)?.target : undefined;
        if (!target) continue;
        const parent = target.parent;
        if (parent && !groups.has(parent)) { groups.add(parent); visible.push(parent); }
        if (!parent || parent.expanded) visible.push(target);
      }
      return visible;
    },
  });
}
