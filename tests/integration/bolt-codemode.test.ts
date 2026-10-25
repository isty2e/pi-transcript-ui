import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const binary = process.env.PI_TRANSCRIPT_UI_TEST_BOLT;
it.skipIf(!binary)("projects codemode items through Pi-Bolt's native mode, renderer dispatch and lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "transcript-bolt-codemode-"));
  const report = join(directory, "report.json");
  try {
    const extension = fileURLToPath(new URL("./fixtures/bolt-codemode.ts", import.meta.url));
    const run = promisify(execFile)(binary!, ["--offline", "--mode", "rpc", "--no-session", "--no-tools", "--no-mcp",
      "--no-extensions", "--no-skills", "--no-themes", "--no-prompt-templates", "--no-context-files", "-e", extension], {
      cwd: directory, timeout: 90_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1", PI_TRANSCRIPT_UI_RUNTIME_REPORT: report },
    });
    run.child.stdin?.end();
    await run;
    const result = JSON.parse(await readFile(report, "utf8")) as {
      ok: boolean; version: string; cases: string[]; executed?: number; terminalStarts?: number; terminalWrites?: number; error?: string; stack?: string;
    };
    expect(result, result.stack ?? result.error).toMatchObject({ ok: true, executed: 0, terminalStarts: 0, terminalWrites: 0 });
    expect(result.cases).toHaveLength(3);
    console.info(`Pi-Bolt codemode: SDK ${result.version}; ${result.cases.length} native-mode/renderer/lifecycle cases; no tool execution`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 100_000);
