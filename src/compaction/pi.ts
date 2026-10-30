import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { isRecord } from "../intent.js";
import { currentCheckpointReader, type CheckpointSource } from "./source.js";
import { COMPACTION_DISPLAY_TYPE, compactionDisplay, declaredCheckpointRoute, checkpointRouteMismatch } from "./producer.js";
import { CompactionView } from "./view.js";

const OWNER = Symbol.for("pi-transcript-ui.compaction-presentation.v1");
const METHODS = ["renderSessionEntries", "addMessageToChat", "addCompactionCostNotice", "addCustomEntryToChat"] as const;
type NativeMethod = (this: unknown, ...args: unknown[]) => unknown;
interface Mode {
  readonly chatContainer: { children: Component[] };
  readonly sessionManager: CheckpointSource;
  readonly session?: { readonly model?: unknown; readonly extensionRunner?: { getUIContext(): { readonly theme: unknown } } };
  readonly ui: { requestRender(): void };
  readonly toolOutputExpanded?: boolean;
  getMarkdownThemeWithSettings(): MarkdownTheme;
  readonly [key: string]: unknown;
}
interface Row {
  readonly key: string;
  entry: CompactionEntry;
  billing: Component[];
  readonly component: CheckpointRow;
  plan: { readonly linked: readonly Display[]; readonly consumed: ReadonlySet<Display> };
}
interface Slot { readonly replacement: Component; readonly originals: Component[]; readonly row: Row }
interface Display {
  readonly entry: Record<string, unknown>;
  readonly renderer: NativeMethod;
  readonly nodes: Component[];
  readonly target: string;
  readonly usage: boolean;
  slot?: Component | undefined;
}
interface Patch { readonly name: string; readonly descriptor: PropertyDescriptor | undefined; readonly wrapper: NativeMethod }

class CheckpointRow extends Container {
  view: CompactionView | undefined;
  get expanded(): boolean { return this.view?.expanded ?? false; }
  setExpanded(value: boolean): void { this.view?.setExpanded(value); }
}

function checkpoint(value: unknown): CompactionEntry | undefined {
  return isRecord(value) && value.type === "compaction" && typeof value.id === "string" &&
    typeof value.summary === "string" && typeof value.tokensBefore === "number" && Number.isFinite(value.tokensBefore)
    ? value as unknown as CompactionEntry : undefined;
}

function nativeMode(value: unknown): Mode {
  if (!isRecord(value) || !Object.isExtensible(value) || !isRecord(value.chatContainer) ||
      !Array.isArray(value.chatContainer.children) || !isRecord(value.sessionManager) ||
      !isRecord(value.ui) || typeof value.ui.requestRender !== "function" ||
      typeof value.getMarkdownThemeWithSettings !== "function") throw new Error("Unsupported native compaction view");
  for (const method of ["getSessionId", "getLeafId", "getEntry"])
    if (typeof value.sessionManager[method] !== "function") throw new Error("Unsupported checkpoint source");
  for (const name of METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (typeof value[name] !== "function" || (descriptor && (!descriptor.configurable || "get" in descriptor)))
      throw new Error(`Unsupported compaction rendering boundary: ${name}`);
  }
  return value as unknown as Mode;
}

export class CompactionAttachment {
  readonly protocol = 1;
  private active = true;
  private disposed = false;
  private scope: { readonly sources: readonly (CompactionEntry | undefined)[]; cursor: number } | undefined;
  private pending: { readonly row: Row } | undefined;
  private readonly rows = new Map<string, Row>();
  private readonly folds = new Map<string, boolean>();
  private readonly displays = new Map<string, Display>();
  private readonly slots: Slot[] = [];
  private readonly patches: Patch[] = [];
  private current: () => CompactionEntry | undefined;

  constructor(private readonly mode: Mode) {
    this.current = currentCheckpointReader(() => mode.sessionManager);
  }

