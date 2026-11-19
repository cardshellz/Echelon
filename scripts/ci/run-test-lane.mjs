import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CI_GUARD_TEST_FILES } from "./guard-test-manifest.mjs";

export function testLaneArguments(lane, extra = []) {
  if (!["guards", "unit"].includes(lane)) throw new Error("Expected guards or unit test lane");
  // Only the workflow's dependent unit lane omits preflight guards. The normal
  // package test:unit command continues to run the complete local unit suite.
  return ["run", ...(lane === "guards" ? CI_GUARD_TEST_FILES
    : ["unit", ...CI_GUARD_TEST_FILES.flatMap(file => ["--exclude", file])]),
    "--allowOnly=false", "--passWithNoTests=false", ...extra];
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [lane, ...extra] = process.argv.slice(2);
  const result = spawnSync(process.execPath,
    [fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url)), ...testLaneArguments(lane, extra)],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
