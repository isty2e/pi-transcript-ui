import { describe, expect, it, vi } from "vitest";
import { NO_SUMMARY_METRICS } from "../src/tool-metrics.js";
import { IntentTransport, INTENT_ENTRY } from "../src/intent-transport.js";
import { defaultSettings } from "../src/settings.js";
import { normalizeIntent } from "../src/intent.js";

const policy = defaultSettings().intent;
const schema = Object.freeze({ type: "object", properties: Object.freeze({ value: Object.freeze({ type: "string" }) }), required: Object.freeze(["value"]), additionalProperties: false });
const tools = [{ name: "custom", parameters: schema }];
const call = (args: unknown, id = "c1", name = "custom") => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
const envelopes = [
  (s: unknown) => ({ tools: [{ type: "function", function: { name: "custom", parameters: s, strict: true } }] }),
  (s: unknown) => ({ tools: [{ type: "function", name: "custom", parameters: s, strict: true }] }),
  (s: unknown) => ({ tools: [{ name: "custom", input_schema: s, defer_loading: true }] }),
  (s: unknown) => ({ config: { tools: [{ functionDeclarations: [{ name: "custom", parametersJsonSchema: s }] }] } }),
  (s: unknown) => ({ toolConfig: { tools: [{ toolSpec: { name: "custom", inputSchema: { json: s } } }] } }),
  (s: unknown) => ({ input: [{ type: "tool_search_output", tools: [{ name: "custom", parameters: s }] }] }),
  (s: unknown) => ({ messages: [{ role: "system", tools: [{ type: "function", function: { name: "custom", parameters: s } }] }] }),
  (s: unknown) => ({ context: { tools: [{ name: "custom", parameters: s }] } }),
  (s: unknown) => ({ config: { tools: [{ functionDeclarations: [{ name: "custom", parameters: s }] }] } }),
];
describe("model-only intent transport", () => {
  for (const [index, envelope] of envelopes.entries()) it(`augments provider envelope ${index}, never native schema`, () => {
    const persist = vi.fn(), transport = new IntentTransport(persist), warn = vi.fn();
    const payload = envelope(schema);
    const result = transport.preparePayload(payload, tools, policy, warn);
    expect(JSON.stringify(result)).toContain('"displaySummary"');
    expect(JSON.stringify(result)).not.toContain('"minLength"');
    expect(JSON.stringify(result)).toContain('"maxLength":48');
    expect(JSON.stringify(payload)).not.toContain("displaySummary");
    const original = Object.freeze({ value: "native", displaySummary: "Explain why this matters" });
    const message = transport.prepareMessage(call(original)) as ReturnType<typeof call>;
    expect(message.content[0]!.arguments).toEqual({ value: "native" });
    expect(original.displaySummary).toBe("Explain why this matters");
    expect(transport.get("c1")).toEqual({ toolCallId: "c1", text: "Explain why this matters", source: "model" });
    expect(persist).toHaveBeenCalledTimes(1);
    const restored = new IntentTransport(vi.fn());
    restored.restore([{ type: "custom", customType: INTENT_ENTRY, data: persist.mock.calls[0]![0] }]);
    expect(restored.get("c1")).toEqual(transport.get("c1"));
    expect(warn).not.toHaveBeenCalled();
  });
  it("creates no records for omitted/empty/null summaries without modifying native input", () => {
    const persist = vi.fn(), transport = new IntentTransport(persist);
    transport.preparePayload(envelopes[0]!(schema), tools, policy, vi.fn());
    const message = call({ value: "native" });
    expect(transport.prepareMessage(message)).toBe(message);
    expect(transport.get("c1")).toBeUndefined();
    expect((transport.prepareMessage(call({ value: "native", displaySummary: " \n" }, "c2")) as ReturnType<typeof call>).content[0]!.arguments).toEqual({ value: "native" });
    expect(transport.get("c2")).toBeUndefined();
    expect((transport.prepareMessage(call({ value: "native", displaySummary: null }, "c3")) as ReturnType<typeof call>).content[0]!.arguments).toEqual({ value: "native" });
    expect(transport.get("c3")).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });
  it("separates intent from proxy arguments without writing through the proxy", () => {
    const transport = new IntentTransport(vi.fn());
    transport.preparePayload(envelopes[0]!(schema), tools, policy, vi.fn());
    const args = new Proxy({ value: "native", displaySummary: "Verify proxied arguments" }, {
      set() { throw new Error("writes forbidden"); },
      deleteProperty() { throw new Error("deletes forbidden"); },
    });
    const message = transport.prepareMessage(call(args)) as ReturnType<typeof call>;
    expect(message.content[0]!.arguments).toEqual({ value: "native" });
    expect(args.displaySummary).toBe("Verify proxied arguments");
  });
  it("does not acquire foreign displaySummary or alter unknown calls", () => {
    const transport = new IntentTransport(vi.fn());
    const foreign = { ...schema, properties: { value: { type: "string" }, displaySummary: { type: "number" } } };
    const payload = envelopes[0]!(foreign);
    expect(transport.preparePayload(payload, [{ name: "custom", parameters: foreign }], policy, vi.fn())).toEqual(payload);
    const message = call({ value: "native", displaySummary: 42 });
    expect(transport.prepareMessage(message)).toBe(message);
    expect(transport.get("c1")).toBeUndefined();
  });
  it("supports native provider casing and removes owned fields before native prep", () => {
    const transport = new IntentTransport(vi.fn());
    transport.preparePayload({ tools: [{ name: "Read", input_schema: schema }] }, [{ name: "read", parameters: schema }], policy, vi.fn());
    const message = transport.prepareMessage(call({ value: "native", displaySummary: "Inspect package dependencies" }, "c1", "read")) as ReturnType<typeof call>;
    expect(message.content[0]!.arguments).toEqual({ value: "native" });
  });
  it("retains ownership when a provider retries with the already-decorated payload", () => {
    const transport = new IntentTransport(vi.fn());
    const original = envelopes[0]!(schema);
    const first = transport.preparePayload(original, tools, policy, vi.fn());
    const second = transport.preparePayload(first, tools, policy, vi.fn());
    expect(second).toEqual(first);
    expect((transport.prepareMessage(call({ value: "native", displaySummary: "Retry safely" })) as ReturnType<typeof call>).content[0]!.arguments).toEqual({ value: "native" });
    expect(transport.preparePayload(second, tools, { ...policy, enabled: false }, vi.fn())).toEqual(original);
  });
  it("handles disabled requests without stripping unrelated arguments", () => {
    const transport = new IntentTransport(vi.fn());
    const payload = envelopes[0]!(schema);
    expect(transport.preparePayload(payload, tools, { ...policy, enabled: false }, vi.fn())).toEqual(payload);
    const message = call({ displaySummary: "not ours" });
    expect(transport.prepareMessage(message)).toBe(message);
  });
  it("does not make whole-object constraints unsatisfiable by adding a required property", () => {
    const transport = new IntentTransport(vi.fn()), warn = vi.fn();
    for (const constraint of [{ maxProperties: 1 }, { propertyNames: { pattern: "^[a-z]+$" } }, { allOf: [schema] }]) {
      const original = envelopes[0]!({ ...schema, ...constraint });
      expect(transport.preparePayload(original, tools, policy, warn)).toEqual(original);
      const message = call({ value: "native" });
      expect(transport.prepareMessage(message)).toBe(message);
      expect(transport.get("c1")).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(3);
  });
  it("warns on unsupported provider envelopes and preserves payload", () => {
    const transport = new IntentTransport(vi.fn()), warn = vi.fn();
    const payload = { unfamiliar: [] };
    expect(transport.preparePayload(payload, tools, policy, warn)).toEqual(payload);
    expect(warn).toHaveBeenCalledOnce();
  });
  it("keeps request ownership after settings change and reports storage failure without leaking UI args", () => {
    const error = new Error("disk full"), warn = vi.fn();
    const transport = new IntentTransport(() => { throw error; }, warn);
    const mutable = { ...policy };
    transport.preparePayload(envelopes[0]!(schema), tools, mutable, vi.fn());
    mutable.enabled = false; mutable.language = "zh-CN";
    const message = transport.prepareMessage(call({ value: "native", displaySummary: "Genuine purpose" })) as ReturnType<typeof call>;
    expect(message.content[0]!.arguments).toEqual({ value: "native" });
    expect(transport.get("c1")?.text).toBe("Genuine purpose");
    expect(warn).toHaveBeenCalledWith(error);
  });
  it("retains only the selected branch and sanitizes restored records", () => {
    const transport = new IntentTransport(vi.fn());
    transport.restore([{ type: "custom", customType: INTENT_ENTRY, data: [{ toolCallId: "c1", text: "\x1b[31mSafe text\x1b[0m", source: "model" }] }]);
    expect(transport.get("c1")?.text).toBe("Safe text");
    transport.restore([]);
    expect(transport.get("c1")).toBeUndefined();
  });
  it("strips terminal escapes instead of rendering their fragments", () => {
    expect(normalizeIntent("\x1b[31mFind dependencies\x1b[0m\x1b]0;hidden\x07")).toBe("Find dependencies");
    expect(normalizeIntent("\x1b]8;;https://example.com\x1b\\Find dependencies\x1b]8;;\x1b\\")).toBe("Find dependencies");
  });
});

it("hides historical fallback, upgrades retries to genuine intent, and restores model records without wording blacklists", () => {
  const persist = vi.fn(), transport = new IntentTransport(persist);
  const fallback = { toolCallId: "c1", text: "Run custom", source: "fallback" };
  const entries = [{ type: "custom", customType: INTENT_ENTRY, data: [fallback] }];
  transport.restore(entries);
  expect(transport.resolve("c1", {}, 48)).toBeUndefined();
  expect(transport.resolve("c1", { displaySummary: "Genuine later args" }, 48)).toBe("Genuine later args");
  transport.preparePayload(envelopes[0]!(schema), tools, policy, vi.fn());
  transport.prepareMessage(call({ value: "native", displaySummary: "Run custom" }));
  expect(transport.get("c1")).toEqual({ ...fallback, source: "model" });
  expect(transport.resolve("c1", {}, 48)).toBe("Run custom");
  transport.prepareMessage(call({ value: "native" }));
  expect(persist).toHaveBeenCalledOnce();
  expect(entries[0]!.data[0]).toBe(fallback);
  transport.restore([...entries, { type: "custom", customType: INTENT_ENTRY, data: persist.mock.calls[0]![0] }, ...entries]);
  expect(transport.resolve("c1", {}, 48)).toBe("Run custom");
  transport.restore(entries);
  expect(transport.resolve("c1", {}, 48)).toBeUndefined();
  transport.restore([]);
  expect(transport.resolve("c1", {}, 48)).toBeUndefined();
});

it("executes validation of optional/nullable purpose for actual Completions and Responses strict variants", async () => {
  const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
  const { join } = await import("node:path");
  const { validateToolArguments } = await import(join(getPackageDir(), "node_modules/@earendil-works/pi-ai/dist/utils/validation.js"));
  for (const nested of [true, false]) for (const strict of [undefined, false, true, null]) {
    const transport = new IntentTransport(vi.fn());
    const declaration = { name: "custom", parameters: schema, ...(strict === undefined ? {} : { strict }) };
    const payload = { tools: [nested ? { type: "function", function: declaration } : { type: "function", ...declaration }] };
    const prepared = transport.preparePayload(payload, tools, policy, vi.fn()) as { tools: any[] };
    const tool = nested ? prepared.tools[0].function : prepared.tools[0];
    const nullable = strict === true || (!nested && strict == null);
    expect(tool.strict).toBe(strict);
    expect(Object.hasOwn(tool, "strict")).toBe(strict !== undefined);
    expect(tool.parameters.required).toEqual(nullable ? ["value", "displaySummary"] : ["value"]);
    expect(tool.parameters.properties.displaySummary.type).toEqual(nullable ? ["string", "null"] : "string");
    expect(tool.parameters.properties.displaySummary.description).toContain("Omit when redundant");
    expect(tool.parameters.properties.displaySummary.description).toContain("use null");
    const validate = (arguments_: unknown) => validateToolArguments({ name: "custom", parameters: tool.parameters }, { name: "custom", arguments: arguments_ });
    for (const displaySummary of ["", "Run command", ...(nullable ? [null] : [])]) {
      const args = { value: "native", displaySummary };
      expect(() => validate(args)).not.toThrow();
      const message = transport.prepareMessage(call(args, `c-${String(displaySummary)}`)) as ReturnType<typeof call>;
      expect(message.content[0]!.arguments).toEqual({ value: "native" });
      expect(() => validateToolArguments({ name: "custom", parameters: schema }, { name: "custom", arguments: message.content[0]!.arguments })).not.toThrow();
    }
    if (nullable) expect(() => validate({ value: "native" })).toThrow();
    else expect(() => validate({ value: "native" })).not.toThrow();
    expect(() => validate({ displaySummary: "valid purpose" })).toThrow();
    expect(() => validate({ value: {}, displaySummary: "valid purpose" })).toThrow();
    expect(() => validate({ value: "native", displaySummary: {} })).toThrow();
    expect(() => validate({ value: "native", displaySummary: "x".repeat(49) })).toThrow();
    expect(tool.parameters.properties.value).toBe(schema.properties.value);
  }
  // Untyped flat Google/Pi declarations do not inherit Responses defaults.
  const transport = new IntentTransport(vi.fn());
  const result = transport.preparePayload({ tools: [{ name: "custom", parameters: schema }] }, tools, policy, vi.fn()) as any;
  expect(result.tools[0].parameters.required).toEqual(["value"]);
});

it("reclaims the actual description budget when intent is omitted or a restored fallback is hidden", async () => {
  const { displayFor, joinLine, settledLine } = await import("../src/display.js");
  const transport = new IntentTransport(vi.fn());
  transport.restore([{ type: "custom", customType: INTENT_ENTRY, data: [{ toolCallId: "c1", text: "Run command", source: "fallback" }] }]);
  const args = { command: "printf abcdefghijklmnopqrstuvwxyz0123456789" };
  const row = (intent: string | undefined) => joinLine(settledLine({ toolName: "bash", display: displayFor("bash", args), content: [{ type: "text", text: "ok" }], isError: false, intent, layout: { width: 60 }, metrics: NO_SUMMARY_METRICS }));
  const absent = row(transport.resolve("c1", args, 48));
  expect(absent).toBe(row(undefined));
  expect(absent).toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  expect(row("Explain the specific investigation")).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
});
