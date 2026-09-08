import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { attachTranscriptPresentation, type PresentationAttachment } from "./wiring.js";
import { ToolNavigation, navigationComponent } from "./navigation.js";
import { intentGuideline } from "./intent.js";
import { INTENT_ENTRY, IntentTransport } from "./intent-transport.js";
import { defaultSettings, groupingRules, SettingsFile } from "./settings.js";
import { editSettings } from "./settings-ui.js";
import packageMetadata from "../package.json" with { type: "json" };

export const TRANSCRIPT_UI_VERSION = packageMetadata.version;
const WIDGET_KEY = "pi-transcript-ui-attachment";
const COMPOSITOR_ACTIVE = Symbol.for("pi-fixed-editor-compositor.alternateScreenActive");
function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else process.stderr.write(`transcript-ui: ${message}\n`);
}

export default function transcriptUi(pi: ExtensionAPI): void {
  const file = new SettingsFile(process.env["PI_TRANSCRIPT_UI_SETTINGS"] ?? join(getAgentDir(), "extensions", "pi-transcript-ui", "settings.json"));
  let reportPersistenceError: (error: unknown) => void = (error) => { process.stderr.write(`transcript-ui intent was not persisted: ${String(error)}\n`); };
  const intents = new IntentTransport((records) => pi.appendEntry(INTENT_ENTRY, records), (error) => { reportPersistenceError(error); });
  let settings = defaultSettings();
  let detach: PresentationAttachment | undefined;
  let closeNavigator: (() => void) | undefined;
  let reconfigure: (() => void) | undefined;
  let live = false;
  const warned = new Set<string>();
  const navigate = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui" || closeNavigator) return;
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
  pi.registerShortcut("ctrl+shift+o", { description: "Navigate tool groups and members", handler: navigate });
  pi.on("session_start", async (_event, ctx) => {
    closeNavigator?.();
    detach?.(); detach = undefined; reconfigure = undefined;
    reportPersistenceError = (error) => {
      const message = `Transcript intent remains visible but was not saved: ${String(error)}`;
      notify(ctx, message, "error");
    };
    try { settings = (await file.load()).settings; }
    catch (error) { notify(ctx, `Settings not loaded: ${String(error)}`, "error"); }
    intents.restore(ctx.sessionManager.getBranch());
    if (ctx.mode !== "tui") return;
    live = true;
    ctx.ui.setWidget(WIDGET_KEY, (tui) => {
      reconfigure = () => {
        closeNavigator?.();
        detach?.(); detach = undefined;
        if (!live) return;
        try {
          detach = attachTranscriptPresentation(tui, {
            getTheme: () => ctx.ui.theme, requestRender: () => tui.requestRender(), rules: groupingRules(settings), displayLimits: settings.display,
            resolveIntent: (id, args) => settings.intent.enabled ? intents.resolve(id, args, settings.intent.maxLength) : undefined,
            onUnsupported: (name, error) => ctx.ui.notify(`transcript-ui kept ${name} native: ${String(error)}`, "warning"),
          });
          tui.requestRender();
        } catch (error) { ctx.ui.notify(`transcript-ui attachment failed: ${String(error)}`, "error"); }
      };
      if (live && !detach) reconfigure();
      return { render: () => [], invalidate: () => {} };
    });
  });
  pi.on("session_tree", (_event, ctx) => { intents.restore(ctx.sessionManager.getBranch()); });
  pi.on("session_shutdown", (_event, ctx) => {
    live = false;
    closeNavigator?.();
    detach?.(); detach = undefined; reconfigure = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
  });
  pi.on("before_agent_start", (event) => settings.intent.enabled ? {
    systemPrompt: `${event.systemPrompt}\n\n${intentGuideline(settings.intent.language)}`,
  } : undefined);
  pi.on("before_provider_request", (event, ctx) => {
    const active = new Set(pi.getActiveTools());
    return intents.preparePayload(event.payload, pi.getAllTools().filter((tool) => active.has(tool.name)), settings.intent, (message) => {
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
  pi.registerCommand("transcript-ui", {
    description: "Tool presentation settings and navigation.",
    getArgumentCompletions: (prefix) => {
      const matches = subcommands.filter(command => command.name.startsWith(prefix.trimStart()));
      return matches.length ? matches.map(command => ({ value: command.name, label: command.name, description: command.description })) : null;
    },
    handler: async (args, ctx) => {
      const name = args.trim() || "help";
      const command = subcommands.find(command => command.name === name);
      if (!command) {
        notify(ctx, `Usage: /transcript-ui <${subcommands.map(command => command.name).join("|")}>`, "warning");
        return;
      }
      await command.handler(ctx);
    },
  });
  const marker = process.env["PI_TRANSCRIPT_UI_LOAD_MARKER"];
  if (marker) {
    try { appendFileSync(marker, `loaded ${TRANSCRIPT_UI_VERSION} ${Date.now()}\n`); }
    catch { /* optional diagnostic */ }
  }
}
