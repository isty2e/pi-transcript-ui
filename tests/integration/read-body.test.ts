import { expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createReadToolDefinition, createWriteToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { fileReadFor, readBodyCount } from "../../src/read-body.js";
import { attachTranscriptPresentation } from "../../src/wiring.js";
import { defaultSettings, groupingRules } from "../../src/settings.js";

const footer = "[9 more lines in file. Use offset=5 to continue.]";
const cases: [string, string, { offset?: number; limit?: number }, number | undefined, string?][] = [
  ["empty", "", {}, 0, "body"],
  ["unterminated", "a\nb", {}, 2, "body"],
  ["final LF", "a\nb\n", {}, 2, "body"],
  ["blank", "\n", {}, 1, "body"],
  ["multiple blanks", "\n\n", {}, 2, "body"],
  ["CRLF", "a\r\nb\r\n\r\n", {}, 3, "body"],
  ["limited", "a\nb\nc\nd", { limit: 2 }, 2, "limited-body"],
  ["limited blank ending", "a\n\nb\nc", { limit: 2 }, 1, "limited-body"],
  ["limited blank only", "\na\nb", { limit: 1 }, 0, "limited-body"],
  ["zero limit", "a\nb", { limit: 0 }, 0, "limited-body"],
  ["offset", "a\nb\nc\nd", { offset: 2, limit: 2 }, 2, "limited-body"],
  ["offset zero", "a\nb\nc", { offset: 0, limit: 1 }, 1, "limited-body"],
  ["offset EOF", "a\nb\n", { offset: 3 }, 0, "body"],
  ["limit beyond EOF", "a\nb\n", { offset: 2, limit: 50 }, 1, "body"],
  ["full limited EOF", "a\nb", { limit: 2 }, 2, "body"],
  ["footer-like raw text", `a\n\n${footer}`, {}, 3, "body"],
  ["footer-like raw limited EOF", `a\n\n${footer}`, { limit: 3 }, 3, "body"],
  ["footer-like raw plus generated footer", `a\n\n${footer}\nmore`, { limit: 3 }, 3, "limited-body"],
  ["footer-like raw final LF", `a\n\n${footer}\n`, { limit: 8 }, 3, "body"],
  ["automatic lines", Array(2001).fill("a").join("\n"), {}, 2000, "truncation"],
  ["automatic final blank selected", [...Array(1999).fill("a"), "", "b"].join("\n"), {}, 2000, "truncation"],
  ["automatic all blanks", "\n".repeat(2001), {}, 2000, "truncation"],
  ["automatic bytes", Array(100).fill("x".repeat(1024)).join("\n"), {}, 49, "truncation"],
  ["first line too large", "x".repeat(51201), {}, 0, "truncation"],
  ["automatic within user limit", Array(2200).fill("a").join("\n"), { offset: 10, limit: 2100 }, 2000, "truncation"],
  ["fractional offset", "a\nb\nc", { offset: 1.5 }, undefined],
  ["negative limit", "a\nb\nc", { limit: -1 }, undefined],
  ["fractional limit", "a\nb\nc", { limit: 1.5 }, undefined],
  ["ambiguous automatic-like raw text", "a\n\n[Showing lines 1-1 of 20. Use offset=2 to continue.]", {}, undefined],
  ["ambiguous image-note raw text", "Read image file [image/png]", {}, undefined],
];

it.each(cases)("counts native read %s without rereading or changing returned bodies", async (_name, text, selection, lines, source) => {
  const dir = await mkdtemp(join(tmpdir(), "read-count-"));
  try {
    const path = join(dir, "fixture.txt"); await writeFile(path, text);
    const def = createReadToolDefinition(dir);
    const args = { path, ...selection };
    const result = await def.execute("read", args, undefined, undefined, {} as never);
    const before = structuredClone(result);
    await rm(path); // Counts have only returned evidence; no presentation-time file exists.
    const count = readBodyCount(fileReadFor(def.parameters), args, result);
    expect(count?.lines).toBe(lines);
    expect(count?.source).toBe(source);
    expect(result).toEqual(before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("keeps native image/error results unknown, including offset beyond EOF", async () => {
  const dir = await mkdtemp(join(tmpdir(), "read-image-"));
  try {
    const def = createReadToolDefinition(dir, { autoResizeImages: false });
    const path = join(dir, "pixel.png");
    await writeFile(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
    const image = await def.execute("image", { path }, undefined, undefined, {} as never);
    expect(image.content.some((block) => block.type === "image")).toBe(true);
    expect(readBodyCount(fileReadFor(def.parameters), { path }, image)).toBeUndefined();
    await writeFile(join(dir, "empty"), "");
    for (const args of [{ path: join(dir, "missing") }, { path: join(dir, "empty"), offset: 2 }]) {
      let error: unknown;
      try { await def.execute("error", args, undefined, undefined, {} as never); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(readBodyCount(fileReadFor(def.parameters), args, { content: [{ type: "text", text: String(error) }], isError: true })).toBeUndefined();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const theme = { bold: (s: string) => s, fg: (_kind: string, s: string) => s };
const render = (chat: Container, width = 120) => stripTerminalSequences(chat.render(width).join("\n"));
const native = (def: ReturnType<typeof createReadToolDefinition>, id: string, args: unknown) => new ToolExecutionComponent(def.name, id, args, {}, def, { requestRender: vi.fn() } as never, "/tmp");

it("sums repeated/overlapping real reads, preserves native bodies, updates/removal/reattachment and partial cap provenance", async () => {
  initTheme();
  const dir = await mkdtemp(join(tmpdir(), "read-group-"));
  const root = new Container(), chat = new Container(); root.addChild(chat);
  let dispose: ReturnType<typeof attachTranscriptPresentation> | undefined;
  try {
    const path = join(dir, "same.txt"); await writeFile(path, Array.from({ length: 500 }, (_, i) => String(i)).join("\n"));
    const def = createReadToolDefinition(dir);
    const members: ToolExecutionComponent[] = [];
    const widths = [12, 48, 80, 120];
    const bodies: Map<number, string[]>[] = [];
    for (const [index, offset] of [1, 1, 100].entries()) {
      const args = { path, offset, limit: 140 };
      const output = await def.execute(String(index), args, undefined, undefined, {} as never);
      const tool = native(def, String(index), args); tool.updateResult({ ...output, isError: false });
      tool.setExpanded(true); bodies.push(new Map(widths.map((width) => [width, tool.render(width)]))); tool.setExpanded(false);
      members.push(tool); chat.addChild(tool);
    }
    const attach = (rowMaxWidth = 120) => attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), displayLimits: { rowMaxWidth } });
    dispose = attach();
    expect(render(chat)).toBe("\n▸ Read 1 file (3 reads, 420 lines)");
    dispose.targets()[0]!.setExpanded(true);
    for (const [index, member] of members.entries()) {
      member.setExpanded(true);
      for (const width of widths) expect(member.render(width).slice(index === 0 ? 3 : 1)).toEqual(bodies[index]!.get(width));
      expect(member.render(120)[index === 0 ? 2 : 0]).toContain("(140 lines)");
      member.setExpanded(false);
    }
    members[2]!.updateResult({ content: [{ type: "text", text: "untrusted update" }], isError: false }, true);
    expect(render(chat)).toContain("Reading 1 file (partial 2/3: 3 reads, 280 lines)…");
    members[2]!.updateResult({ content: [{ type: "text", text: "failure" }], isError: true });
    expect(render(chat)).toContain("Read 1 file — 1 failed (partial 2/3: 3 reads, 280 lines)");
    expect(members[2]!.render(120).join("\n")).toContain("— error");
    expect(members[2]!.render(120).join("\n")).not.toContain("1 line");
    dispose(); dispose = undefined;
    for (let cap = 1; cap <= 120; cap++) {
      dispose = attach(cap);
      for (const width of [1, 12, 35, 80, 120, 240]) {
        const header = chat.render(width)[1]!;
        expect(visibleWidth(header)).toBeLessThanOrEqual(Math.min(width, cap));
        if (header.includes("280")) expect(header).toContain("partial 2/3:");
      }
      dispose(); dispose = undefined;
    }
    dispose = attach();
    chat.removeChild(members[2]!);
    expect(render(chat)).toContain("Read 1 file (2 reads, 280 lines)");
    const mutable = { content: [{ type: "text", text: "a\nb\n" }], isError: false };
    members[1]!.updateArgs({ path }); members[1]!.updateResult(mutable);
    expect(render(chat)).toContain("Read 1 file (2 reads, 142 lines)");
    mutable.content[0]!.text = "";
    expect(render(chat)).toContain("Read 1 file (2 reads, 140 lines)");
    chat.clear(); chat.addChild(members[0]!); chat.addChild(members[1]!);
    expect(render(chat)).toContain("Read 1 file (2 reads, 140 lines)");
    dispose(); dispose = attach();
    expect(render(chat)).toContain("Read 1 file (2 reads, 140 lines)");
  } finally { dispose?.(); await rm(dir, { recursive: true, force: true }); }
});

it("uses compatible renamed readers but not path-only lookalikes; respects saved families/exclusions and native mutation counts", () => {
  initTheme();
  const root = new Container(), chat = new Container(); root.addChild(chat);
  const reader = { ...createReadToolDefinition("/tmp"), name: "external_reader" };
  const a = native(reader, "a", { path: "same" });
  a.updateResult({ content: [{ type: "text", text: "a\nb\n" }], isError: false });
  const opaque = native({ ...reader, name: "opaque", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } as typeof reader, "b", { path: "same" });
  opaque.updateResult({ content: [{ type: "text", text: "not a proven read" }], isError: false });
  chat.addChild(a); chat.addChild(opaque);
  const settings = defaultSettings(); settings.grouping.exploration.push("external_reader", "opaque");
  let dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), rules: groupingRules(settings) });
  expect(render(chat)).toContain("Exploration 2 calls (partial 1/2: 2 lines)");
  dispose();
  settings.grouping.exploration = settings.grouping.exploration.filter((name) => name !== "external_reader");
  settings.grouping.standalone = ["external_reader"];
  dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), rules: groupingRules(settings) });
  expect(render(chat)).toContain("Read same (2 lines)");
  expect(render(chat)).not.toContain("2 calls");
  dispose();
  const writer = createWriteToolDefinition("/tmp");
  const mutation = new ToolExecutionComponent("write", "w", { path: "same", content: "x" }, {}, writer, { requestRender: vi.fn() } as never, "/tmp");
  mutation.updateResult({ content: [{ type: "text", text: "success" }], isError: false, details: { patch: "--- same\n+++ same\n@@ -1 +1 @@\n-old\n+new\n" } });
  chat.removeChild(opaque); chat.addChild(mutation);
  settings.grouping.standalone = []; settings.grouping.exploration.push("external_reader", "write"); settings.grouping.mutation = settings.grouping.mutation.filter((name) => name !== "write");
  dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), rules: groupingRules(settings) });
  expect(render(chat)).toContain("Exploration 2 calls (partial 1/2: +1 -1)");
  dispose();
});

