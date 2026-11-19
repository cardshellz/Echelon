/**
 * Schema drift check: does a database built from this repository have the same
 * structure as production?
 *
 * The baseline in migrations/baseline/ is a snapshot. It goes stale when
 * production's structure changes without a migration in this repository: a
 * manual change, or the other application that shares the database
 * (shellz-club-app) shipping a change to its own tables. This check finds that.
 *
 * What it does, on a disposable local PostgreSQL 17:
 *   1. builds a database from the repository (baseline, then every migration
 *      the baseline does not cover) and dumps its structure;
 *   2. takes production's structure dump, loads it into a second scratch
 *      database and dumps that again, because PostgreSQL rewords stored
 *      expressions on reload and only two reloaded dumps are comparable;
 *   3. compares the two dumps object by object.
 *
 * It never connects to production. Production's structure arrives as files:
 * normally a checkout of the `production-structure` branch, which a nightly
 * Heroku job publishes (scripts/publish-production-structure.ts), so no
 * database credential leaves Heroku. A copy that is older than the limit, or
 * whose files do not match their recorded hashes, is refused.
 *
 * Outcomes:
 *   exit 0  the structures are identical (or the self-check passed)
 *   exit 1  they differ, or the check could not be completed. With an alert
 *           webhook configured, both cases post to it, with different text.
 *
 *   ECHELON_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres \
 *   ECHELON_TEST_DATABASE_DISPOSABLE=true MIGRATION_DATABASE_SSL=disable \
 *   node --import tsx scripts/ci/check-schema-drift.ts --self-check
 *
 * Environment:
 *   SCHEMA_DRIFT_ALERT_WEBHOOK_URL   Discord-compatible webhook for alerts
 *   SCHEMA_DRIFT_RUN_URL             link to this run, added to alerts
 *   PG_DUMP_PATH                     pg_dump 17 executable (default: pg_dump)
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { transformProductionDump } from "../migrations/baseline-format.mjs";
import { MigrationPolicyError, validateMigrationDirectory } from "../migrations/migration-policy.mjs";
import {
  APPLIED_MIGRATIONS_FILENAME, HEARTBEAT_FILENAME, STRUCTURE_FILENAME, verifyPublication,
} from "../migrations/production-structure.mjs";
import {
  compareStructureDumps, formatCheckFailureAlert, formatDriftAlert,
  type StructureComparison,
} from "../migrations/schema-drift.mjs";
import {
  ADMIN_STATEMENT_TIMEOUT_MS, CheckError, MIGRATIONS_DIR,
  adminUrlFromEnv, databaseUrlOn, localSslFromEnv, runMigrationRunner,
} from "./disposable-database";
import {
  findUnreleasedMigrations, parseAppliedMigrations, parseDriftCheckArguments, sendAlert,
  type DriftCheckOptions,
} from "./schema-drift-check-support";
import { dumpStructure, libpqEnvironment } from "./structure-dump";

const LOAD_STATEMENT_TIMEOUT_MS = 5 * 60_000;
const SELF_CHECK_MARKER_TABLE = "schema_drift_self_check_marker";

interface ProductionStructure {
  dump: string;
  applied: string[];
}

function log(level: "info" | "error", outcome: string, errorCode: string | null, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, action: "schema_drift_check", outcome, error_code: errorCode, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

/** Reads and verifies a checkout of the production-structure branch. `now` is passed in so the caller owns the clock. */
function readPublishedStructure(directory: string, now: Date): ProductionStructure {
  const read = (name: string): string => {
    try {
      return readFileSync(path.join(directory, name), "utf8");
    } catch {
      throw new CheckError("SCHEMA_DRIFT_PRODUCTION_STRUCTURE_MISSING", `The published production structure has no ${name}; the Heroku job that publishes it has not run yet.`, { file: name });
    }
  };
  const texts = { structureText: read(STRUCTURE_FILENAME), appliedText: read(APPLIED_MIGRATIONS_FILENAME), heartbeatText: read(HEARTBEAT_FILENAME) };
  try {
    const verified = verifyPublication({ ...texts, now });
    return { dump: verified.structure, applied: verified.applied };
  } catch (error) {
    // The format module reports problems with its own error type; keep its code and message.
    if (error instanceof MigrationPolicyError) throw new CheckError(String(error.code), error.message, error.context as Record<string, unknown>);
    throw error;
  }
}

