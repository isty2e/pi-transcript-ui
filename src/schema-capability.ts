import { isRecord } from "./intent.js";

const keywords = new Set(["type", "properties", "required", "items", "additionalProperties", "description", "title", "$schema", "$id", "default", "examples", "deprecated", "readOnly", "writeOnly", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "uniqueItems", "enum", "const"]);

/** Shared bounded direct-schema gate; does not resolve references or compositions. */
export function supportedDirectSchema(parameters: unknown): boolean {
  try {
    let remaining = 128;
    const supported = (schema: unknown, depth: number): boolean => {
      if (--remaining < 0 || depth > 4 || !isRecord(schema)) return false;
      const prototype = Object.getPrototypeOf(schema);
      if ((prototype !== Object.prototype && prototype !== null) || !Object.hasOwn(schema, "type")) return false;
      const keys = Object.keys(schema);
      if (keys.length > 64 || keys.some((key) => !keywords.has(key))) return false;
      if (schema.properties !== undefined) {
        if (!isRecord(schema.properties)) return false;
        const fields = Object.values(schema.properties);
        if (fields.length > 64 || !fields.every((field) => supported(field, depth + 1))) return false;
      }
      if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length > 64 || !schema.required.every((key) => typeof key === "string"))) return false;
      if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") return false;
      return schema.items === undefined || supported(schema.items, depth + 1);
    };
    return supported(parameters, 0);
  } catch { return false; }
}
