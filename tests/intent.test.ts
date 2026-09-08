import { describe, expect, it } from "vitest";
import { addIntentSchema, hasIntentParameter, intentFromArgs, intentGuideline, normalizeIntent } from "../src/intent.js";

describe("existing model-written intent reception", () => {
  it("clones frozen/accessor-backed schemas while preserving unrelated descriptor behavior", () => {
    const metadata = Symbol("metadata");
    const prototype = { inspect(this: Record<symbol, unknown>) { return this[metadata]; } };
    const properties = Object.freeze({ value: { type: "string" } });
    const schema = Object.freeze(Object.create(prototype, {
      properties: { get: () => properties, enumerable: true },
      required: { get: () => ["value"], enumerable: true },
      [metadata]: { value: "original metadata", writable: false },
    }));
    const next = addIntentSchema(schema, { enabled: true, language: "en", maxLength: 64 });
    expect(prototype.inspect.call(next)).toBe("original metadata");
    expect(() => { (next as Record<symbol, unknown>)[metadata] = "changed"; }).toThrow();
    expect(next.required).toEqual(["value"]);
    expect((next.properties as Record<string, unknown>).displaySummary).toMatchObject({ type: "string", maxLength: 64 });
    expect(schema.properties).toBe(properties);
    expect(schema.required).toEqual(["value"]);
  });
  it("normalizes model purpose without generating fallback intent", () => {
    expect(normalizeIntent("  Check\t test\nsetup ")).toBe("Check test setup");
    for (const value of [undefined, null, "", "  ", 42]) expect(normalizeIntent(value)).toBeUndefined();
    expect(normalizeIntent("x".repeat(200))).toHaveLength(48);
    expect(normalizeIntent("🧪".repeat(60))).toBe("🧪".repeat(48));
    expect(normalizeIntent("x".repeat(47) + "é")).toBe("x".repeat(47));
    expect(normalizeIntent("x".repeat(47) + "👨‍👩‍👧‍👦")).toBe("x".repeat(47));
    expect(intentFromArgs({})).toBeUndefined();
  });
  it("reads only own intent and leaves source arguments unchanged", () => {
    const args = Object.freeze({ path: "f", displaySummary: "Explain the failure" });
    expect(intentFromArgs(args)).toBe("Explain the failure");
    expect(args.displaySummary).toBe("Explain the failure");
    expect(intentFromArgs(Object.create(args))).toBeUndefined();
  });
  it("identifies existing field ownership without changing the schema", () => {
    const parameters = Object.freeze({ type: "object", properties: Object.freeze({ displaySummary: { type: "string" } }) });
    expect(hasIntentParameter(parameters)).toBe(true);
    expect(hasIntentParameter({ type: "object", properties: {} })).toBe(false);
    expect(intentGuideline()).toContain("displaySummary");
    expect(intentGuideline()).toContain("Never include secrets");
  });
});
