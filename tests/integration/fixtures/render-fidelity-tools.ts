/** Real-runtime fixture: load both with and without transcript-ui. No global config writes. */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export default function fidelityTools(pi: ExtensionAPI): void {
  const parameters = {
    type: "object", properties: { displaySummary: { type: "string", description: "Purpose of this call" } },
    required: ["displaySummary"], additionalProperties: false,
  };
  for (const shell of ["default", "self", "missing"] as const) {
    const definition = {
      name: `fidelity_${shell}`,
      label: `Fidelity ${shell}`,
      description: `Render fidelity fixture ${shell}. Call once to inspect the original ${shell} shell.`,
      parameters,
      execute: async () => ({ content: [{ type: "text" as const, text: "FIRST RESULT LINE\nSECOND RESULT LINE" }], details: { proof: "fixture-result" } }),
      ...(shell !== "missing" ? {
        renderShell: shell,
        renderCall: (_args: unknown, theme: any, context: any) => {
          if (context.argsComplete) context.state.ready = "READY";
          const text = context.lastComponent ?? new Text("", 0, 0);
          text.setText(theme.fg("accent", theme.bold(`FOREIGN CALL ${shell} ${context.state.ready ?? "STREAMING"}`)));
          return text;
        },
        renderResult: (result: any, _options: unknown, theme: any, context: any) => {
          const text = context.lastComponent ?? new Text("", 0, 0);
          text.setText(theme.fg("success", `FOREIGN RESULT ${shell} ${context.state.ready ?? "MISSING STATE"}\n${result.content[0].text}`));
          return text;
        },
      } : {}),
    };
    pi.registerTool(definition as ToolDefinition);
  }
}
