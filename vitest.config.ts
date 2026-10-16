import { createRequire, findPackageJSON } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { piCapabilities } from "./tests/fixtures/pi-capabilities.js";

const compatibilityCases = [
  "tests/fixtures/pi-host.test.ts",
  "tests/integration/read-body.test.ts",
  "tests/integration/file-mutation.test.ts",
  "tests/integration/exec-session.test.ts",
  "tests/integration/exec-session-modern.test.ts",
  "tests/integration/tool-duration.test.ts",

  "tests/integration/adjacent-groups.test.ts",
  "tests/integration/navigation.test.ts",
  "tests/integration/presentation-settings.test.ts",
  "tests/integration/alternative-compositor.test.ts",
  "tests/integration/exec-session-compositor.test.ts",
  "tests/integration/patch-request-compositor.test.ts",

  "tests/integration/intent-session.test.ts",
  "tests/integration/intent-prompt.test.ts",
  "tests/integration/intent-prompt-legacy.test.ts",
  "tests/integration/codemode-runtime.test.ts",
];

function hostProject(name: string, source: string, include: string[]) {
  const entry = import.meta.resolve(source);
  const require = createRequire(entry);
  const manifest = findPackageJSON(entry);
  if (!manifest) throw new Error(`Cannot resolve the package metadata for ${source}`);
  const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
  const capabilities = piCapabilities(version);
  const exclude = [capabilities.promptApi === "legacy-string"
    ? "tests/integration/intent-prompt.test.ts" : "tests/integration/intent-prompt-legacy.test.ts"];
  if (!capabilities.codemode) exclude.push("tests/integration/codemode-runtime.test.ts");

  return {
    resolve: { alias: {
      "@earendil-works/pi-coding-agent": fileURLToPath(entry),
      "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
    } },
    test: { name, include, exclude: [...configDefaults.exclude, ...exclude] },
  };
}

export default defineConfig({ test: { projects: [
  hostProject("current", "@earendil-works/pi-coding-agent", ["tests/**/*.test.ts"]),
  hostProject("compat", "pi-compat-fixture", compatibilityCases),
  hostProject("legacy", "pi-legacy-fixture", compatibilityCases),
] } });
