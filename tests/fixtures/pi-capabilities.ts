import { gte } from "semver";

export function piCapabilities(version: string) {
  const promptApi = gte(version, "1.2.0") ? "structured-trigger"
    : gte(version, "0.86.0") ? "structured-positional" : "legacy-string";

  return {
    promptApi,
    codemode: gte(version, "0.99.0"),
    recordedToolDuration: gte(version, "1.1.0"),
  } as const;
}
