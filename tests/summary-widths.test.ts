import { expect, it, vi } from "vitest";
import { NO_SUMMARY_METRICS } from "../src/tool-metrics.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { displayFor, joinLine, runningLine, settledLine, targetText } from "../src/display.js";
import { defaultSettings, parseSettings, SettingsFile } from "../src/settings.js";
import { editSettings } from "../src/settings-ui.js";

const output = [{ type: "text", text: "a\nb\nc" }];
it("gives the command space before intent in running, completed and error rows", () => {
  const command = "npm run integration -- " + "x".repeat(200);
  const display = displayFor("bash", { command })!;
  for (const width of [40, 64, 100, 180]) {
    const layout = { width, limits: { commandMaxWidth: 120, intentMaxWidth: 24 } };
    for (const error of [false, true]) {
      const line = joinLine(settledLine({ toolName: "bash", display, content: output, isError: error, intent: "Purpose ".repeat(20), layout, metrics: NO_SUMMARY_METRICS }));
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(line).toContain("npm run");
      expect(line).not.toContain("(3 lines)");
      if (error) expect(line).toContain("error");
      expect(visibleWidth(line)).toBeLessThanOrEqual(120);
    }
    const running = joinLine(runningLine("bash", display, "Purpose ".repeat(20), layout));
    expect(visibleWidth(running)).toBeLessThanOrEqual(width);
    expect(running.endsWith("…")).toBe(true);
  }
  expect(display.target).toEqual({ kind: "command", command });
  const short = displayFor("bash", { command: "npm test && git diff --check" });
  expect(joinLine(settledLine({ toolName: "bash", display: short, content: output, isError: false, intent: "한글 확인", layout: { width: 10 }, metrics: NO_SUMMARY_METRICS }))).not.toContain(" — ");
});

it("honors independently configured command and intent ceilings", () => {
  const display = displayFor("bash", { command: "npm run " + "x".repeat(200) })!;
  const layout = { width: 160, limits: { commandMaxWidth: 36, intentMaxWidth: 8 } };
  expect(visibleWidth(targetText(display.target, layout.limits))).toBe(36);
  const line = joinLine(settledLine({ toolName: "bash", display, content: output, isError: false, intent: "통합 테스트와 타입 검사 실행", layout, metrics: NO_SUMMARY_METRICS }));
  expect(visibleWidth(line.split(" — ")[1]!)).toBeLessThanOrEqual(8);
  expect(visibleWidth(targetText(display.target))).toBe(120);
});

it("clips CJK, combining characters and emoji at grapheme boundaries", () => {
  const command = "한글 é 👨‍👩‍👧‍👦 🧪 done";
  const prefixes = new Set([""]);
  let prefix = "";
  for (const { segment } of new Intl.Segmenter().segment(command)) { prefix += segment; prefixes.add(prefix); }
  for (let width = 1; width <= 35; width++) {
    const shown = targetText({ kind: "command", command }, { commandMaxWidth: width, intentMaxWidth: 48 });
    expect(visibleWidth(shown)).toBeLessThanOrEqual(width);
    expect(prefixes.has(stripTerminalSequences(shown).replace(/…$/, ""))).toBe(true);
  }
  const colored = targetText({ kind: "command", command: "\x1b[31m한글 명령어\x1b[0m" }, { commandMaxWidth: 5, intentMaxWidth: 48 });
  expect(visibleWidth(colored)).toBeLessThanOrEqual(5);
});

it("loads old files without rewriting or replacing explicit intent limits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "summary-legacy-"));
  try {
    const store = new SettingsFile(join(dir, "settings.json"));
    const { display: _display, ...legacy } = defaultSettings();
    legacy.intent.maxLength = 96;
    const original = JSON.stringify(legacy);
    await writeFile(store.path, original);
    const loaded = await store.load();
    expect(loaded.settings.intent.maxLength).toBe(96);
    expect(loaded.settings.display).toEqual({ rowMaxWidth: 120, commandMaxWidth: 120, intentMaxWidth: 48, commandPreview: 'compact' });
    expect(await readFile(store.path, "utf8")).toBe(original);
    expect(defaultSettings().intent.maxLength).toBe(48);
    expect(parseSettings({ ...legacy, display: { commandMaxWidth: 200 } }).display).toEqual({ rowMaxWidth: 120, commandMaxWidth: 200, intentMaxWidth: 48, commandPreview: 'compact' });
    for (const width of [0, -1, 2.5, NaN, Infinity, "40", null]) {
      expect(() => parseSettings({ ...legacy, display: { commandMaxWidth: width } })).toThrow();
      expect(() => parseSettings({ ...legacy, display: { rowMaxWidth: width } })).toThrow();
    }
    for (const display of [null, [], { typo: 80 }]) expect(() => parseSettings({ ...legacy, display })).toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("saves generation and all display limits and discards cancelled width changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "summary-settings-"));
  try {
    const store = new SettingsFile(join(dir, "settings.json"));
    const ui = { select: vi.fn(), input: vi.fn(), editor: vi.fn(), notify: vi.fn() };
    ui.select.mockResolvedValueOnce("Display").mockResolvedValueOnce("Command display width: 120").mockResolvedValueOnce("Intent display width: 48").mockResolvedValueOnce("Back")
      .mockResolvedValueOnce("Intent").mockResolvedValueOnce("Intent generation length: 48").mockResolvedValueOnce("Back")
      .mockResolvedValueOnce("Display").mockResolvedValueOnce("Total row width: 120").mockResolvedValueOnce("Back").mockResolvedValueOnce("Save");
    ui.input.mockResolvedValueOnce("160").mockResolvedValueOnce("32").mockResolvedValueOnce("24").mockResolvedValueOnce("100");
    const saved = await editSettings(ui, store);
    expect(saved?.display).toEqual({ rowMaxWidth: 100, commandMaxWidth: 160, intentMaxWidth: 32, commandPreview: 'compact' });
    expect(saved?.intent.maxLength).toBe(24);
    expect((await store.load()).settings).toEqual(saved);
    const original = await readFile(store.path, "utf8");
    ui.select.mockResolvedValueOnce("Display").mockResolvedValueOnce("Command display width: 160").mockResolvedValueOnce("Back").mockResolvedValueOnce("Cancel");
    ui.input.mockResolvedValueOnce("200");
    expect(await editSettings(ui, store)).toBeUndefined();
    expect(await readFile(store.path, "utf8")).toBe(original);
    expect(saved?.display.commandMaxWidth).toBe(160);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
