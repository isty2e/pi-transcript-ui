import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { INTENT_MAX_LENGTH, clampIntentLength, isRecord, type IntentPolicy } from "./intent.js";
import type { ToolGroupingRules } from "./classify.js";
import { DEFAULT_DISPLAY_LIMITS, type DisplayLimits } from "./display.js";

export interface Settings {
  version: 1;
  grouping: { exploration: string[]; mutation: string[]; standalone?: string[] };
  intent: IntentPolicy;
  display: DisplayLimits;
}
export function defaultSettings(): Settings {
  return { version: 1, grouping: { exploration: ["read", "grep", "find", "ls"], mutation: ["edit", "write"], standalone: [] },
    intent: { enabled: true, language: "auto", maxLength: INTENT_MAX_LENGTH }, display: { ...DEFAULT_DISPLAY_LIMITS } };
}
function names(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 4096 || value.some((name) => typeof name !== "string" || !name.trim() || name.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(name))) {
    throw new Error("Tool lists must contain at most 4096 non-empty exact tool names without control characters");
  }
  return [...new Set(value as string[])];
}
export function parseSettings(value: unknown): Settings {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.grouping) || !isRecord(value.intent)) throw new Error("Expected settings version 1 with grouping and intent objects");
  for (const [object, allowed] of [[value, ["version", "grouping", "intent", "display"]], [value.grouping, ["exploration", "mutation", "standalone"]], [value.intent, ["enabled", "language", "maxLength"]]] as const) {
    if (Object.keys(object).some((key) => !(allowed as readonly string[]).includes(key))) throw new Error("Unknown settings key; refusing to silently discard it");
  }
  const exploration = names(value.grouping.exploration), mutation = names(value.grouping.mutation);
  const standalone = Object.hasOwn(value.grouping, "standalone") ? names(value.grouping.standalone) : [];
  if (exploration.some((name) => mutation.includes(name) || standalone.includes(name)) || mutation.some((name) => standalone.includes(name))) throw new Error("A tool cannot be in both grouping lists (exploration, mutation, standalone)");
  const { enabled, language, maxLength } = value.intent;
  if (typeof enabled !== "boolean" || !["auto", "en", "zh-CN"].includes(String(language)) || typeof maxLength !== "number" || !Number.isInteger(maxLength)) {
    throw new Error("Intent requires enabled:boolean, language:auto|en|zh-CN and integer maxLength (clamped to 16–256)");
  }
  const display = { ...DEFAULT_DISPLAY_LIMITS };
  if (Object.hasOwn(value, "display")) {
    if (!isRecord(value.display) || Object.keys(value.display).some((key) => key !== "rowMaxWidth" && key !== "commandMaxWidth" && key !== "intentMaxWidth" && key !== "commandPreview")) throw new Error("Invalid display settings or unknown display key");
    if (Object.hasOwn(value.display, "commandPreview")) {
      const mode = value.display.commandPreview;
      if (mode !== "compact" && mode !== "raw") throw new Error("Command preview must be compact or raw");
      display.commandPreview = mode;
    }
    for (const key of ["rowMaxWidth", "commandMaxWidth", "intentMaxWidth"] as const) {
      if (!Object.hasOwn(value.display, key)) continue;
      const width = value.display[key];
      if (typeof width !== "number" || !Number.isInteger(width) || width < 1 || width > 4096) throw new Error("Display widths must be integers from 1 to 4096 terminal columns");
      display[key] = width;
    }
  }
  return { version: 1, grouping: { exploration, mutation, standalone }, intent: { enabled, language: language as IntentPolicy["language"], maxLength: clampIntentLength(maxLength) }, display };
}
export function groupingRules(settings: Settings): ToolGroupingRules {
  const rules: Record<string, ToolGroupingRules[string]> = Object.create(null);
  for (const name of ["read", "grep", "find", "ls", "edit", "write"]) rules[name] = "standalone";
  for (const name of settings.grouping.exploration) rules[name] = name === "grep" || name === "find" ? "search" : name === "ls" ? "list" : name === "read" ? "read" : "explore";
  for (const name of settings.grouping.mutation) rules[name] = name === "edit" || name === "write" ? "mutation" : "change";
  for (const name of settings.grouping.standalone ?? []) rules[name] = "standalone";
  return rules;
}
export class SettingsFile {
  constructor(readonly path: string) {}
  private async raw(): Promise<string | undefined> {
    let file;
    try { file = await open(this.path, "r"); }
    catch (error) { if (isRecord(error) && error.code === "ENOENT") return undefined; throw error; }
    try {
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length === buffer.length) throw new Error("Settings file exceeds 1 MiB");
      return buffer.subarray(0, length).toString("utf8");
    } finally { await file.close(); }
  }
  async load(): Promise<{ settings: Settings; original: string | undefined }> {
    const original = await this.raw();
    return { settings: original === undefined ? defaultSettings() : parseSettings(JSON.parse(original)), original };
  }
  async save(settings: Settings, expected: string | undefined): Promise<void> {
    const data = JSON.stringify(parseSettings(settings), null, 2) + "\n";
    if (Buffer.byteLength(data) > 1024 * 1024) throw new Error("Settings exceed 1 MiB");
    if (await this.raw() !== expected) throw new Error("Settings changed since this dialog opened; reopen it before saving");
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, data, { flag: "wx", mode: 0o600 });
      await rename(temp, this.path);
    } finally {
      await unlink(temp).catch((error: unknown) => { if (!isRecord(error) || error.code !== "ENOENT") throw error; });
    }
  }
}
