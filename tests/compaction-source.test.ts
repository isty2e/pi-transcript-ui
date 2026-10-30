import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentCheckpointReader } from "../src/compaction/source.js";

afterEach(() => vi.restoreAllMocks());
const message = () => ({ role: "user" as const, content: "Owned source fixture", timestamp: 1 });
const compact = (manager: SessionManager) => manager.appendCompaction("Owned summary", "", 42123);

it("keeps stable and appended lookup costs independent of transcript size", () => {
  const costs = [10, 10000].map(size => {
    const manager = SessionManager.inMemory(), id = compact(manager);
    for (let i = 0; i < size; i++) manager.appendMessage(message());
    const original = manager.getEntry.bind(manager);
    const read = vi.spyOn(manager, "getEntry").mockImplementation(original);
    vi.spyOn(manager, "buildContextEntries").mockImplementation(() => { throw new Error("Unexpected context reconstruction"); });
    vi.spyOn(manager, "getBranch").mockImplementation(() => { throw new Error("Unexpected branch reconstruction"); });
    const current = currentCheckpointReader(() => manager);
    expect(current()?.id).toBe(id);
    read.mockClear();
    for (let i = 0; i < 100; i++) expect(current()?.id).toBe(id);
    const stable = read.mock.calls.length;
    manager.appendMessage(message()); read.mockClear();
    expect(current()?.id).toBe(id);
    return { stable, appended: read.mock.calls.length };
  });
  expect(costs[0]).toEqual(costs[1]);
});

it("follows branch changes, newer checkpoints and session replacement", () => {
  let manager = SessionManager.inMemory();
  const root = manager.appendMessage(message()), current = currentCheckpointReader(() => manager);
  expect(current()).toBeUndefined();
  const first = compact(manager), latest = compact(manager);
  expect(current()?.id).toBe(latest);
  manager.branch(first); expect(current()?.id).toBe(first);
  manager.branch(root); expect(current()).toBeUndefined();
  manager = SessionManager.inMemory();
  const replacement = compact(manager);
  expect(current()?.id).toBe(replacement);
  manager.newSession(); expect(current()).toBeUndefined();
});

it("does not mistake retained historical compactions for the active checkpoint", () => {
  const manager = SessionManager.inMemory(), first = compact(manager);
  manager.appendMessage(message());
  const latest = manager.appendCompaction("Latest summary", first, 50000);
  expect(manager.buildContextEntries().map(entry => entry.id)).toEqual(expect.arrayContaining([latest, first]));
  expect(currentCheckpointReader(() => manager)()?.id).toBe(latest);
});

it("invalidates when the same session and leaf IDs are loaded from new records", () => {
  const directory = mkdtempSync(join(tmpdir(), "transcript-checkpoint-source-"));
  try {
    const original = SessionManager.inMemory(directory), first = compact(original);
    const leaf = original.appendMessage(message()), header = original.getHeader()!, entries = original.getEntries();
    const file = join(directory, "session.jsonl");
    const save = (values: unknown[]) => writeFileSync(file, values.map(value => JSON.stringify(value)).join("\n") + "\n");
    save([header, ...entries]);
    const manager = SessionManager.open(file), current = currentCheckpointReader(() => manager);
    expect(current()?.id).toBe(first);
    const replacement = { ...entries[0], id: "replacement-checkpoint", summary: "Replacement summary" };
    save([header, replacement, { ...entries[1], parentId: replacement.id }]);
    manager.setSessionFile(file);
    expect(manager.getSessionId()).toBe(header.id);
    expect(manager.getLeafId()).toBe(leaf);
    expect(current()?.id).toBe(replacement.id);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