  get isActive(): boolean { return this.active; }

  private chat(): Component[] { return this.mode.chatContainer.children; }
  private key(id: string): string { return JSON.stringify([this.mode.sessionManager.getSessionId(), id]); }

  private prune(): void {
    const children = new Set(this.chat());
    for (let i = this.slots.length - 1; i >= 0; i--) if (!children.has(this.slots[i]!.replacement)) this.slots.splice(i, 1);
    for (const [id, row] of this.rows) if (!children.has(row.component)) this.rows.delete(id);
    for (const [id, display] of this.displays)
      if (!(display.slot ? children.has(display.slot) : display.nodes.some(node => children.has(node)))) this.displays.delete(id);
  }

  private capture(original: NativeMethod, args: unknown[]): { result: unknown; nodes: Component[] } {
    const before = this.chat().slice(), result = Reflect.apply(original, this.mode, args), after = this.chat();
    const appended = before.every((node, index) => after[index] === node) && after.length >= before.length;
    return { result, nodes: appended ? after.slice(before.length) : [] };
  }

  private replace(nodes: Component[], replacement: Component, row: Row): Component | undefined {
    if (!nodes.length) return undefined;
    const index = this.chat().indexOf(nodes[0]!);
    if (index < 0 || !nodes.every((node, offset) => this.chat()[index + offset] === node)) return undefined;
    this.chat().splice(index, nodes.length, replacement);
    this.slots.push({ replacement, originals: nodes, row });
    return replacement;
  }

  private hide(nodes: Component[], row: Row): Component | undefined {
    return this.replace(nodes, { render: () => [], invalidate() {} }, row);
  }

  private restore(slot: Slot): void {
    const index = this.chat().indexOf(slot.replacement);
    if (index >= 0) {
      if (slot.replacement === slot.row.component) for (const component of slot.originals) {
        if ("setExpanded" in component && typeof component.setExpanded === "function") component.setExpanded(slot.row.component.expanded);
      }
      this.chat().splice(index, 1, ...slot.originals);
    }
    const owned = this.slots.indexOf(slot);
    if (owned >= 0) this.slots.splice(owned, 1);
  }

  private reconcile(row: Row): void {
    if (!this.chat().includes(row.component)) return;
    for (const display of row.plan.linked) {
      if (row.plan.consumed.has(display) && !display.slot) display.slot = this.hide(display.nodes, row);
      else if (!row.plan.consumed.has(display) && display.slot) {
        const slot = this.slots.find(slot => slot.replacement === display.slot);
        if (slot) this.restore(slot);
        display.slot = undefined;
      }
    }
  }

  private rebuild(row: Row): void {
    const linked = [...this.displays.values()].filter(display => display.target === row.key);
    const details: Component[] = [], consumed = new Set<Display>();
    for (const display of linked) {
      if (!display.usage && !declaredCheckpointRoute(row.entry.details)) continue;
      try {
        const theme = this.mode.session?.extensionRunner?.getUIContext().theme;
        const rendered: unknown = Reflect.apply(display.renderer, undefined, [display.entry, { expanded: true }, theme]);
        if (!isRecord(rendered) || typeof rendered.render !== "function" || typeof rendered.invalidate !== "function") continue;
        let component = rendered as unknown as Component;
        if (!display.usage && Array.isArray(rendered.children)) {
          const content = new Container();
          for (const child of rendered.children as Component[]) content.addChild(child);
          component = content;
        }
        details.push(component); consumed.add(display);
      } catch { /* Leave the original producer content visible when cloning is unavailable. */ }
    }
    const currentView = (view: CompactionView) => this.active && row.component.view === view &&
      row.key === this.key(row.entry.id) && this.chat().includes(row.component);
    const view = new CompactionView({
      tokensBefore: row.entry.tokensBefore,
      body: new Markdown(row.entry.summary, 0, 0, this.mode.getMarkdownThemeWithSettings()),
      billing: row.billing, details,
      initialExpanded: this.folds.get(row.key) ?? Boolean(this.mode.toolOutputExpanded),
      hasRouteMismatch: () => {
        if (!this.active || row.key !== this.key(row.entry.id)) return false;
        const active = this.current();
        return active?.id === row.entry.id && this.chat().includes(row.component) && checkpointRouteMismatch(active, this.mode.session?.model);
      },
      canInteract: currentView,
      onChange: (view, expanded) => {
        if (!currentView(view)) return;
        this.folds.set(row.key, expanded);
        this.mode.ui.requestRender();
      },
    });
    row.component.view = view;
    row.plan = { linked, consumed };
    row.component.clear(); row.component.addChild(view);
    this.reconcile(row);
  }

