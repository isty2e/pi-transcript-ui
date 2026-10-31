import { expect, it, vi } from "vitest";
import { InteractiveMode, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { compactionFixture, checkpointDetails, usage } from "./fixtures/compaction.js";
import { piCapabilities } from "../fixtures/pi-capabilities.js";

it("attaches the product before the first tool-free source render and preserves every original record", async () => {
  const f = await compactionFixture(), cp = f.checkpoint();
  f.display(cp.id); f.display(cp.id, "PROVIDER BILLING", "usage");
  const original = JSON.stringify(f.manager.getEntries());
  f.draw();
  expect(f.lines()).toEqual(["", "▸ Compacted from 42,123 tokens"]);
  f.mode.setToolsExpanded(true);
  const opened = f.render();
  expect(opened).toContain("Original checkpoint summary");
  expect(opened).toContain("PRODUCER EXPLANATION");
  expect(opened).toContain("PROVIDER BILLING");
  expect(opened).toContain("1.8k tokens billed");
  expect(JSON.stringify(f.manager.getEntries())).toBe(original);
});

it("separates a checkpoint from neighboring content in the native transcript", async () => {
  const f = await compactionFixture(); f.checkpoint();
  const original = JSON.stringify(f.manager.getEntries());
  f.draw();
  f.mode.chatContainer.children.unshift(new Text("PRECEDING ACTIVITY", 0, 0));
  f.mode.chatContainer.addChild(new Text("FOLLOWING MESSAGE", 0, 0));
  const collapsed = ["PRECEDING ACTIVITY", "", "▸ Compacted from 42,123 tokens", "FOLLOWING MESSAGE"];

  expect(f.lines()).toEqual(collapsed);
  f.mode.setToolsExpanded(true);
  expect(f.lines().slice(0, 3)).toEqual(["PRECEDING ACTIVITY", "", "▾ Compacted from 42,123 tokens"]);
  expect(f.render()).toContain("Original checkpoint summary");
  f.mode.setToolsExpanded(false);
  expect(f.lines().slice(0, collapsed.length)).toEqual(collapsed);
  expect(f.render()).not.toContain("Original checkpoint summary");
  expect(JSON.stringify(f.manager.getEntries())).toBe(original);
});

it("reconstructs the same ID and native bulk state on reload without relying on a new UI context", async () => {
  const f = await compactionFixture(), cp = f.checkpoint();
  f.display(cp.id); f.draw(); f.mode.setToolsExpanded(true);
  const before = f.manager.getEntries();
  await f.owner.session.reload({ beforeSessionStart: () => f.mode.rebuildChatFromMessages() });
  expect(f.render()).toContain("Original checkpoint summary");
  expect(f.render().match(/Compacted from 42,123 tokens/g)).toHaveLength(1);
  expect(f.manager.getEntries()).toEqual(before);
  f.mode.setToolsExpanded(false);
  expect(f.lines().slice(0, 2)).toEqual(["", "▸ Compacted from 42,123 tokens"]);
  expect(f.render()).not.toContain("Original checkpoint summary");
  expect(f.render()).not.toContain("PRODUCER EXPLANATION");
});

it("preserves independent per-ID disclosure across history reconstruction and ignores retired headers", async () => {
  const f = await compactionFixture(), cp = f.checkpoint(); f.display(cp.id); f.draw();
  const row = f.mode.chatContainer.children[0] as Container;
  const view = row.children[0] as Container, header = view.children.find(component => component.handleMouse)!;
  const click = () => header.handleMouse?.({ type: "click", button: "left", x: 0, y: 0, width: 100, height: 1,
    screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false });
  click();
  expect(f.render()).toContain("Original checkpoint summary");
  f.mode.rebuildChatFromMessages();
  expect(f.render()).toContain("Original checkpoint summary");
  const before = f.lines();
  click();
  expect(f.lines()).toEqual(before);
});

it("updates a live route warning without transcript reconstruction and follows the latest raw checkpoint", async () => {
  const f = await compactionFixture(), first = f.checkpoint("[OpenAI native compaction checkpoint]");
  f.manager.appendMessage({ role: "user", content: "Retained user content", timestamp: 1 });
  const latest = f.checkpoint("[OpenAI native compaction checkpoint]", checkpointDetails, first.id);
  f.draw();
  const auth = vi.spyOn(f.modelRuntime, "checkAuth").mockResolvedValue({ type: "api_key" });
  await f.owner.session.setModel({ ...f.owner.session.model!, provider: "anthropic", api: "anthropic-messages" }, { persist: false });
  auth.mockRestore();
  const context = vi.spyOn(f.manager, "buildContextEntries").mockImplementation(() => { throw new Error("No full context reads during paint"); });
  expect(f.render().match(/Current model cannot reuse checkpoint/g)).toHaveLength(1);
  expect(f.render()).toContain("Compacted from 42,123 tokens · ⚠ Current model cannot reuse checkpoint");
  expect(context).not.toHaveBeenCalled(); context.mockRestore();
  f.checkpoint("Portable latest summary", undefined);
  f.draw();
  expect(f.render()).not.toContain("Current model cannot reuse checkpoint");
  expect(f.manager.getEntry(latest.id)?.type).toBe("compaction");
});

it("keeps unknown producer roles and metadata visible instead of treating them as consumed details", async () => {
  const f = await compactionFixture(), cp = f.checkpoint("Summary with unknown engine", { strategy: "unknown" });
  f.display(cp.id, "UNSUPPORTED EXPLANATION");
  f.display(cp.id, "UNKNOWN ROLE", "future-role");
  f.display("missing-checkpoint", "UNLINKED DETAIL");
  f.draw();
  const text = f.render();
  expect(text).toContain("▸ Compacted from 42,123 tokens");
  expect(text).toContain("UNSUPPORTED EXPLANATION");
  expect(text).toContain("UNKNOWN ROLE");
  expect(text).toContain("UNLINKED DETAIL");
});

it.runIf(piCapabilities(VERSION).codemode)("allows Codemode and compaction to share discovery while keeping the checkpoint out of tool groups", async () => {
  const f = await compactionFixture({ code: true });
  const cp = f.checkpoint();
  f.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "code", name: "codemode", arguments: { code: "return 1;" } }],
    api: "openai-codex-responses", provider: "openai-codex", model: "fixture", usage: usage(), stopReason: "toolUse", timestamp: 1 });
  f.manager.appendMessage({ role: "toolResult", toolCallId: "code", toolName: "codemode", isError: false, timestamp: 2,
    content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }],
    details: { calls: [{ id: "code/1", name: "read", status: "ok", args: JSON.stringify({ path: "alpha.ts" }) }] } });
  f.draw(); f.mode.setToolsExpanded(true);
  const text = f.render();
  expect(text).toContain("Compacted from 42,123 tokens");
  expect(text).toContain("Read alpha.ts");
  expect(text.match(/Compacted from 42,123 tokens/g)).toHaveLength(1);
  expect(f.manager.getEntry(cp.id)?.type).toBe("compaction");
});

