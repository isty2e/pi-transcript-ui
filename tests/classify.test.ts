import { describe, expect, it } from "vitest";
import { classifyTool } from "../src/classify.js";

describe("classifyTool", () => {
  it("maps built-in exploration tools to the exploration family", () => {
    expect(classifyTool("read")).toEqual({ family: "exploration", evidence: "built-in-read", operation: "read" });
    expect(classifyTool("grep")).toEqual({ family: "exploration", evidence: "built-in-read", operation: "search" });
    expect(classifyTool("find")).toEqual({ family: "exploration", evidence: "built-in-read", operation: "search" });
    expect(classifyTool("ls")).toEqual({ family: "exploration", evidence: "built-in-read", operation: "list" });
  });

  it("does not infer file mutation from edit/write names; bash stays standalone", () => {
    expect(classifyTool("edit")).toEqual({ family: null, evidence: "none", operation: "unknown" });
    expect(classifyTool("write")).toEqual({ family: null, evidence: "none", operation: "unknown" });
    expect(classifyTool("bash")).toEqual({ family: null, evidence: "none", operation: "execute" });
    expect(classifyTool("powershell")).toEqual({ family: null, evidence: "none", operation: "execute" });
  });

  it("leaves custom tools standalone and fails closed on hostile input", () => {
    expect(classifyTool("my-tool")).toEqual({ family: null, evidence: "none", operation: "unknown" });
    for (const hostile of [undefined, null, 42, "", "x".repeat(513), {}, []] as const) {
      expect(classifyTool(hostile)).toEqual({ family: null, evidence: "none", operation: "unknown" });
    }
  });

  it("lets exact-name user rules supersede the built-ins", () => {
    const rules = { "my-tool": "read", read: "standalone", bash: "mutation" } as const;
    expect(classifyTool("my-tool", rules)).toEqual({
      family: "exploration",
      evidence: "user-configured",
      operation: "read",
    });
    expect(classifyTool("read", rules)).toEqual({ family: null, evidence: "none", operation: "unknown" });
    expect(classifyTool("bash", rules)).toEqual({ family: "mutation", evidence: "user-configured", operation: "mutate" });
    expect(classifyTool("ls", rules)).toEqual({ family: "exploration", evidence: "built-in-read", operation: "list" });
  });

  it("fails closed on hostile rule tables", () => {
    expect(classifyTool("read", null)).toEqual({
      family: "exploration",
      evidence: "built-in-read",
      operation: "read",
    });
    const evil = Object.freeze({ __proto__: { read: "mutation" } });
    expect(classifyTool("read", evil as never)).toEqual({
      family: "exploration",
      evidence: "built-in-read",
      operation: "read",
    });
  });
});
