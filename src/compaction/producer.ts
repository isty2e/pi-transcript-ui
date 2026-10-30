import { isRecord } from "../intent.js";

export const COMPACTION_DISPLAY_TYPE = "codex-native-compaction-display";
const NATIVE_STRATEGIES = new Set(["openai-native-compact-v1", "openai-responses-compaction-v2"]);
const OPAQUE_SUMMARY = "[OpenAI native compaction checkpoint]";
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export interface DeclaredCheckpointRoute { readonly provider: string; readonly api: string }

export function declaredCheckpointRoute(value: unknown): DeclaredCheckpointRoute | undefined {
  if (!isRecord(value) || typeof value.strategy !== "string" || !NATIVE_STRATEGIES.has(value.strategy) ||
      !nonempty(value.provider) || !nonempty(value.api) || ![value.model, value.baseUrl, value.createdAt].every(nonempty) ||
      !Array.isArray(value.compactedWindow)) return undefined;
  return { provider: value.provider, api: value.api };
}

export function checkpointRouteMismatch(checkpoint: { readonly summary: string; readonly details?: unknown }, model: unknown): boolean {
  if (nonempty(checkpoint.summary) && checkpoint.summary !== OPAQUE_SUMMARY) return false;
  const declared = declaredCheckpointRoute(checkpoint.details);
  if (!declared || !isRecord(model) || ![model.provider, model.api, model.id].every(nonempty)) return false;
  return declared.provider !== model.provider || declared.api !== model.api;
}

export interface CompactionDisplay {
  readonly compactionEntryId: string;
  readonly content: string;
  readonly kind?: "usage";
}

export function compactionDisplay(value: unknown): CompactionDisplay | undefined {
  if (!isRecord(value) || typeof value.compactionEntryId !== "string" || typeof value.content !== "string" ||
      (value.kind !== undefined && value.kind !== "usage")) return undefined;
  return { compactionEntryId: value.compactionEntryId, content: value.content, ...(value.kind ? { kind: value.kind } : {}) };
}
