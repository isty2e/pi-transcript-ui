import { isRecord } from "../intent.js";

export type ObservedOutputItem =
  | { readonly type: "text"; readonly text: string; readonly console?: true }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

export interface OutputWitness {
  readonly items: readonly ObservedOutputItem[];
  readonly terminal: { readonly ok: true; readonly value?: string } | { readonly ok: false; readonly error: string };
}

export interface OutputBlock { readonly type: string; readonly [key: string]: unknown }
type OutputSegment = { readonly kind: "text"; readonly index: number; readonly from: number; readonly to: number }
  | { readonly kind: "block"; readonly index: number };
interface OutputSelection {
  readonly ordinal: number;
  readonly segments: readonly OutputSegment[];
}
export type OutputPart = OutputSelection & (
  | {readonly kind: "text" | "return" | "console" | "image" | "additional"}
  | {readonly kind: "formatted"; readonly printedIndex: number; readonly printedTotal: number}
);
export type ScriptOutput = {
  readonly content: readonly OutputBlock[];
  readonly fullOutputPath: string | undefined;
} & (
  | {readonly parts: readonly OutputPart[]; readonly partition: "observed" | "formatted"}
  | {readonly parts?: never; readonly partition?: never}
);

class OutputCursor {
  private index = 0;
  private offset = 0;
  private lastText = "";
  constructor(private readonly blocks: readonly OutputBlock[]) {}

  private take(value: string): { kind: "text"; index: number; from: number; to: number } {
    const block = this.blocks[this.index];
    if (block?.type !== "text" || typeof block.text !== "string" || !block.text.startsWith(value, this.offset)) throw new Error();

    const from = this.offset;
    this.offset += value.length;
    return { kind: "text", index: this.index, from, to: this.offset };
  }

  private separator(): void {
    if (this.lastText !== "" && !this.lastText.endsWith("\n")) { this.take("\n"); this.lastText = "\n"; }
  }

  text(prefix: string, value: string, suffix = ""): OutputSegment {
    this.separator(); this.take(prefix);
    const segment = this.take(value);
    this.take(suffix);
    const framed = prefix + value + suffix;
    if (framed !== "") this.lastText = framed;
    return segment;
  }

  image(item: Extract<ObservedOutputItem, {type: "image"}>): readonly OutputSegment[] {
    this.separator();
    const block = this.blocks[this.index], image = this.blocks[this.index + 1];
    if (block?.type !== "text" || typeof block.text !== "string" || image?.type !== "image" ||
      image.data !== item.data || image.mimeType !== item.mimeType) throw new Error();

    const label = block.text.slice(this.offset);
    if ((!label.startsWith("[Image saved to ") && !label.startsWith("[Image (")) || !label.endsWith("]")) throw new Error();
    const segments: OutputSegment[] = [this.take(label), {kind: "block", index: this.index + 1}];
    this.index += 2; this.offset = 0; this.lastText = "";
    return segments;
  }

  remaining(): readonly OutputSegment[] {
    const segments: OutputSegment[] = [];
    for (let index = this.index; index < this.blocks.length; index++) {
      const block = this.blocks[index]!;
      if (block.type === "text" && typeof block.text === "string") {
        const from = index === this.index ? this.offset : 0;
        if (from < block.text.length) segments.push({kind: "text", index, from, to: block.text.length});
      } else segments.push({kind: "block", index});
    }
    return segments;
  }
}

function observedPartition(content: readonly OutputBlock[], witness: OutputWitness): readonly OutputPart[] | undefined {
  try {
    const cursor = new OutputCursor(content), parts: OutputPart[] = [];
    const append = (kind: Exclude<OutputPart["kind"], "formatted">, segments: readonly OutputSegment[]) => {
      parts.push(Object.freeze({kind, ordinal: parts.length,
        segments: Object.freeze(segments.map(segment => Object.freeze(segment)))}));
    };

    const regular = witness.items.filter(item => item.type !== "text" || !item.console);
    const console = witness.items.filter((item): item is Extract<ObservedOutputItem, {type: "text"}> => item.type === "text" && item.console === true);
    const returned = witness.terminal.ok && witness.terminal.value !== undefined
      ? JSON.parse(witness.terminal.value) as unknown : undefined;
    const returnText = returned === undefined ? undefined : typeof returned === "string" ? returned : JSON.stringify(returned);

    const count = regular.filter(item => item.type === "text").length + (returnText === undefined ? 0 : 1);
    let index = 0;
    const appendText = (kind: "text" | "return", text: string) => {
      index++;
      const prefix = count > 1 ? `==> text ${index}/${count} <==\n` : "";
      append(kind, [cursor.text(prefix, text)]);
    };

    for (const item of regular) {
      if (item.type === "text") appendText("text", item.text);
      else append("image", cursor.image(item));
    }
    if (returnText !== undefined) appendText("return", returnText);
    if (console.length > 0)
      append("console", [cursor.text("<console_output>\n", console.map(item => item.text).join("\n"), "\n</console_output>")]);

    const rest = cursor.remaining();
    if (rest.length > 0) append("additional", rest);
    return parts.length > 0 ? Object.freeze(parts) : undefined;
  } catch { return undefined; }
}

