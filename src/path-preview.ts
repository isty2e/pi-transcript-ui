import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function middleClip(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const segments = Array.from(graphemes.segment(text), part => part.segment);
  const tailBudget = Math.ceil((width - 1) / 2);
  let tailWidth = 0, start = segments.length;
  while (start > 0) {
    const nextWidth = visibleWidth(segments[start - 1]!);
    if (tailWidth + nextWidth > tailBudget) break;
    tailWidth += nextWidth;
    start--;
  }
  const head = stripTerminalSequences(truncateToWidth(text, width - 1 - tailWidth, ""));
  return head + "…" + segments.slice(start).join("");
}

export function pathPreview(path: string, width: number): string {
  width = Math.max(0, Math.floor(width));
  if (width === 0) return "";
  const text = stripTerminalSequences(path).replace(/[\r\n\t]/g, " ");
  if (visibleWidth(text) <= width) return text;

  const windows = process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\");
  const root = (windows ? /^(?:[A-Za-z]:[\\/]+|~[\\/]+|[\\/]+)/ : /^(?:~\/+|\/+)/).exec(text)?.[0] ?? "";
  const body = text.slice(root.length);
  const parts = Array.from(body.matchAll(windows ? /[^\\/]+/g : /[^/]+/g));
  const rootWidth = visibleWidth(root);
  if (parts.length <= 1) {
    const rootBudget = width - visibleWidth(body);
    if (rootBudget >= 1) return stripTerminalSequences(truncateToWidth(root, rootBudget, "…")) + body;
    return width > rootWidth ? root + middleClip(body, width - rootWidth) : middleClip(text, width);
  }

  const suffixWidths: number[] = new Array(parts.length);
  const separators: string[] = new Array(parts.length);
  let suffixWidth = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    const end = parts[i + 1]?.index ?? body.length;
    suffixWidth += visibleWidth(body.slice(part.index, end));
    suffixWidths[i] = suffixWidth;
    separators[i] = i === 0 ? "" : body.slice(parts[i - 1]!.index + parts[i - 1]![0].length, part.index);
  }

  const first = parts[0]![0];
  const prefix = root + first + separators[1] + "…";
  const prefixWidth = visibleWidth(prefix);
  for (let i = 2; i < parts.length; i++) {
    if (prefixWidth + visibleWidth(separators[i]!) + suffixWidths[i]! <= width) {
      return prefix + separators[i] + body.slice(parts[i]!.index);
    }
  }

  const last = parts.length - 1;
  const tail = body.slice(parts[last]!.index);
  const gap = parts.length > 2 ? separators[1] + "…" + separators[last] : separators[last]!;
  const firstBudget = width - rootWidth - visibleWidth(gap) - suffixWidths[last]!;
  if (firstBudget >= 2) {
    const head = stripTerminalSequences(truncateToWidth(first, firstBudget, "…"));
    if (head !== "…") return root + head + gap + tail;
  }

  for (let i = 1; i < parts.length; i++) {
    if (rootWidth + 1 + visibleWidth(separators[i]!) + suffixWidths[i]! <= width) {
      return root + "…" + separators[i] + body.slice(parts[i]!.index);
    }
  }
  const omitted = root + "…" + separators[last];
  const originBudget = width - suffixWidths[last]!;
  if (originBudget >= 1) return stripTerminalSequences(truncateToWidth(omitted, originBudget, "…")) + tail;
  const nameBudget = width - visibleWidth(omitted);
  return nameBudget > 0 ? omitted + middleClip(tail, nameBudget) : middleClip(text, width);
}
