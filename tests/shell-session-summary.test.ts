import { expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { shellSessionSummary } from "../src/shell-session-summary.js";
import { joinLine, shellSessionLine, targetText } from "../src/display.js";

const schema = (name: string, extras: Record<string, unknown> = {}) => ({ type: "object",
  properties: { [name === "exec_command" ? "cmd" : "session_id"]: { type: name === "exec_command" ? "string" : "number" },
    chars: { type: "string" }, ...extras }, required: [name === "exec_command" ? "cmd" : "session_id"] });
const summarize = (name = "write_stdin", args: unknown = { session_id: 73 }, details?: unknown, parameters: unknown = schema(name)) =>
  shellSessionSummary({ toolName: name, parameters, args, result: { details }, isPartial: false });

it.each([
  ["conversion/mkaros", { shell: { type: "string" }, login: { type: "boolean" }, tty: { type: "boolean" }, max_output_tokens: { type: "number" } }, {}],
  ["iamwrm", { on_exit: { type: "string", enum: ["none", "wake"] }, cols: { type: "number" }, rows: { type: "number" } }, { chars_b64: { type: "string" }, yield_until: { type: "string" } }],
  ["chensl/2h2d", { workdir: { type: "string" }, yield_time_ms: { type: "number" }, max_output_tokens: { type: "number" } }, { max_output_tokens: { type: "number" } }],
  ["capyup", { tty: { type: "boolean" }, max_output_bytes: { type: "number" } }, { max_output_bytes: { type: "number" } }],
] as const)("admits the common direct request fields with %s options", (_provider, execExtras, stdinExtras) => {
  expect(summarize("exec_command", { cmd: "npm test" }, undefined, { ...schema("exec_command", execExtras), additionalProperties: false })?.action).toBe("Run");
  expect(summarize("write_stdin", { session_id: 73, chars: "\n" }, undefined, { ...schema("write_stdin", stdinExtras), additionalProperties: false })?.action).toBe("Send input");
});

it("projects common requests without assuming shell language or process lifetime", () => {
  expect(summarize("exec_command", { cmd: "npm test", shell: "/bin/fish" })).toEqual({ action: "Run", command: "npm test" });
  for (const chars of [undefined, ""]) expect(summarize("write_stdin", { session_id: 1, chars })).toEqual({ action: "Check output" });
  for (const chars of ["\n", " ", "\u0003", "help\n", "\\x03"]) expect(summarize("write_stdin", { session_id: 1, chars })).toEqual({ action: "Send input" });
});

it.each(["exec_command", "write_stdin"])("requires every declared input before projecting %s", name => {
  const key = name === "exec_command" ? "workdir" : "chars";
  const base = name === "exec_command" ? { cmd: "npm test" } : { session_id: 1 };
  const value = name === "exec_command" ? "/tmp" : "";
  const parameters = { ...schema(name, { [key]: { type: "string" } }),
    required: [name === "exec_command" ? "cmd" : "session_id", key] };
  const inherited = { ...base }; Object.setPrototypeOf(inherited, { [key]: value });
  for (const args of [base, { ...base, [key]: undefined }, inherited]) {
    for (const isPartial of [true, false]) {
      expect(shellSessionSummary({ toolName: name, parameters, args, isPartial })).toBeUndefined();
    }
  }
  expect(summarize(name, { ...base, [key]: value }, undefined, parameters)?.action)
    .toBe(name === "exec_command" ? "Run" : "Check output");
});

it("does not fill missing required inputs from schema defaults", () => {
  for (const name of ["exec_command", "write_stdin"]) {
    const key = name === "exec_command" ? "workdir" : "chars";
    const args = name === "exec_command" ? { cmd: "npm test" } : { session_id: 1 };
    const parameters = { ...schema(name, { [key]: { type: "string", default: name === "exec_command" ? "/tmp" : "" } }),
      required: [name === "exec_command" ? "cmd" : "session_id", key] };
    expect(summarize(name, args, undefined, parameters)).toBeUndefined();
  }
});

it("retains defined empty, zero and false required inputs", () => {
  const parameters = { ...schema("exec_command", { workdir: { type: "string" }, tty: { type: "boolean" }, yield_time_ms: { type: "number" } }),
    required: ["cmd", "workdir", "tty", "yield_time_ms"] };
  expect(summarize("exec_command", { cmd: "npm test", workdir: "", tty: false, yield_time_ms: 0 }, undefined, parameters))
    .toEqual({ action: "Run", command: "npm test" });
  expect(summarize("write_stdin", { session_id: 0, chars: "" }, undefined, { ...schema("write_stdin"), required: ["session_id", "chars"] }))
    .toEqual({ action: "Check output" });
});

it("marks omitted command lines before the whole-script exit code", () => {
  const summary = summarize("exec_command", { cmd: "cd repo\nrm -rf build\nnpm test" },
    { output: "", wall_time_seconds: 1, exit_code: 0 })!;
  expect(joinLine(shellSessionLine(summary, false, false))).toBe("▸ Run cd repo […] (exit 0)");
});

it.each(["\n", "\n\n  \n", "\r\n", "\r\n \t\r\n"])("keeps trailing whitespace out of the omission claim and exit label: %j", suffix => {
  const args = { cmd: "npm test" + suffix };
  const summary = summarize("exec_command", args, { output: "", wall_time_seconds: 1, exit_code: 0 })!;
  expect(joinLine(shellSessionLine(summary, false, false))).toBe("▸ Run npm test (exit 0)");
  expect(args.cmd).toBe("npm test" + suffix);
});

it.each(["\nnpm test", " \t\nnpm test", "\r\nnpm test"])("refuses an empty first command line: %j", cmd => {
  expect(summarize("exec_command", { cmd })).toBeUndefined();
});

it.each([
  ["conversion and mkaros", { output: "", wall_time_seconds: 0, exit_code: 0 }, 0],
  ["unified-exec", { operation: "write_stdin", status: "exited", running: false, output: "x", wall_time_seconds: 0.2, exit_code: 7, command: "npm test" }, 7],
  ["chensl", { output: "x", wall_time_seconds: 0.2, exit_code: 2, cancelled: true }, 2],
  ["2h2d", { chunkId: "abc", wallTimeSeconds: 0.2, exitCode: -1, fullOutputPath: "/tmp/log" }, -1],
  ["capyup", { tool: "write_stdin", status: "exited", durationMs: 12, output: "", exitCode: 0, sessionId: 73 }, 0],
] as const)("reads only established exit facts from %s receipts", (_provider, details, exit) => {
  expect(summarize("write_stdin", { session_id: 73 }, details)).toEqual({ action: "Check output", exitCode: exit });
});

it.each([undefined, {}, { exit_code: 0 }, { exitCode: 0 },
  { output: "", wall_time_seconds: 0, session_id: 73 },
  { output: "", wall_time_seconds: 0, exit_code: null },
  { output: "", wall_time_seconds: 0, exit_code: NaN },
  { output: "", wall_time_seconds: -1, exit_code: 0 },
  { output: "", wall_time_seconds: 0, exit_code: 0, exitCode: 7 },
  { tool: "write_stdin", status: "running", output: "", durationMs: 0, exitCode: 7 },
])("does not manufacture exit success or merge incompatible receipt interpretations", details => {
  expect(summarize("write_stdin", { session_id: 73 }, details)?.exitCode).toBeUndefined();
});

it("refuses other input channels rather than treating their missing chars as a poll", () => {
  const binary = schema("write_stdin", { chars_b64: { type: "string" }, yield_until: { type: "string" } });
  for (const chars_b64 of ["bHMK", "  ", null, 12]) {
    expect(summarize("write_stdin", { session_id: 1, chars_b64 }, undefined, binary)).toBeUndefined();
  }
  expect(summarize("write_stdin", { session_id: 1, chars_b64: "" }, undefined, binary)?.action).toBe("Check output");
  expect(summarize("write_stdin", { session_id: 1, data: "input" })).toBeUndefined();
  expect(summarize("write_stdin", { session_id: 1 }, undefined, schema("write_stdin", { data: { type: "string", default: "input" } }))).toBeUndefined();
  for (const field of ["chars", "chars_b64"]) {
    const defaults = schema("write_stdin", { [field]: { type: "string", default: "input" } });
    expect(summarize("write_stdin", { session_id: 1 }, undefined, defaults)).toBeUndefined();
  }
});

it("omits exit metadata from partial updates without losing the request", () => {
  expect(shellSessionSummary({ toolName: "exec_command", parameters: schema("exec_command"), args: { cmd: "npm test" },
    result: { details: { output: "", wall_time_seconds: 1, exit_code: 0 } }, isPartial: true })).toEqual({ action: "Run", command: "npm test" });
});

it("refuses unknown names, schema meanings and malformed requests", () => {
  expect(summarize("other", { cmd: "x" })).toBeUndefined();
  expect(shellSessionSummary({ toolName: "exec_command", parameters: undefined, args: { cmd: "x" }, isPartial: false })).toBeUndefined();
  for (const parameters of [{ ...schema("exec_command"), required: [] },
    { ...schema("exec_command"), anyOf: [] }, schema("write_stdin"),
    { type: "object", properties: { cmd: { type: "number" } }, required: ["cmd"] }]) {
    expect(summarize("exec_command", { cmd: "x" }, undefined, parameters)).toBeUndefined();
  }
  for (const args of [{}, { cmd: " " }, { cmd: 1 }, { command: "alias not declared" }]) expect(summarize("exec_command", args)).toBeUndefined();
  for (const args of [{ session_id: "1" }, { session_id: -1 }, { session_id: 1, chars: 2 }]) expect(summarize("write_stdin", args)).toBeUndefined();
  expect(summarize("exec_command", Object.defineProperty({}, "cmd", { get() { throw new Error("getter"); } }))).toBeUndefined();
});

it("keeps opaque commands raw, uncolored, bounded and independent from exit/error status", () => {
  const command = "echo 'quoted' && fish-specific $argv[1]\nsecond command";
  const summary = summarize("exec_command", { cmd: command }, { output: "x", wall_time_seconds: 1, exit_code: 7 })!;
  const parts = shellSessionLine(summary, false, false, { intent: "Check tests", layout: { width: 80 } });
  expect(joinLine(parts)).toContain("Run echo 'quoted' && fish-specific $argv[1]");
  expect(joinLine(parts)).toContain("(exit 7)");
  expect(parts.command).toBeUndefined();
  expect(joinLine(parts)).not.toContain("— error");
  expect(joinLine(shellSessionLine(summary, true, false))).toContain("— error");
  for (const width of [0, 1, 5, 24]) expect(visibleWidth(targetText({ kind: "opaque-command", command }, {}, width))).toBeLessThanOrEqual(width);
});
