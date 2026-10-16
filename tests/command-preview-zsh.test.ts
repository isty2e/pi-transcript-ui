import { expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { COMMAND_SOURCE_LIMIT, commandPreview } from "../src/command-preview.js";

it.each([
  "cd /workspace/long/project/path && npm run build --configuration development || printf '%s' fallback | head -n 20; git status",
  "export FLAG=ready\nprintf '%s' 'quoted && | ; text'\ngit diff --check",
  "printf '%s' \"a\\\nb\"\ngit status",
  "printf repeat\n'repeat' arg\n\\repeat arg\ngit status",
])("shares common chain allocation without changing zsh source meaning: %s", source => {
  for (const width of [0, 1, 8, 24, 60, 96, 120]) {
    const preview = commandPreview(source, width, "zsh");
    expect(preview).toBe(commandPreview(source, width, "bash"));
    expect(visibleWidth(preview)).toBeLessThanOrEqual(width);
  }
});

it("keeps ordinary zsh command heads and newline boundaries", () => {
  expect(commandPreview("npm test\ngit diff --check\nprintf '%s' ready", 120, "zsh"))
    .toBe("npm test ↵ git diff --check ↵ printf '%s' ready");
});

it.each([
  ["repeat", "repeat 2 do\nprintf HIDDEN\ndone\nprintf AFTER"],
  ["repeat", "repeat 2 printf HIDDEN && printf BODY_TAIL\nprintf AFTER"],
  [undefined, "FLAG=ready repeat 2 do\nprintf HIDDEN\ndone\nprintf AFTER"],
  ["foreach", "foreach item (a b)\nprintf HIDDEN\nend\nprintf AFTER"],
  ["always", "always { printf HIDDEN; }\nprintf AFTER"],
  ["end", "end\nprintf AFTER"],
  ["noglob", "noglob printf HIDDEN && printf AFTER"],
  ["nocorrect", "nocorrect printf HIDDEN && printf AFTER"],
  [undefined, "- printf HIDDEN && printf AFTER"],
] as const)("does not expose a refused zsh body as outer stages: %s", (head, tail) => {
  const source = `npm test\n${tail}`;
  expect(commandPreview(source, 120, "zsh")).toBe(`npm test ↵ ${head ? `${head} ` : ""}[…]`);
  for (const width of [0, 1, 8, 24, 60, 120]) {
    const preview = commandPreview(source, width, "zsh");
    expect(visibleWidth(preview)).toBeLessThanOrEqual(width);
    expect(preview).not.toMatch(/HIDDEN|BODY_TAIL|AFTER|\[\+\d+\]/);
    expect(preview.match(/↵/g)?.length ?? 0).toBeLessThanOrEqual(1);
  }
});

it.each([
  "printf '%s' $(repeat 2 printf HIDDEN)\nprintf AFTER",
  "printf '%s' $(printf '%s' $(repeat 2 printf HIDDEN))\nprintf AFTER",
  "printf '%s' $(printf repeat && repeat 2 printf HIDDEN)\nprintf AFTER",
  "printf '%s' ${values[(r)*]}\nprintf AFTER",
  "printf '%s' **/*.ts(N)\nprintf AFTER",
  "printf '%s' =(printf HIDDEN)\nprintf AFTER",
  "printf HIDDEN &!\nprintf AFTER",
  "printf '%s' $'HIDDEN|BODY'\nprintf AFTER",
])("keeps one opaque remainder for unsupported zsh syntax: %s", tail => {
  const preview = commandPreview(`npm test\n${tail}`, 120, "zsh");
  expect(preview).toBe("npm test ↵ printf […]");
});

it.each(["printf repeat", "printf repeat foreach end always noglob nocorrect", "FLAG=ready printf repeat",
  "printf '%s' $(printf repeat)"])("keeps zsh control words that are ordinary substitution arguments: %s", content => {
  const source = `npm test\nprintf '%s' $(${content})\ngit status`;
  expect(commandPreview(source, 120, "zsh")).toBe("npm test ↵ printf '%s' $(…) ↵ git status");
});

it.each(["EOF", "'EOF'", '"EOF"'])("does not expose a zsh heredoc body for delimiter %s", delimiter => {
  const source = `npm test\ncat <<${delimiter}\nrepeat 2 do; HIDDEN | BODY; done\nEOF\ngit status`;
  expect(commandPreview(source, 120, "zsh")).toBe("npm test ↵ cat […] ↵ git status");
});

it("rewinds pending heredoc stages when a zsh control head stops interpretation", () => {
  const source = "npm test\ncat <<'EOF'; repeat 2 do\nHIDDEN_BODY | BODY_TAIL\nEOF\nprintf INNER\ndone\nprintf AFTER";
  expect(commandPreview(source, 120, "zsh")).toBe("npm test ↵ cat […]");
});

it("honors Raw and bounded fallback instead of claiming zsh parsing", () => {
  for (const source of ["npm test\ngit status", "repeat 2 do\nprintf HIDDEN\ndone", "npm test\r\ngit status",
    "printf " + "x".repeat(COMMAND_SOURCE_LIMIT)]) {
    for (const width of [0, 1, 8, 24, 120]) {
      const raw = commandPreview(source, width, "zsh", "raw");
      expect(raw).toBe(commandPreview(source, width, "bash", "raw"));
      expect(visibleWidth(commandPreview(source, width, "zsh"))).toBeLessThanOrEqual(width);
    }
  }
  expect(commandPreview("npm test\r\ngit status", 120, "zsh")).toBe("npm test […]");
  expect(commandPreview("repeat 2 do\nprintf HIDDEN\ndone", 120, "zsh")).toBe("repeat […]");
});