async function withScratchDatabase<T>(admin: pg.Client, purpose: string, use: (databaseName: string) => Promise<T>): Promise<T> {
  // The name is built from fixed text and hex digits only; identifiers cannot be bound as parameters.
  const databaseName = `echelon_drift_${purpose}_${randomUUID().replace(/-/g, "")}`;
  await admin.query(`CREATE DATABASE ${databaseName}`);
  try {
    return await use(databaseName);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  }
}

/** Loads a structure dump into an empty scratch database, in one transaction. */
async function loadStructure(databaseUrl: URL, ssl: ReturnType<typeof localSslFromEnv>, dump: string, extraSql: string | null): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl.toString(), ssl, statement_timeout: LOAD_STATEMENT_TIMEOUT_MS });
  await client.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(transformProductionDump(dump));
      if (extraSql) await client.query(extraSql);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw new CheckError("SCHEMA_DRIFT_PRODUCTION_DUMP_NOT_LOADABLE", "Production's structure dump could not be loaded into a scratch database.", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    await client.end();
  }
}

async function compareWithProduction(options: DriftCheckOptions, env: NodeJS.ProcessEnv, now: Date): Promise<StructureComparison> {
  const adminUrl = adminUrlFromEnv(env);
  const ssl = localSslFromEnv(env);
  const repositoryMigrations = validateMigrationDirectory(MIGRATIONS_DIR);
  const selfCheck = options.source.kind === "self-check";

  const admin = new pg.Client({ connectionString: adminUrl.toString(), ssl, statement_timeout: ADMIN_STATEMENT_TIMEOUT_MS });
  await admin.connect();
  try {
    const repositoryDump = await withScratchDatabase(admin, "repository", async (databaseName) => {
      const databaseUrl = databaseUrlOn(adminUrl, databaseName);
      runMigrationRunner(databaseUrl.toString(), env);
      return dumpStructure(libpqEnvironment(databaseUrl, { production: false }), "SCHEMA_DRIFT_LOCAL_DUMP_FAILED");
    });

    let production: ProductionStructure;
    if (options.source.kind === "self-check") {
      // Stand in for production with the repository build itself, so the whole
      // path (pg_dump, reload, comparison) runs without production access.
      production = { dump: repositoryDump, applied: repositoryMigrations };
    } else if (options.source.kind === "files") {
      production = {
        dump: readFileSync(options.source.dumpFile, "utf8"),
        applied: parseAppliedMigrations(readFileSync(options.source.appliedFile, "utf8")),
      };
    } else {
      production = readPublishedStructure(options.source.directory, now);
    }

    const unreleased = findUnreleasedMigrations(repositoryMigrations, production.applied);
    if (unreleased.length > 0) {
      throw new CheckError("SCHEMA_DRIFT_PRODUCTION_MISSING_MIGRATIONS", `Production has not applied ${unreleased.length} migration(s) in the repository, so the structures cannot be compared until they are released: ${unreleased.join(", ")}`, { unreleased });
    }

    const reload = (extraSql: string | null) => withScratchDatabase(admin, "production", async (databaseName) => {
      const databaseUrl = databaseUrlOn(adminUrl, databaseName);
      await loadStructure(databaseUrl, ssl, production.dump, extraSql);
      return dumpStructure(libpqEnvironment(databaseUrl, { production: false }), "SCHEMA_DRIFT_LOCAL_DUMP_FAILED");
    });

    const comparison = compareStructureDumps({ repositoryDump, productionDump: await reload(null) });
    if (!selfCheck) return comparison;

    // Self-check: identical input must compare as identical, and one planted
    // table must be reported as exactly one difference. Either failing means
    // the check itself is broken and would mislead on a real run.
    if (!comparison.identical) {
      throw new CheckError("SCHEMA_DRIFT_SELF_CHECK_FALSE_DRIFT", "The check reported drift between a database and its own reloaded dump.", {
        differences: comparison.differences.slice(0, 20).map(({ schema, type, name, kind }) => ({ schema, type, name, kind })),
      });
    }
    const planted = compareStructureDumps({
      repositoryDump,
      productionDump: await reload(`CREATE TABLE public.${SELF_CHECK_MARKER_TABLE} (id integer)`),
    });
    const found = planted.differences.map(({ schema, type, name, kind }) => `${schema}|${type}|${name}|${kind}`);
    if (found.length !== 1 || found[0] !== `public|TABLE|${SELF_CHECK_MARKER_TABLE}|only_in_production`) {
      throw new CheckError("SCHEMA_DRIFT_SELF_CHECK_MISSED_DRIFT", "The check did not report a planted table as the only difference.", { found: found.slice(0, 20) });
    }
    return comparison;
  } finally {
    await admin.end();
  }
}

