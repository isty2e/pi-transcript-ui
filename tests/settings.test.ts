import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTool } from "../src/classify.js";
import { defaultSettings, groupingRules, parseSettings, SettingsFile } from "../src/settings.js";
import { editSettings } from "../src/settings-ui.js";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function file() { const dir = await mkdtemp(join(tmpdir(), "transcript-settings-")); dirs.push(dir); return new SettingsFile(join(dir, "settings.json")); }
it("uses defaults without creating a file, then atomically saves and reloads", async () => {
  const store = await file();
  const { settings, original } = await store.load();
  expect(original).toBeUndefined();
  await expect(readFile(store.path)).rejects.toMatchObject({ code: "ENOENT" });
  settings.grouping.exploration = ["mcp_docs", "__proto__", "server/tool,with space"];
  await store.save(settings, original);
  expect((await store.load()).settings).toEqual(settings);
  expect(classifyTool("read", groupingRules(settings)).family).toBeNull();
  expect(classifyTool("mcp_docs", groupingRules(settings)).family).toBe("exploration");
  expect(classifyTool("__proto__", groupingRules(settings)).family).toBe("exploration");
  expect(classifyTool("server/tool,with space", groupingRules(settings)).family).toBe("exploration");
});
it("loads old positive-only settings without rewriting intent limits or saved bytes", async () => {
  const store = await file();
  const old = defaultSettings(); delete old.grouping.standalone; old.intent.maxLength = 96;
  const bytes = JSON.stringify(old); await writeFile(store.path, bytes);
  const loaded = await store.load();
  expect(loaded.settings.grouping.standalone).toEqual([]);
  expect(loaded.settings.intent.maxLength).toBe(96);
  expect(await readFile(store.path, "utf8")).toBe(bytes);
});
it("saves explicit custom auto-group exclusions, reloads them and cancels without writes", async () => {
  const store = await file();
  const ui = { select: vi.fn().mockResolvedValueOnce("Grouping").mockResolvedValueOnce("Standalone tools — exclude auto-grouping (0)").mockResolvedValueOnce("Back").mockResolvedValueOnce("Cancel"), editor: vi.fn().mockResolvedValue("custom_write"), input: vi.fn(), notify: vi.fn() };
  expect(await editSettings(ui, store)).toBeUndefined();
  expect((await store.load()).original).toBeUndefined();
  ui.select.mockResolvedValueOnce("Grouping").mockResolvedValueOnce("Standalone tools — exclude auto-grouping (0)").mockResolvedValueOnce("Back").mockResolvedValueOnce("Save");
  const saved = await editSettings(ui, store);
  expect(saved?.grouping.standalone).toEqual(["custom_write"]);
  expect((await store.load()).settings).toEqual(saved);
  expect(groupingRules((await store.load()).settings).custom_write).toBe("standalone");
  const bytes = await readFile(store.path, "utf8");
  ui.select.mockResolvedValueOnce("Grouping").mockResolvedValueOnce("Standalone tools — exclude auto-grouping (1)").mockResolvedValueOnce("Back").mockResolvedValueOnce("Cancel");
  ui.editor.mockResolvedValueOnce("");
  await editSettings(ui, store);
  expect(await readFile(store.path, "utf8")).toBe(bytes);
});
it("rejects standalone overlaps with either family", () => {
  for (const name of ["read", "write"]) {
    const settings = defaultSettings(); settings.grouping.standalone = [name];
    expect(() => parseSettings(settings)).toThrow("both");
  }
});
it("rejects overlapping lists, malformed settings and unrecognized keys", () => {
  const defaults = defaultSettings();
  expect(() => parseSettings({ ...defaults, grouping: { exploration: ["same"], mutation: ["same"] } })).toThrow("both");
  expect(parseSettings({ ...defaults, intent: { ...defaults.intent, maxLength: 257 } }).intent.maxLength).toBe(256);
  expect(parseSettings({ ...defaults, intent: { ...defaults.intent, maxLength: 1 } }).intent.maxLength).toBe(16);
  expect(() => parseSettings({ ...defaults, intent: { ...defaults.intent, maxLength: 3.5 } })).toThrow();
  expect(() => parseSettings({ ...defaults, typo: true })).toThrow();
});
it("does not overwrite corrupt files or a concurrent external edit", async () => {
  const store = await file();
  await writeFile(store.path, "broken json");
  await expect(store.load()).rejects.toThrow();
  await expect(store.save(defaultSettings(), undefined)).rejects.toThrow("changed");
  expect(await readFile(store.path, "utf8")).toBe("broken json");
});
it("UI cancellation writes nothing; Save commits and returns the edited draft", async () => {
  const store = await file();
  const ui = { select: vi.fn().mockResolvedValueOnce("Intent").mockResolvedValueOnce("Intent: on").mockResolvedValueOnce("Back").mockResolvedValueOnce("Cancel"), editor: vi.fn(), input: vi.fn(), notify: vi.fn() };
  expect(await editSettings(ui, store)).toBeUndefined();
  expect((await store.load()).original).toBeUndefined();
  ui.select.mockResolvedValueOnce("Grouping").mockResolvedValueOnce("Exploration tools (4)").mockResolvedValueOnce("Back")
    .mockResolvedValueOnce("Intent").mockResolvedValueOnce("Intent: on").mockResolvedValueOnce("Back").mockResolvedValueOnce("Save");
  ui.editor.mockResolvedValueOnce("mcp_docs\nread");
  const updated = await editSettings(ui, store);
  expect(updated?.intent.enabled).toBe(false);
  expect(updated?.grouping.exploration).toEqual(["mcp_docs", "read"]);
  expect((await store.load()).settings).toEqual(updated);
});