it("keeps pending/image/unknown members uncounted, knows empty zero, and snapshots read schema only on attachment", () => {
  initTheme();
  const root = new Container(), chat = new Container(); root.addChild(chat);
  const original = createReadToolDefinition("/tmp");
  let parameters: unknown = original.parameters, reads = 0;
  const def = { ...original, get parameters() { reads++; return parameters as typeof original.parameters; } };
  const a = native(def, "a", { path: "a" }), b = native(def, "b", { path: "b" });
  chat.addChild(a); chat.addChild(b);
  a.updateResult({ content: [{ type: "text", text: "" }], isError: false });
  reads = 0;
  const attach = () => attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
  let dispose = attach();
  expect(reads).toBe(2);
  expect(render(chat)).toContain("Reading 2 files (partial 1/2: 0 lines)…");
  b.updateResult({ content: [{ type: "text", text: "Read image file [image/png]" }], isError: false });
  expect(render(chat)).toContain("Read 2 files (partial 1/2: 0 lines)");
  dispose.targets()[0]!.setExpanded(true);
  expect(b.render(120).join("\n")).toContain("(lines unknown)");
  expect(a.render(120).join("\n")).toContain("(0 lines)");
  parameters = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  expect(render(chat)).toContain("Read 2 files (partial 1/2: 0 lines)");
  expect(reads).toBe(2);
  dispose(); dispose = attach();
  expect(reads).toBe(4);
  expect(render(chat)).toContain("Read 2 files");
  expect(render(chat)).not.toContain("(0 lines)");
  dispose(); parameters = original.parameters; dispose = attach();
  expect(render(chat)).toContain("Read 2 files (partial 1/2: 0 lines)");
  a.updateResult({ content: [{ type: "text", text: "failed" }], isError: true });
  expect(render(chat)).toContain("Read 2 files — 1 failed");
  dispose();
});

