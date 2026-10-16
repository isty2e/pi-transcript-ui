import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DefaultResourceLoader, ExtensionRunner, getPackageDir, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
  type BuildSystemPromptOptions, type ExtensionError, type ExtensionFactory,
} from "pi-legacy-fixture";
import transcriptUi from "../../src/index.js";
import { intentGuideline } from "../../src/intent.js";
import { defaultSettings } from "../../src/settings.js";

const { buildSystemPrompt: renderLegacy } = await import(join(getPackageDir(), "dist/core/system-prompt.js")) as {
  buildSystemPrompt: (options: BuildSystemPromptOptions) => string;
};
let directory: string;
let settingsPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "transcript-legacy-prompt-"));
  settingsPath = join(directory, "settings.json");
  vi.stubEnv("PI_TRANSCRIPT_UI_SETTINGS", settingsPath);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function legacyRunner() {
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [transcriptUi as unknown as ExtensionFactory] });
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
