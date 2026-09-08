import { INTENT_FIELD, INTENT_LENGTH_LIMIT, addIntentSchema, hasIntentParameter, intentFromArgs, isRecord, isRestorableIntentText, normalizeIntent, type IntentPolicy, type IntentRecord } from "./intent.js";

export const INTENT_ENTRY = "pi-transcript-ui.intent.v1";
export interface ToolMetadata { name: string; parameters: unknown }

/** Owns only model-request additions; native tool definitions and validators are untouched. */
export class IntentTransport {
  private owned = new Map<string, IntentPolicy>();
  private records = new Map<string, IntentRecord>();
  private augmentedSchemas = new WeakMap<object, Record<string, unknown>>();
  constructor(private readonly persist: (records: readonly IntentRecord[]) => void,
    private readonly onPersistenceError: (error: unknown) => void = (error) => console.error("transcript-ui intent was not persisted:", error)) {}

  get(toolCallId: string): IntentRecord | undefined { return this.records.get(toolCallId); }

  resolve(toolCallId: string, args: unknown, maxLength: number): string | undefined {
    const record = this.records.get(toolCallId);
    return (record?.source === "model" ? normalizeIntent(record.text, maxLength) : undefined) ?? intentFromArgs(args, maxLength);
  }

  restore(entries: readonly unknown[]): void {
    this.records.clear();
    for (const entry of entries) {
      if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== INTENT_ENTRY || !Array.isArray(entry.data)) continue;
      for (const record of entry.data) {
        if (isRecord(record) && typeof record.toolCallId === "string" && isRestorableIntentText(record.text) &&
          (record.source === "model" || record.source === "fallback")) {
          const text = normalizeIntent(record.text, INTENT_LENGTH_LIMIT);
          if (text && (record.source === "model" || this.records.get(record.toolCallId)?.source !== "model")) this.records.set(record.toolCallId, { toolCallId: record.toolCallId, text, source: record.source });
        }
      }
    }
  }

  preparePayload(payload: unknown, tools: readonly ToolMetadata[], policy: IntentPolicy, warn: (message: string) => void): unknown {
    this.owned.clear();
    const owned = new Map<string, IntentPolicy>();
    const known = new Map(tools.map((tool) => [tool.name, tool]));
    const foldedNames = new Map<string, ToolMetadata | undefined>();
    for (const tool of tools) {
      const folded = tool.name.toLowerCase();
      foldedNames.set(folded, foldedNames.has(folded) ? undefined : tool);
    }
    const encountered = new Set<string>();
    const decorate = (item: unknown): unknown => {
      if (!isRecord(item)) return item;
      if (isRecord(item.function)) return { ...item, function: decorate(item.function) };
      if (Array.isArray(item.functionDeclarations)) return { ...item, functionDeclarations: item.functionDeclarations.map(decorate) };
      if (isRecord(item.toolSpec)) return { ...item, toolSpec: decorate(item.toolSpec) };
      if (typeof item.name !== "string") return item;
      const tool = known.get(item.name) ?? foldedNames.get(item.name.toLowerCase());
      if (!tool) return item;
      encountered.add(tool.name);
      if (hasIntentParameter(tool.parameters)) return item;
      let key: "parameters" | "input_schema" | "parametersJsonSchema" | "inputSchema" | undefined;
      if (isRecord(item.parameters)) key = "parameters";
      else if (isRecord(item.input_schema)) key = "input_schema";
      else if (isRecord(item.parametersJsonSchema)) key = "parametersJsonSchema";
      else if (isRecord(item.inputSchema) && isRecord(item.inputSchema.json)) key = "inputSchema";
      const outer = key ? item[key] : undefined;
      const received = key === "inputSchema" && isRecord(outer) ? outer.json : outer;
      if (!key || !isRecord(received)) {
        if (policy.enabled) warn(`Intent schema not injected for ${item.name}: no recognized object schema`);
        return item;
      }
      const schema = this.augmentedSchemas.get(received) ?? received;
      const replaceSchema = (replacement: Record<string, unknown>) => ({ ...item,
        [key]: key === "inputSchema" ? { ...(outer as Record<string, unknown>), json: replacement } : replacement });
      if (!policy.enabled) return schema === received ? item : replaceSchema(schema);
      if (hasIntentParameter(schema)) return item;
      const rootConstraints = ["$ref", "$dynamicRef", "$recursiveRef", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "dependentSchemas", "dependentRequired", "dependencies", "propertyNames", "patternProperties", "minProperties", "maxProperties", "enum", "const", "unevaluatedProperties"];
      if (rootConstraints.some((key) => Object.hasOwn(schema, key)) ||
          (schema.type !== undefined && schema.type !== "object") || (schema.type === undefined && !isRecord(schema.properties))) {
        warn(`Intent schema not injected for ${item.name}: unsupported root schema constraints`);
        return item;
      }
      // Responses defaults to strict normalization (including Pi Codex's null).
      // Completions and untyped provider declarations do not share that default.
      const nullableRequired = item.strict === true || (item.type === "function" && key === "parameters" && item.strict == null);
      const next = addIntentSchema(schema, policy, nullableRequired);
      this.augmentedSchemas.set(next, schema);
      owned.set(tool.name, { ...policy });
      return replaceSchema(next);
    };
    if (!isRecord(payload)) {
      if (policy.enabled) warn("Intent injection unavailable: unsupported provider payload");
      return payload;
    }
    let next = payload;
    if (Array.isArray(payload.tools)) next = { ...next, tools: payload.tools.map(decorate) };
    if (isRecord(payload.config) && Array.isArray(payload.config.tools)) {
      next = { ...next, config: { ...payload.config, tools: payload.config.tools.map(decorate) } };
    }
    if (isRecord(payload.context) && Array.isArray(payload.context.tools)) {
      next = { ...next, context: { ...payload.context, tools: payload.context.tools.map(decorate) } };
    }
    if (isRecord(payload.toolConfig) && Array.isArray(payload.toolConfig.tools)) {
      next = { ...next, toolConfig: { ...payload.toolConfig, tools: payload.toolConfig.tools.map(decorate) } };
    }
    if (Array.isArray(payload.input)) next = { ...next, input: payload.input.map((item) =>
      isRecord(item) && item.type === "tool_search_output" && Array.isArray(item.tools) ? { ...item, tools: item.tools.map(decorate) } : item) };
    if (Array.isArray(payload.messages)) next = { ...next, messages: payload.messages.map((item) =>
      isRecord(item) && item.role === "system" && Array.isArray(item.tools) ? { ...item, tools: item.tools.map(decorate) } : item) };
    if (policy.enabled && encountered.size === 0 && tools.length > 0) warn("Intent injection unavailable: provider payload exposes no recognized tool schemas");
    this.owned = owned;
    return next;
  }

  /** Pi awaits message_end before native argument preparation and validation. */
  prepareMessage(message: unknown): unknown {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return message;
    const added: IntentRecord[] = [];
    let changed = false;
    const content = message.content.map((block: unknown) => {
      if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") return block;
      const policy = this.owned.get(block.name);
      if (!policy || !isRecord(block.arguments)) return block;
      const model = intentFromArgs(block.arguments, policy.maxLength);
      const previous = this.records.get(block.id);
      if (model && previous?.source !== "model") added.push({ toolCallId: block.id, text: model, source: "model" });
      if (!Object.hasOwn(block.arguments, INTENT_FIELD)) return block;
      const { [INTENT_FIELD]: _displayOnly, ...args } = block.arguments;
      changed = true;
      return { ...block, arguments: args };
    });
    if (added.length) {
      for (const record of added) this.records.set(record.toolCallId, record);
      try { this.persist(added); }
      catch (error) { this.onPersistenceError(error); }
    }
    return changed ? { ...message, content } : message;
  }
}