it("reattaches during actual new, fork and resume lifecycles", async () => {
  const f = await compactionFixture();
  const seed = (manager: SessionManager) => {
    const user = manager.appendMessage({ role: "user", content: "Lifecycle user", timestamp: 1 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Lifecycle response" }], api: "openai-codex-responses",
      provider: "openai-codex", model: "fixture", usage: usage(), stopReason: "stop", timestamp: 2 });
    const cp = manager.appendCompaction("Lifecycle checkpoint", "", 42123, checkpointDetails, true, usage());
    return { user, cp };
  };
  let created: ReturnType<typeof seed> | undefined;
  await f.owner.newSession({ async setup(manager) { created = seed(manager); } });
  expect(f.render()).toContain("▸ Compacted from 42,123 tokens");
  await f.owner.fork(created!.user, { position: "at" });
  f.checkpoint(); f.mode.rebuildChatFromMessages();
  expect(f.render()).toContain("▸ Compacted from 42,123 tokens");
  const saved = SessionManager.create(f.directory, join(f.directory, "resume"));
  seed(saved); await f.owner.switchSession(saved.getSessionFile()!);
  expect(f.render()).toContain("▸ Compacted from 42,123 tokens");
});

it("restores the exact native view when the product is shut down", async () => {
  const f = await compactionFixture(), cp = f.checkpoint(); f.display(cp.id);
  f.draw();
  await f.owner.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  const restored = f.lines();
  f.draw();
  expect(f.lines()).toEqual(restored);
  f.mode.setToolsExpanded(true);
  expect(f.render()).toContain("Original checkpoint summary");
  expect(f.render()).toContain("PRODUCER EXPLANATION");
});

