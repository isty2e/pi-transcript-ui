import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

function hostProject(name: string, source: string, include: string[], exclude: string[] = []) {
  const entry = fileURLToPath(import.meta.resolve(source));
  const require = createRequire(entry);

  return {
    resolve: { alias: {
      "@earendil-works/pi-coding-agent": entry,
      "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
    } },
    test: { name, include, exclude: [...configDefaults.exclude, ...exclude] },
  };
}

export default defineConfig({ test: { projects: [
  hostProject("current", "@earendil-works/pi-coding-agent", ["tests/**/*.test.ts"], [
    "tests/integration/intent-prompt-legacy.test.ts",
  ]),
  hostProject("codemode-compat", "pi-codemode-fixture", [
    "tests/integration/codemode-runtime.test.ts",
    "tests/integration/exec-session-modern.test.ts",
  ]),
  hostProject("structured-compat", "pi-structured-prompt-fixture", [
    "tests/integration/intent-prompt.test.ts",
  ]),
  hostProject("legacy", "pi-legacy-fixture", [
    "tests/integration/intent-prompt-legacy.test.ts",
  ]),
] } });
