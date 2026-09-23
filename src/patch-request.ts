import { isRecord } from "./intent.js";
import { supportedDirectSchema } from "./schema-capability.js";
import type { EditDelta } from "./edit-delta.js";

export type PatchTarget = Readonly<{ path: string } & (
  { kind: "add" | "delete" } | { kind: "update"; moveTo?: string }
)>;

/** Requested syntax only; neither targets nor deltas establish applied effects. */
export interface PatchRequest {
  readonly targets: readonly PatchTarget[];
  readonly delta: EditDelta | undefined;
}

type PatchInput = { kind: "envelope"; key: "input" | "patch" | "patchText" } | { kind: "operation" };
const payloadKeys = ["input", "patch", "patchText"] as const;
const SOURCE_LIMIT = 65536;
const LINE_LIMIT = 4096;
const TARGET_LIMIT = 256;

function inputFor(parameters: unknown): PatchInput | undefined {
  if (!supportedDirectSchema(parameters) || !isRecord(parameters) || parameters.type !== "object" || !isRecord(parameters.properties)) return undefined;
  const properties = parameters.properties;
  const field = (key: string, required = true) => Object.hasOwn(properties, key) &&
    isRecord(properties[key]) && properties[key].type === "string" &&
    (!required || (Array.isArray(parameters.required) && parameters.required.includes(key)));
  const payloads = payloadKeys.filter(key => Object.hasOwn(properties, key));

  if (payloads.length) {
    const key = payloads[0]!;
    if (payloads.length !== 1 || !field(key) || ["type", "path", "diff"].some(key => Object.hasOwn(properties, key))) return undefined;
    return { kind: "envelope", key };
  }
  return field("type") && field("path") && field("diff", false) ? { kind: "operation" } : undefined;
}

function pathValue(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && path.trim().length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(path);
}

function linesOf(text: string): string[] | undefined {
  if (text.length > SOURCE_LIMIT) return undefined;
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) return undefined;
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length <= LINE_LIMIT ? lines : undefined;
}

function addition(lines: readonly string[]): EditDelta | undefined {
  return lines.every(line => line.startsWith("+")) ? { added: lines.length, removed: 0 } : undefined;
}

function update(lines: readonly string[]): EditDelta | undefined {
  let inHunk = false;
  let body = false;
  let added = 0;
  let removed = 0;

  for (const [index, line] of lines.entries()) {
    if (line === "@@" || line.startsWith("@@ ")) {
      if (inHunk && !body) return undefined;
      inHunk = true;
      body = false;
    } else if (line === "*** End of File") {
      if (!body || index !== lines.length - 1) return undefined;
    } else {
      if (!inHunk || !/^[ +\-]/.test(line)) return undefined;
      body = true;
      if (line[0] === "+") added++;
      if (line[0] === "-") removed++;
    }
  }
  return inHunk && body ? { added, removed } : undefined;
}

function envelope(text: string): PatchRequest | undefined {
  const lines = linesOf(text);
  if (!lines || lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") return undefined;
  const targets: PatchTarget[] = [];
  let added = 0;
  let removed = 0;
  let deletion = false;
  let at = 1;

  while (at < lines.length - 1) {
    if (targets.length >= TARGET_LIMIT) return undefined;
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[at++]!);
    if (!header) return undefined;
    if (!pathValue(header[2]!) || header[2]!.trim() !== header[2]) return undefined;
    const path = header[2]!;
    let moveTo: string | undefined;

    if (header[1] === "Update" && lines[at]?.startsWith("*** Move to: ")) {
      const destination = lines[at++]!.slice("*** Move to: ".length);
      if (!pathValue(destination) || destination.trim() !== destination) return undefined;
      moveTo = destination;
    }
    const start = at;
    while (at < lines.length - 1 && (!lines[at]!.startsWith("*** ") || lines[at] === "*** End of File")) at++;
    const body = lines.slice(start, at);

    if (header[1] === "Delete") {
      if (body.length) return undefined;
      targets.push({ kind: "delete", path });
      deletion = true;
      continue;
    }
    const delta = header[1] === "Add" ? addition(body) : update(body);
    if (!delta) return undefined;
    added += delta.added;
    removed += delta.removed;
    targets.push(header[1] === "Add" ? { kind: "add", path }
      : { kind: "update", path, ...(moveTo === undefined ? {} : { moveTo }) });
  }
  return targets.length ? { targets, delta: deletion ? undefined : { added, removed } } : undefined;
}

function operation(type: string, path: string, diff: string | undefined): PatchRequest | undefined {
  if (!pathValue(path)) return undefined;
  if (type === "delete_file") return diff === undefined ? { targets: [{ kind: "delete", path }], delta: undefined } : undefined;
  if (diff === undefined || (type !== "create_file" && type !== "update_file")) return undefined;
  const lines = linesOf(diff);
  if (!lines) return undefined;
  const delta = type === "create_file" ? addition(lines) : update(lines);
  return delta ? { targets: [{ kind: type === "create_file" ? "add" : "update", path }], delta } : undefined;
}

function inputValues(shape: PatchInput, args: unknown): (string | undefined)[] | undefined {
  if (!isRecord(args)) return undefined;
  const supplied = payloadKeys.filter(key => Object.hasOwn(args, key));
  let values: (string | undefined)[];

  if (shape.kind === "envelope") {
    if (supplied.length !== 1 || supplied[0] !== shape.key || typeof args[shape.key] !== "string" || ["type", "path", "diff"].some(key => Object.hasOwn(args, key))) return undefined;
    values = [args[shape.key] as string];
  } else {
    const diff = Object.hasOwn(args, "diff") ? args.diff : undefined;
    if (supplied.length || !Object.hasOwn(args, "type") || !Object.hasOwn(args, "path") || typeof args.type !== "string" || typeof args.path !== "string" || (diff !== undefined && typeof diff !== "string")) return undefined;
    values = [args.type, args.path, diff];
  }
  return values.some(value => value !== undefined && value.length > SOURCE_LIMIT) ? undefined : values;
}

/** One bounded value-keyed cache per attachment; unsupported schemas have no parser. */
export function createPatchRequestParser(parameters: unknown): ((args: unknown) => PatchRequest | undefined) | undefined {
  let input: PatchInput | undefined;
  try { input = inputFor(parameters); } catch { return undefined; }
  if (!input) return undefined;
  const shape = input;
  let previous: readonly (string | undefined)[] | undefined;
  let request: PatchRequest | undefined;

  return (args) => {
    try {
      const values = inputValues(shape, args);
      if (!values) {
        previous = undefined;
        request = undefined;
        return undefined;
      }
      if (previous && previous.length === values.length && previous.every((value, index) => value === values[index])) return request;
      previous = values;
      request = shape.kind === "envelope" ? envelope(values[0]!) : operation(values[0]!, values[1]!, values[2]);
      return request;
    } catch {
      previous = undefined;
      request = undefined;
      return undefined;
    }
  };
}
