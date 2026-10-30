import { afterEach, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Pi from "@earendil-works/pi-coding-agent";
import { AgentSessionRuntime, InteractiveMode, ModelRuntime, SessionManager, SettingsManager, initTheme,
  createAgentSessionServices, createAgentSessionFromServices,
  type SessionEntry, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import transcriptUi from "../../../src/index.js";
import { COMPACTION_DISPLAY_TYPE } from "../../../src/compaction/producer.js";

export const checkpointDetails = { strategy: "openai-responses-compaction-v2", provider: "openai-codex", api: "openai-codex-responses",
  model: "fixture", baseUrl: "https://fixture.invalid/v1", createdAt: "2026-10-30T00:00:00Z",
  compactedWindow: [{ type: "compaction", encrypted_content: "owned-fixture-only" }] };
export const usage = () => ({ input: 1200, output: 100, cacheRead: 500, cacheWrite: 0, totalTokens: 1800,
  cost: { input: 0.01, output: 0.002, cacheRead: 0.001, cacheWrite: 0, total: 0.013 } });

interface NativeAccess {
  readonly ui: Container & { requestRender(): void; queryTerminalColors(): Promise<Record<string, never>> };
  readonly documentContainer: Container;
  readonly chatContainer: Container;
  readonly sessionManager: SessionManager;
  isInitialized: boolean;
  bindCurrentSessionExtensions(): Promise<void>;
  renderSessionEntries(entries: SessionEntry[]): unknown;
  rebuildChatFromMessages(): void;
  setToolsExpanded(value: boolean): void;
  updateAvailableProviderCount(): Promise<void>;
  stop(): void;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) try { await cleanup(); } catch (error) { failures.push(error); }
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  if (failures.length) throw new AggregateError(failures, "Compaction fixture cleanup failed");
});

export async function compactionFixture(options: { product?: boolean; code?: boolean; renderer?: (entry: { data?: unknown }, theme: Theme) => Container | Text } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "transcript-compaction-"));
  vi.stubEnv("PI_TRANSCRIPT_UI_SETTINGS", join(directory, "transcript-settings.json"));
  let requests = 0, starts = 0, writes = 0;
  vi.stubGlobal("fetch", () => { requests++; throw new Error("No model requests in display fixture"); });
  initTheme("dark", false);
  const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models"), refreshOnCreate: false });
  const model = { id: "fixture", name: "fixture", provider: checkpointDetails.provider, api: "openai-codex-responses" as const,
    baseUrl: checkpointDetails.baseUrl, reasoning: false, input: ["text" as const], contextWindow: 100000, maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const prepareServices = () => createAgentSessionServices({ cwd: directory, agentDir: directory, modelRuntime,
    settingsManager: SettingsManager.inMemory({ theme: "dark", outputPad: 0, showCacheMissNotices: true }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [
        ...(options.code ? [Pi.createCodemodeExtension({ models: false })] : []),
        (api: ExtensionAPI) => {
          api.registerEntryRenderer(COMPACTION_DISPLAY_TYPE, (entry, _options, theme) => {
            if (options.renderer) return options.renderer(entry, theme);
            const data = entry.data as { content: string; kind?: "usage" };
            if (data.kind === "usage") return new Text(theme.fg("dim", data.content), 0, 0);
            const box = new Box(1, 1, text => theme.bg("customMessageBg", text));
            box.addChild(new Text(theme.fg("customMessageLabel", "[compaction]"), 0, 0));
            box.addChild(new Text(data.content, 0, 0));
            return box;
          });
        },
        ...(options.product === false ? [] : [transcriptUi]),
      ] } });
  const services = await prepareServices(), manager = SessionManager.inMemory(directory);
  const makeSession = (services: Awaited<ReturnType<typeof prepareServices>>, manager: SessionManager,
    sessionStartEvent?: Parameters<typeof createAgentSessionFromServices>[0]["sessionStartEvent"]) =>
    createAgentSessionFromServices({ services, sessionManager: manager, model, tools: options.code ? ["codemode", "read"] : [],
      ...(sessionStartEvent ? { sessionStartEvent } : {}) });
  const { session } = await makeSession(services, manager);
  const owner = new AgentSessionRuntime(session, services, async request => {
    const services = await prepareServices();
    return { ...await makeSession(services, request.sessionManager, request.sessionStartEvent), services, diagnostics: [] };
  });
  const terminal: Terminal = { columns: 100, rows: 40, kittyProtocolActive: false,
    start() { starts++; }, stop() {}, drainInput: async () => {}, write() { writes++; }, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} };
  const mode = new InteractiveMode(owner, { terminal }) as unknown as NativeAccess;
  mode.ui.requestRender = () => {};
  mode.ui.queryTerminalColors = async () => ({});
  mode.updateAvailableProviderCount = async () => {};
  mode.ui.addChild(mode.documentContainer); mode.isInitialized = true;
  cleanups.push(async () => {
    try {
      await owner.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      expect(requests).toBe(0); expect(starts).toBe(0); expect(writes).toBe(0);
    } finally { mode.stop(); owner.session.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
  await mode.bindCurrentSessionExtensions();
  return {
    directory, owner, mode, modelRuntime,
    get manager() { return owner.session.sessionManager; },
    lines(width = 100) { return mode.chatContainer.render(width).map(stripTerminalSequences).map(line => line.trimEnd()); },
    render() { return mode.chatContainer.render(100).map(stripTerminalSequences).join("\n"); },
    draw() { mode.chatContainer.clear(); mode.renderSessionEntries(owner.session.sessionManager.buildContextEntries()); },
    checkpoint(summary = "Original checkpoint summary", details: unknown = checkpointDetails, firstKept = "") {
      const id = owner.session.sessionManager.appendCompaction(summary, firstKept, 42123, details, true, usage());
      return owner.session.sessionManager.getEntry(id)!;
    },
    display(id: string, content = "PRODUCER EXPLANATION", kind?: string) {
      return owner.session.sessionManager.appendCustomEntry(COMPACTION_DISPLAY_TYPE,
        { compactionEntryId: id, content, ...(kind === undefined ? {} : { kind }) });
    },
  };
}