  private patch(name: string, body: (original: NativeMethod, args: unknown[]) => unknown): void {
    const descriptor = Object.getOwnPropertyDescriptor(this.mode, name), original = this.mode[name] as NativeMethod;
    const owner = this;
    let forwardingInherited = false;
    const wrapper: NativeMethod = function (...args) {
      if (this !== owner.mode) return Reflect.apply(original, this, args);
      if (owner.active) return body(original, args);
      if (!descriptor && !forwardingInherited && Object.getOwnPropertyDescriptor(owner.mode, name)?.value === wrapper) {
        const prototype: object | null = Object.getPrototypeOf(owner.mode);
        const inherited: unknown = prototype ? Reflect.get(prototype, name, this) : undefined;
        if (typeof inherited === "function" && inherited !== wrapper) {
          forwardingInherited = true;
          try { return Reflect.apply(inherited, this, args); } finally { forwardingInherited = false; }
        }
      }
      return Reflect.apply(original, this, args);
    };
    Object.defineProperty(this.mode, name, { configurable: true, writable: true, value: wrapper });
    this.patches.push({ name, descriptor, wrapper });
  }

  adoptSourceRender(args: unknown[], invoke: () => unknown): unknown {
    if (!this.active || !Array.isArray(args[0])) return invoke();
    this.prune();
    const previous = this.scope, previousPending = this.pending;
    this.scope = { sources: args[0].filter(value => isRecord(value) && value.type === "compaction").map(checkpoint), cursor: 0 };
    this.pending = undefined;
    try { return invoke(); } finally { this.scope = previous; this.pending = previousPending; }
  }

