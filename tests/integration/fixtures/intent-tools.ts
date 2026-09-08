import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { appendFileSync } from "node:fs";

export default function intentTools(pi: ExtensionAPI): void {
  const log = (phase: string, args: unknown) => {
    const path = process.env["PI_TRANSCRIPT_UI_PROBE_LOG"];
    if (path) appendFileSync(path, JSON.stringify({ phase, args }) + "\n");
  };
  pi.registerTool({
    name: "intent_probe", label: "Intent Probe", description: "Harmless fixture that verifies native argument and renderer preservation.",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } as never,
    prepareArguments(args) { log("prepare", args); return args as never; },
    async execute(_id, args) {
      log("execute", args);
      return { content: [{ type: "text", text: `NATIVE VALUE ${(args as { value: string }).value}\nNATIVE SECOND ROW` }], details: {} };
    },
    renderCall(args, theme, context) {
      context.state["ready"] = context.argsComplete;
      return new Text(theme.fg("accent", `NATIVE CALL ${(args as { value?: string }).value ?? "pending"}`), 0, 0);
    },
    renderResult(result, _options, theme, context) {
      return new Text(theme.fg("success", `NATIVE STATE ${context.state["ready"] ? "READY" : "STREAMING"}\n${result.content.map((block) => block.type === "text" ? block.text : "").join("\n")}`), 0, 0);
    },
  });
}
