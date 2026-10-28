import type { SummaryRequest } from "../tool-summary.js";

type ObjectFrame = {
  kind: "object";
  phase: "first" | "key" | "colon" | "value" | "separator";
  start: number;
  keys: Set<string>;
  key?: string;
};
type ArrayFrame = {kind: "array"; phase: "first" | "value" | "separator"; start: number};
type TokenEnd = number | "prefix" | undefined;
const space = (char: string | undefined) => char === " " || char === "\t" || char === "\r" || char === "\n";
const digit = (char: string | undefined) => char !== undefined && char >= "0" && char <= "9";
const boundary = (char: string | undefined) => space(char) || char === "," || char === "}" || char === "]";

function stringEnd(text: string, from: number): TokenEnd {
  for (let at = from + 1; at < text.length; at++) {
    const char = text[at]!;
    if (char === '"') return at + 1;
    if (char.charCodeAt(0) < 32) return undefined;
    if (char !== "\\") continue;

    const escape = text[++at];
    if (escape === undefined) return "prefix";
    if ('"\\/bfnrt'.includes(escape)) continue;
    if (escape !== "u") return undefined;
    for (let count = 0; count < 4; count++) {
      const hex = text[++at];
      if (hex === undefined) return "prefix";
      if (!/[0-9a-fA-F]/.test(hex)) return undefined;
    }
  }
  return "prefix";
}

function valueEnd(text: string, from: number): TokenEnd {
  const first = text[from]!;
  if (first === '"') return stringEnd(text, from);
  for (const literal of ["true", "false", "null"]) {
    if (first !== literal[0]) continue;
    const rest = text.slice(from);
    if (rest.length < literal.length && literal.startsWith(rest)) return "prefix";
    const end = from + literal.length;
    return text.startsWith(literal, from) && (end === text.length || boundary(text[end])) ? end : undefined;
  }

  let at = from;
  if (text[at] === "-") at++;
  if (at === text.length) return "prefix";
  if (text[at] === "0") at++;
  else if (text[at]! >= "1" && text[at]! <= "9") { while (digit(text[at])) at++; }
  else return undefined;

  if (text[at] === ".") {
    at++;
    if (at === text.length) return "prefix";
    if (!digit(text[at])) return undefined;
    while (digit(text[at])) at++;
  }

  if (text[at] === "e" || text[at] === "E") {
    at++;
    if (text[at] === "+" || text[at] === "-") at++;
    if (at === text.length) return "prefix";
    if (!digit(text[at])) return undefined;
    while (digit(text[at])) at++;
  }
  // An EOF number could still acquire more digits, a fraction or an exponent.
  return at === text.length ? "prefix" : boundary(text[at]) ? at : undefined;
}

function objectPrefix(text: string, partial: boolean): SummaryRequest | undefined {
  let at = 0;
  while (space(text[at])) at++;
  if (text[at] !== "{") return undefined;

  const args: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const stack: (ObjectFrame | ArrayFrame)[] = [{kind: "object", phase: "first", start: at++, keys: new Set()}];

  const supplied = (from: number, end: number) => {
    const owner = stack.at(-1)!;
    if (owner.kind === "object") {
      if (stack.length === 1) Object.defineProperty(args, owner.key!, {value: JSON.parse(text.slice(from, end)), enumerable: true});
      owner.phase = "separator";
    } else owner.phase = "separator";
  };
  const prefix = () => partial ? Object.freeze({args: Object.freeze(args), complete: false, source: "preview" as const}) : undefined;

  while (stack.length) {
    while (space(text[at])) at++;
    if (at === text.length) return prefix();
    const owner = stack.at(-1)!, char = text[at]!;
    const closes = owner.kind === "object" ? char === "}" : char === "]";
    if (closes) {
      if (owner.phase !== "first" && owner.phase !== "separator") return undefined;
      stack.pop(); at++;
      if (stack.length) supplied(owner.start, at);
      else {
        while (space(text[at])) at++;
        return at === text.length ? Object.freeze({args: Object.freeze(args), complete: true, source: "preview" as const}) : undefined;
      }
      continue;
    }

    if (owner.phase === "separator") {
      if (char !== ",") return undefined;
      owner.phase = owner.kind === "object" ? "key" : "value"; at++; continue;
    }

    if (owner.kind === "object" && (owner.phase === "first" || owner.phase === "key")) {
      if (char !== '"') return undefined;
      const end = stringEnd(text, at);
      if (end === "prefix") return prefix();
      if (end === undefined) return undefined;
      const key: string = JSON.parse(text.slice(at, end));
      if (owner.keys.has(key)) return undefined;
      owner.keys.add(key); owner.key = key; owner.phase = "colon"; at = end; continue;
    }

    if (owner.kind === "object" && owner.phase === "colon") {
      if (char !== ":") return undefined;
      owner.phase = "value"; at++; continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? {kind: "object", phase: "first", start: at, keys: new Set()} : {kind: "array", phase: "first", start: at});
      at++; continue;
    }

    const end = valueEnd(text, at);
    if (end === "prefix") return prefix();
    if (end === undefined) return undefined;
    supplied(at, end); at = end;
  }
  return undefined;
}

/** Decode only complete root fields from the native JSON-plus-truncation preview. */
export function argumentPreview(preview: string | undefined): SummaryRequest | undefined {
  if (preview === undefined) return undefined;
  try {
    const whole = objectPrefix(preview, false);
    if (whole) return whole;
    if (!preview.endsWith("...")) return undefined;
    const prefix = objectPrefix(preview.slice(0, -3), true);
    return prefix?.complete === false ? prefix : undefined;
  } catch { return undefined; }
}