it("does not present output-line counts for excluded schema-unknown reads or label mixed reader/search schemas as patterns", () => {
  initTheme();
  const root = new Container(), chat = new Container(); root.addChild(chat);
  const def = createReadToolDefinition("/tmp");
  const opaqueDef = { ...def, parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } as typeof def;
  const opaque = native(opaqueDef, "opaque", { path: "same" });
  opaque.updateResult({ content: [{ type: "text", text: "unproven\nbody\n" }], isError: false }); chat.addChild(opaque);
  let dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn(), rules: { read: "standalone" } });
  expect(render(chat)).toContain("Read same (lines unknown)");
  dispose(); chat.clear();
  const renamed = native({ ...def, name: "grep" }, "renamed", { path: "same" });
  renamed.updateResult({ content: [{ type: "text", text: "a\nb" }], isError: false });
  const search = native({ ...opaqueDef, name: "grep" }, "search", { pattern: "query" });
  search.updateResult({ content: [{ type: "text", text: "match" }], isError: false });
  chat.addChild(renamed); chat.addChild(search);
  dispose = attachTranscriptPresentation(root, { getTheme: () => theme, requestRender: vi.fn() });
  expect(render(chat)).toContain("Exploration 2 calls (partial 1/2: 2 lines)");
  expect(render(chat)).not.toContain("patterns");
  dispose();
});
