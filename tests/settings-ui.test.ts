import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings, SettingsFile, type Settings } from "../src/settings.js";
import { editSettings } from "../src/settings-ui.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function store() {
  const dir = await mkdtemp(join(tmpdir(), "settings-menu-"));
  dirs.push(dir);
  return new SettingsFile(join(dir, "settings.json"));
}

const cases: readonly {
  label: string;
  category: "Grouping" | "Intent" | "Display";
  editor?: string;
  input?: string;
  submenu?: string;
  change(settings: Settings): void;
}[] = [
  { category: "Grouping", label: "Exploration tools (4)", editor: "remote_reader", change: s => { s.grouping.exploration = ["remote_reader"]; } },
  { category: "Grouping", label: "Mutation tools (2)", editor: "remote_writer", change: s => { s.grouping.mutation = ["remote_writer"]; } },
  { category: "Intent", label: "Intent: on", change: s => { s.intent.enabled = false; } },
  { category: "Intent", label: "Intent language: auto", submenu: "en", change: s => { s.intent.language = "en"; } },
  { category: "Intent", label: "Intent generation length: 48", input: "300", change: s => { s.intent.maxLength = 256; } },
  { category: "Display", label: "Command display width: 120", input: "91", change: s => { s.display.commandMaxWidth = 91; } },
  { category: "Display", label: "Intent display width: 48", input: "31", change: s => { s.display.intentMaxWidth = 31; } },
  { category: "Display", label: "Total row width: 120", input: "99", change: s => { s.display.rowMaxWidth = 99; } },
  { category: "Grouping", label: "Standalone tools — exclude auto-grouping (0)", editor: "external", change: s => { s.grouping.standalone = ["external"]; } },
  { category: "Display", label: "Command preview: Compact", submenu: "Raw", change: s => { s.display.commandPreview = "raw"; } },
];

it.each(cases)("edits only the selected setting through $label, saving only on Save", async entry => {
  const file = await store();
  const selections = [entry.category, entry.label, ...(entry.submenu ? [entry.submenu] : []), "Back", "Save"];
  const ui = {
    select: vi.fn(async (title: string, options: string[]) => {
      await expect(readFile(file.path)).rejects.toMatchObject({ code: "ENOENT" });
      if (title === "Transcript UI settings") {
        expect(options).toEqual(["Grouping", "Intent", "Display", "Save", "Cancel"]);
      }
      if (selections[0] === entry.label) {
        expect(title).toBe(`Transcript UI settings — ${entry.category}`);
        expect(options).toEqual([...cases.filter(item => item.category === entry.category).map(item => item.label), "Back"]);
      }
      const selection = selections.shift()!;
      expect(options).toContain(selection);
      return selection;
    }),
    editor: vi.fn().mockResolvedValue(entry.editor),
    input: vi.fn().mockResolvedValue(entry.input),
    notify: vi.fn(),
  };
  const expected = defaultSettings();
  entry.change(expected);
  expect(await editSettings(ui, file)).toEqual(expected);
  expect((await file.load()).settings).toEqual(expected);
  expect(ui.notify).not.toHaveBeenCalled();
});

it("rejects an invalid draft edit without affecting the next selected field", async () => {
  const file = await store();
  const ui = {
    select: vi.fn().mockResolvedValueOnce("Display").mockResolvedValueOnce("Command display width: 120").mockResolvedValueOnce("Total row width: 120").mockResolvedValueOnce("Back").mockResolvedValueOnce("Save"),
    input: vi.fn().mockResolvedValueOnce("not a number").mockResolvedValueOnce("80"),
    editor: vi.fn(), notify: vi.fn(),
  };
  const expected = defaultSettings();
  expected.display.rowMaxWidth = 80;
  expect(await editSettings(ui, file)).toEqual(expected);
  expect(ui.notify).toHaveBeenCalledOnce();
  expect((await file.load()).settings).toEqual(expected);
});

it("dismisses a subdialog without modifying the draft and cancels without creating a file", async () => {
  const file = await store();
  const ui = {
    select: vi.fn().mockResolvedValueOnce("Intent").mockResolvedValueOnce("Intent language: auto").mockResolvedValueOnce(undefined).mockResolvedValueOnce("Intent: on").mockResolvedValueOnce("Back").mockResolvedValueOnce("Cancel"),
    input: vi.fn(), editor: vi.fn(), notify: vi.fn(),
  };
  expect(await editSettings(ui, file)).toBeUndefined();
  await expect(readFile(file.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await file.load()).settings).toEqual(defaultSettings());
});

