import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DefaultResourceLoader, ExtensionRunner, getPackageDir, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
  type BuildSystemPromptOptions, type ExtensionError,
} from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader as StructuredLoader, ExtensionRunner as StructuredRunner, getPackageDir as getStructuredPackageDir,
  ModelRegistry as StructuredRegistry, ModelRuntime as StructuredRuntime, SessionManager as StructuredSessions,
  SettingsManager as StructuredSettings, type BuildSystemPromptOptions as StructuredPromptOptions,
  type ExtensionError as StructuredError, type ExtensionFactory as StructuredFactory, type ExtensionUIContext as StructuredUI,
} from "pi-structured-prompt-fixture";
import transcriptUi from "../../src/index.js";
import { intentGuideline } from "../../src/intent.js";
import { defaultSettings } from "../../src/settings.js";

const { buildSystemPrompt: renderStructured } = await import(join(getStructuredPackageDir(), "dist/core/system-prompt.js")) as {
  buildSystemPrompt: (options: StructuredPromptOptions) => string;
};
const { buildSystemPrompt: renderLegacy } = await import(join(getPackageDir(), "dist/core/system-prompt.js")) as {
  buildSystemPrompt: (options: BuildSystemPromptOptions) => string;
};
const sectionName = "pi_transcript_ui_intent";
const structuredTranscriptUi = transcriptUi as unknown as StructuredFactory;
let directory: string;
let settingsPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "transcript-prompt-"));
  settingsPath = join(directory, "settings.json");
  vi.stubEnv("PI_TRANSCRIPT_UI_SETTINGS", settingsPath);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function structuredRunner(factories: StructuredFactory[] = [structuredTranscriptUi]) {
  const loader = new StructuredLoader({ cwd: directory, agentDir: directory, settingsManager: StructuredSettings.inMemory(),
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: factories });
  await loader.reload();
  const { extensions, runtime, errors: loadErrors } = loader.getExtensions();
  expect(loadErrors).toEqual([]);
  const models = await StructuredRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models"), refreshOnCreate: false });
  const runner = new StructuredRunner(extensions, runtime, directory, StructuredSessions.inMemory(directory), new StructuredRegistry(models));
  const errors: StructuredError[] = [];
  runner.onError(error => errors.push(error));
  await runner.emit({ type: "session_start", reason: "startup" });
  expect(errors).toEqual([]);
  return { runner, errors };
}

async function legacyRunner() {
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [transcriptUi] });
  await loader.reload();
  const { extensions, runtime, errors: loadErrors } = loader.getExtensions();
  expect(loadErrors).toEqual([]);
  const models = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models"), refreshOnCreate: false });
  const runner = new ExtensionRunner(extensions, runtime, directory, SessionManager.inMemory(directory), new ModelRegistry(models));
  const errors: ExtensionError[] = [];
  runner.onError(error => errors.push(error));
  await runner.emit({ type: "session_start", reason: "startup" });
  expect(errors).toEqual([]);
  return { runner, errors };
}

async function saveIntent(runner: StructuredRunner, selections: string[]) {
  const choices = [...selections];
  const notify = vi.fn();
  runner.setUIContext({ select: async (_title: string, items: string[]) => {
    const choice = choices.shift();
    expect(items).toContain(choice);
    return choice;
  }, notify } as unknown as StructuredUI, "rpc");
  const command = runner.getCommand("transcript-ui");
  if (!command) throw new Error("Transcript UI command was not registered");
  await command.handler("settings", runner.createCommandContext());
  expect(choices).toEqual([]);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("settings saved:"), "info");
}

it.each(["before", "after"] as const)("composes structured sections when the other extension loads %s transcript-ui", async order => {
  const observations: string[] = [];
  const probe: StructuredFactory = pi => {
    pi.on("before_agent_start", (event, ctx) => {
      event.systemPromptOptions.sections.independent_probe = "Independent extension instructions";
      observations.push(event.systemPrompt);
      expect(ctx.getSystemPrompt()).toBe(event.systemPrompt);
    });
  };
  const { runner, errors } = await structuredRunner(order === "before"
    ? [probe, structuredTranscriptUi] : [structuredTranscriptUi, probe]);
  const options: StructuredPromptOptions = { cwd: directory, customPrompt: "Original instructions",
    sections: Object.freeze({ existing: "Existing section instructions" }) };
  let current = options;

  for (let turn = 0; turn < 3; turn++) {
    const result = await runner.emitBeforeAgentStart("Inspect the workspace", undefined, current);
    current = result.systemPromptOptions;
    const text = renderStructured(current);
    expect(current.forceSystemPrompt).toBeUndefined();
    expect(text).toContain("Original instructions");
    expect(text).toContain("<existing>\nExisting section instructions\n</existing>");
    expect(text).toContain("<independent_probe>\nIndependent extension instructions\n</independent_probe>");
    expect(text.split(intentGuideline("auto"))).toHaveLength(2);
    expect(current.sections?.[sectionName]).toBe(intentGuideline("auto"));
  }

  expect(observations).toHaveLength(3);
  expect(observations.every(text => text.includes("Independent extension instructions"))).toBe(true);
  expect(options.sections).toEqual({ existing: "Existing section instructions" });
  expect(errors).toEqual([]);
});

