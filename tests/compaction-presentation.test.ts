import { expect, it, vi } from "vitest";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { checkpointRouteMismatch, compactionDisplay, declaredCheckpointRoute } from "../src/compaction/producer.js";
import { CompactionView } from "../src/compaction/view.js";

const details = { strategy: "openai-responses-compaction-v2", provider: "openai-codex", api: "openai-codex-responses",
  model: "recorded-model", baseUrl: "https://fixture.invalid/v1", createdAt: "2026-10-30T00:00:00Z", compactedWindow: [] };
const opaque = { summary: "[OpenAI native compaction checkpoint]", details };
const model = { provider: details.provider, api: details.api, id: "selected-model" };

it("reads a declared provider/API restriction rather than guessing from a provider family", () => {
  expect(checkpointRouteMismatch(opaque, model)).toBe(false);
  expect(checkpointRouteMismatch(opaque, { ...model, provider: "openai", api: "openai-responses" })).toBe(true);
  expect(checkpointRouteMismatch(opaque, { ...model, api: "openai-completions" })).toBe(true);
  expect(checkpointRouteMismatch(opaque, { ...model, baseUrl: "https://other.invalid" })).toBe(false);
  expect(checkpointRouteMismatch(opaque, undefined)).toBe(false);
  expect(checkpointRouteMismatch(opaque, { provider: "anthropic" })).toBe(false);
  expect(checkpointRouteMismatch({ ...opaque, summary: "Portable summary" }, { ...model, provider: "anthropic" })).toBe(false);
  expect(checkpointRouteMismatch({ ...opaque, details: { ...details, strategy: "unrecognized" } }, model)).toBe(false);
  expect(declaredCheckpointRoute({ ...details, provider: "" })).toBeUndefined();
  expect(declaredCheckpointRoute({ ...details, strategy: "openai-native-compact-v1" })).toEqual({ provider: details.provider, api: details.api });
});

it("does not traverse opaque payloads or validate unrelated producer diagnostics", () => {
  const window = new Array<unknown>(100000);
  Object.defineProperty(window, "0", { get() { throw new Error("Opaque payload must not be inspected"); } });
  const checkpoint = { ...opaque, details: { ...details, compactedWindow: window,
    get requestMeta() { throw new Error("Producer diagnostics are not UI-owned"); } } };
  expect(checkpointRouteMismatch(checkpoint, { ...model, provider: "anthropic" })).toBe(true);
  expect(checkpointRouteMismatch({ ...opaque, details: { ...details, requestMeta: "malformed" } }, { ...model, provider: "anthropic" })).toBe(true);
  expect(compactionDisplay({ compactionEntryId: "checkpoint", content: "Owned explanation", kind: "usage" })).toEqual({
    compactionEntryId: "checkpoint", content: "Owned explanation", kind: "usage",
  });
  expect(compactionDisplay({ compactionEntryId: "checkpoint", content: "Unknown role", kind: "unknown" })).toBeUndefined();
});

it("keeps one collapsed line and renders the complete original detail on expansion", () => {
  let mismatch = false, current = true;
  const changed = vi.fn();
  const view = new CompactionView({ tokensBefore: 42123, body: new Text("ORIGINAL SUMMARY", 0, 0),
    billing: [new Text("NATIVE BILLING", 0, 0)], details: [new Text("PRODUCER DETAIL", 0, 0)],
    initialExpanded: false, hasRouteMismatch: () => mismatch, canInteract: () => current, onChange: changed });
  expect(view.render(120)).toEqual(["", "▸ Compacted from 42,123 tokens"]);
  mismatch = true;
  expect(view.render(120)).toEqual(["", "▸ Compacted from 42,123 tokens · ⚠ Current model cannot reuse checkpoint"]);
  expect(visibleWidth(view.render(30).find(line => line.trim())!)).toBeLessThanOrEqual(30);
  view.setExpanded(true);
  expect(view.render(120).map(line => line.trimEnd())).toEqual(["", "▾ Compacted from 42,123 tokens · ⚠ Current model cannot reuse checkpoint",
    "ORIGINAL SUMMARY", "NATIVE BILLING", "PRODUCER DETAIL"]);
  mismatch = false;
  expect(view.render(120).slice(0, 2)).toEqual(["", "▾ Compacted from 42,123 tokens"]);
  const click = () => view.children.find(component => component.handleMouse)?.handleMouse?.({
    type: "click", button: "left", x: 0, y: 0, width: 120, height: 1,
    screenX: 0, screenY: 1, shift: false, alt: false, ctrl: false });
  changed.mockClear(); click();
  expect(view.expanded).toBe(false);
  expect(changed).toHaveBeenLastCalledWith(view, false);

  current = false; changed.mockClear(); click();
  expect(view.expanded).toBe(false);
  expect(changed).not.toHaveBeenCalled();
});

it("separates the checkpoint from preceding activity without adding space below it", () => {
  const view = new CompactionView({ tokensBefore: 42123, body: new Text("ORIGINAL SUMMARY", 0, 0),
    billing: [new Text("NATIVE BILLING", 0, 0)], details: [new Text("PRODUCER DETAIL", 0, 0)],
    initialExpanded: false, hasRouteMismatch: () => false, canInteract: () => true, onChange() {} });
  const transcript = new Container();
  transcript.addChild(new Text("PRECEDING ACTIVITY", 0, 0));
  transcript.addChild(view);
  transcript.addChild(new Text("FOLLOWING MESSAGE", 0, 0));
  const collapsed = ["PRECEDING ACTIVITY", "", "▸ Compacted from 42,123 tokens", "FOLLOWING MESSAGE"];

  expect(transcript.render(120).map(line => line.trimEnd())).toEqual(collapsed);
  view.setExpanded(true);
  expect(transcript.render(120).map(line => line.trimEnd())).toEqual([
    "PRECEDING ACTIVITY", "", "▾ Compacted from 42,123 tokens",
    "ORIGINAL SUMMARY", "NATIVE BILLING", "PRODUCER DETAIL", "FOLLOWING MESSAGE",
  ]);
  view.setExpanded(false);
  expect(transcript.render(120).map(line => line.trimEnd())).toEqual(collapsed);
});