it("retains one draft across all categories, including Escape back to the root", async () => {
  const file = await store();
  const selections: (string | undefined)[] = [
    "Grouping", "Exploration tools (4)", undefined,
    "Intent", "Intent: on", "Back",
    "Display", "Command preview: Compact", "Raw", "Back",
    "Grouping", "Back", "Intent", "Back", "Display", undefined, "Save",
  ];
  const ui = {
    select: vi.fn(async (title: string, options: string[]) => {
      await expect(readFile(file.path)).rejects.toMatchObject({ code: "ENOENT" });
      const selected = selections.shift();
      if (selected !== undefined) expect(options).toContain(selected);
      if (selections.length <= 6 && title.endsWith(" — Grouping")) expect(options).toContain("Exploration tools (1)");
      if (selections.length <= 6 && title.endsWith(" — Intent")) expect(options).toContain("Intent: off");
      if (selections.length <= 6 && title.endsWith(" — Display")) expect(options).toContain("Command preview: Raw");
      return selected;
    }),
    editor: vi.fn().mockResolvedValue("custom_reader"), input: vi.fn(), notify: vi.fn(),
  };
  const expected = defaultSettings();
  expected.grouping.exploration = ["custom_reader"];
  expected.intent.enabled = false;
  expected.display.commandPreview = "raw";
  expect(await editSettings(ui, file)).toEqual(expected);
  expect((await file.load()).settings).toEqual(expected);
  expect(selections).toHaveLength(0);
  expect(ui.notify).not.toHaveBeenCalled();
});

it.each([undefined, "Cancel"])("discards edits on root %j without changing an existing file", async cancellation => {
  const file = await store();
  await file.save(defaultSettings(), undefined);
  const original = await readFile(file.path, "utf8");
  const ui = {
    select: vi.fn().mockResolvedValueOnce("Intent").mockResolvedValueOnce("Intent: on")
      .mockResolvedValueOnce(undefined).mockResolvedValueOnce(cancellation),
    input: vi.fn(), editor: vi.fn(), notify: vi.fn(),
  };
  expect(await editSettings(ui, file)).toBeUndefined();
  expect(await readFile(file.path, "utf8")).toBe(original);
});

it("cancels a field chooser back to its category without losing previous edits", async () => {
  const file = await store();
  const ui = {
    select: vi.fn().mockResolvedValueOnce("Intent").mockResolvedValueOnce("Intent: on")
      .mockResolvedValueOnce("Intent language: auto").mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("Back").mockResolvedValueOnce("Save"),
    input: vi.fn(), editor: vi.fn(), notify: vi.fn(),
  };
  const expected = defaultSettings();
  expected.intent.enabled = false;
  expect(await editSettings(ui, file)).toEqual(expected);
  expect(ui.select.mock.calls[4]).toEqual(["Transcript UI settings — Intent", [
    "Intent: off", "Intent language: auto", "Intent generation length: 48", "Back",
  ]]);
});

it("keeps the initial file snapshot for conflict detection across category changes", async () => {
  const file = await store();
  const external = JSON.stringify({ ...defaultSettings(), display: { ...defaultSettings().display, rowMaxWidth: 77 } });
  const selections = ["Intent", "Intent: on", "Back", "Display", "Back", "Save"];
  const ui = {
    select: vi.fn(async () => {
      const selected = selections.shift();
      if (selected === "Display") await writeFile(file.path, external);
      return selected;
    }),
    input: vi.fn(), editor: vi.fn(), notify: vi.fn(),
  };
  await expect(editSettings(ui, file)).rejects.toThrow(/changed/i);
  expect(await readFile(file.path, "utf8")).toBe(external);
});

it.each([
  { category: "Grouping", label: "Exploration tools (4)", chooser: false },
  { category: "Display", label: "Command display width: 120", chooser: false },
  { category: "Display", label: "Command preview: Compact", chooser: true },
])("dismisses $label without losing edits in another category", async entry => {
  const file = await store();
  const selections = ["Intent", "Intent: on", "Back", entry.category, entry.label,
    ...(entry.chooser ? [undefined] : []), "Back", "Save"];
  const ui = {
    select: vi.fn(async (_title: string, options: string[]) => {
      const selected = selections.shift();
      if (selected !== undefined) expect(options).toContain(selected);
      return selected;
    }),
    input: vi.fn().mockResolvedValue(undefined), editor: vi.fn().mockResolvedValue(undefined), notify: vi.fn(),
  };
  const expected = defaultSettings();
  expected.intent.enabled = false;
  expect(await editSettings(ui, file)).toEqual(expected);
  expect((await file.load()).settings).toEqual(expected);
});
