#!/usr/bin/env node
/**
 * Release-phase smoke check for the customer order editor's read path.
 * Read-only. Exits non-zero when the editor's warehouse inspection SQL cannot
 * run against the target database, so the release stops instead of customers
 * finding the fault. Set SKIP_ORDER_EDIT_RELEASE_SMOKE=true to bypass it.
 */
import { Pool } from "pg";
import { createDatabasePoolConfig } from "../server/database-pool-config";
import { runOrderEditReadSmoke } from "../server/modules/order-edits/infrastructure/order-edit-release-smoke";

const EVENT = "order_edit_release_smoke";

function log(level: "info" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({ level, event: EVENT, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

async function main(): Promise<number> {
  if (process.env.SKIP_ORDER_EDIT_RELEASE_SMOKE === "true") {
    log("info", { outcome: "skipped", reason: "disabled_by_env" });
    return 0;
  }
  const connectionString =
    process.env.EXTERNAL_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    log("error", { outcome: "failed", error_code: "DATABASE_URL_MISSING" });
    return 1;
  }
  const pool = new Pool(
    createDatabasePoolConfig({
      connectionString,
      ssl: { rejectUnauthorized: false },
    }),
  );
  try {
    log("info", await runOrderEditReadSmoke(pool));
    return 0;
  } catch (error) {
    log("error", {
      outcome: "failed",
      error_code:
        (error as { code?: unknown } | null)?.code ?? "ORDER_EDIT_SMOKE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    log("error", { outcome: "failed", message: String(error) });
    process.exit(1);
  },
);
