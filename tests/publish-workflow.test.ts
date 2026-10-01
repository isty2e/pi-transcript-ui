import { afterEach, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const workflow = parse(await readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8")) as {
  jobs: { publish: { "timeout-minutes": number; steps: { run?: string; env?: Record<string, string> }[] } };
};
const publicationScripts = workflow.jobs.publish.steps.flatMap(step => step.env?.PACKAGE_VERSION && step.run ? [step.run] : []);
const packageVersion = "1.2.3";
const artifact = "Tested publication artifact";
const integrity = "sha512-" + createHash("sha512").update(artifact).digest("base64");
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "transcript-publication-"));
  await mkdir(join(directory, "bin"));
  await mkdir(join(directory, "npm-package"));
  await writeFile(join(directory, "npm-package", `pi-transcript-ui-${packageVersion}.tgz`), artifact);
  await writeFile(join(directory, "waits.jsonl"), "");
  await writeFile(join(directory, "lookup-bounds.jsonl"), "");
  await writeFile(join(directory, "fast-time.mjs"), `
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(import.meta.url);
require("node:timers/promises").setTimeout = async milliseconds => {
  appendFileSync(process.env.PUBLICATION_WAITS, JSON.stringify(milliseconds) + "\\n");
  process.env.PUBLICATION_ELAPSED_MS = String(Number(process.env.PUBLICATION_ELAPSED_MS) + milliseconds);
};
const childProcess = require("node:child_process");
const execute = childProcess.execFileSync;
childProcess.execFileSync = (command, args, options) => {
  if (command === "npm" && args[0] === "view") {
    appendFileSync(process.env.PUBLICATION_LOOKUP_BOUNDS,
      JSON.stringify({ timeout: options.timeout, killSignal: options.killSignal }) + "\\n");
  }
  return execute(command, args, options);
};
syncBuiltinESMExports();
`);
  await writeFile(join(directory, "bin", "npm"), `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const path = process.env.PUBLICATION_CALLS;
const calls = existsSync(path) ? readFileSync(path, "utf8").trim().split("\\n").map(line => JSON.parse(line)) : [];
const args = process.argv.slice(2);
appendFileSync(path, JSON.stringify(args) + "\\n");
const scenario = process.env.PUBLICATION_SCENARIO;
if (args[0] === "publish") process.exit(scenario === "publish-failed" ? 1 : 0);
if (args[0] !== "view") process.exit(2);
const attempt = calls.filter(call => call[0] === "view").length + 1;
if (scenario === "unavailable" || (scenario === "delayed" && attempt <= 2) || (scenario === "network" && attempt === 1)
  || (scenario === "late" && Number(process.env.PUBLICATION_ELAPSED_MS) < 8 * 60 * 1000)) {
  process.stderr.write(scenario === "network" ? "EAI_AGAIN\\n" : "E404\\n");
  process.exit(1);
}
if (scenario === "empty" && attempt === 1) process.exit(0);
if (scenario === "invalid-json") { process.stdout.write("not JSON"); process.exit(0); }
process.stdout.write(JSON.stringify(scenario === "mismatch" ? "sha512-wrong" : process.env.PACKAGE_INTEGRITY));
`, { mode: 0o755 });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function executePublication(scenario: string, expectedIntegrity = integrity) {
  let status: number | null = 0;
  let output = "";
  for (const script of publicationScripts) {
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, RUNNER_TEMP: directory, PACKAGE_VERSION: packageVersion, PACKAGE_INTEGRITY: expectedIntegrity,
        PUBLICATION_CALLS: join(directory, "calls.jsonl"), PUBLICATION_SCENARIO: scenario,
        PUBLICATION_WAITS: join(directory, "waits.jsonl"), PUBLICATION_LOOKUP_BOUNDS: join(directory, "lookup-bounds.jsonl"),
        PUBLICATION_ELAPSED_MS: "0", PATH: `${join(directory, "bin")}:${process.env.PATH}`,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${join(directory, "fast-time.mjs")}`].filter(Boolean).join(" "),
      },
    });
    expect(result.error).toBeUndefined();
    output += result.stdout + result.stderr;
    status = result.status;
    if (status !== 0) break;
  }
  return { status, output };
}

async function calls() {
  try { return (await readFile(join(directory, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function verificationTiming() {
  const waits = (await readFile(join(directory, "waits.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as number);
  const lookups = (await readFile(join(directory, "lookup-bounds.jsonl"), "utf8")).split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as { timeout: number; killSignal: string });
  return { waits, lookups };
}

it("publishes once and accepts immediately visible matching integrity", async () => {
  expect(executePublication("visible").status).toBe(0);
  expect((await verificationTiming()).waits).toEqual([]);
  const commands = await calls();
  expect(commands.map(command => command[0])).toEqual(["publish", "view"]);
  expect(commands[0]).toEqual(["publish", join(directory, "npm-package", `pi-transcript-ui-${packageVersion}.tgz`),
    "--access", "public", "--registry=https://registry.npmjs.org/", "--ignore-scripts"]);
});

it.each([["delayed", 3], ["network", 2], ["empty", 2]] as const)("retries only lookups after %s visibility", async (scenario, count) => {
  expect(executePublication(scenario).status).toBe(0);
  const commands = await calls();
  expect(commands.filter(command => command[0] === "publish")).toHaveLength(1);
  const views = commands.filter(command => command[0] === "view");
  expect(views).toHaveLength(count);
  for (const command of views) expect(command).toEqual(["view", `pi-transcript-ui@${packageVersion}`, "dist.integrity", "--json",
    "--registry=https://registry.npmjs.org/", "--fetch-retries=0", "--fetch-timeout=15000"]);
});

it("accepts registry visibility after eight minutes without republishing", async () => {
  expect(executePublication("late").status).toBe(0);
  const commands = await calls();
  expect(commands.filter(command => command[0] === "publish")).toHaveLength(1);
  expect(commands.filter(command => command[0] === "view")).toHaveLength(17);
  expect((await verificationTiming()).waits.reduce((total, delay) => total + delay, 0)).toBe(8 * 60 * 1000);
});

it.each(["unavailable", "invalid-json"])("fails visibly after bounded %s lookups without republishing", async scenario => {
  const result = executePublication(scenario);
  expect(result.status).not.toBe(0);
  expect(result.output.trim()).not.toBe("");
  const commands = await calls();
  expect(commands.filter(command => command[0] === "publish")).toHaveLength(1);
  expect(commands.filter(command => command[0] === "view")).toHaveLength(21);
});

it("budgets ten minutes of polling and capped lookups within the publish job", async () => {
  expect(executePublication("unavailable").status).not.toBe(0);
  const { waits, lookups } = await verificationTiming();
  expect(waits).toEqual(Array<number>(20).fill(30000));
  expect(lookups).toEqual(Array.from({ length: 21 }, () => ({ timeout: 20000, killSignal: "SIGKILL" })));

  const configuredBudget = waits.reduce((total, delay) => total + delay, 0)
    + lookups.reduce((total, lookup) => total + lookup.timeout, 0);
  expect(configuredBudget).toBe(17 * 60 * 1000);
  expect(configuredBudget + 3 * 60 * 1000).toBeLessThanOrEqual(workflow.jobs.publish["timeout-minutes"] * 60 * 1000);
});

it("fails an integrity mismatch immediately without retrying publication or the lookup", async () => {
  expect(executePublication("mismatch").status).not.toBe(0);
  expect((await calls()).map(command => command[0])).toEqual(["publish", "view"]);
  expect((await verificationTiming()).waits).toEqual([]);
});

it("does not retry or look up a failed or ambiguous publication", async () => {
  expect(executePublication("publish-failed").status).not.toBe(0);
  expect((await calls()).map(command => command[0])).toEqual(["publish"]);
  expect((await verificationTiming()).waits).toEqual([]);
});

it("refuses a transferred artifact mismatch before any npm command", async () => {
  expect(executePublication("visible", "sha512-wrong").status).not.toBe(0);
  expect(await calls()).toEqual([]);
  expect((await verificationTiming()).waits).toEqual([]);
});