async function main(): Promise<number> {
  const env = process.env;
  const runUrl = env.SCHEMA_DRIFT_RUN_URL || null;
  const webhookUrl = env.SCHEMA_DRIFT_ALERT_WEBHOOK_URL || null;
  let options: DriftCheckOptions | null = null;
  // A self-check proves the tooling; it never speaks for production, so it never alerts.
  const alert = async (content: string): Promise<void> => {
    if (!webhookUrl || !options || options.source.kind === "self-check") return;
    await sendAlert(webhookUrl, content, fetch);
  };

  try {
    options = parseDriftCheckArguments(process.argv.slice(2));
    if (options.alertRequired && !webhookUrl) {
      throw new CheckError("SCHEMA_DRIFT_ALERT_WEBHOOK_MISSING", "SCHEMA_DRIFT_ALERT_WEBHOOK_URL is required with --require-alert: without it nobody would hear about drift.");
    }
    // The clock is read once, here at the edge; everything below receives it.
    const comparison = await compareWithProduction(options, env, new Date());
    if (options.reportFile) {
      writeFileSync(options.reportFile, `${JSON.stringify({ outcome: comparison.identical ? "no_drift" : "drift", ...comparison }, null, 2)}\n`, "utf8");
    }
    if (comparison.identical) {
      log("info", options.source.kind === "self-check" ? "self_check_passed" : "no_drift", null, { objects: comparison.objects });
      return 0;
    }
    log("error", "drift", "SCHEMA_DRIFT_DETECTED", {
      objects: comparison.objects,
      differences: comparison.differences.map(({ schema, type, name, kind }) => ({ schema, type, name, kind })),
    });
    await alert(formatDriftAlert({ differences: comparison.differences, runUrl }));
    return 1;
  } catch (error) {
    const failure = error instanceof CheckError ? error : null;
    const code = failure?.code ?? "SCHEMA_DRIFT_CHECK_CRASHED";
    log("error", "failed", code, {
      message: error instanceof Error ? error.message : String(error),
      context: failure?.context ?? {},
    });
    if (code !== "SCHEMA_DRIFT_ALERT_NOT_DELIVERED") {
      try {
        // Only this script's own messages go to the alert; an unexpected error's text is not known to be safe to post.
        await alert(formatCheckFailureAlert({ code, message: failure?.message ?? "The check stopped on an unexpected error; see the run log.", runUrl }));
      } catch (alertError) {
        const alertFailure = alertError instanceof CheckError ? alertError : null;
        log("error", "alert_failed", alertFailure?.code ?? "SCHEMA_DRIFT_ALERT_NOT_DELIVERED", { context: alertFailure?.context ?? {} });
      }
    }
    return 1;
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});
