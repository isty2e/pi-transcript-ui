import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import transcriptUi from "../src/index.js";

let directory: string;
let settingsPath: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "transcript-commands-"));
  settingsPath = join(directory, "settings.json");
  vi.stubEnv("PI_TRANSCRIPT_UI_SETTINGS", settingsPath);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function commandHarness() {
  const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
  transcriptUi({ on: vi.fn(), registerCommand, registerShortcut: vi.fn() } as never);
  const command = registerCommand.mock.calls.find(([name]) => name === "transcript-ui")?.[1];
  if (!command) throw new Error("Transcript UI command was not registered");
  const ui = {
    notify: vi.fn(), select: vi.fn(async () => "Cancel"), input: vi.fn(), editor: vi.fn(), custom: vi.fn(),
  };
  const context = { mode: "tui", hasUI: true, ui } as unknown as ExtensionCommandContext;
  const autocomplete = new CombinedAutocompleteProvider(
    registerCommand.mock.calls.map(([name, options]) => ({ name, ...options })), directory,
  );
  return { command, context, ui, autocomplete };
}

it("shows the same help for empty input and help without opening dialogs or writing settings", async () => {
  const { command, context, ui } = commandHarness();
  for (const args of ["", "  ", "help", " help \t"]) await command.handler(args, context);
  expect(ui.notify).toHaveBeenCalledTimes(4);
  const [message, level] = ui.notify.mock.calls[0]!;
  expect(level).toBe("info");
  for (const name of ["settings", "tools", "help"]) expect(message).toContain(`/transcript-ui ${name}`);
  expect(ui.notify.mock.calls.every(call => call[0] === message && call[1] === level)).toBe(true);
  expect(ui.select).not.toHaveBeenCalled();
  expect(ui.custom).not.toHaveBeenCalled();
  await expect(access(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["ping", "Settings", "settings extra", "tools extra", "help extra", "settings\nSave"])(
  "refuses %j without executing a partial command", async args => {
    const { command, context, ui } = commandHarness();
    await command.handler(args, context);
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /transcript-ui"), "warning");
    expect(ui.select).not.toHaveBeenCalled();
    expect(ui.custom).not.toHaveBeenCalled();
    await expect(access(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("opens settings with surrounding whitespace and leaves cancellation unsaved", async () => {
  const { command, context, ui } = commandHarness();
  await command.handler(" settings \t", context);
  expect(ui.select).toHaveBeenCalledWith("Transcript UI settings", expect.arrayContaining(["Save", "Cancel"]));
  expect(ui.notify).not.toHaveBeenCalled();
  await expect(access(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains settings load-error reporting without overwriting the file", async () => {
  const { command, context, ui } = commandHarness();
  await writeFile(settingsPath, "invalid JSON");
  await command.handler("settings", context);
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Settings unchanged:"), "error");
  expect(ui.select).not.toHaveBeenCalled();
  expect(await readFile(settingsPath, "utf8")).toBe("invalid JSON");
});

it("keeps navigation TUI-only and reports an unattached TUI", async () => {
  const { command, context, ui } = commandHarness();
  await command.handler("tools", { ...context, mode: "rpc" });
  expect(ui.notify).not.toHaveBeenCalled();
  await command.handler("tools", context);
  expect(ui.notify).toHaveBeenCalledWith("Tool presentation is not attached", "warning");
  expect(ui.custom).not.toHaveBeenCalled();
});

it("prints help without UI and does not open settings in print mode", async () => {
  const { command, context, ui } = commandHarness();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const headless = { ...context, mode: "print" as const, hasUI: false };
  await command.handler("", headless);
  await command.handler("settings", headless);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("/transcript-ui settings"));
  expect(ui.notify).not.toHaveBeenCalled();
  expect(ui.select).not.toHaveBeenCalled();
  await expect(access(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("completes the root command and inserts an executable subcommand through native autocomplete", async () => {
  const { autocomplete, command, context, ui } = commandHarness();
  const rootInput = "/transcript-u";
  const root = await autocomplete.getSuggestions([rootInput], 0, rootInput.length, { signal: new AbortController().signal });
  if (!root?.items[0]) throw new Error("Missing root completion");
  expect(root.items.map(item => item.value)).toEqual(["transcript-ui"]);
  const insertedRoot = autocomplete.applyCompletion([rootInput], 0, rootInput.length, root.items[0], root.prefix);
  expect(insertedRoot.lines).toEqual(["/transcript-ui "]);
  const input = `${insertedRoot.lines[0]}se`;
  const suggestions = await autocomplete.getSuggestions([input], 0, input.length, { signal: new AbortController().signal });
  if (!suggestions?.items[0]) throw new Error("Missing argument completion");
  expect(suggestions.items.map(item => item.value)).toEqual(["settings"]);
  const inserted = autocomplete.applyCompletion([input], 0, input.length, suggestions.items[0], suggestions.prefix);
  expect(inserted.lines).toEqual(["/transcript-ui settings"]);
  await command.handler(inserted.lines[0]!.slice("/transcript-ui ".length), context);
  expect(ui.select).toHaveBeenCalled();
});

it.each([
  ["", ["settings", "tools", "help"]],
  ["t", ["tools"]],
  ["he", ["help"]],
  ["  se", ["settings"]],
  ["settings ", []],
  ["settings extra", []],
  ["unknown", []],
  ["ping", []],
] as const)("completes argument prefix %j without effects", async (prefix, expected) => {
  const { autocomplete, ui } = commandHarness();
  const input = `/transcript-ui ${prefix}`;
  const suggestions = await autocomplete.getSuggestions([input], 0, input.length, { signal: new AbortController().signal });
  expect(suggestions?.items.map(item => item.value) ?? []).toEqual(expected);
  expect(ui.select).not.toHaveBeenCalled();
  expect(ui.notify).not.toHaveBeenCalled();
  await expect(access(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
});
