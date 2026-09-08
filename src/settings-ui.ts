import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseSettings, type Settings, type SettingsFile } from "./settings.js";

type SettingsUI = Pick<ExtensionContext["ui"], "select" | "editor" | "input" | "notify">;
const CATEGORIES = ["Grouping", "Intent", "Display"] as const;
type SettingsCategory = typeof CATEGORIES[number];

export async function editSettings(ui: SettingsUI, file: SettingsFile): Promise<Settings | undefined> {
  const loaded = await file.load();
  let draft = loaded.settings;
  let category: SettingsCategory | undefined;
  while (true) {
    if (category === undefined) {
      const chosen = await ui.select("Transcript UI settings", [...CATEGORIES, "Save", "Cancel"]);
      if (chosen === undefined || chosen === "Cancel") return undefined;
      if (chosen === "Save") {
        await file.save(draft, loaded.original);
        return draft;
      }
      category = CATEGORIES.find(value => value === chosen);
      continue;
    }

    const options = [
      { category: "Grouping", id: "exploration", label: `Exploration tools (${draft.grouping.exploration.length})` },
      { category: "Grouping", id: "mutation", label: `Mutation tools (${draft.grouping.mutation.length})` },
      { category: "Intent", id: "intent-enabled", label: `Intent: ${draft.intent.enabled ? "on" : "off"}` },
      { category: "Intent", id: "intent-language", label: `Intent language: ${draft.intent.language}` },
      { category: "Intent", id: "intent-length", label: `Intent generation length: ${draft.intent.maxLength}` },
      { category: "Display", id: "commandMaxWidth", label: `Command display width: ${draft.display.commandMaxWidth}` },
      { category: "Display", id: "intentMaxWidth", label: `Intent display width: ${draft.display.intentMaxWidth}` },
      { category: "Display", id: "rowMaxWidth", label: `Total row width: ${draft.display.rowMaxWidth}` },
      { category: "Grouping", id: "standalone", label: `Standalone tools — exclude auto-grouping (${draft.grouping.standalone?.length ?? 0})` },
      { category: "Display", id: "command-preview", label: `Command preview: ${draft.display.commandPreview === "raw" ? "Raw" : "Compact"}` },
    ] as const satisfies readonly { category: SettingsCategory; id: string; label: string }[];
    const visibleOptions = options.filter(option => option.category === category);
    const chosen = await ui.select(`Transcript UI settings — ${category}`, [...visibleOptions.map(option => option.label), "Back"]);
    if (chosen === undefined || chosen === "Back") {
      category = undefined;
      continue;
    }
    const selection = visibleOptions.find(option => option.label === chosen);
    if (!selection) continue;

    const candidate: Settings = {
      ...draft,
      grouping: { ...draft.grouping },
      intent: { ...draft.intent },
      display: { ...draft.display },
    };
    switch (selection.id) {
      case "exploration":
      case "mutation":
      case "standalone": {
        const key = selection.id;
        const title = key === "standalone"
          ? "Standalone tools — exclude auto-grouping; one exact name per line"
          : `${key} tools — one exact name per line`;
        const text = await ui.editor(title, (draft.grouping[key] ?? []).join("\n"));
        if (text === undefined) continue;
        candidate.grouping[key] = text.split(/\r?\n/).filter(Boolean);
        break;
      }
      case "intent-enabled":
        candidate.intent.enabled = !candidate.intent.enabled;
        break;
      case "intent-language": {
        const language = await ui.select("Intent language", ["auto", "en", "zh-CN"]);
        if (!language) continue;
        candidate.intent.language = language as Settings["intent"]["language"];
        break;
      }
      case "intent-length": {
        const value = await ui.input("Intent generation maximum characters (16–256)", String(draft.intent.maxLength));
        if (value === undefined || !value.trim()) continue;
        candidate.intent.maxLength = Number(value);
        break;
      }
      case "commandMaxWidth":
      case "intentMaxWidth":
      case "rowMaxWidth": {
        const key = selection.id;
        const value = await ui.input("Display width in terminal columns (1–4096)", String(draft.display[key]));
        if (value === undefined || !value.trim()) continue;
        candidate.display[key] = Number(value);
        break;
      }
      case "command-preview": {
        const mode = await ui.select("Command preview", ["Compact", "Raw"]);
        if (mode !== "Compact" && mode !== "Raw") continue;
        candidate.display.commandPreview = mode === "Raw" ? "raw" : "compact";
        break;
      }
      default:
        throw new Error(`Unsupported settings action: ${selection satisfies never}`);
    }
    try {
      draft = parseSettings(candidate);
    } catch (error) {
      ui.notify(String(error), "error");
    }
  }
}
