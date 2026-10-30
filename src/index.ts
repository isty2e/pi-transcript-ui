import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { attachTranscriptPresentation, UnsupportedTranscriptContainerError, type PresentationAttachment } from "./wiring.js";
import { ToolNavigation, navigationComponent } from "./navigation.js";
import { intentGuideline, isRecord } from "./intent.js";
import { INTENT_ENTRY, IntentTransport } from "./intent-transport.js";
import { defaultSettings, groupingRules, SettingsFile } from "./settings.js";
import { editSettings } from "./settings-ui.js";
import { CodemodeRuntime } from "./codemode/pi.js";
import { CodemodePresentation } from "./codemode/view.js";
import { CompactionRuntime } from "./compaction/pi.js";
import { observeNativeMode, NativeModeCleanupError, type NativeModeObservation } from "./native-mode.js";
import packageMetadata from "../package.json" with { type: "json" };

export const TRANSCRIPT_UI_VERSION = packageMetadata.version;
const WIDGET_KEY = "pi-transcript-ui-attachment";
const INTENT_PROMPT_SECTION = "pi_transcript_ui_intent";
const COMPOSITOR_ACTIVE = Symbol.for("pi-fixed-editor-compositor.alternateScreenActive");
const NATIVE_HOST_NOTICE = "Transcript UI cannot attach to this host's transcript; original tool display is unchanged.";
function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else process.stderr.write(`transcript-ui: ${message}\n`);
}

