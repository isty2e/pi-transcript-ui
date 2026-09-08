import { isRecord } from "./intent.js";
import { supportedDirectSchema } from "./schema-capability.js";

export type FileMutation = Readonly<{ pathKey: "path" | "file_path" } & (
  { action: "Write"; shape: "content" } |
  { action: "Edit"; shape: "edits" | "replacement"; oldKey: "oldText" | "old_string"; newKey: "newText" | "new_string" }
)>;

const mutationKeys = ["content", "edits", "oldText", "newText", "old_string", "new_string"];

/** Bounded direct schemas only: no references, compositions or unknown validation keywords. */
export function fileMutationFor(parameters: unknown): FileMutation | undefined {
  try {
    if (!supportedDirectSchema(parameters) || !isRecord(parameters) || parameters.type !== "object" || !isRecord(parameters.properties)) return undefined;
    const properties = parameters.properties;
    const requiredField = (schema: Record<string, unknown>, key: string, type: string): boolean =>
      Array.isArray(schema.required) && schema.required.includes(key) && isRecord(schema.properties) &&
      Object.hasOwn(schema.properties, key) && isRecord(schema.properties[key]) && schema.properties[key].type === type;
    const paths = (["path", "file_path"] as const).filter((key) => Object.hasOwn(properties, key));
    const pathKey = paths[0];
    if (paths.length !== 1 || !pathKey || !requiredField(parameters, pathKey, "string")) return undefined;
    const present = mutationKeys.filter((key) => Object.hasOwn(properties, key));
    if (present.length === 1 && present[0] === "content" && requiredField(parameters, "content", "string")) return Object.freeze({ pathKey, action: "Write", shape: "content" });
    const pair = (schema: Record<string, unknown>) => {
      if (schema.type !== "object" || !isRecord(schema.properties)) return undefined;
      const fields = mutationKeys.filter((key) => Object.hasOwn(schema.properties as object, key));
      for (const [oldKey, newKey] of [["oldText", "newText"], ["old_string", "new_string"]] as const) {
        if (fields.length === 2 && requiredField(schema, oldKey, "string") && requiredField(schema, newKey, "string")) return { oldKey, newKey };
      }
      return undefined;
    };
    if (present.length === 1 && present[0] === "edits" && requiredField(parameters, "edits", "array")) {
      const edits = properties.edits as Record<string, unknown>;
      const replacement = isRecord(edits.items) ? pair(edits.items) : undefined;
      return replacement ? Object.freeze({ pathKey, action: "Edit", shape: "edits", ...replacement }) : undefined;
    }
    const replacement = pair(parameters);
    return replacement ? Object.freeze({ pathKey, action: "Edit", shape: "replacement", ...replacement }) : undefined;
  } catch { return undefined; }
}

const writtenCounts = new WeakMap<object, { content: string; lines: number }>();

/** Successful compatible writers report full content size, never a patch delta or receipt size. */
export function writtenLineCount(capability: FileMutation | undefined, args: unknown, result: unknown, isPartial: boolean): number | undefined {
  try {
    if (capability?.shape !== "content" || isPartial || !isRecord(result) || !Array.isArray(result.content) || (result.isError !== undefined && result.isError !== false) ||
      !isRecord(args) || !fileMutationPath(capability, args) || typeof args.content !== "string") return undefined;
    const content = args.content;
    const cached = writtenCounts.get(args);
    if (cached?.content === content) return cached.lines;

    let lines = content.length ? 1 : 0;
    for (let at = content.indexOf("\n"); at !== -1; at = content.indexOf("\n", at + 1)) lines++;
    if (content.endsWith("\n")) lines--;

    writtenCounts.set(args, { content, lines });
    return lines;
  } catch { return undefined; }
}

export function fileMutationPath(capability: FileMutation, args: unknown): string | undefined {
  try {
    if (!isRecord(args) || typeof args[capability.pathKey] !== "string") return undefined;
    const replacement = (value: unknown): boolean => capability.action === "Edit" && isRecord(value) && typeof value[capability.oldKey] === "string" && typeof value[capability.newKey] === "string";
    const valid = capability.shape === "content" ? typeof args.content === "string"
      : capability.shape === "replacement" ? replacement(args)
      : Array.isArray(args.edits) && args.edits.length <= 4096 && args.edits.every(replacement);
    return valid ? args[capability.pathKey] as string : undefined;
  } catch { return undefined; }
}
