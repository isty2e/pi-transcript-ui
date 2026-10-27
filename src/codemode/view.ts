import { Text, stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import type { DisclosureTarget } from "../navigation.js";
import type { ToolClassification } from "../classify.js";
import type { GroupMemberSummary } from "../group-summary.js";
import type { LineParts } from "../display.js";
import type { ToolPhase } from "../tool-phase.js";
import type { NativeToolComponent } from "../wiring.js";
import type { ActivityRecord, MatchedTerminal, ParentOutcome, ScriptOutput } from "./model.js";
import { outputPartPreview, type OutputPart } from "./output.js";
import type { CodemodeParent, CodemodeRuntime, CompletedBody } from "./pi.js";
import { summarizeActivity, type CodemodeSummary } from "./summary.js";

export interface ItemDescription {
  readonly classification: ToolClassification;
  readonly member: GroupMemberSummary;
  line(width?: number): LineParts;
}
export interface GroupRow extends Component, DisclosureTarget {
  readonly toolName: string;
  readonly toolCallId: string;
  inheritExpansion(other: GroupRow): void;
}
export interface ItemToolkit {
  row(read: (width: number | undefined, format: (parts: LineParts, error?: boolean) => string) => string): Component & { readonly text: string; dispose(): void };
  describe(record: ActivityRecord, matched: MatchedTerminal | undefined, parent: NativeToolComponent): ItemDescription;
  group(id: string, classification: ToolClassification, members: () => readonly GroupMemberSummary[], parent: () => DisclosureTarget,
    indent: () => number): GroupRow;
  requestRender(): void;
}
export interface CodemodeProjection {
  readonly items: boolean;
  readonly fallback: boolean;
  readonly summaryRevision: number;
  readonly outcome: ParentOutcome | undefined;
  summary(phase: ToolPhase): CodemodeSummary;
  parentLines(width: number, read: () => string[]): string[];
  parentChildren(read: () => Component[]): Component[];
  current(width: number): boolean;
  observe(): void;
  changed(): void;
}

class SectionRow implements Component, DisclosureTarget {
  readonly kind = "tool" as const;
  readonly toolName: string;
  readonly toolCallId: string;
  expanded: boolean;
  private headerValue: ReturnType<ItemToolkit["row"]>;
  private live = true;
  private published: { width: number; children: Component[]; lines: string[] } | undefined;

  constructor(private readonly scope: CodemodeScope, private readonly role: "source" | "output") {
    this.toolCallId = `${scope.key}:${role}`;
    this.toolName = `__codemode_${role}__`;
    this.expanded = scope.binding.runtime.initiallyExpanded();
    this.headerValue = this.makeHeader();
  }
  private makeHeader() {
    return this.scope.toolkit.row((_width, format) => " ".repeat(this.scope.headingIndent) +
      format({ marker: this.expanded ? "▾" : "▸", action: this.role === "source" ? "Call" : "Script output",
        rest: this.role === "source" ? "" : ` (${this.scope.outputCount} ${this.scope.formattedOutput ? "sections" : "items"})` }));
  }
  reconfigure(): void { this.headerValue.dispose(); this.headerValue = this.makeHeader(); }
  get label(): string { return this.headerValue.text; }
  get parent(): DisclosureTarget { return this.scope.parentTarget; }
  setExpanded(value: boolean): void {
    if (!this.live || !this.scope.isAttached) return;
    this.expanded = value; this.scope.changed();
  }
  get children(): Component[] { return this.live ? this.published?.children ?? [this.headerValue] : []; }
  prepare(width: number): string[] {
    const children = [this.headerValue, ...(this.role === "source" && this.expanded ? [this.scope.sourceBody] : [])];
    this.published = { width, children, lines: children.flatMap(child => child.render(width)) };
    return this.published.lines;
  }
  render(width: number): string[] { return !this.live ? [] : this.published?.width === width ? this.published.lines : this.prepare(width); }
  handleMouse(event: Parameters<NonNullable<Component["handleMouse"]>>[0]) {
    if (!this.live || !this.scope.isAttached) return { handled: true };
    if (!this.scope.current(event.width) || !this.scope.children.includes(this)) {
      this.scope.toolkit.requestRender(); return { handled: true };
    }
    if (event.y === 0) {
      if (event.button === "left" && event.type === "press") return { handled: true };
      if (event.button === "left" && event.type === "click") { this.setExpanded(!this.expanded); return { handled: true }; }
      return undefined;
    }
    return this.published?.children[1]?.handleMouse?.({ ...event, y: event.y - 1, height: Math.max(0, event.height - 1) });
  }
  invalidate(): void { if (this.live && this.scope.isAttached) this.scope.changed(); }
  suspend(): void { this.published = undefined; }
  dispose(): void { this.live = false; this.headerValue.dispose(); this.published = undefined; }
}

class ItemRow implements Component, DisclosureTarget {
  readonly kind = "tool" as const;
  readonly toolCallId: string;
  readonly toolName: string;
  private headerValue: ReturnType<ItemToolkit["row"]>;
  group: GroupRow | undefined;
  section: SectionRow | undefined;
  expanded: boolean;
  description: ItemDescription | undefined;
  private body: CompletedBody | undefined;
  private matched: MatchedTerminal | undefined;
  private metadata: Text | undefined;
  private output: ScriptOutput | OutputPart | undefined;
  private outputCaption = "Script output";
  private outputPreview = "";
  private live = true;
  private published: { width: number; children: Component[]; lines: string[] } | undefined;

  constructor(readonly scope: CodemodeScope, readonly ordinal: number | "output" | `output:${number}`) {
    this.toolCallId = `${scope.key}:${ordinal}`;
    this.toolName = typeof ordinal === "number" ? "__codemode_activity__" : "__codemode_output__";
    this.expanded = scope.binding.runtime.initiallyExpanded();
    this.headerValue = this.makeHeader();
  }
  private makeHeader(): ReturnType<ItemToolkit["row"]> {
    const scope = this.scope;
    return scope.toolkit.row((width, format) => {
      const indent = scope.headingIndent + (this.group || this.section ? 2 : 0);
      const parts = this.description?.line(width === undefined ? undefined : Math.max(0, width - indent))
        ?? { marker: "", action: this.outputCaption, rest: this.outputPreview ? ` — ${this.outputPreview}` : "" };
      return `${" ".repeat(indent)}${format({ ...parts, marker: this.expanded ? "▾" : "▸" },
        this.description?.member.isError ?? scope.binding.facts.outcome?.isError === true)}`;
    });
  }
  get header(): Component & { readonly text: string } { return this.headerValue; }
  reconfigure(): void { this.headerValue.dispose(); this.headerValue = this.makeHeader(); }
  get label(): string { return this.header.text; }
  get parent(): DisclosureTarget { return this.group ?? this.section ?? this.scope.parentTarget; }
  get summary(): GroupMemberSummary { return this.description!.member; }

  update(record: ActivityRecord, matched: MatchedTerminal | undefined): void {
    if (this.matched?.terminal !== matched?.terminal || this.matched?.request !== matched?.request) {
      this.body?.dispose(); this.body = undefined;
    }
    this.matched = matched;
    this.description = this.scope.toolkit.describe(record, matched, this.scope.original);
    this.metadata = new Text([
      record.preview === undefined ? undefined : `Arguments preview: ${record.preview}`,
      `Status: ${record.status}`, record.error,
      record.durationMs === undefined ? undefined : `Recorded duration: ${record.durationMs} ms`,
      record.cost === undefined ? undefined : `Cost: $${record.cost}`,
      "Detailed result unavailable for this recorded activity.",
    ].filter(value => value !== undefined).map(value => stripTerminalSequences(value!)).join("\n"), 0, 0);
  }
  updateOutput(output: ScriptOutput | OutputPart, caption = "Script output", preview = ""): void {
    if (this.output !== output) { this.body?.dispose(); this.body = undefined; }
    const plain = stripTerminalSequences(preview).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
    this.output = output; this.outputCaption = caption; this.outputPreview = visibleWidth(plain) > 0 ? plain : "";
  }
  setExpanded(value: boolean): void {
    if (!this.live || !this.scope.isAttached) return;
    this.expanded = value; this.body?.setExpanded(value);
    if (value) this.group?.setExpanded(true);
    if (value) this.section?.setExpanded(true);
    this.scope.changed();
  }
  private content(): Component | undefined {
    if (!this.expanded) return undefined;
    const evidence = this.matched ?? this.output;
    if (!evidence) return this.metadata;
    this.body ??= this.scope.binding.createBody(evidence, this.expanded, value => this.setExpanded(value), () => this.scope.changed());
    this.body.appearance(this.scope.binding.runtime.appearance());
    return this.body;
  }
  get children(): Component[] {
    return !this.live ? [] : this.published?.children ?? [this.header];
  }
  prepare(width: number): string[] {
    if (!this.live) return [];
    const content = this.content();
    const children = [this.header, ...(content ? [content] : [])];
    this.published = { width, children, lines: children.flatMap(child => child.render(width)) };
    return this.published.lines;
  }
  render(width: number): string[] { return this.published?.width === width ? this.published.lines : this.prepare(width); }
  handleMouse(event: Parameters<NonNullable<Component["handleMouse"]>>[0]) {
    if (!this.live || !this.scope.isAttached) return { handled: true };
    if (!this.scope.current(event.width) || !this.scope.children.includes(this)) { this.scope.toolkit.requestRender(); return { handled: true }; }
    if (event.y === 0) {
      if (event.button === "left" && event.type === "press") return { handled: true };
      if (event.button === "left" && event.type === "click") { this.setExpanded(!this.expanded); return { handled: true }; }
      return undefined;
    }
    return this.published?.children[1]?.handleMouse?.({ ...event, y: event.y - 1, height: Math.max(0, event.height - 1) });
  }
  invalidate(): void { if (this.live && this.scope.isAttached) { this.body?.invalidate(); this.scope.changed(); } }
  setOutputPad(value: number): void {
    if (this.body && this.scope.binding.runtime.mode()) this.body.appearance({ ...this.scope.binding.runtime.appearance(), outputPad: value });
  }
  suspend(value: boolean): void { this.body?.suspend(value); }
  dispose(): void {
    this.live = false; this.headerValue.dispose(); this.body?.dispose();
    this.body = undefined; this.metadata = undefined; this.published = undefined;
    this.matched = undefined; this.output = undefined; this.description = undefined;
  }
}

interface Frame { width: number; revision: number; state: string; children: Component[]; lines: string[]; heights: number[] }

export class CodemodeScope implements Component, CodemodeProjection {
  private revision = 0;
  private frame: Frame | undefined;
  private parentFrame: { width: number; lines: string[] } | undefined;
  private parentNodes: Component[] | undefined;
  private sourceRow: SectionRow | undefined;
  private sourceSlot: Component | undefined;
  private sourceBodyLines: { width: number; lines: string[] } | undefined;
  private rows = new Map<number, ItemRow>();
  private outputRow: ItemRow | undefined;
  private outputSection: SectionRow | undefined;
  private outputRows: ItemRow[] = [];
  private ordered: ItemRow[] = [];
  private groups = new Map<string, GroupRow>();
  private readonly groupMembers = new Map<string, ItemRow[]>();
  private fault = false;
  private admitted = false;
  private attached = true;
  private wasNative = false;
  private model;
  private epoch = 0;
  private dataRevision = -1;
  private readonly prefix: string;
  readonly sourceBody: Component & { readonly children: Component[] };

  constructor(readonly binding: CodemodeParent, public parentTarget: DisclosureTarget, public toolkit: ItemToolkit,
    private parentVisible: () => boolean, key: string) {
    this.prefix = key;
    this.model = binding.facts;
    binding.onChange = () => this.changed();
    const scope = this;
    this.sourceBody = {
      get children() { const source = scope.sourceSlot ?? binding.source(); return source ? [source] : []; },
      render: width => {
        this.sourceSlot = binding.source();
        if (!this.sourceSlot) throw new Error("Codemode source unavailable");
        if (this.sourceBodyLines?.width !== width) this.sourceBodyLines = { width, lines: this.sourceSlot.render(width) };
        return this.sourceBodyLines.lines;
      },
      invalidate: () => this.changed(),
      handleMouse: event => this.current(event.width)
        ? this.sourceSlot?.handleMouse?.(event) : (this.toolkit.requestRender(), { handled: true }),
    };
  }
  get key(): string { return `${this.prefix}:${this.epoch}`; }
  get original(): NativeToolComponent { return this.binding.parent; }
  get isAttached(): boolean { return this.attached; }
  get headingIndent(): number { return (this.parentTarget.parent ? 2 : 0) + (this.binding.runtime.requested() === "items" ? 2 : 0); }
  get outcome(): ParentOutcome | undefined { return this.binding.facts.outcome; }
  get outputCount(): number { return this.binding.facts.output?.parts?.length ?? 0; }
  get formattedOutput(): boolean { return this.binding.facts.output?.partition === "formatted"; }
  get summaryRevision(): number { return this.revision; }
  summary(phase: ToolPhase): CodemodeSummary {
    return summarizeActivity(this.binding.facts.records, this.binding.facts.final ? "settled" : phase);
  }
  private layoutState(): string {
    let appearance = "unavailable";
    if (this.attached) try {
      const value = this.binding.runtime.appearance();
      appearance = `${value.showImages}:${value.imageWidthCells}:${value.outputPad}`;
    } catch { /* A missing host resolves to original rendering. */ }
    return `${this.binding.runtime.requested()}:${this.headingIndent}:${this.parentVisible()}:${this.parentTarget.expanded}:${this.sourceRow?.expanded}:${this.outputSection?.expanded}:${appearance}:${[...this.groups.values()].map(group => group.expanded).join(",")}`;
  }
  get content(): string { return `codemode:${this.revision}:${this.binding.facts.revision}:${this.items}:${this.layoutState()}`; }
  get items(): boolean {
    if (this.binding.runtime.requested() === "native") { this.wasNative = true; return false; }
    if (this.wasNative) { this.wasNative = false; this.fault = false; }
    if (!this.attached || this.fault) return false;
    let supported = false;
    try { supported = this.binding.supported(); } catch { /* Refuse only this parent. */ }
    if (this.binding.facts.faulted || (this.admitted && !supported)) {
      this.fault = true; this.releaseRows(); this.frame = undefined; return false;
    }
    const available = this.binding.facts.records !== undefined && supported;
    this.admitted ||= available;
    return available;
  }
  get fallback(): boolean { return this.binding.runtime.requested() !== "native" && this.binding.facts.records !== undefined && !this.items; }
  reattach(target: DisclosureTarget, toolkit: ItemToolkit, visible: () => boolean): void {
    this.parentTarget = target; this.toolkit = toolkit; this.parentVisible = visible; this.attached = true;
    if (this.binding.runtime.requested() === "native") this.wasNative = true;
    for (const row of this.rows.values()) { row.suspend(false); row.reconfigure(); }
    this.outputRow?.suspend(false); this.outputRow?.reconfigure();
    for (const row of this.outputRows) { row.suspend(false); row.reconfigure(); }
    this.outputSection?.reconfigure();
    this.sourceRow?.reconfigure();
    this.groups.clear(); this.dataRevision = -1; this.changed();
  }
  changed(): void { this.revision++; if (this.attached) this.toolkit.requestRender(); }
  observe(): void { try { this.binding.observe(); } catch { this.fault = true; this.releaseRows(); this.changed(); } }
  parentLines(width: number, read: () => string[]): string[] {
    if (this.parentFrame?.width !== width) this.parentFrame = { width, lines: read() };
    return this.parentFrame.lines;
  }
  parentChildren(read: () => Component[]): Component[] { return this.parentNodes ??= read(); }
  current(width: number): boolean { return this.frame?.width === width && this.frame.revision === this.revision && this.frame.state === this.layoutState(); }

  private sync(): void {
    const facts = this.binding.facts;
    if (this.model !== facts) { this.releaseRows(); this.model = facts; this.epoch++; this.dataRevision = -1; }
    this.sourceRow ??= new SectionRow(this, "source");
    if (this.dataRevision === facts.revision) return;
    this.dataRevision = facts.revision;
    this.ordered = (facts.records ?? []).map(record => {
      let row = this.rows.get(record.ordinal);
      if (!row) { row = new ItemRow(this, record.ordinal); this.rows.set(record.ordinal, row); }
      row.update(record, facts.matched(record));
      return row;
    });
    if (facts.final) {
      const present = new Set(this.ordered);
      for (const [ordinal, row] of this.rows) if (!present.has(row)) { row.dispose(); this.rows.delete(ordinal); }
    }
    const previous = new Map(this.ordered.map(row => [row, row.group]));
    this.groupMembers.clear();
    for (const row of this.ordered) row.group = undefined;
    let index = 0;
    while (index < this.ordered.length) {
      const first = this.ordered[index]!, classification = first.description!.classification;
      let end = index + 1;
      if (classification.family !== null) while (end < this.ordered.length &&
        this.ordered[end]!.description!.classification.family === classification.family) end++;
      if (classification.family !== null && end - index > 1) {
        const members = this.ordered.slice(index, end), id = `${this.key}:group:${first.ordinal}:${classification.family}`;
        this.groupMembers.set(id, members);
        let group = this.groups.get(id);
        if (!group) {
          group = this.toolkit.group(id, classification, () => (this.groupMembers.get(id) ?? []).map(row => row.summary),
            () => this.parentTarget, () => this.headingIndent);
          if (members.some(row => row.expanded && (!previous.get(row) || previous.get(row)!.expanded))) group.setExpanded(true);
          this.groups.set(id, group);
        }
        for (const row of members) { const prior = previous.get(row); if (prior) group.inheritExpansion(prior); row.group = group; }
      }
      index = end;
    }
    if (facts.output) {
      const output = facts.output;
      if (output.parts && output.parts.length > 1) {
        this.outputSection ??= new SectionRow(this, "output");
        let texts = 0, images = 0;
        this.outputRows = output.parts.map(part => {
          const row = this.outputRows[part.ordinal] ?? new ItemRow(this, `output:${part.ordinal}`);
          if (part.kind === "text") texts++;
          if (part.kind === "image") images++;
          const captions = { text: `Text ${texts}`, return: "Return value", console: "Console output",
            image: `Image ${images}`, additional: "Additional output" };
          row.section = this.outputSection;
          const caption = part.kind === "formatted" ? `Output ${part.printedIndex}/${part.printedTotal}` : captions[part.kind];
          row.updateOutput(part, caption, outputPartPreview(output, part));
          return row;
        });
      } else {
        this.outputRow ??= new ItemRow(this, "output");
        this.outputRow.updateOutput(output.parts?.[0] ?? output);
      }
    }
  }

  prepare(width: number): boolean {
    if (!this.items) return false;
    if (this.current(width)) return true;
    try {
      this.sync();
      this.binding.runtime.admit(this.binding.facts);
      const appearance = this.binding.runtime.appearance();
      const parent = this.original as NativeToolComponent & { setOutputPad(value: number): void; setShowImages(value: boolean): void; setImageWidthCells(value: number): void };
      if (Reflect.get(parent, "outputPad") !== appearance.outputPad) parent.setOutputPad(appearance.outputPad);
      if (Reflect.get(parent, "showImages") !== appearance.showImages) parent.setShowImages(appearance.showImages);
      if (Reflect.get(parent, "imageWidthCells") !== appearance.imageWidthCells) parent.setImageWidthCells(appearance.imageWidthCells);
      this.parentFrame = undefined; this.parentNodes = undefined; this.sourceBodyLines = undefined; this.sourceSlot = undefined;
      const children: Component[] = [this.original];
      if (this.parentVisible() && this.parentTarget.expanded) {
        children.push(this.sourceRow!);
        const seen = new Set<GroupRow>();
        for (const row of this.ordered) {
          if (row.group && !seen.has(row.group)) { children.push(row.group); seen.add(row.group); }
          if (!row.group || row.group.expanded) children.push(row);
        }
        if (this.outputRow) children.push(this.outputRow);
        if (this.outputSection) {
          children.push(this.outputSection);
          if (this.outputSection.expanded) for (const row of this.outputRows) children.push(row);
        }
      }
      const revision = this.revision, state = this.layoutState();
      const rendered = children.map(child => child instanceof ItemRow || child instanceof SectionRow ? child.prepare(width) : child.render(width));
      if (!this.items) { this.frame = undefined; return false; }
      this.frame = { width, revision, state, children, lines: rendered.flat(), heights: rendered.map(lines => lines.length) };
      return true;
    } catch {
      this.fault = true; this.releaseRows(); this.frame = undefined; this.changed(); return false;
    }
  }
  get children(): Component[] { return this.frame?.children ?? [this.original]; }
  render(width: number): string[] {
    if (!this.attached) return [];
    if (!this.frame || this.frame.width !== width) this.prepare(width);
    return this.frame?.lines ?? this.original.render(width);
  }
  targets(): readonly DisclosureTarget[] {
    if (!this.items || !this.frame || !this.parentVisible() || !this.parentTarget.expanded) return [];
    return this.frame.children.flatMap<DisclosureTarget>(child => {
      if (child instanceof ItemRow || child instanceof SectionRow) return [child];
      const group = [...this.groups.values()].find(group => group === child);
      return group ? [group] : [];
    });
  }
  setExpanded(value: boolean): void {
    if (!this.attached) return;
    this.original.setExpanded(value);
    this.sourceRow?.setExpanded(value);
    for (const row of this.rows.values()) row.setExpanded(value);
    this.outputRow?.setExpanded(value);
    this.outputSection?.setExpanded(value);
    for (const row of this.outputRows) row.setExpanded(value);
  }
  setOutputPad(value: number): void {
    if (!this.attached) return;
    const parent = this.original as NativeToolComponent & { setOutputPad(value: number): void };
    parent.setOutputPad(value);
    for (const row of this.rows.values()) row.setOutputPad(value);
    this.outputRow?.setOutputPad(value);
    for (const row of this.outputRows) row.setOutputPad(value);
    this.changed();
  }
  handleMouse(event: Parameters<NonNullable<Component["handleMouse"]>>[0]) {
    if (!this.attached) return { handled: true };
    if (!this.current(event.width)) { this.toolkit.requestRender(); return { handled: true }; }
    let offset = 0;
    for (const [index, child] of this.frame!.children.entries()) {
      const height = this.frame!.heights[index]!;
      if (event.y >= offset && event.y < offset + height) return child.handleMouse?.({ ...event, y: event.y - offset, height });
      offset += height;
    }
    return undefined;
  }
  invalidate(): void {
    if (!this.attached) return;
    this.original.invalidate();
    for (const row of this.rows.values()) row.invalidate();
    this.outputRow?.invalidate();
    for (const row of this.outputRows) row.invalidate();
    this.changed();
  }
  suspend(): void {
    this.attached = false; this.frame = undefined; this.parentFrame = undefined; this.parentNodes = undefined;
    this.sourceBodyLines = undefined; this.sourceSlot = undefined;
    this.sourceRow?.suspend();
    for (const row of this.rows.values()) row.suspend(true);
    this.outputRow?.suspend(true);
    this.outputSection?.suspend();
    for (const row of this.outputRows) row.suspend(true);
  }
  private releaseRows(): void {
    this.sourceRow?.dispose(); this.sourceRow = undefined;
    this.outputSection?.dispose(); this.outputSection = undefined;
    for (const row of this.outputRows) row.dispose();
    this.outputRows = [];
    this.sourceSlot = undefined; this.sourceBodyLines = undefined;
    for (const row of this.rows.values()) row.dispose();
    this.outputRow?.dispose(); this.rows.clear(); this.groups.clear(); this.groupMembers.clear(); this.outputRow = undefined; this.ordered = [];
  }
  dispose(): void { this.suspend(); this.releaseRows(); this.binding.onChange = () => {}; this.binding.runtime.retire(this.original); }
}

export class CodemodePresentation {
  private readonly scopes = new Map<NativeToolComponent, CodemodeScope>();
  private serial = 0;
  private readonly nonce = randomUUID();
  constructor(readonly runtime: CodemodeRuntime) {}
  attach(parent: NativeToolComponent, target: DisclosureTarget, toolkit: ItemToolkit, visible: () => boolean): CodemodeScope | undefined {
    const binding = this.runtime.bind(parent);
    if (!binding) return undefined;
    let scope = this.scopes.get(parent);
    if (scope) scope.reattach(target, toolkit, visible);
    else { scope = new CodemodeScope(binding, target, toolkit, visible, `pi-transcript-ui:codemode:${this.nonce}:${this.serial++}`); this.scopes.set(parent, scope); }
    return scope;
  }
  prune(parents: ReadonlySet<NativeToolComponent>): void {
    for (const [parent, scope] of this.scopes) if (!parents.has(parent)) { scope.dispose(); this.scopes.delete(parent); }
  }
  suspend(): void { for (const scope of this.scopes.values()) scope.suspend(); }
  dispose(): void { for (const scope of this.scopes.values()) scope.dispose(); this.scopes.clear(); }
}
