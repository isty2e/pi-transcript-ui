import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

it("resolves the host's first-party runtime dependencies at the same release", () => {
  const filename = join(getPackageDir(), "package.json");
  const host = JSON.parse(readFileSync(filename, "utf8")) as { version: string; dependencies: Record<string, string> };

  for (const name of ["@earendil-works/chord", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai",
    "@earendil-works/pi-codemode", "@earendil-works/pi-mcp", "@earendil-works/pi-tui"]) {
    if (!(name in host.dependencies)) continue;
    const dependencyFile = findPackageJSON(name, pathToFileURL(filename));
    if (!dependencyFile) throw new Error(`Cannot resolve ${name} from Pi ${host.version}`);
    const dependency = JSON.parse(readFileSync(dependencyFile, "utf8")) as { version: string };
    expect(dependency.version, `${name} resolved by Pi ${host.version}`).toBe(host.version);
  }
});