it("repaints a long transcript without rebuilding history or resolving commands again", async () => {
  const f = await compactionFixture();
  f.checkpoint("[OpenAI native compaction checkpoint]");
  for (let i = 0; i < 1000; i++) f.manager.appendMessage({ role: "user", content: "Owned long transcript", timestamp: 1 });
  f.draw(); f.render();
  const spies = [vi.spyOn(f.manager, "buildContextEntries"), vi.spyOn(f.manager, "getBranch"), vi.spyOn(f.manager, "getEntries")];
  const commands = vi.spyOn(f.owner.session.extensionRunner as unknown as { resolveRegisteredCommands(): unknown[] }, "resolveRegisteredCommands");
  const measure = () => {
    for (let i = 0; i < 5; i++) f.mode.chatContainer.render(100);
    const samples = [];
    for (let sample = 0; sample < 5; sample++) {
      const start = performance.now();
      for (let frame = 0; frame < 30; frame++) f.mode.chatContainer.render(100);
      samples.push((performance.now() - start) / 30);
    }
    samples.sort((a, b) => a - b);
    return { medianMs: samples[2], rangeMs: [samples[0], samples[4]] };
  };
  const compact = measure();
  for (const spy of [...spies, commands]) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
  await f.owner.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  f.draw();
  const native = measure(), report = process.env.PI_TRANSCRIPT_UI_RUNTIME_REPORT;
  if (report) writeFileSync(report, JSON.stringify({ host: VERSION, messages: 1000, compact, native,
    scope: "Warm whole-chat layout, excluding terminal painting; native comparison follows complete extension shutdown" }, null, 2));
});

it("retries an inactive compaction lease after a transient cleanup failure and reload", async () => {
  const f = await compactionFixture(), cp = f.checkpoint(); f.display(cp.id); f.draw();
  const remove = Reflect.deleteProperty;
  let failed = false;
  vi.spyOn(Reflect, "deleteProperty").mockImplementation((object, key) => {
    if (object === f.mode && key === "renderSessionEntries" && !failed) { failed = true; return false; }
    return remove(object, key);
  });
  await f.owner.session.reload({ beforeSessionStart: () => f.mode.rebuildChatFromMessages() });
  expect(failed).toBe(true);
  expect(f.lines().slice(0, 2)).toEqual(["", "▸ Compacted from 42,123 tokens"]);
  f.mode.setToolsExpanded(true);
  expect(f.render()).toContain("Original checkpoint summary");
  expect(f.render()).toContain("PRODUCER EXPLANATION");
});

it.runIf(piCapabilities(VERSION).codemode)("keeps Codemode discoverable when an old compaction source property cannot be removed", async () => {
  const f = await compactionFixture({ code: true });
  f.checkpoint();
  f.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "recovery", name: "codemode", arguments: { code: "return 1;" } }],
    api: "openai-codex-responses", provider: "openai-codex", model: "fixture", usage: usage(), stopReason: "toolUse", timestamp: 1 });
  f.manager.appendMessage({ role: "toolResult", toolCallId: "recovery", toolName: "codemode", isError: false, timestamp: 2,
    content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }],
    details: { calls: [{ id: "recovery/1", name: "read", status: "ok", args: JSON.stringify({ path: "alpha.ts" }) }] } });
  f.draw();
  Object.defineProperty(f.mode, "renderSessionEntries", { configurable: false });
  await f.owner.session.reload({ beforeSessionStart: () => f.mode.rebuildChatFromMessages() });
  f.mode.setToolsExpanded(true);
  expect(f.render()).toContain("Original checkpoint summary");
  expect(f.render()).toContain("Read alpha.ts");
});

it("does not re-enter a foreign forwarder that retained an old inactive source wrapper", async () => {
  const prototype = InteractiveMode.prototype, original = Object.getOwnPropertyDescriptor(prototype, "renderSessionEntries")!;
  const f = await compactionFixture(); f.checkpoint(); f.draw();
  const remove = Reflect.deleteProperty;
  let failed = false, forwarded = 0;
  vi.spyOn(Reflect, "deleteProperty").mockImplementation((object, key) => {
    if (object === f.mode && key === "renderSessionEntries" && !failed) { failed = true; return false; }
    return remove(object, key);
  });
  const loader = f.owner.session.resourceLoader, reload = loader.reload.bind(loader);
  vi.spyOn(loader, "reload").mockImplementation(async () => {
    const held = f.mode.renderSessionEntries;
    Object.defineProperty(prototype, "renderSessionEntries", { ...original, value: function (this: unknown, ...args: unknown[]) {
      forwarded++; return Reflect.apply(held, this, args);
    } });
    await reload();
  });
  try {
    await f.owner.session.reload({ beforeSessionStart: () => f.mode.rebuildChatFromMessages() });
    expect(failed).toBe(true); expect(forwarded).toBe(1);
    expect(f.lines().slice(0, 2)).toEqual(["", "▸ Compacted from 42,123 tokens"]);
    f.mode.rebuildChatFromMessages();
    expect(forwarded).toBe(2);
    expect(f.lines().slice(0, 2)).toEqual(["", "▸ Compacted from 42,123 tokens"]);
  } finally {
    await f.owner.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    Object.defineProperty(prototype, "renderSessionEntries", original);
  }
});
