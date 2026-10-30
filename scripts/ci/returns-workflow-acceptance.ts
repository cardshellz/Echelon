import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPostgresShard } from "./postgres-tests";
import { selectedPostgresShards } from "./postgres-test-impact";

export const RETURN_ACCEPTANCE_DATABASE_FILES = [
  "server/modules/returns/__tests__/integration/customer-return-complex-flow.test.ts",
  "server/modules/returns/__tests__/integration/customer-return-labels.repository.test.ts",
  "server/modules/customer-account/__tests__/integration/order-action-projection.repository.test.ts",
] as const;
const UNIT_FILES = [
  "server/modules/returns/__tests__/unit/customer-return-workflow.worker.test.ts",
  "server/modules/returns/__tests__/unit/customer-return-submission.service.test.ts",
  "server/modules/returns/__tests__/unit/customer-return-customer-operations.service.test.ts",
  "server/modules/returns/__tests__/unit/customer-return-customer.routes.test.ts",
  "server/modules/customer-account/__tests__/unit/customer-account.routes.test.ts",
  "client/src/lib/__tests__/unit/customer-return-customer.test.ts",
];
function run(args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(process.execPath, args, { cwd: process.cwd(), env, stdio: "inherit" });
  if (result.error || result.signal || result.status !== 0) throw new Error("Return workflow acceptance phase failed.");
}
/** One acceptance command. The existing PostgreSQL runner owns fresh databases,
 * validates loopback isolation, strips application DB credentials and cleans up.
 * Providers are HTTP fixtures with no live network fallback or purchase keys. */
export async function runReturnWorkflowAcceptance(env: NodeJS.ProcessEnv): Promise<void> {
  const databaseEnv = { ...env, POSTGRES_SELECTED_TEST_FILES: JSON.stringify(RETURN_ACCEPTANCE_DATABASE_FILES) };
  const plan = selectedPostgresShards(RETURN_ACCEPTANCE_DATABASE_FILES);
  for (let index = 1; index <= plan.shards.length; index++) {
    if (await runPostgresShard([`${index}/${plan.shards.length}`], databaseEnv) !== 0)
      throw new Error("Connected return workflow acceptance failed.");
  }
  const isolatedEnv = { ...env };
  delete isolatedEnv.DATABASE_URL; delete isolatedEnv.EXTERNAL_DATABASE_URL; delete isolatedEnv.BROWSER_FEATURE;
  run(["node_modules/vitest/vitest.mjs", "run", ...UNIT_FILES, "--no-file-parallelism", "--allowOnly=false"], isolatedEnv);
  run(["node_modules/vite/bin/vite.js", "build", "--config", "vite.customer-account.config.ts"], isolatedEnv);
  run(["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.returns-preview.config.ts",
    "returns-customer.spec.ts", "returns-account-layout.spec.ts", "--forbid-only"], isolatedEnv);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReturnWorkflowAcceptance(process.env).catch(error => {
    console.error(error instanceof Error ? error.message : "Return acceptance failed."); process.exitCode = 1;
  });
}
