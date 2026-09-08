export const INTENT_FIELD = "displaySummary";
export const INTENT_MAX_LENGTH = 48;
export const INTENT_LENGTH_LIMIT = 256;
const INTENT_SCHEMA_MARKER = "[pi-transcript-ui intent]";
const intentGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export type IntentLanguage = "auto" | "en" | "zh-CN";
export interface IntentPolicy { enabled: boolean; language: IntentLanguage; maxLength: number }
export interface IntentRecord { toolCallId: string; text: string; source: "model" | "fallback" }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function languageInstruction(language: IntentLanguage = "auto"): string {
  return language === "en" ? "Write it in English." : language === "zh-CN" ? "Write it in Simplified Chinese." : "Use the same primary language as the user's request.";
}
export function intentFieldDescription(language: IntentLanguage = "auto"): string {
  return [`${INTENT_SCHEMA_MARKER} Optional user-facing purpose for this specific tool call. Omit when redundant; use null if the schema requires this nullable field.`, languageInstruction(language),
    "Use a short purpose phrase, not a full explanatory sentence. Use sentence case, omit trailing punctuation, and never include secrets or credentials.",
    "Describe why the tool is being used rather than merely repeating its raw arguments."].join(" ");
}
export function intentGuideline(language: IntentLanguage = "auto"): string {
  return `For ${INTENT_FIELD} fields marked ${INTENT_SCHEMA_MARKER} in their schema description, optionally supply a short purpose phrase, not a full explanatory sentence. Omit intent when redundant; use null if the schema requires a nullable field. ${languageInstruction(language)} Never include secrets or credentials. Other fields retain their own schema semantics.`;
}
export function clampIntentLength(maxLength: number): number {
  return Number.isFinite(maxLength)
    ? Math.min(INTENT_LENGTH_LIMIT, Math.max(16, Math.floor(maxLength)))
    : INTENT_MAX_LENGTH;
}

/** Persisted text uses the same code-point limit as generation, with a bounded raw scan. */
export function isRestorableIntentText(value: unknown): value is string {
  return typeof value === "string" && value.length <= INTENT_LENGTH_LIMIT * 2 &&
    [...value].length <= INTENT_LENGTH_LIMIT;
}

export function normalizeIntent(value: unknown, maxLength = INTENT_MAX_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/\x1b\][^\x07]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ").trim();
  const cap = clampIntentLength(maxLength);
  let end = 0;
  let characters = 0;
  for (const { segment } of intentGraphemes.segment(normalized)) {
    const length = [...segment].length;
    if (characters + length > cap) break;
    characters += length;
    end += segment.length;
  }
  return end ? normalized.slice(0, end) : undefined;
}
export function intentFromArgs(args: unknown, maxLength = INTENT_MAX_LENGTH): string | undefined {
  return isRecord(args) && Object.hasOwn(args, INTENT_FIELD) ? normalizeIntent(args[INTENT_FIELD], maxLength) : undefined;
}
export function hasIntentParameter(parameters: unknown): boolean {
  return isRecord(parameters) && isRecord(parameters.properties) && Object.hasOwn(parameters.properties, INTENT_FIELD);
}
export function addIntentSchema(schema: Record<string, unknown>, policy: IntentPolicy, nullableRequired = false): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const nextProperties = Object.create(Object.getPrototypeOf(properties), {
    ...Object.getOwnPropertyDescriptors(properties),
    [INTENT_FIELD]: { enumerable: true, configurable: true, writable: true,
      value: { type: nullableRequired ? ["string", "null"] : "string", description: intentFieldDescription(policy.language), maxLength: policy.maxLength } },
  });
  const descriptors = Object.getOwnPropertyDescriptors(schema);
  return Object.create(Object.getPrototypeOf(schema), {
    ...descriptors,
    properties: { configurable: descriptors.properties?.configurable ?? true, enumerable: descriptors.properties?.enumerable ?? true,
      writable: descriptors.properties?.writable ?? true, value: nextProperties },
    ...(nullableRequired ? { required: { configurable: descriptors.required?.configurable ?? true, enumerable: descriptors.required?.enumerable ?? true,
      writable: descriptors.required?.writable ?? true, value: [...new Set([...(Array.isArray(schema.required) ? schema.required : []), INTENT_FIELD])] } } : {}),
  });
}
