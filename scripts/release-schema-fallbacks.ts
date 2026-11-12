#!/usr/bin/env node
/**
 * Release-phase run of the legacy idempotent schema fallbacks
 * (`runReleaseSchemaFallbacks` in server/db.ts).
 *
 * These statements used to run inside the web process on every boot. They take
 * exclusive table locks, so one blocked lock kept the app from starting. Here
 * they run once per release, before the new web process starts, and the web
 * process itself never changes table structure.
 *
 * Exit code: always 0 unless the script cannot run at all. Tracked migrations
 * (migrations/run-migrations.ts, the step before this one) are the fail-fast
 * gate; these fallbacks have always been allowed to skip when blocked, and a
 * skipped fallback is logged at error level for follow-up rather than stopping
 * the release. Set SKIP_STARTUP_MIGRATIONS=true to skip the step entirely.
 */
const EVENT = "release_schema_fallbacks";

function log(level: "info" | "warn" | "error", fields: Record<string, unknown>): void {
  const line = JSON.stringify({ level, action: EVENT, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

async function main(): Promise<number> {
  if (process.env.SKIP_STARTUP_MIGRATIONS === "true") {
    log("warn", { outcome: "skipped", reason: "disabled_by_env" });
    return 0;
  }
  if (!process.env.EXTERNAL_DATABASE_URL?.trim() && !process.env.DATABASE_URL?.trim()) {
    log("error", { outcome: "failed", error_code: "DATABASE_URL_MISSING" });
    return 1;
  }
  const startedAt = Date.now();
  const { pool, runReleaseSchemaFallbacks } = await import("../server/db");
  try {
    const outcome = await runReleaseSchemaFallbacks();
    log(outcome === "completed" ? "info" : "error", {
      outcome,
      error_code: outcome === "completed" ? null : "RELEASE_SCHEMA_FALLBACKS_SKIPPED",
      durationMs: Date.now() - startedAt,
    });
    return 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    log("error", {
      outcome: "failed",
      error_code: "RELEASE_SCHEMA_FALLBACKS_CRASHED",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  },
);