export default function transcriptUi(pi: ExtensionAPI): void {
  const file = new SettingsFile(process.env["PI_TRANSCRIPT_UI_SETTINGS"] ?? join(getAgentDir(), "extensions", "pi-transcript-ui", "settings.json"));
  let reportPersistenceError: (error: unknown) => void = (error) => { process.stderr.write(`transcript-ui intent was not persisted: ${String(error)}\n`); };
  const intents = new IntentTransport((records) => pi.appendEntry(INTENT_ENTRY, records), (error) => { reportPersistenceError(error); });
  let settings = defaultSettings();
  const codemode = new CodemodeRuntime(pi, () => settings.display.codemode);
  const codemodePresentation = new CodemodePresentation(codemode);
  const compaction = new CompactionRuntime();
  let nativeObservation: NativeModeObservation | undefined;
  let nativeFailure: unknown;
  let pendingDiscoveryCleanup: (() => void) | undefined;
  let nativeContext: ExtensionContext | undefined;
  let detach: PresentationAttachment | undefined;
  let closeNavigator: (() => void) | undefined;
  let reconfigure: (() => void) | undefined;
  let live = false;
  let attachmentFailure: "unsupported" | "error" | undefined;
  const intentEnabled = () => settings.intent.enabled && !attachmentFailure;
  const warned = new Set<string>();
  const navigate = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui" || closeNavigator) return;
    if (attachmentFailure === "unsupported") { notify(ctx, NATIVE_HOST_NOTICE, "info"); return; }
    if (Reflect.get(globalThis, COMPOSITOR_ACTIVE) === true) {
      notify(ctx, "Alternative compositor is active: use the mouse to expand or collapse tool groups and members. Transcript keyboard navigation is unavailable in this mode; existing Pi shortcuts are unchanged.", "info");
      return;
    }
    if (!detach) { notify(ctx, "Tool presentation is not attached", "warning"); return; }
    const navigation = new ToolNavigation(() => detach?.targets() ?? []);
    try {
      await ctx.ui.custom<void>((tui, _theme, keybindings, done) => {
        closeNavigator = () => done();
        return navigationComponent(navigation, {
          close: () => done(), requestRender: () => tui.requestRender(),
          isBulkToggle: (data) => keybindings.matches(data, "app.tools.expand"),
          toggleAll: () => ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded()),
        });
      });
    } finally { closeNavigator = undefined; }
  };
  const reportNativeFailure = (error: unknown): void => {
    nativeFailure = error;
    if (error instanceof NativeModeCleanupError) pendingDiscoveryCleanup = error.retryCleanup;
    if (!nativeContext || nativeContext.mode !== "tui") return;
    const message = `Native transcript presentation kept its existing display: ${String(error)}`;
    if (!warned.has(message)) { warned.add(message); notify(nativeContext, message, "warning"); }
  };
  const stopNative = (): void => {
    const failures: unknown[] = [];
    try { compaction.dispose(); } catch (error) { failures.push(error); }
    try { nativeObservation?.dispose(); nativeObservation = undefined; } catch (error) { failures.push(error); }
    try { pendingDiscoveryCleanup?.(); pendingDiscoveryCleanup = undefined; } catch (error) { failures.push(error); }
    if (failures.length) reportNativeFailure(new AggregateError(failures, "Native transcript cleanup is incomplete"));
  };
  pi.registerShortcut("ctrl+shift+o", { description: "Navigate tool groups and members", handler: navigate });
  pi.on("session_start", async (_event, ctx) => {
    nativeContext = ctx;
    closeNavigator?.();
    detach?.(); detach = undefined; reconfigure = undefined;
    codemodePresentation.dispose(); codemode.stop();
    attachmentFailure = undefined;
    reportPersistenceError = (error) => {
      const message = `Transcript intent remains visible but was not saved: ${String(error)}`;
      notify(ctx, message, "error");
    };
    try { settings = (await file.load()).settings; }
    catch (error) { notify(ctx, `Settings not loaded: ${String(error)}`, "error"); }
    intents.restore(ctx.sessionManager.getBranch());
    codemode.start(ctx);
    if (ctx.mode !== "tui") { stopNative(); return; }
    if (nativeObservation?.error) reportNativeFailure(nativeObservation.error);
    else if (nativeFailure) reportNativeFailure(nativeFailure);
    live = true;
    ctx.ui.setWidget(WIDGET_KEY, (tui) => {
      codemode.setRoot(tui);
      reconfigure = () => {
        closeNavigator?.();
        detach?.(); detach = undefined;
        if (!live) return;
        if (attachmentFailure) { codemode.start(ctx); codemode.captureMode(nativeObservation?.mode); codemode.setRoot(tui); }
        try {
          detach = attachTranscriptPresentation(tui, {
            getTheme: () => ctx.ui.theme, requestRender: () => tui.requestRender(), rules: groupingRules(settings), displayLimits: settings.display,
            codemode: codemodePresentation,
            resolveParameters: name => pi.getAllTools().find(tool => tool.name === name)?.parameters,
            resolveIntent: (id, args) => intentEnabled() ? intents.resolve(id, args, settings.intent.maxLength) : undefined,
            onUnsupported: (name, error) => ctx.ui.notify(`transcript-ui kept ${name} native: ${String(error)}`, "warning"),
            onCleanupIncomplete: (source, failure) => {
              const context = source.kind === "tool" ? source.toolName : "attachment";
              const first = failure.failures[0]!;
              const issueCount = failure.failures.length;
              ctx.ui.notify(`transcript-ui cleanup incomplete (${context}, ${issueCount} issue${issueCount === 1 ? "" : "s"}): ${first.slot}: ${String(first.error)}`, "error");
            },
          });
          attachmentFailure = undefined;
          tui.requestRender();
        } catch (error) {
          attachmentFailure = error instanceof UnsupportedTranscriptContainerError ? "unsupported" : "error";
          detach?.(); detach = undefined;
          codemodePresentation.dispose(); codemode.shutdown();
          if (attachmentFailure === "error") {
            ctx.ui.notify(`transcript-ui attachment failed: ${String(error)}`, "error");
            return;
          }
          if (!warned.has(NATIVE_HOST_NOTICE)) {
            warned.add(NATIVE_HOST_NOTICE);
            notify(ctx, NATIVE_HOST_NOTICE, "info");
          }
        }
      };
      if (live && !detach) reconfigure();
      return { render: () => [], invalidate: () => {} };
    });
  });
  pi.on("session_tree", (_event, ctx) => { intents.restore(ctx.sessionManager.getBranch()); });
  pi.on("session_shutdown", (_event, ctx) => {
    live = false;
    const failures: unknown[] = [];
    for (const cleanup of [
      () => codemode.shutdown(), stopNative, () => closeNavigator?.(),
      () => { detach?.(); detach = undefined; reconfigure = undefined; },
      () => codemodePresentation.dispose(),
      () => { if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined); },
    ]) try { cleanup(); } catch (error) { failures.push(error); }
    if (failures.length) notify(ctx, `Transcript cleanup incomplete: ${String(failures[0])}`, "error");
  });
  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    if (options && "sections" in options && isRecord(options.sections)) {
      if (intentEnabled()) options.sections[INTENT_PROMPT_SECTION] = intentGuideline(settings.intent.language);
      else delete options.sections[INTENT_PROMPT_SECTION];
      return;
    }

    if (intentEnabled()) return {
      systemPrompt: `${event.systemPrompt}\n\n${intentGuideline(settings.intent.language)}`,
    };
  });
  pi.on("before_provider_request", (event, ctx) => {
    const active = new Set(pi.getActiveTools());
    return intents.preparePayload(event.payload, pi.getAllTools().filter((tool) => active.has(tool.name)), {
      ...settings.intent, enabled: intentEnabled(),
    }, (message) => {
      if (warned.has(message)) return;
      warned.add(message);
      notify(ctx, message, "warning");
    });
  });
  pi.on("message_end", (event) => {
    const message = intents.prepareMessage(event.message);
    return message === event.message ? undefined : { message: message as typeof event.message };
  });
  const openSettings = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) return;
    try {
      const updated = await editSettings(ctx.ui, file);
      if (!updated) return;
      settings = updated; reconfigure?.();
      ctx.ui.notify(`Transcript UI settings saved: ${file.path}`, "info");
    } catch (error) { ctx.ui.notify(`Settings unchanged: ${String(error)}`, "error"); }
  };
  const showHelp = (ctx: ExtensionContext): void => {
    notify(ctx, [
      `pi-transcript-ui ${TRANSCRIPT_UI_VERSION}`,
      ...subcommands.map(command => `/transcript-ui ${command.name} — ${command.description}`),
    ].join("\n"), "info");
  };
  const subcommands = [
    { name: "settings", description: "Edit settings (Save applies immediately).", handler: openSettings },
    { name: "tools", description: "Navigate tool groups and members (Ctrl+Shift+O).", handler: navigate },
    { name: "help", description: "Show command help.", handler: showHelp },
  ];
  const commandHandler = async (args: string, ctx: ExtensionContext): Promise<void> => {
    const name = args.trim() || "help";
    const command = subcommands.find(command => command.name === name);
    if (!command) {
      notify(ctx, `Usage: /transcript-ui <${subcommands.map(command => command.name).join("|")}>`, "warning");
      return;
    }
    await command.handler(ctx);
  };
  pi.registerCommand("transcript-ui", {
    description: "Tool presentation settings and navigation.",
    getArgumentCompletions: (prefix) => {
      const matches = subcommands.filter(command => command.name.startsWith(prefix.trimStart()));
      return matches.length ? matches.map(command => ({ value: command.name, label: command.name, description: command.description })) : null;
    },
    handler: commandHandler,
  });
  const marker = process.env["PI_TRANSCRIPT_UI_LOAD_MARKER"];
  if (marker) {
    try { appendFileSync(marker, `loaded ${TRANSCRIPT_UI_VERSION} ${Date.now()}\n`); }
    catch { /* optional diagnostic */ }
  }

  try {
    nativeObservation = observeNativeMode(pi, commandHandler, (mode, original, args) => {
      codemode.captureMode(mode);
      let attachment;
      try { attachment = compaction.attach(mode); } catch (error) { reportNativeFailure(error); }
      return attachment ? () => attachment.adoptSourceRender(args, () => Reflect.apply(original, mode, args)) : undefined;
    });
  } catch (error) { reportNativeFailure(error); }
}
