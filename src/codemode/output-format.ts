import { Buffer } from "node:buffer";
import { outputPartContent, type OutputBlock, type OutputPart, type ScriptOutput } from "./output.js";

const maxBytes = 50 * 1024, maxLines = 2000;
type Selection = ScriptOutput | OutputPart;
interface Usage { bytes: number; lines: number }

function measure(text: string, indent: number, usage: Usage): boolean {
  usage.bytes += Buffer.byteLength(text) + indent * 2;
  for (let index = 0; index < text.length; index++) if (text[index] === "\n") usage.lines++;
  return usage.bytes <= maxBytes && usage.lines <= maxLines;
}

function whitespace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

// JSON.parse validates grammar; this pass preserves the original token spellings.
function reflow(text: string, append: (token: string, indent: number) => boolean): boolean {
  let depth = 0, previous = "";
  for (let index = 0; index < text.length;) {
    const char = text[index]!;
    if (whitespace(char)) { index++; continue; }
    if (char === '"') {
      const from = index++;
      while (index < text.length) {
        const next = text[index++]!;
        if (next === "\\") index++;
        else if (next === '"') break;
      }
      if (!append(text.slice(from, index), 0)) return false;
    } else if (char === "{" || char === "[") {
      if (!append(char, 0)) return false;
      depth++; index++;
      let next = index;
      while (whitespace(text[next])) next++;
      if (text[next] !== "}" && text[next] !== "]" && !append("\n", depth)) return false;
    } else if (char === "}" || char === "]") {
      depth--; index++;
      if (previous !== "{" && previous !== "[" && !append("\n", depth)) return false;
      if (!append(char, 0)) return false;
    } else if (char === "," || char === ":") {
      index++;
      if (!append(char === ":" ? ": " : ",", 0) || (char === "," && !append("\n", depth))) return false;
    } else {
      const from = index++;
      while (index < text.length && !whitespace(text[index]) && !",]}".includes(text[index]!)) index++;
      if (!append(text.slice(from, index), 0)) return false;
    }
    previous = char;
  }
  return true;
}

function container(text: string): boolean {
  if (!/^[ \t\r\n]*[\[{]/.test(text)) return false;
  try { JSON.parse(text); return true; } catch { return false; }
}

export function formattedOutput(output: ScriptOutput): ReadonlyMap<Selection, readonly OutputBlock[]> | undefined {
  try {
    const source: Usage = { bytes: 0, lines: 0 };
    let hasText = false;
    for (const block of output.content) {
      if (block.type !== "text" || typeof block.text !== "string") continue;
      hasText = true; source.lines++;
      if (block.text.length > maxBytes || !measure(block.text, 0, source)) return undefined;
    }
    if (!hasText) return undefined;

    const projected: Usage = { bytes: 0, lines: 0 };
    const plan: {selection: Selection; blocks: readonly OutputBlock[]; containers: Set<number>}[] = [];
    for (const selection of output.parts?.length ? output.parts : [output]) {
      const blocks = "segments" in selection ? outputPartContent(output, selection) : output.content;
      const containers = new Set<number>();
      for (const [index, block] of blocks.entries()) {
        if (block.type !== "text" || typeof block.text !== "string") continue;
        projected.lines++;
        if (container(block.text)) {
          if (!reflow(block.text, (token, indent) => measure(token, indent, projected))) return undefined;
          containers.add(index);
        } else if (!measure(block.text, 0, projected)) return undefined;
      }
      plan.push({selection, blocks, containers});
    }

    const formatted = new Map<Selection, readonly OutputBlock[]>();
    for (const {selection, blocks, containers} of plan) {
      if (containers.size === 0) continue;
      let changed = false;
      const content = blocks.map((block, index) => {
        if (!containers.has(index)) return block;
        const chunks: string[] = [];
        reflow(block.text as string, (token, indent) => { chunks.push(token, " ".repeat(indent * 2)); return true; });
        const text = chunks.join("");
        if (text === block.text) return block;
        changed = true;
        return { ...block, text };
      });
      if (changed) formatted.set(selection, content);
    }
    return formatted.size > 0 ? formatted : undefined;
  } catch { return undefined; }
}