function formattedPartition(content: readonly OutputBlock[]): readonly OutputPart[] | undefined {
  const markers: {index: number; offset: number; contentOffset: number; number: number; total: number}[] = [];
  for (const [index, block] of content.entries()) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    for (const match of block.text.matchAll(/^==> text ([1-9]\d*)\/([1-9]\d*) <==\r?$/gm)) {
      const end = match.index + match[0].length;
      markers.push({index, offset: match.index, contentOffset: end + (block.text[end] === "\n" ? 1 : 0),
        number: Number(match[1]), total: Number(match[2])});
    }
  }

  const total = markers[0]?.total;
  if (total === undefined || total < 2 || markers.length !== total ||
    !markers.every((marker, index) => marker.number === index + 1 && marker.total === total)) return undefined;

  const select = (from: {index: number; offset: number}, to: {index: number; offset: number}): readonly OutputSegment[] => {
    const segments: OutputSegment[] = [];
    for (let index = from.index; index < content.length && index <= to.index; index++) {
      const block = content[index]!;
      if (block.type === "text" && typeof block.text === "string") {
        const start = index === from.index ? from.offset : 0, end = index === to.index ? to.offset : block.text.length;
        if (end > start) segments.push(Object.freeze({kind: "text", index, from: start, to: end}));
        else if (block.text.length === 0 && index < to.index) segments.push(Object.freeze({kind: "block", index}));
      } else if (index < to.index) segments.push(Object.freeze({kind: "block", index}));
    }
    return Object.freeze(segments);
  };

  const parts: OutputPart[] = [], first = markers[0]!;
  const prelude = select({index: 0, offset: 0}, first);
  if (prelude.length > 0) parts.push(Object.freeze({kind: "additional", ordinal: 0, segments: prelude}));
  for (const [index, marker] of markers.entries()) {
    const end = markers[index + 1] ?? {index: content.length, offset: 0};
    parts.push(Object.freeze({kind: "formatted", ordinal: parts.length, printedIndex: marker.number,
      printedTotal: total, segments: select({index: marker.index, offset: marker.contentOffset}, end)}));
  }
  return Object.freeze(parts);
}

export function scriptOutput(result: unknown, witness?: OutputWitness): ScriptOutput | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  if (!result.content.every(block => isRecord(block) && typeof block.type === "string")) return undefined;
  let content = result.content as OutputBlock[];
  const first = content[0];
  const framed = first?.type === "text" && typeof first.text === "string" &&
    /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/.test(first.text);
  if (framed) content = content.slice(1);
  if (!content.some(block => block.type !== "text" || typeof block.text !== "string" || block.text.length > 0)) return undefined;

  const snapshot = Object.freeze([...content]);
  const fullOutputPath = isRecord(result.details) && typeof result.details.fullOutputPath === "string" ? result.details.fullOutputPath : undefined;
  if (fullOutputPath === undefined) {
    const sealed = Object.freeze(snapshot.map(block => Object.freeze({...block})));
    const observed = framed && witness ? observedPartition(sealed, witness) : undefined;
    if (observed) return Object.freeze({content: sealed, fullOutputPath, parts: observed, partition: "observed"});
    const formatted = formattedPartition(sealed);
    if (formatted) return Object.freeze({content: sealed, fullOutputPath, parts: formatted, partition: "formatted"});
  }
  return Object.freeze({content: snapshot, fullOutputPath});
}

export function outputPartContent(output: ScriptOutput, selected: OutputPart): readonly OutputBlock[] {
  if (output.parts?.[selected.ordinal] !== selected) throw new Error("Output part is not owned by this result");
  return selected.segments.map(segment => {
    const block = output.content[segment.index]!;
    return segment.kind === "block" ? block : {...block, text: (block.text as string).slice(segment.from, segment.to)};
  });
}

export function outputPartPreview(output: ScriptOutput, selected: OutputPart): string | undefined {
  if (output.parts?.[selected.ordinal] !== selected) return undefined;
  const first = selected.segments.find(segment => segment.kind === "text");
  if (!first || first.kind !== "text") return undefined;
  const text = output.content[first.index]!.text as string;
  const newline = text.indexOf("\n", first.from);
  return text.slice(first.from, newline >= 0 ? Math.min(newline, first.to) : first.to);
}
