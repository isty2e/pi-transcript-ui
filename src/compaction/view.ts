import { Container, MouseRegion, truncateToWidth, type Component } from "@earendil-works/pi-tui";

export interface CompactionViewInput {
  readonly tokensBefore: number;
  readonly body: Component;
  readonly billing: readonly Component[];
  readonly details: readonly Component[];
  readonly initialExpanded: boolean;
  hasRouteMismatch(): boolean;
  canInteract(view: CompactionView): boolean;
  onChange(view: CompactionView, expanded: boolean): void;
}

export class CompactionView extends Container {
  private open: boolean;
  private readonly header: MouseRegion;

  constructor(private readonly input: CompactionViewInput) {
    super();
    this.open = input.initialExpanded;
    const label = `Compacted from ${input.tokensBefore.toLocaleString("en-US")} tokens`;
    this.header = new MouseRegion({
      render: width => {
        const warning = input.hasRouteMismatch() ? " · ⚠ Current model cannot reuse checkpoint" : "";
        return [truncateToWidth(`${this.open ? "▾" : "▸"} ${label}${warning}`, width)];
      },
      invalidate() {},
    }, event => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      if (input.canInteract(this)) this.setExpanded(!this.open);
      return { handled: true };
    });
    this.rebuild();
  }

  get expanded(): boolean { return this.open; }

  setExpanded(value: boolean): void {
    this.open = value;
    this.rebuild();
    this.input.onChange(this, value);
  }

  private rebuild(): void {
    this.clear();
    this.addChild(this.header);
    if (this.open) {
      this.addChild(this.input.body);
      for (const component of this.input.billing) this.addChild(component);
      for (const component of this.input.details) this.addChild(component);
    }
  }
}
