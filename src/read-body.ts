import { isRecord } from "./intent.js";
import { supportedDirectSchema } from "./schema-capability.js";

export type FileRead = Readonly<{ kind: "native-compatible-read" }>;
export type ReadBodyCount = Readonly<{ lines: number; source: "truncation" | "body" | "limited-body" }>;

/** Compatibility contract: native read's complete argument shape, never a name/path-only guess. */
export function fileReadFor(parameters: unknown): FileRead | undefined {
  try {
    if (!supportedDirectSchema(parameters) || !isRecord(parameters) ||
      parameters.type !== "object" || !isRecord(parameters.properties)) return undefined;

    const fields = parameters.properties;
    const names = Object.keys(fields);
    if (names.length !== 3 || names.some(name => !["path", "offset", "limit"].includes(name)) ||
      !Array.isArray(parameters.required) || parameters.required.length !== 1 ||
      parameters.required[0] !== "path") return undefined;
    if (!isRecord(fields.path) || fields.path.type !== "string" ||
      !isRecord(fields.offset) || fields.offset.type !== "number" ||
      !isRecord(fields.limit) || fields.limit.type !== "number") return undefined;

    return Object.freeze({ kind: "native-compatible-read" });
  } catch {
    return undefined;
  }
}

function bodyLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

const whole = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const automaticNotice = /(?:^|\n\n)\[Showing lines [^\n]*\]$|^\[Line \d+ is [^\n]+, exceeds [^\n]+ limit\. Use bash: [\s\S]*\]$/;

/** Count only returned native-compatible text bodies; ambiguity is unknown, never a guessed zero. */
export function readBodyCount(
  capability: FileRead | undefined,
  args: unknown,
  result: unknown,
  partial = false,
): ReadBodyCount | undefined {
  try {
    if (!capability || partial || !isRecord(args) || typeof args.path !== "string" ||
      !isRecord(result) || result.isError === true) return undefined;
    if ((args.offset !== undefined && !whole(args.offset)) ||
      (args.limit !== undefined && !whole(args.limit))) return undefined;

    const start = Math.max(1, (args.offset as number | undefined) ?? 1);
    if (!Array.isArray(result.content) || result.content.length !== 1) return undefined;
    const block = result.content[0];
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return undefined;
    const text = block.text;
    // Image processing can return only a description on failure/non-vision paths.
    if (/^Read image file \[[^\n]+\]/.test(text)) return undefined;

    const metadata = isRecord(result.details) ? result.details.truncation : undefined;
    if (metadata !== undefined) {
      if (!isRecord(metadata) || typeof metadata.content !== "string" ||
        !whole(metadata.outputLines) || !whole(metadata.outputBytes) || !whole(metadata.totalLines) ||
        metadata.outputLines > metadata.totalLines ||
        (args.limit !== undefined && metadata.outputLines > (args.limit as number)) ||
        Buffer.byteLength(metadata.content, "utf8") !== metadata.outputBytes) return undefined;

      if (metadata.firstLineExceedsLimit === true) {
        const notice = /^\[Line (\d+) is [^\n]+, exceeds [^\n]+ limit\. Use bash: [\s\S]*\]$/.exec(text);
        return metadata.truncated === true && metadata.truncatedBy === "bytes" &&
          metadata.content === "" && metadata.outputLines === 0 && notice && Number(notice[1]) === start
          ? { lines: 0, source: "truncation" } : undefined;
      }
      if (metadata.firstLineExceedsLimit !== false) return undefined;
      if (metadata.truncated === false) {
        return text === metadata.content && bodyLines(text) === metadata.outputLines
          ? { lines: metadata.outputLines, source: "truncation" } : undefined;
      }
      if (metadata.truncated !== true || !["lines", "bytes"].includes(String(metadata.truncatedBy)) ||
        metadata.outputLines === 0) return undefined;

      // Truncated output joins selected slots: its final blank selected line still counts.
      if (metadata.content.split("\n").length !== metadata.outputLines) return undefined;
      const end = start + metadata.outputLines - 1;
      const suffix = text.slice(metadata.content.length);
      const notice = /^\n\n\[Showing lines (\d+)-(\d+) of (\d+)( \([^\n]+ limit\))?\. Use offset=(\d+) to continue\.\]$/.exec(suffix);
      if (!text.startsWith(metadata.content) || !notice || Number(notice[1]) !== start ||
        Number(notice[2]) !== end || Number(notice[3]) < end || Number(notice[5]) !== end + 1 ||
        Boolean(notice[4]) !== (metadata.truncatedBy === "bytes")) return undefined;

      return { lines: metadata.outputLines, source: "truncation" };
    }

    // A missing automatic-truncation record cannot be reconstructed from a notice alone.
    if (automaticNotice.test(text)) return undefined;
    if (args.limit !== undefined) {
      const limit = args.limit as number;
      const slots = text.split("\n").length;
      if (slots > limit && !(limit === 0 && text === "")) {
        const footer = /\n\n\[([1-9]\d*) more lines in file\. Use offset=(\d+) to continue\.\]$/.exec(text);
        if (!footer || Number(footer[2]) !== start + limit) return undefined;
        const body = text.slice(0, footer.index);
        if (limit === 0 ? body !== "" : body.split("\n").length !== limit) return undefined;
        return { lines: bodyLines(body), source: "limited-body" };
      }
    }
    return { lines: bodyLines(text), source: "body" };
  } catch {
    return undefined;
  }
}

export function readCountText(counted: number, total: number, lines: number, repeated = false): string {
  if (counted === 0) return repeated ? `(${total} reads)` : "";
  const coverage = counted === total ? "" : `partial ${counted}/${total}: `;
  const reads = repeated ? `${total} reads, ` : "";
  return `(${coverage}${reads}${lines} ${lines === 1 ? "line" : "lines"})`;
}
