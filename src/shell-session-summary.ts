import { INTENT_FIELD, isRecord } from "./intent.js";
import { supportedDirectSchema } from "./schema-capability.js";

export type ShellSessionSummary = (
  | Readonly<{ action: "Run"; command: string; commandSyntax?: "bash" | "zsh" }>
  | Readonly<{ action: "Check output" | "Send input"; command?: never }>
) & Readonly<{ exitCode?: number }>;

const stdinFields = new Set(["session_id", "chars", "chars_b64", "yield_time_ms", "yield_until", "max_output_tokens", "max_output_bytes", INTENT_FIELD]);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isSafeInteger = (value: unknown): value is number => isFiniteNumber(value) && Number.isSafeInteger(value);

function receiptExitCode(details: unknown, toolName: string): number | undefined {
  if (!isRecord(details)) return undefined;

  // The inspected receipt families are alternatives, not aliases to merge.
  if (Object.hasOwn(details, "exit_code") && Object.hasOwn(details, "exitCode")) return undefined;
  if (typeof details.output === "string" && isFiniteNumber(details.wall_time_seconds) && details.wall_time_seconds >= 0) {
    return isSafeInteger(details.exit_code) ? details.exit_code : undefined;
  }
  if (typeof details.chunkId === "string" && details.chunkId.length > 0 && isFiniteNumber(details.wallTimeSeconds) && details.wallTimeSeconds >= 0) {
    return isSafeInteger(details.exitCode) ? details.exitCode : undefined;
  }
  if (details.tool === toolName && details.status === "exited" && typeof details.output === "string" &&
    isFiniteNumber(details.durationMs) && details.durationMs >= 0) return isSafeInteger(details.exitCode) ? details.exitCode : undefined;

  return undefined;
}

/** Project the common request subset; unknown schemas, input channels and receipts stay opaque. */
export function shellSessionSummary({ toolName, parameters, args, result, isPartial, completeRequest = true }: {
  readonly toolName: string;
  readonly parameters: unknown;
  readonly args: unknown;
  readonly result?: { details?: unknown } | undefined;
  readonly isPartial: boolean;
  readonly completeRequest?: boolean;
}): ShellSessionSummary | undefined {
  try {
    if (toolName !== "exec_command" && toolName !== "write_stdin") return undefined;
    if (!supportedDirectSchema(parameters) || !isRecord(parameters) || parameters.type !== "object" ||
      !isRecord(parameters.properties) || !Array.isArray(parameters.required) || !isRecord(args)) return undefined;

    const fields = parameters.properties;
    const requiredKeys = parameters.required;
    if (completeRequest && requiredKeys.some((key: string) => !Object.hasOwn(args, key) || args[key] === undefined)) return undefined;
    const required = (key: string, type: string) => requiredKeys.includes(key) && isRecord(fields[key]) && fields[key].type === type;

    const exit = !isPartial ? receiptExitCode(result?.details, toolName) : undefined;
    const outcome = exit === undefined ? {} : { exitCode: exit };

    if (toolName === "exec_command") {
      if (!required("cmd", "string") || typeof args.cmd !== "string" || !args.cmd.split("\n", 1)[0]?.trim()) return undefined;

      const shellSchema: unknown = Object.getOwnPropertyDescriptor(fields, "shell")?.value;
      const shell: unknown = isRecord(shellSchema) && Object.getOwnPropertyDescriptor(shellSchema, "type")?.value === "string"
        ? Object.getOwnPropertyDescriptor(args, "shell")?.value : undefined;
      const executable = typeof shell === "string" ? shell.split(/[\\/]/).at(-1) : undefined;
      const syntax = executable === "bash" || executable === "bash.exe" ? { commandSyntax: "bash" as const }
        : executable === "zsh" || executable === "zsh.exe" ? { commandSyntax: "zsh" as const } : {};
      return { action: "Run", command: args.cmd, ...syntax, ...outcome };
    }

    if (!required("session_id", "number") || !isSafeInteger(args.session_id) || args.session_id < 0 ||
      !isRecord(fields.chars) || fields.chars.type !== "string" ||
      Object.keys(fields).some(key => !stdinFields.has(key)) ||
      Object.keys(args).some(key => !stdinFields.has(key))) return undefined;
    if (!completeRequest && (!Object.hasOwn(args, "chars") || (Object.hasOwn(fields, "chars_b64") && !Object.hasOwn(args, "chars_b64")))) return undefined;
    if (args.chars !== undefined && typeof args.chars !== "string") return undefined;
    if (args.chars === undefined && fields.chars.default !== undefined && fields.chars.default !== "") return undefined;
    if (Object.hasOwn(args, "chars_b64") && (args.chars_b64 !== "" || !isRecord(fields.chars_b64) || fields.chars_b64.type !== "string")) return undefined;
    if (args.chars_b64 === undefined && isRecord(fields.chars_b64) && fields.chars_b64.default !== undefined && fields.chars_b64.default !== "") return undefined;

    return { action: typeof args.chars === "string" && args.chars.length > 0 ? "Send input" : "Check output", ...outcome };
  } catch { return undefined; }
}
