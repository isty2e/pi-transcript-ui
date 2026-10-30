import type { CompactionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export type CheckpointSource = Pick<SessionManager, "getSessionId" | "getLeafId" | "getEntry">;

export function currentCheckpointReader(getManager: () => CheckpointSource): () => CompactionEntry | undefined {
  let managerBefore: CheckpointSource | undefined, sessionBefore: string | undefined, leafBefore: string | null | undefined;
  let entryBefore: ReturnType<CheckpointSource["getEntry"]>, checkpointBefore: string | undefined;

  return () => {
    const manager = getManager(), session = manager.getSessionId(), leaf = manager.getLeafId();
    const leafEntry = leaf ? manager.getEntry(leaf) : undefined;
    const sameScope = manager === managerBefore && session === sessionBefore;
    if (!sameScope || leaf !== leafBefore || leafEntry !== entryBefore) {
      let entry = leafEntry, checkpoint: string | undefined;
      while (entry) {
        if (entry.type === "compaction") { checkpoint = entry.id; break; }
        if (sameScope && entry === entryBefore) { checkpoint = checkpointBefore; break; }
        entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined;
      }
      managerBefore = manager; sessionBefore = session; leafBefore = leaf;
      entryBefore = leafEntry; checkpointBefore = checkpoint;
    }
    const checkpoint = checkpointBefore ? manager.getEntry(checkpointBefore) : undefined;
    return checkpoint?.type === "compaction" ? checkpoint : undefined;
  };
}