it("replaces language and removes only its section after saved settings changes, then restores it on re-enable", async () => {
  const { runner, errors } = await structuredRunner();
  let result = await runner.emitBeforeAgentStart("First turn", undefined, { cwd: directory, customPrompt: "Original instructions",
    sections: { unrelated: "Keep this section" } });
  expect(renderStructured(result.systemPromptOptions).split(intentGuideline("auto"))).toHaveLength(2);

  await saveIntent(runner, ["Intent", "Intent language: auto", "en", "Back", "Save"]);
  result = await runner.emitBeforeAgentStart("Next turn", undefined, result.systemPromptOptions);
  const english = renderStructured(result.systemPromptOptions);
  expect(english.split(intentGuideline("en"))).toHaveLength(2);
  expect(english).not.toContain(intentGuideline("auto"));
  expect(result.systemPromptOptions.forceSystemPrompt).toBeUndefined();

  await saveIntent(runner, ["Intent", "Intent: on", "Back", "Save"]);
  result = await runner.emitBeforeAgentStart("Disabled turn", undefined, result.systemPromptOptions);
  const disabled = renderStructured(result.systemPromptOptions);
  expect(disabled).not.toContain("displaySummary");
  expect(result.systemPromptOptions.sections).toEqual({ unrelated: "Keep this section" });
  expect(disabled).toContain("Original instructions");
  expect(disabled).toContain("Keep this section");
  expect(result.systemPromptOptions.forceSystemPrompt).toBeUndefined();

  await saveIntent(runner, ["Intent", "Intent: off", "Back", "Save"]);
  result = await runner.emitBeforeAgentStart("Re-enabled turn", undefined, result.systemPromptOptions);
  expect(renderStructured(result.systemPromptOptions).split(intentGuideline("en"))).toHaveLength(2);
  expect(result.systemPromptOptions.sections?.unrelated).toBe("Keep this section");
  expect(errors).toEqual([]);
});

it("starts disabled without contributing guidance or altering existing structured sections", async () => {
  const settings = defaultSettings();
  settings.intent.enabled = false;
  await writeFile(settingsPath, JSON.stringify(settings));
  const { runner, errors } = await structuredRunner();
  const options: StructuredPromptOptions = { cwd: directory, customPrompt: "Original instructions", sections: { other: "Other instructions" } };
  const result = await runner.emitBeforeAgentStart("Disabled turn", undefined, options);
  expect(renderStructured(result.systemPromptOptions)).toBe(renderStructured(options));
  expect(result.systemPromptOptions.forceSystemPrompt).toBeUndefined();
  expect(errors).toEqual([]);
});

it.each(["before", "after"] as const)("preserves an opaque prompt returned by an extension loaded %s transcript-ui", async order => {
  const opaque: StructuredFactory = pi => {
    pi.on("before_agent_start", () => ({ systemPrompt: "Authoritative opaque prompt" }));
  };
  const { runner, errors } = await structuredRunner(order === "before"
    ? [opaque, structuredTranscriptUi] : [structuredTranscriptUi, opaque]);
  const result = await runner.emitBeforeAgentStart("First turn", undefined, { cwd: directory, sections: { other: "Keep this section" } });
  expect(result.systemPromptOptions.forceSystemPrompt).toBe("Authoritative opaque prompt");
  expect(renderStructured(result.systemPromptOptions)).toBe("Authoritative opaque prompt");
  expect(result.systemPromptOptions.sections?.other).toBe("Keep this section");
  expect(errors).toEqual([]);
});

it("does not clear or append to an explicitly empty forced prompt", async () => {
  const { runner, errors } = await structuredRunner();
  const result = await runner.emitBeforeAgentStart("First turn", undefined, { cwd: directory, forceSystemPrompt: "", sections: { other: "Keep this section" } });
  expect(result.systemPromptOptions.forceSystemPrompt).toBe("");
  expect(renderStructured(result.systemPromptOptions)).toBe("");
  expect(result.systemPromptOptions.sections?.other).toBe("Keep this section");
  expect(errors).toEqual([]);
});

it("appends guidance through the real legacy runner even though legacy systemPromptOptions exists", async () => {
  const { runner, errors } = await legacyRunner();
  const options: BuildSystemPromptOptions = { cwd: directory, customPrompt: "Original legacy instructions", appendSystemPrompt: "Other legacy instructions" };
  const original = renderLegacy(options);
  for (let turn = 0; turn < 3; turn++) {
    const result = await runner.emitBeforeAgentStart("Legacy turn", undefined, original, options);
    expect(result?.systemPrompt).toBe(`${original}\n\n${intentGuideline("auto")}`);
  }
  expect(options).toEqual({ cwd: directory, customPrompt: "Original legacy instructions", appendSystemPrompt: "Other legacy instructions" });
  expect(errors).toEqual([]);
});

it("leaves the real legacy prompt unchanged when intent is disabled", async () => {
  const settings = defaultSettings();
  settings.intent.enabled = false;
  await writeFile(settingsPath, JSON.stringify(settings));
  const { runner, errors } = await legacyRunner();
  const options: BuildSystemPromptOptions = { cwd: directory, customPrompt: "Original legacy instructions" };
  const original = renderLegacy(options);
  const result = await runner.emitBeforeAgentStart("Disabled legacy turn", undefined, original, options);
  expect(result?.systemPrompt ?? original).toBe(original);
  expect(errors).toEqual([]);
});
