import { expect, it } from "vitest";
import { normalizeIntent } from "../src/intent.js";
import { INTENT_ENTRY, IntentTransport } from "../src/intent-transport.js";

const parameters = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };

for (const limit of [16, 48, 256]) {
  for (const sample of ["Inspect configuration ".repeat(20), "🔎".repeat(300), "x".repeat(limit - 1) + "🔎", "é".repeat(200), "👨‍👩‍👧‍👦".repeat(100)]) {
    it(`round-trips normalized intent at ${limit} code points (${sample.slice(0, 12)})`, () => {
      const entries: unknown[] = [];
      const transport = new IntentTransport(records => entries.push({ type: "custom", customType: INTENT_ENTRY, data: records }));
      const policy = { enabled: true, language: "auto", maxLength: limit } as const;
      transport.preparePayload({ tools: [{ type: "function", function: { name: "read", parameters } }] }, [{ name: "read", parameters }], policy, () => {});
      const text = normalizeIntent(sample, limit)!;
      const prepared = transport.prepareMessage({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "source.ts", displaySummary: text } }] });
      expect(prepared).toEqual({ role: "assistant", content: [
        { type: "toolCall", id: "call", name: "read", arguments: { path: "source.ts" } },
      ] });
      expect(transport.resolve("call", {}, limit)).toBe(text);

      const restored = new IntentTransport(() => {});
      restored.restore(JSON.parse(JSON.stringify(entries)));
      expect(restored.resolve("call", {}, limit)).toBe(text);
    });
  }
}

it.each(["x".repeat(257), "🔎".repeat(257), "x".repeat(1_000_000)])("rejects over-limit persisted records (%#)", text => {
  const transport = new IntentTransport(() => {});
  transport.restore([{ type: "custom", customType: INTENT_ENTRY, data: [{ toolCallId: "call", text, source: "model" }] }]);
  expect(transport.resolve("call", {}, 256)).toBeUndefined();
});