  install(): void {
    if (Object.getOwnPropertyDescriptor(this.mode, OWNER)) throw new Error("Native compaction presentation already has an owner");
    Object.defineProperty(this.mode, OWNER, { configurable: true, value: this });
    this.patch("renderSessionEntries", (original, args) => this.adoptSourceRender(args, () => Reflect.apply(original, this.mode, args)));
    this.patch("addMessageToChat", (original, args) => {
      this.pending = undefined;
      if (!isRecord(args[0]) || args[0].role !== "compactionSummary") return Reflect.apply(original, this.mode, args);
      const source = this.scope ? this.scope.sources[this.scope.cursor++] : this.current();
      if (!source) return Reflect.apply(original, this.mode, args);
      const captured = this.capture(original, args);
      if (!captured.nodes.length) return captured.result;
      const id = this.key(source.id);
      let row = this.rows.get(id);
      if (!row || !this.chat().includes(row.component)) {
        row = { key: id, entry: source, billing: [], component: new CheckpointRow(), plan: { linked: [], consumed: new Set() } };
        this.rebuild(row);
        if (!this.replace(captured.nodes, row.component, row)) return captured.result;
        this.rows.set(id, row); this.reconcile(row);
      } else {
        row.entry = source; this.rebuild(row); this.hide(captured.nodes, row);
      }
      const token = { row };
      this.pending = token;
      queueMicrotask(() => { if (this.pending === token) this.pending = undefined; });
      return captured.result;
    });
    this.patch("addCompactionCostNotice", (original, args) => {
      const source = this.pending; this.pending = undefined;
      if (!isRecord(args[0]) || args[0].kind !== "compaction" || !source || !this.chat().includes(source.row.component) ||
          args[0].usage !== source.row.entry.usage) return Reflect.apply(original, this.mode, args);
      const captured = this.capture(original, args);
      if (!this.chat().includes(source.row.component)) return captured.result;
      source.row.billing = captured.nodes.filter(node => !(node instanceof Spacer));
      this.rebuild(source.row); this.hide(captured.nodes, source.row);
      return captured.result;
    });
    this.patch("addCustomEntryToChat", (original, args) => {
      this.pending = undefined;
      const entry = args[0];
      const display = isRecord(entry) && entry.type === "custom" && entry.customType === COMPACTION_DISPLAY_TYPE ? compactionDisplay(entry.data) : undefined;
      if (!display || !isRecord(entry) || typeof entry.id !== "string") return Reflect.apply(original, this.mode, args);
      const captured = this.capture(original, args);
      const native = captured.nodes.find(node => isRecord(node) && node.entry === entry && typeof node.renderer === "function");
      if (!native || !isRecord(native) || typeof native.renderer !== "function") return captured.result;
      const record: Display = { entry, renderer: native.renderer as NativeMethod, nodes: captured.nodes,
        target: this.key(display.compactionEntryId), usage: display.kind === "usage" };
      this.displays.set(this.key(entry.id), record);
      const row = this.rows.get(record.target);
      if (row && this.chat().includes(row.component)) this.rebuild(row);
      return captured.result;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.active = false; this.pending = undefined; this.current = () => undefined;
    const errors: unknown[] = [];
    for (let i = this.slots.length - 1; i >= 0; i--) try { this.restore(this.slots[i]!); } catch (error) { errors.push(error); }
    this.rows.clear(); this.displays.clear(); this.folds.clear();
    for (let i = this.patches.length - 1; i >= 0; i--) {
      const patch = this.patches[i]!;
      try {
        if (Object.getOwnPropertyDescriptor(this.mode, patch.name)?.value === patch.wrapper) {
          if (patch.descriptor) Object.defineProperty(this.mode, patch.name, patch.descriptor);
          else if (!Reflect.deleteProperty(this.mode, patch.name)) throw new Error(`Could not restore ${patch.name}`);
        }
        this.patches.splice(i, 1);
      } catch (error) { errors.push(error); }
    }
    if (!errors.length && Object.getOwnPropertyDescriptor(this.mode, OWNER)?.value === this && !Reflect.deleteProperty(this.mode, OWNER))
      errors.push(new Error("Could not release compaction presentation ownership"));
    if (errors.length) throw new AggregateError(errors, "Compaction presentation cleanup is incomplete");
    this.disposed = true;
  }
}

export class CompactionRuntime {
  private readonly owned = new Set<CompactionAttachment>();

  attach(value: unknown): CompactionAttachment | undefined {
    if (isRecord(value)) {
      const previous: unknown = Object.getOwnPropertyDescriptor(value, OWNER)?.value;
      if (isRecord(previous) && previous.protocol === 1 && previous.isActive === false && typeof previous.dispose === "function")
        Reflect.apply(previous.dispose, previous, []);
    }
    if (isRecord(value) && Object.hasOwn(value, "renderSessionEntries")) return undefined;
    const attachment = new CompactionAttachment(nativeMode(value));
    this.owned.add(attachment);
    try { attachment.install(); return attachment; }
    catch (error) {
      try { attachment.dispose(); this.owned.delete(attachment); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Compaction setup left pending cleanup"); }
      throw error;
    }
  }

  dispose(): void {
    const errors: unknown[] = [];
    for (const attachment of this.owned) {
      try { attachment.dispose(); this.owned.delete(attachment); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Compaction runtime cleanup is incomplete");
  }
}
