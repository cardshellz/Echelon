import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const vitestBin = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));
const tscBin = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));

function extractContractTestFiles() {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf("  contracts:");
  if (start === -1) throw new Error("Missing contracts job in .github/workflows/ci.yml");
  let end = start + 1;
  while (end < lines.length && !/^  [a-z][a-z0-9-]*:/.test(lines[end])) end++;
  const files = [];
  for (let i = start + 1; i < end; i++) {
    const match = /^ {10}([\w./-]+\.test\.tsx?)$/.exec(lines[i]);
    if (match) files.push(match[1]);
  }
  if (files.length === 0) throw new Error("No contract test files parsed from .github/workflows/ci.yml");
  return [...new Set(files)];
}

function runStep(label, args, extraEnv = {}) {
  const started = Date.now();
  process.stdout.write(`\n=== [verify-prepush] ${label} ===\n`);
  const nodeOptions = [process.env.NODE_OPTIONS, "--max-old-space-size=8192"].filter(Boolean).join(" ");
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: nodeOptions, ...extraEnv },
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    process.stderr.write(`\n[verify-prepush] FAILED (${label}) with exit code ${result.status}\n`);
    process.exit(result.status ?? 1);
  }
  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`=== [verify-prepush] PASSED (${label}) in ${elapsedSec}s ===\n`);
}

runStep("Migration check", ["scripts/migrations/check-migrations.mjs"]);
runStep("Fast CI guards", ["scripts/ci/run-test-lane.mjs", "guards"]);
runStep("Typecheck (application)", [tscBin, "-p", "tsconfig.json", "--noEmit"]);
runStep("Typecheck (client-tests)", [tscBin, "-p", "tsconfig.tests.client.json", "--noEmit"]);
runStep("Typecheck (server-tests)", [tscBin, "-p", "tsconfig.tests.server.json", "--noEmit"]);
runStep("Offline UI & runtime contracts", [vitestBin, "run", "--allowOnly=false", "--passWithNoTests=false", ...extractContractTestFiles()]);
runStep("Full repository unit lane (all 4 CI shards)", ["scripts/ci/run-test-lane.mjs", "unit"]);

process.stdout.write("\n[verify-prepush] ALL LOCAL CI GATES PASSED.\n");
