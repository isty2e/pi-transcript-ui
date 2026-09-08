import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";

export interface DisclosureTarget {
  readonly kind: "group" | "tool";
  readonly label: string;
  readonly expanded: boolean;
  readonly parent?: DisclosureTarget | undefined;
  setExpanded(expanded: boolean): void;
}

/** Selection is local; expansion remains owned by the actual target. */
export class ToolNavigation {
  private selected: DisclosureTarget | undefined;
  constructor(private readonly getTargets: () => readonly DisclosureTarget[]) {}

  view(): { targets: readonly DisclosureTarget[]; selected: DisclosureTarget | undefined; index: number } {
    const targets = this.getTargets();
    if (!this.selected || !targets.includes(this.selected)) {
      this.selected = this.selected?.parent && targets.includes(this.selected.parent)
        ? this.selected.parent : targets.at(-1);
    }
    return { targets, selected: this.selected, index: this.selected ? targets.indexOf(this.selected) : -1 };
  }

  act(action: "up" | "down" | "left" | "right" | "toggle"): void {
    const { targets, selected, index } = this.view();
    if (!selected) return;
    if (action === "up" || action === "down") {
      this.selected = targets[Math.max(0, Math.min(targets.length - 1, index + (action === "up" ? -1 : 1)))];
    } else if (action === "toggle") selected.setExpanded(!selected.expanded);
    else if (action === "left") {
      if (selected.expanded) selected.setExpanded(false);
      else if (selected.parent) this.selected = selected.parent;
    } else if (!selected.expanded) selected.setExpanded(true);
    else if (selected.kind === "group") {
      this.selected = this.getTargets().find((target) => target.parent === selected) ?? selected;
    }
  }
}

export function navigationComponent(navigation: ToolNavigation, options: {
  close(): void;
  requestRender(): void;
  isBulkToggle(data: string): boolean;
  toggleAll(): void;
}): Component {
  return {
    render(width) {
      const { targets, selected, index } = navigation.view();
      const start = Math.max(0, index - 3);
      const rows = targets.slice(start, start + 7).map((target) => `${target === selected ? "> " : "  "}${target.label}`);
      return ["Tool navigation — ↑↓ select · → open/enter · ← close/parent", ...rows,
        targets.length ? `${index + 1}/${targets.length} · Enter/Space toggle · Esc return` : "No tool rows · Esc return"]
        .map((line) => truncateToWidth(line, Math.max(0, width)));
    },
    handleInput(data) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { options.close(); return; }
      if (options.isBulkToggle(data)) options.toggleAll();
      else if (matchesKey(data, "enter") || matchesKey(data, "space")) navigation.act("toggle");
      else for (const key of ["up", "down", "left", "right"] as const) {
        if (matchesKey(data, key)) { navigation.act(key); break; }
      }
      options.requestRender();
    },
    invalidate() {},
  };
}
