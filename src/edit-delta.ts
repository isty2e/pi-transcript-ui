import { isRecord } from "./intent.js";
import type { FileMutation } from "./file-mutation.js";

export interface EditDelta { readonly added: number; readonly removed: number }
const cache = new WeakMap<object, { patch: string; delta: EditDelta | undefined }>();

/** Accept one complete unified file patch; context and EOF markers are not changes. */
export function countPatchChanges(patch: string): EditDelta | undefined {
  if (patch.length > 1024 * 1024 || patch.includes("\r")) return undefined;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (!lines[0]?.startsWith("--- ") || !lines[1]?.startsWith("+++ ")) return undefined;
  let added = 0, removed = 0, oldRemaining = 0, newRemaining = 0;
  let oldEnd = 0, newEnd = 0, inHunk = false, canMarkEof = false;
  let previousKind = "", oldEof = false, newEof = false;
  for (const line of lines.slice(2)) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(line);
    if (hunk) {
      if (oldRemaining || newRemaining) return undefined;
      const oldStart = Number(hunk[1]), newStart = Number(hunk[3]);
      const oldCount = Number(hunk[2] ?? 1), newCount = Number(hunk[4] ?? 1);
      if (![oldStart, newStart, oldCount, newCount, oldStart + oldCount, newStart + newCount].every(Number.isSafeInteger) || oldStart < oldEnd || newStart < newEnd) return undefined;
      if ((!oldCount && !newCount) || (oldCount > 0 && (oldStart === 0 || oldEof)) || (newCount > 0 && (newStart === 0 || newEof))) return undefined;
      oldEnd = oldStart + oldCount; newEnd = newStart + newCount;
      oldRemaining = oldCount; newRemaining = newCount; inHunk = true; canMarkEof = false;
      continue;
    }
    if (!inHunk) return undefined;
    if (line === "\\ No newline at end of file") {
      if (!canMarkEof) return undefined;
      if (previousKind !== "+") { if (oldRemaining) return undefined; oldEof = true; }
      if (previousKind !== "-") { if (newRemaining) return undefined; newEof = true; }
      canMarkEof = false; continue;
    }
    if ((oldEof && line[0] !== "+") || (newEof && line[0] !== "-")) return undefined;
    if (line.startsWith("+")) { added++; newRemaining--; }
    else if (line.startsWith("-")) { removed++; oldRemaining--; }
    else if (line.startsWith(" ")) { oldRemaining--; newRemaining--; }
    else return undefined;
    if (oldRemaining < 0 || newRemaining < 0) return undefined;
    canMarkEof = true; previousKind = line[0]!;
  }
  return oldRemaining || newRemaining ? undefined : { added, removed };
}

/** Schema capability and a successful complete patch are independent required evidence. */
export function editDeltaFor(capability: FileMutation | undefined, result: unknown, isPartial = false): EditDelta | undefined {
  try {
    if (!capability || isPartial || !isRecord(result) || result.isError !== false || !isRecord(result.details) || typeof result.details.patch !== "string") return undefined;
    const patch = result.details.patch;
    const previous = cache.get(result);
    if (previous?.patch === patch) return previous.delta;
    const delta = countPatchChanges(patch);
    cache.set(result, { patch, delta });
    return delta;
  } catch { return undefined; }
}
